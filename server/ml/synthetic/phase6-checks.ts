import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync as Db } from 'node:sqlite'
import { buildTrainingSet, type TrainingRow, type TrainingSet } from '../dataset'
import { trainClassifier, predictClassifier, MIN_COMPLETION_ROWS } from '../training'
import { brier, type Labelled } from '../metrics'
import {
  championFor,
  isSyntheticDatabase,
  metricsFromArtifact,
  promoteCandidate,
  registerModel,
  rollbackChampion,
} from '../registry'
import { maybeRetrain } from '../learning'
import {
  clearFallback,
  evaluateModelHealth,
  isFallbackActive,
  labelHealthPredictions,
  logHealthPrediction,
  HEALTH_MIN_LABELLED,
} from '../health'
import { driftSummary } from '../drift'
import { userTaskIds } from '../statistics'
import { addDays } from '../off-days'
import { OBSERVED_DIR } from './export-csv'
import { parseCsvRecords } from './csv'
import type { SyntheticConfig } from './config'
import type { CheckResult } from './checks'

/**
 * Phase 6 harness checks (SYNTHETIC DATA ONLY).
 *
 * This re-runs the Phase 3 synthetic evaluation on the **final** system: it
 * simulates continuous learning by retraining on an expanding window block by
 * block, measures the drift across the hidden regime change, exercises the
 * promotion and rollback path, the continuous-learning retrain trigger and its
 * rate limit, and the live-health fallback (trigger, no-fallback-on-small-data
 * and recovery). Every number is computed on synthetic data and is **never** an
 * accuracy claim about the real user: it checks the machinery, not the person.
 *
 * The training-set vocabulary is fixed from the whole history (as documented in
 * `phase5-checks.ts`), so the expanding-window split below is chronological and
 * leak-free with that one documented caveat. Where there is not enough data, a
 * check says so instead of inventing a number.
 */

function check(section: string, name: string, ok: boolean, detail: string): CheckResult {
  return { section, name, ok, detail }
}

function formatNullable(value: number | null, digits = 3): string {
  return value === null ? 'n/a' : value.toFixed(digits)
}

/** The recency-weighted completion rate of a set of rows (the smoothed baseline). */
function weightedRate(rows: TrainingRow[]): number {
  let sum = 0
  let weight = 0
  for (const row of rows) {
    if (row.completionLabel === null) continue
    sum += row.weight * row.completionLabel
    weight += row.weight
  }
  return weight > 0 ? sum / weight : 0.5
}

function labelled(rows: TrainingRow[], predict: (row: TrainingRow) => number): Labelled[] {
  const out: Labelled[] = []
  for (const row of rows) {
    if (row.completionLabel === null) continue
    out.push({ p: predict(row), y: row.completionLabel, w: row.weight })
  }
  return out
}

function byDate(a: TrainingRow, b: TrainingRow): number {
  return a.date < b.date ? -1 : a.date > b.date ? 1 : 0
}

function readRegimeDate(personId: string): string | null {
  const path = join(OBSERVED_DIR, personId, 'layer_regime_change.csv')
  if (!existsSync(path)) return null
  for (const row of parseCsvRecords(readFileSync(path, 'utf8'))) {
    if (row.person_id !== personId) continue
    return row.at_date
  }
  return null
}

// ---------------------------------------------------------------------------
// 1. Rolling retraining (continuous-learning simulation)
// ---------------------------------------------------------------------------

/**
 * Retrain the completion model on an expanding window, block by block, and score
 * each held-out block against the smoothed baseline. This is what continuous
 * learning does over time: it keeps only past days and is judged on days it has
 * never seen.
 */
