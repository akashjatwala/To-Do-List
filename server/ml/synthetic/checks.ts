import type { DatabaseSync } from 'node:sqlite'
import { endOfLocalDay, startOfLocalDay } from './calendar'
import { rangesOverlap, type SessionRange } from '../sessions'
import { readinessFromCheckin } from '../readiness'
import { evaluateEstimates } from '../estimates'
import { listCheckins, type CheckinRow } from '../../checkins-store'
import type { SyntheticModel } from './model'
import type { SyntheticConfig } from './config'
import type { CoverageReport } from './coverage'
import type { Cell } from './csv'

/**
 * Data-quality, leakage and Phase 2a checks (Phase 3).
 *
 * These run over a generated model (in memory) and over the reloaded synthetic
 * database. They are the checks that can be answered *now*, before any model
 * exists; the Phase 5 metric harness in `harness.ts` refuses to report numbers
 * until real predictions exist.
 *
 * Nothing here ever claims accuracy. It checks the dataset is well-formed,
 * leak-free, honestly labelled, and that the Phase 2a layer behaves as it should
 * on data whose hidden rules are known.
 */

export interface CheckResult {
  section: string
  name: string
  ok: boolean
  detail: string
}

export interface ChecksReport {
  personId: string
  asOfDate: string
  checks: CheckResult[]
  allOk: boolean
}

const OBSERVED_ANSWER_KEYS = [
  'feeling',
  'energy',
  'motivation',
  'sleep',
  'stress',
  'free_time',
  'focus',
  'body',
  'workload',
] as const

function check(section: string, name: string, ok: boolean, detail: string): CheckResult {
  return { section, name, ok, detail }
}

