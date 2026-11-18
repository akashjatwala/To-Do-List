import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { endOfLocalDay, startOfLocalDay } from './calendar'
import { rangesOverlap, type SessionRange } from '../sessions'
import { readinessFromCheckin } from '../readiness'
import { evaluateEstimates } from '../estimates'
import {
  checkinState,
  getCheckin,
  listCheckins,
  type CheckinAnswerKey,
  type CheckinRow,
} from '../../checkins-store'
import { getPredictionSettings, offDayDates } from '../off-days'
import {
  addDays,
  groupStatistics,
  userCompletionPrior,
  userTaskIds,
} from '../statistics'
import { logPrediction } from '../predictions'
import { predictTask, taskContext, type PredictContext, type TaskPrediction } from '../predictors'
import { GROUND_TRUTH_DIR } from './export-csv'
import { parseCsvRecords, type Cell } from './csv'
import type { SyntheticModel } from './model'
import type { SyntheticConfig } from './config'
import type { CoverageReport } from './coverage'

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

// ---------------------------------------------------------------------------
// Phase 4 pipeline checks
// ---------------------------------------------------------------------------

const PHASE4_DEFAULT_WINDOW_DAYS = 60
const PHASE4_CALIBRATION_BINS = 5
const PHASE4_MIN_SCORED = 20
/** A fixed timestamp for the log rows, so the check is reproducible. */
const PHASE4_LOG_NOW = Date.parse('2026-11-18T00:00:00Z')

export interface Phase4GroundTruth {
  date: string
  taskId: string
  trueProbability: number
  truePerformed: number
  offDay: number
}

/**
 * Read the hidden daily probability ground truth for one person. Ground truth
 * never enters the database; it is read straight from the file and used only to
 * score the pipeline.
 */
export function readPhase4GroundTruth(personId: string): Phase4GroundTruth[] {
  const path = join(GROUND_TRUTH_DIR, 'daily_probability.csv')
  if (!existsSync(path)) return []
  const out: Phase4GroundTruth[] = []
  for (const row of parseCsvRecords(readFileSync(path, 'utf8'))) {
    if (row.person_id !== personId) continue
    out.push({
      date: row.date,
      taskId: row.task_id,
      trueProbability: Number(row.true_probability),
      truePerformed: Number(row.true_performed),
      offDay: Number(row.off_day),
    })
  }
  return out
}

/** A small deterministic RNG so the exploration share is reproducible. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function checkinAnswers(row: CheckinRow): Partial<Record<CheckinAnswerKey, number>> {
  const out: Partial<Record<CheckinAnswerKey, number>> = {}
  for (const key of [
    'feeling',
    'energy',
    'motivation',
    'sleep',
    'stress',
    'free_time',
    'focus',
    'body',
    'workload',
  ] as const) {
    const value = row[key]
    if (value !== null) out[key] = value
  }
  return out
}

interface ScoredPrediction {
  date: string
  taskId: string
  prediction: TaskPrediction
  trueProbability: number | null
  truePerformed: number | null
}

function countRows(db: DatabaseSync, sql: string, ...values: Array<string | number>): number {
  return (db.prepare(sql).get(...values) as unknown as { n: number }).n
}

/**
 * Phase 4 checks against the reloaded database: run the app's own prediction
 * pipeline over past days (leak-free: each day is predicted only from what was
 * known before it) and inspect the results.
 *
 * These are **pipeline checks only**. The Brier score and calibration bins are
 * reported next to a constant-rate baseline purely to show the numbers can be
 * computed; they are never a claim of accuracy, and no ground-truth column is
 * ever written back into an observed table.
 */