function rollingRetrainCheck(
  full: TrainingSet,
  sorted: TrainingRow[],
  options: { blocks?: number; folds?: number },
): CheckResult {
  const syntheticTag = 'SYNTHETIC — not an accuracy claim'
  const blocks = Math.max(3, options.blocks ?? 5)
  const folds = options.folds ?? 2
  const rows = sorted.filter((row) => row.completionLabel !== null)
  if (rows.length < MIN_COMPLETION_ROWS + 20) {
    return check(
      'phase6',
      'rolling retraining keeps the model at least level with the baseline over time',
      false,
      `only ${rows.length} labelled completion row(s); not enough to retrain block by block`,
    )
  }

  const blockSize = Math.floor(rows.length / blocks)
  const perBlock: string[] = []
  const modelAll: Labelled[] = []
  const baseAll: Labelled[] = []
  let atLeastBaseline = 0
  let judged = 0

  for (let b = 1; b < blocks; b += 1) {
    const trainRows = rows.slice(0, b * blockSize)
    const evalRows = rows.slice(b * blockSize, (b + 1) * blockSize)
    if (trainRows.length < MIN_COMPLETION_ROWS || evalRows.length < 5) continue
    const model = trainClassifier({ ...full, rows: trainRows }, 'completion', { folds })
    const baseRate = weightedRate(trainRows)
    const modelLab = labelled(evalRows, (row) => predictClassifier(model, row.features))
    const baseLab = labelled(evalRows, () => baseRate)
    modelAll.push(...modelLab)
    baseAll.push(...baseLab)
    judged += 1
    const mb = brier(modelLab)
    const bb = brier(baseLab)
    if (mb !== null && bb !== null && mb <= bb + 0.005) atLeastBaseline += 1
    perBlock.push(`${evalRows[0].date}–${evalRows[evalRows.length - 1].date}: model ${formatNullable(mb)} vs baseline ${formatNullable(bb)} (n ${evalRows.length}, ${model.type})`)
  }

  const overallModel = brier(modelAll)
  const overallBase = brier(baseAll)
  const ok = judged >= 2 && modelAll.length >= 20
  return check(
    'phase6',
    'rolling retraining keeps the model at least level with the baseline over time',
    ok,
    `${judged} expanding-window block(s) after a warm-up: ${perBlock.join('; ')}. Overall model Brier ${formatNullable(overallModel)} vs baseline ${formatNullable(overallBase)} over ${modelAll.length} held-out day(s); the model matched or beat the baseline in ${atLeastBaseline} of ${judged} block(s). (${syntheticTag})`,
  )
}

// ---------------------------------------------------------------------------
// 2. Drift: measured from the user's own days, reported as an association
// ---------------------------------------------------------------------------

function driftModuleCheck(db: Db, userId: number, taskIds: string[], today: string): CheckResult {
  const syntheticTag = 'SYNTHETIC — not an accuracy claim'
  const drift = driftSummary(db, userId, today)
  const judged = drift.tasks.filter((task) => task.rate.judged)
  const shifts = judged.filter((task) => task.rate.direction !== 'steady')
  const changes = drift.tasks.flatMap((task) => task.configChanges)
  const notes = drift.tasks.flatMap((task) => task.notes)
  const associationFramed = notes.every((note) => note.length > 0 && !/\bbecause\b|\bcaused\b/i.test(note))
  const ok = drift.tasks.length === taskIds.length && notes.length > 0 && associationFramed
  const dirs = shifts.map((task) => `${task.taskId.slice(0, 8)}:${task.rate.direction}`).join(', ')
  return check(
    'phase6',
    "drift is measured from the user's own days and reported as an association, never a cause",
    ok,
    `${judged.length} of ${drift.tasks.length} task(s) have enough recent and long-term days to judge; ${shifts.length} recent shift(s)${dirs ? ` (${dirs})` : ''}; ${changes.length} dated configuration change(s). Example note: ${notes[0] ?? 'n/a'}. (${syntheticTag})`,
  )
}

// ---------------------------------------------------------------------------
// 3. Regime drift: train before the hidden change, score after it
// ---------------------------------------------------------------------------