/** In-memory data-quality and leakage checks over the generated model. */
export function runModelChecks(model: SyntheticModel, config: SyntheticConfig, coverage: CoverageReport): CheckResult[] {
  const results: CheckResult[] = []
  const lastEvaluatedIndex = Math.max(0, model.person.dates.length - config.pendingTailDays - 1)
  const pendingStart = lastEvaluatedIndex + 1

  // --- Data quality ---------------------------------------------------------
  const badAnswers = model.checkins.filter((row) =>
    OBSERVED_ANSWER_KEYS.some((key) => {
      const value = row[key]
      return value !== null && (value < 1 || value > 5)
    }),
  )
  results.push(
    check('data-quality', 'check-in answers are 1–5 or blank', badAnswers.length === 0, `${badAnswers.length} out-of-range answer(s)`),
  )

  const badDurations = model.sessions.filter((row) => row.duration_minutes < 1 || row.duration_minutes > 24 * 60)
  results.push(
    check('data-quality', 'session durations are within a day', badDurations.length === 0, `${badDurations.length} bad duration(s)`),
  )

  const ids = new Set<string>()
  let duplicateIds = 0
  for (const row of model.sessions) {
    if (ids.has(row.id)) duplicateIds += 1
    ids.add(row.id)
  }
  results.push(check('data-quality', 'session ids are unique', duplicateIds === 0, `${duplicateIds} duplicate(s)`))

  const byTask = new Map<string, SessionRange[]>()
  let overlaps = 0
  for (const row of model.sessions) {
    const list = byTask.get(row.task_id) ?? []
    const range: SessionRange = { id: row.id, startedAt: row.started_at, endedAt: row.ended_at, durationMinutes: row.duration_minutes }
    if (list.some((existing) => rangesOverlap(range, existing))) overlaps += 1
    list.push(range)
    byTask.set(row.task_id, list)
  }
  results.push(check('data-quality', 'no overlapping sessions within a task', overlaps === 0, `${overlaps} overlap(s)`))

  const flagOk = model.sessions.every((row) => row.source === 'synthetic') &&
    model.checkins.every((row) => row.source === 'synthetic') &&
    model.dailyStatus.every((row) => row.source === 'synthetic') &&
    model.offDays.every((row) => row.synthetic === 1) &&
    model.recommendations.every((row) => row.synthetic === 1) &&
    model.liveReplay.every((row) => row.synthetic === 1)
  results.push(check('data-quality', 'every observed row is flagged synthetic', flagOk, flagOk ? 'all rows flagged' : 'a row is missing its flag'))

  results.push(
    check(
      'data-quality',
      'coverage matrix met',
      coverage.allOk,
      coverage.allOk ? 'every minimum met' : coverage.missing.join('; '),
    ),
  )
  results.push(
    check('data-quality', 'row cap respected', coverage.capOk, `${coverage.totalRows} of ${coverage.maxRows}`),
  )
  results.push(
    check(
      'data-quality',
      'deliberately-invalid entries were rejected',
      model.coverage.counts.invalidOrDuplicateEntries > 0,
      `${model.coverage.counts.invalidOrDuplicateEntries} rejected`,
    ),
  )

  // --- Leakage --------------------------------------------------------------
  const offDayBounds = model.sessions.filter(
    (row) => row.started_at < startOfLocalDay(row.local_date) || row.started_at > endOfLocalDay(row.local_date),
  )
  results.push(
    check('leakage', 'sessions fall inside their local day', offDayBounds.length === 0, `${offDayBounds.length} out of bounds`),
  )

  const lateCreated = model.sessions.filter((row) => row.created_at > endOfLocalDay(row.local_date) + 3 * 24 * 60 * 60 * 1000)
  results.push(
    check(
      'leakage',
      'no session logged more than 3 days after the fact',
      lateCreated.length === 0,
      `${lateCreated.length} later than allowed`,
    ),
  )

  const pendingCheckins = model.checkins.filter((row) => row.date > model.person.dates[lastEvaluatedIndex])
  const pendingStatuses = model.dailyStatus.filter((row) => row.local_date > model.person.dates[lastEvaluatedIndex])
  const pendingSessions = model.sessions.filter((row) => row.local_date > model.person.dates[lastEvaluatedIndex])
  results.push(
    check(
      'leakage',
      'pending days carry no labels or sessions',
      pendingCheckins.length === 0 && pendingStatuses.length === 0 && pendingSessions.length === 0,
      `checkins ${pendingCheckins.length}, statuses ${pendingStatuses.length}, sessions ${pendingSessions.length} (pending from index ${pendingStart})`,
    ),
  )

  const predictionsAsOutcomes = model.liveReplay.filter((row) => row.prediction !== null && row.outcome !== null)
  results.push(
    check(
      'leakage',
      'no prediction recorded as an outcome',
      predictionsAsOutcomes.length === 0,
      `${predictionsAsOutcomes.length} row(s) with both a prediction and an outcome`,
    ),
  )

  const gtCovered = model.gtDaily.some((row) => row.date <= model.person.dates[lastEvaluatedIndex])
  results.push(
    check(
      'leakage',
      'ground truth is present for the evaluated window',
      gtCovered,
      gtCovered ? 'ground truth covers the evaluated days' : 'no ground-truth rows in the evaluated window',
    ),
  )

  // --- Phase 2a (in-memory shape) -------------------------------------------
  const scored = model.checkins
    .filter((row) => row.skipped === 0)
    .map((row) => readinessFromCheckin(row as unknown as CheckinRow))
    .filter((score) => score.score !== null)
  results.push(
    check(
      'phase2a',
      'readiness scores can be computed from the check-ins',
      scored.length > 0,
      `${scored.length} scored day(s)`,
    ),
  )

  return results
}

/** Completion rate for a day: tasks with sessions over tasks with any signal. */
function completionRateForDate(db: DatabaseSync, userId: number, date: string): number | null {
  const sessions = db
    .prepare('SELECT COUNT(DISTINCT task_id) AS n FROM activity_sessions WHERE user_id = ? AND local_date = ?')
    .get(userId, date) as unknown as { n: number }
  const missed = db
    .prepare("SELECT COUNT(*) AS n FROM daily_activity_status WHERE user_id = ? AND local_date = ? AND status IN ('skipped', 'postponed')")
    .get(userId, date) as unknown as { n: number }
  const denominator = sessions.n + missed.n
  if (denominator === 0) return null
  return sessions.n / denominator
}

/**
 * Phase 2a checks against the reloaded database: does the readiness score line
 * up with what got done, per task, and do the display estimates hold up against
 * the simple baselines. Reported per task, never as one blended number.
 */