export function runPhase4Checks(
  db: DatabaseSync,
  userId: number,
  config: SyntheticConfig,
  options: { windowDays?: number; groundTruth?: Phase4GroundTruth[] } = {},
): CheckResult[] {
  const results: CheckResult[] = []
  const windowDays = Math.max(1, options.windowDays ?? PHASE4_DEFAULT_WINDOW_DAYS)

  const bounds = db
    .prepare('SELECT MIN(local_date) AS lo, MAX(local_date) AS hi FROM activity_sessions WHERE user_id = ?')
    .get(userId) as unknown as { lo: string | null; hi: string | null }
  if (!bounds.lo || !bounds.hi) {
    results.push(check('phase4', 'predictions can be produced and scored', false, 'no observed days in the reloaded database'))
    return results
  }
  const firstActive = bounds.lo
  const lastActive = bounds.hi
  const windowStart = addDays(lastActive, -(windowDays - 1))
  const offDates = new Set(offDayDates(db, userId, firstActive, lastActive))

  // Predict the first observed day (cold start), the recent window, and every
  // off day, so each branch of the pipeline is actually exercised.
  const daySet = new Set<string>([firstActive, ...offDates])
  let cursor = windowStart
  while (cursor <= lastActive) {
    daySet.add(cursor)
    cursor = addDays(cursor, 1)
  }
  const days = [...daySet].sort()

  const settings = getPredictionSettings(db, userId)
  const taskIds = userTaskIds(db, userId)
  const groundTruth = options.groundTruth ?? readPhase4GroundTruth(config.personId)
  const truthByKey = new Map(groundTruth.map((row) => [`${row.date}|${row.taskId}`, row]))

  const statusBefore = countRows(db, 'SELECT COUNT(*) AS n FROM daily_activity_status WHERE user_id = ?', userId)
  const sessionsBefore = countRows(db, 'SELECT COUNT(*) AS n FROM activity_sessions WHERE user_id = ?', userId)

  const scored: ScoredPrediction[] = []
  const random = mulberry32(0x5eed)
  let suppressedOnOffDay = 0

  for (const date of days) {
    const previous = addDays(date, -1)
    const checkinRow = getCheckin(db, userId, date)
    const state = checkinRow ? checkinState(checkinRow) : 'not_asked'
    const answers = checkinRow && checkinRow.skipped === 0 ? checkinAnswers(checkinRow) : null
    const priorRate = userCompletionPrior(db, userId, taskIds, previous)
    const tagStats = groupStatistics(db, userId, taskIds, previous, priorRate, 'tag')
    const priorityStats = groupStatistics(db, userId, taskIds, previous, priorRate, 'priority')
    const context: PredictContext = {
      date,
      today: previous,
      nowMinutes: 8 * 60,
      checkinState: state,
      answers,
      settings,
      priorRate,
      tagStats,
      priorityStats,
      random,
      // Leak-free: only count a session if it had started before this day began.
      asOfEpoch: startOfLocalDay(date) - 1,
    }

    for (const taskId of taskIds) {
      const task = taskContext(db, taskId, date)
      if (!task || !task.active) continue
      const prediction = predictTask(db, userId, taskId, context)
      if (!prediction) {
        if (offDates.has(date)) suppressedOnOffDay += 1
        continue
      }
      logPrediction(db, userId, prediction, state, PHASE4_LOG_NOW)
      const truth = truthByKey.get(`${date}|${taskId}`)
      scored.push({
        date,
        taskId,
        prediction,
        trueProbability: truth ? truth.trueProbability : null,
        truePerformed: truth ? truth.truePerformed : null,
      })
    }
  }

  // --- Probability bounds ---------------------------------------------------
  const outOfRange = scored.filter((row) => {
    const p = row.prediction
    return (
      !(p.completionProbability >= 0 && p.completionProbability <= 1) ||
      (p.targetProbability !== null && !(p.targetProbability >= 0 && p.targetProbability <= 1))
    )
  })
  results.push(
    check(
      'phase4',
      'every probability stays within [0, 1]',
      scored.length > 0 && outOfRange.length === 0,
      `${scored.length} prediction(s), ${outOfRange.length} out of range`,
    ),
  )

  // --- Ordered intervals ----------------------------------------------------
  const unordered = scored.filter((row) => {
    const p = row.prediction
    const durationOk =
      p.expectedDuration === null ||
      ((p.durationLow === null || p.durationLow <= p.expectedDuration) &&
        (p.durationHigh === null || p.expectedDuration <= p.durationHigh))
    const windowOk = p.recommendedStart === null || p.recommendedEnd === null || p.recommendedEnd > p.recommendedStart
    return !durationOk || !windowOk
  })
  results.push(
    check(
      'phase4',
      'durations and windows stay ordered',
      unordered.length === 0,
      `${unordered.length} unordered interval(s)`,
    ),
  )

  // --- Low data reads as low confidence -------------------------------------
  const lowDataNotLow = scored.filter(
    (row) => row.prediction.dataSufficiencyDays < settings.stage2MinDays && row.prediction.confidence !== 'low',
  )
  const lowConfidence = scored.filter((row) => row.prediction.confidence === 'low').length
  results.push(
    check(
      'phase4',
      'low-data predictions read as low confidence',
      lowDataNotLow.length === 0 && lowConfidence > 0,
      `${lowConfidence} low-confidence prediction(s); ${lowDataNotLow.length} below ${settings.stage2MinDays} labelled days not marked low`,
    ),
  )

  // --- Off days suppress predictions ----------------------------------------
  const onOffDay = scored.filter((row) => offDates.has(row.date))
  const onGtOffDay = scored.filter((row) => truthByKey.get(`${row.date}|${row.taskId}`)?.offDay === 1).length
  const offDayOk =
    onOffDay.length === 0 && onGtOffDay === 0 && (offDates.size === 0 || suppressedOnOffDay > 0)
  results.push(
    check(
      'phase4',
      'off days suppress predictions',
      offDayOk,
      offDates.size === 0
        ? 'no off days recorded in the database — nothing to suppress'
        : `${offDates.size} off day(s) in range; ${onOffDay.length} prediction(s) on them; ${onGtOffDay} on a ground-truth off day; ${suppressedOnOffDay} task-day(s) suppressed`,
    ),
  )

  // --- Exploration respects its gates ---------------------------------------
  const exploratory = scored.filter((row) => row.prediction.exploratory)
  const badExploratory = exploratory.filter((row) => {
    const task = taskContext(db, row.taskId, row.date)
    const highPriority = task?.priority === 'high' || task?.priority === 'urgent'
    return row.prediction.confidence === 'low' || row.prediction.stage !== 2 || highPriority
  })
  const exploratoryShare = scored.length > 0 ? exploratory.length / scored.length : 0
  results.push(
    check(
      'phase4',
      'exploration is rare, labelled and never on a high priority or low-confidence task',
      badExploratory.length === 0 && exploratoryShare <= settings.explorationShare + 0.1,
      `${exploratory.length} exploratory of ${scored.length} (${(exploratoryShare * 100).toFixed(1)}%, cap ${(settings.explorationShare * 100).toFixed(0)}%); ${badExploratory.length} that broke a gate`,
    ),
  )

  // --- Predictions are logged, never outcomes -------------------------------
  const statusAfter = countRows(db, 'SELECT COUNT(*) AS n FROM daily_activity_status WHERE user_id = ?', userId)
  const sessionsAfter = countRows(db, 'SELECT COUNT(*) AS n FROM activity_sessions WHERE user_id = ?', userId)
  const logged = countRows(db, 'SELECT COUNT(*) AS n FROM predictions WHERE user_id = ?', userId)
  results.push(
    check(
      'phase4',
      'the system logs predictions without writing outcomes',
      logged === scored.length && statusAfter === statusBefore && sessionsAfter === sessionsBefore,
      `logged ${logged} prediction(s); statuses ${statusBefore}→${statusAfter}, sessions ${sessionsBefore}→${sessionsAfter}`,
    ),
  )

  // --- Pending days carry no labels -----------------------------------------
  const pendingStatuses = countRows(
    db,
    'SELECT COUNT(*) AS n FROM daily_activity_status WHERE user_id = ? AND local_date > ?',
    userId,
    lastActive,
  )
  const pendingSessions = countRows(
    db,
    'SELECT COUNT(*) AS n FROM activity_sessions WHERE user_id = ? AND local_date > ?',
    userId,
    lastActive,
  )
  results.push(
    check(
      'phase4',
      'pending days carry no labels or sessions',
      pendingStatuses === 0 && pendingSessions === 0,
      `after ${lastActive}: statuses ${pendingStatuses}, sessions ${pendingSessions}`,
    ),
  )

  // --- Ground-truth scoring (pipeline check only) ---------------------------
  const paired = scored.filter((row) => row.truePerformed !== null && row.trueProbability !== null)
  if (paired.length < PHASE4_MIN_SCORED) {
    results.push(
      check(
        'phase4',
        'predictions can be scored against ground truth',
        false,
        `only ${paired.length} prediction(s) joined to ground truth (need ${PHASE4_MIN_SCORED}); is ground-truth/daily_probability.csv present?`,
      ),
    )
    return results
  }

  const brier = paired.reduce((sum, row) => sum + (row.prediction.completionProbability - row.truePerformed!) ** 2, 0) / paired.length
  const trueGap =
    paired.reduce((sum, row) => sum + Math.abs(row.prediction.completionProbability - row.trueProbability!), 0) / paired.length
  const observedRate = paired.reduce((sum, row) => sum + row.truePerformed!, 0) / paired.length
  const naiveBrier = paired.reduce((sum, row) => sum + (observedRate - row.truePerformed!) ** 2, 0) / paired.length
  results.push(
    check(
      'phase4',
      'predictions can be scored against ground truth (pipeline check only)',
      Number.isFinite(brier) && brier >= 0 && brier <= 1,
      `Brier ${brier.toFixed(3)} vs constant-rate baseline ${naiveBrier.toFixed(3)}; mean |prediction − true probability| ${trueGap.toFixed(3)} over ${paired.length} prediction(s). Not an accuracy claim.`,
    ),
  )

  const binRows: string[] = []
  let worstGap = 0
  for (let bin = 0; bin < PHASE4_CALIBRATION_BINS; bin += 1) {
    const lo = bin / PHASE4_CALIBRATION_BINS
    const hi = (bin + 1) / PHASE4_CALIBRATION_BINS
    const inBin = paired.filter((row) => {
      const p = row.prediction.completionProbability
      return bin === PHASE4_CALIBRATION_BINS - 1 ? p >= lo && p <= hi : p >= lo && p < hi
    })
    if (inBin.length === 0) continue
    const meanPredicted = inBin.reduce((sum, row) => sum + row.prediction.completionProbability, 0) / inBin.length
    const observed = inBin.reduce((sum, row) => sum + row.truePerformed!, 0) / inBin.length
    worstGap = Math.max(worstGap, Math.abs(meanPredicted - observed))
    binRows.push(`${lo.toFixed(1)}–${hi.toFixed(1)}: predicted ${meanPredicted.toFixed(2)} vs observed ${observed.toFixed(2)} (n ${inBin.length})`)
  }
  results.push(
    check(
      'phase4',
      'calibration is reported, never gated',
      true,
      `largest predicted-vs-observed gap ${worstGap.toFixed(2)}; ${binRows.join('; ')}`,
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