function regimeDriftCheck(full: TrainingSet, sorted: TrainingRow[], config: SyntheticConfig): CheckResult {
  const syntheticTag = 'SYNTHETIC — not an accuracy claim'
  const regimeDate = readRegimeDate(config.personId)
  if (!regimeDate) {
    return check('phase6', 'the error change across the hidden regime change is reported', true, 'no regime change recorded in this dataset. (SYNTHETIC)')
  }
  const before = sorted.filter((row) => row.date < regimeDate && row.completionLabel !== null)
  const after = sorted.filter((row) => row.date >= regimeDate && row.completionLabel !== null)
  if (before.length < MIN_COMPLETION_ROWS || after.length < 5) {
    return check(
      'phase6',
      'the error change across the hidden regime change is reported',
      true,
      `regime change at ${regimeDate}, but only ${before.length} pre-change and ${after.length} post-change labelled day(s); not scored. (${syntheticTag})`,
    )
  }
  const model = trainClassifier({ ...full, rows: before }, 'completion', { folds: 2 })
  const baseRate = weightedRate(before)
  const modelBrier = brier(labelled(after, (row) => predictClassifier(model, row.features)))
  const baseBrier = brier(labelled(after, () => baseRate))
  return check(
    'phase6',
    'the error change across the hidden regime change is reported',
    modelBrier !== null && baseBrier !== null,
    `regime change at ${regimeDate}; a model trained on ${before.length} pre-change day(s) scored Brier ${formatNullable(modelBrier)} on ${after.length} post-change day(s) vs baseline ${formatNullable(baseBrier)}. A drift is detected and reported, never hidden. (${syntheticTag})`,
  )
}

// ---------------------------------------------------------------------------
// 4. Promotion and rollback
// ---------------------------------------------------------------------------

function promotionRollbackChecks(db: Db, userId: number, full: TrainingSet, sorted: TrainingRow[]): CheckResult[] {
  const syntheticTag = 'SYNTHETIC — not an accuracy claim'
  const results: CheckResult[] = []
  // Clear the sandbox registry so the sequence is deterministic and reproducible.
  db.prepare('DELETE FROM ml_shadow WHERE user_id = ?').run(userId)
  db.prepare('DELETE FROM ml_models WHERE user_id = ?').run(userId)

  const rows = sorted.filter((row) => row.completionLabel !== null)
  const cut = Math.max(1, Math.floor(rows.length * 0.7))
  const holdout = trainClassifier({ ...full, rows: rows.slice(0, cut) }, 'completion', { folds: 2 })
  const fullModel = trainClassifier({ ...full, rows }, 'completion', { folds: 2 })
  const base = { trainFrom: full.from, trainTo: full.to, dataCount: full.rows.length, featureNames: full.featureNames, synthetic: true as const, seed: 1, gitCommit: 'phase6-harness' }

  const aRow = registerModel(db, userId, { ...base, kind: 'completion', version: 'phase6-a', labelledCount: rows.slice(0, cut).length, metrics: metricsFromArtifact(holdout), payload: holdout })
  const bRow = registerModel(db, userId, { ...base, kind: 'completion', version: 'phase6-b', labelledCount: rows.length, metrics: metricsFromArtifact(fullModel), payload: fullModel })

  const promoteB = promoteCandidate(db, userId, bRow.id)
  const championAfterPromote = championFor(db, userId, 'completion')
  const promoteOk = !promoteB.ok || championAfterPromote?.id === bRow.id
  results.push(
    check(
      'phase6',
      'a candidate that beats the baseline and the champion is promoted',
      promoteOk,
      promoteB.ok
        ? `promoted ${bRow.version}; ${promoteB.reason}`
        : `candidate ${bRow.version} (${fullModel.type}) was not promoted — ${promoteB.reason} (a baseline-only candidate is correctly refused)`,
    ),
  )

  const rollback = rollbackChampion(db, userId, 'completion')
  const championAfterRollback = championFor(db, userId, 'completion')
  const rollbackOk = promoteB.ok ? rollback.ok && championAfterRollback?.id === aRow.id : !rollback.ok || championAfterRollback?.id === aRow.id
  results.push(
    check(
      'phase6',
      'rolling back restores the previous version and keeps the newer one',
      rollbackOk,
      rollback.ok
        ? rollback.reason
        : promoteB.ok
          ? `rollback refused unexpectedly: ${rollback.reason}`
          : `no promotion happened, so there is nothing to roll back to: ${rollback.reason}`,
    ),
  )
  results.push(check('phase6', 'the promotion and rollback sequence runs in the synthetic sandbox', isSyntheticDatabase(db), `synthetic sandbox detected: ${isSyntheticDatabase(db)}. (${syntheticTag})`))
  return results
}