export function runPhase2aChecks(db: DatabaseSync, userId: number, config: SyntheticConfig): CheckResult[] {
  const results: CheckResult[] = []

  // Score against the most recent day that actually has data. `config.endDate`
  // is the pending tail and carries no labels yet, so checking against it would
  // always come back empty; the last active day sits inside the evaluated window.
  const lastActiveRow = db
    .prepare('SELECT MAX(local_date) AS d FROM activity_sessions WHERE user_id = ?')
    .get(userId) as unknown as { d: string | null }
  const asOf = lastActiveRow.d ?? config.endDate

  const checkins = listCheckins(db, userId, 400)
  const scoreByDate = new Map<string, number>()
  for (const row of checkins) {
    const score = readinessFromCheckin(row).score
    if (score !== null) scoreByDate.set(row.date, score)
  }

  const tasks = db
    .prepare('SELECT id, text FROM tasks WHERE user_id = ? ORDER BY position')
    .all(userId) as unknown as Array<{ id: string; text: string }>

  let tracked = 0
  let assessable = 0
  for (const task of tasks) {
    const dates = db
      .prepare('SELECT DISTINCT local_date FROM activity_sessions WHERE user_id = ? AND task_id = ?')
      .all(userId, task.id) as unknown as Array<{ local_date: string }>
    const doneDates = new Set(dates.map((row) => row.local_date))
    const doneScores: number[] = []
    const notDoneScores: number[] = []
    for (const [date, score] of scoreByDate) {
      if (doneDates.has(date)) doneScores.push(score)
      else notDoneScores.push(score)
    }
    const mean = (values: number[]) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null)
    const doneMean = mean(doneScores)
    const notMean = mean(notDoneScores)
    const enough = doneScores.length >= 5 && notDoneScores.length >= 5
    const gap = doneMean !== null && notMean !== null ? doneMean - notMean : null
    // A task the person does at least ten times is "tracked"; only those are
    // expected to have enough labelled days. A short-lived or sparse task is
    // reported informationally and never counted as a failure — the aggregate
    // check below is what guards the dataset.
    const isTracked = doneScores.length >= 10
    if (isTracked) tracked += 1
    if (isTracked && enough) assessable += 1
    results.push(
      check(
        'phase2a',
        `readiness vs completion — ${task.text}`,
        true,
        enough
          ? `mean readiness ${doneMean!.toFixed(1)} on days done vs ${notMean!.toFixed(1)} otherwise (gap ${gap!.toFixed(1)}; done ${doneScores.length}, other ${notDoneScores.length})`
          : `not enough labelled days to assess (done ${doneScores.length}, other ${notDoneScores.length})${isTracked ? '' : ' — sparse task, informational'}`,
      ),
    )
  }

  const mostAssessable = tracked >= 2 && assessable >= Math.ceil((tracked * 2) / 3)
  results.push(
    check(
      'phase2a',
      'most tracked tasks can be assessed against readiness',
      mostAssessable,
      `${assessable} of ${tracked} tracked task(s) have enough done/other days (need at least two thirds)`,
    ),
  )

  const association = completionRateForDate(db, userId, asOf)
  results.push(
    check(
      'phase2a',
      'a day-level completion rate can be derived',
      association !== null,
      association === null ? 'no completed or skipped task-days' : 'derived',
    ),
  )

  const estimates = evaluateEstimates(db, userId, asOf)
  results.push(
    check(
      'phase2a',
      'display estimates evaluated against simple baselines',
      estimates.evaluations.length > 0,
      estimates.evaluations.length > 0
        ? `${estimates.evaluations.filter((row) => row.beatsBaseline).length} of ${estimates.evaluations.length} fields match or beat the best baseline`
        : estimates.note,
    ),
  )

  return results
}

export function combineReports(personId: string, asOfDate: string, ...groups: CheckResult[][]): ChecksReport {
  const checks = groups.flat()
  return { personId, asOfDate, checks, allOk: checks.every((row) => row.ok) }
}

/** CSV rows for the quality report file (never the data itself). */
export function reportToCsvRows(report: ChecksReport): Cell[][] {
  return report.checks.map((row) => [report.personId, row.section, row.name, row.ok ? 'pass' : 'fail', row.detail, 1])
}

export function formatChecksReport(report: ChecksReport): string {
  const lines: string[] = []
  lines.push('Data-quality / Phase 2a report (SYNTHETIC DATA)')
  lines.push('---------------------------------------------')
  for (const row of report.checks) {
    lines.push(`  [${row.ok ? 'ok ' : 'FAIL'}] (${row.section}) ${row.name}`)
    lines.push(`         ${row.detail}`)
  }
  lines.push(report.allOk ? 'Result: PASS' : 'Result: FAIL — see the failing checks above.')
  return lines.join('\n')
}