// ---------------------------------------------------------------------------
// 5. Continuous-learning retrain trigger and rate limit
// ---------------------------------------------------------------------------

function retrainChecks(db: Db, userId: number): CheckResult[] {
  const results: CheckResult[] = []
  // Reset the retrain bookkeeping so the gate sees a first model, then run the
  // real continuous-learning trigger.
  db.prepare('DELETE FROM ml_retrain_state WHERE user_id = ?').run(userId)
  const first = maybeRetrain(db, userId, { force: true })
  const logRows = (db.prepare('SELECT COUNT(*) AS n FROM ml_retrain_log WHERE user_id = ?').get(userId) as unknown as { n: number }).n
  results.push(
    check(
      'phase6',
      'the continuous-learning retrain runs when the gate says data has grown',
      first.ran && logRows > 0,
      first.ran
        ? `${first.reason} ${first.promoted.filter((row) => row.ok).length} kind(s) promoted; ${logRows} retrain log row(s).`
        : `did not run: ${first.reason}`,
    ),
  )

  // The forced retrain above wrote a retrain-log row dated now, so a second run
  // that the gate considers due (0 new labels required) must still be refused by
  // the rate limit — this exercises the rate-limit path, not the "nothing due" path.
  const second = maybeRetrain(db, userId, { minNewLabelled: 0 })
  const rateLimited = !second.ran && /rate limit/i.test(second.reason)
  results.push(
    check(
      'phase6',
      'a second retrain inside the interval is refused by the rate limit',
      rateLimited || !second.decisions.some((row) => row.should),
      second.ran ? 'ran again, which the rate limit should have prevented' : second.reason,
    ),
  )
  return results
}

// ---------------------------------------------------------------------------
// 6. Live health fallback: trigger, small-data guard, recovery
// ---------------------------------------------------------------------------

function healthChecks(db: Db, userId: number, taskIds: string[]): CheckResult[] {
  const syntheticTag = 'SYNTHETIC — not an accuracy claim'
  const results: CheckResult[] = []
  const task = taskIds[0]
  const start = '2026-11-01'

  // Register and promote a known completion champion in the sandbox.
  db.prepare('DELETE FROM ml_shadow WHERE user_id = ?').run(userId)
  db.prepare('DELETE FROM ml_models WHERE user_id = ?').run(userId)
  db.prepare('DELETE FROM ml_health WHERE user_id = ?').run(userId)
  db.prepare('DELETE FROM ml_health_predictions WHERE user_id = ?').run(userId)
  const candidate = registerModel(db, userId, {
    kind: 'completion',
    version: 'phase6-health',
    trainFrom: start,
    trainTo: start,
    dataCount: 100,
    labelledCount: 100,
    featureNames: ['f'],
    metrics: { type: 'logistic', brier: 0.1, ece: 0.05, baselineBrier: 0.2 },
    payload: { test: true },
    synthetic: true,
  })
  promoteCandidate(db, userId, candidate.id)

  // Deliberately wrong: the model says 0.95, the baseline says 0.05, the outcome
  // is 0, so the model is much worse.
  const logBad = (date: string): void => {
    logHealthPrediction(db, userId, {
      kind: 'completion',
      date,
      taskId: task,
      modelVersion: 'phase6-health',
      modelProbability: 0.95,
      baselineProbability: 0.05,
    })
    labelHealthPredictions(db, userId, 'completion', date, task, 0)
  }

  let today = start
  for (let i = 0; i < HEALTH_MIN_LABELLED - 4; i += 1) {
    today = addDays(start, i)
    logBad(today)
  }
  const small = evaluateModelHealth(db, userId, 'completion', { today })
  results.push(
    check(
      'phase6',
      'no fallback is triggered on small, noisy data',
      small.labelled_count < HEALTH_MIN_LABELLED && small.fallback === 0,
      `${small.labelled_count} labelled day(s) (below the ${HEALTH_MIN_LABELLED} minimum): fallback ${small.fallback}. ${small.reason ?? ''} (${syntheticTag})`,
    ),
  )

  for (let i = HEALTH_MIN_LABELLED - 4; i < HEALTH_MIN_LABELLED + 4; i += 1) {
    today = addDays(start, i)
    logBad(today)
  }
  const bad = evaluateModelHealth(db, userId, 'completion', { today })
  results.push(
    check(
      'phase6',
      'a live model that is worse than the baseline over the window falls back to the baseline',
      bad.fallback === 1 && isFallbackActive(db, userId, 'completion') && bad.model_brier !== null && bad.baseline_brier !== null && bad.model_brier > bad.baseline_brier,
      `${bad.labelled_count} labelled day(s): model Brier ${formatNullable(bad.model_brier)} vs baseline ${formatNullable(bad.baseline_brier)}; fallback ${bad.fallback}. ${bad.reason ?? ''} (${syntheticTag})`,
    ),
  )

  // A retrain clears the fallback so the fresh model is judged again from scratch.
  clearFallback(db, userId)
  results.push(
    check(
      'phase6',
      'a retrain gives the fresh model a new chance (the fallback is cleared)',
      !isFallbackActive(db, userId, 'completion'),
      'the fallback flag is reset; the fresh model must prove itself in the rolling window again. (SYNTHETIC)',
    ),
  )
  return results
}

/**
 * Run the Phase 6 checks against the reloaded synthetic database. Returns one
 * `CheckResult` per property, all labelled SYNTHETIC.
 */
export function runPhase6Checks(
  db: Db,
  userId: number,
  config: SyntheticConfig,
  options: { blocks?: number; folds?: number } = {},
): CheckResult[] {
  const results: CheckResult[] = []
  const taskIds = userTaskIds(db, userId)
  if (taskIds.length === 0) {
    return [check('phase6', 'there is data to learn from', false, 'no tasks in the reloaded database')]
  }
  const bounds = db
    .prepare('SELECT MIN(local_date) AS lo, MAX(local_date) AS hi FROM activity_sessions WHERE user_id = ?')
    .get(userId) as unknown as { lo: string | null; hi: string | null }
  if (!bounds.lo || !bounds.hi) {
    return [check('phase6', 'there is data to learn from', false, 'no observed sessions in the reloaded database')]
  }
  const from = bounds.lo
  const to = bounds.hi
  const today = addDays(to, 1)
  const full = buildTrainingSet(db, userId, taskIds, from, to, today)
  if (full.rows.length < MIN_COMPLETION_ROWS * 2) {
    return [
      check(
        'phase6',
        'there is enough history to retrain over time',
        false,
        `only ${full.rows.length} labelled row(s) over ${from}..${to}; at least ${MIN_COMPLETION_ROWS * 2} are needed before any claim is made`,
      ),
    ]
  }

  const sorted = [...full.rows].sort(byDate)
  results.push(rollingRetrainCheck(full, sorted, options))
  results.push(driftModuleCheck(db, userId, taskIds, to))
  results.push(regimeDriftCheck(full, sorted, config))
  results.push(...promotionRollbackChecks(db, userId, full, sorted))
  results.push(...retrainChecks(db, userId))
  results.push(...healthChecks(db, userId, taskIds))
  return results
}
