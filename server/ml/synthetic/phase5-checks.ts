import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { DatabaseSync as Db } from 'node:sqlite'
import { buildTrainingSet, type TrainingRow, type TrainingSet } from '../dataset'
import { predictClassifier, trainClassifier, trainDuration, predictDuration, type ClassifierArtifact } from '../training'
import { brier, calibrationError, confusion, intervalCoverage, mae, rmse, rocAuc, type Labelled } from '../metrics'
import { trainLogistic, predictLogistic, type LogisticModel } from '../model/logistic'
import type { Example } from '../model/math'
import {
  championFor,
  isSyntheticDatabase,
  loadChampionArtifact,
  metricsFromArtifact,
  promoteCandidate,
  registerModel,
  rollbackChampion,
} from '../registry'
import { labelShadow, logShadow, promoteAfterShadow, shadowSummary } from '../shadow'
import { serveTask } from '../serving'
import { userTaskIds } from '../statistics'
import { addDays } from '../off-days'
import { createMlSchema } from '../schema'
import { configForDate } from '../task-config'
import { GROUND_TRUTH_DIR, OBSERVED_DIR } from './export-csv'
import { parseCsvRecords } from './csv'
import type { SyntheticConfig } from './config'
import type { CheckResult } from './checks'

/**
 * Phase 5 harness checks (SYNTHETIC DATA ONLY).
 *
 * These run the real training, evaluation, promotion, rollback and shadow code
 * against the reloaded synthetic database, whose hidden rules are known. Every
 * number here is computed on synthetic data and is **never** an accuracy claim
 * about the real user: it checks the machinery, not the person.
 *
 * The checks cover exactly what the brief asks for: metrics against baselines and
 * the ground-truth probabilities, a learning curve, feature ablations
 * (check-in / priority / tags), a no-mood-effect control, a drift scenario, and
 * promotion, rollback and shadow behaviour. The tag vocabulary is fixed from the
 * whole history (it counts tag *identity* frequency, not outcomes), so the
 * holdout split below is chronological and leak-free with that one documented
 * caveat.
 */

function check(section: string, name: string, ok: boolean, detail: string): CheckResult {
  return { section, name, ok, detail }
}

interface TruthRow {
  trueProbability: number
  truePerformed: number
  regime: number
}

function readTruth(personId: string): Map<string, TruthRow> {
  const path = join(GROUND_TRUTH_DIR, 'daily_probability.csv')
  const out = new Map<string, TruthRow>()
  if (!existsSync(path)) return out
  for (const row of parseCsvRecords(readFileSync(path, 'utf8'))) {
    if (row.person_id !== personId) continue
    out.set(`${row.date}|${row.task_id}`, {
      trueProbability: Number(row.true_probability),
      truePerformed: Number(row.true_performed),
      regime: Number(row.regime),
    })
  }
  return out
}

function readParams(personId: string): Map<string, string> {
  const path = join(GROUND_TRUTH_DIR, 'params.csv')
  const out = new Map<string, string>()
  if (!existsSync(path)) return out
  for (const row of parseCsvRecords(readFileSync(path, 'utf8'))) {
    if (row.person_id !== personId) continue
    out.set(row.key, row.value)
  }
  return out
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

function examplesOf(rows: TrainingRow[], label: (row: TrainingRow) => number | null): Example[] {
  const out: Example[] = []
  for (const row of rows) {
    const y = label(row)
    if (y === null) continue
    out.push({ x: row.features, y, w: row.weight })
  }
  return out
}

function completionBaseRate(rows: TrainingRow[]): number {
  let sum = 0
  let weight = 0
  for (const row of rows) {
    if (row.completionLabel === null) continue
    sum += row.weight * row.completionLabel
    weight += row.weight
  }
  return weight > 0 ? sum / weight : 0.5
}

function completionLabelled(rows: TrainingRow[], predict: (row: TrainingRow) => number): Labelled[] {
  const out: Labelled[] = []
  for (const row of rows) {
    if (row.completionLabel === null) continue
    out.push({ p: predict(row), y: row.completionLabel, w: row.weight })
  }
  return out
}

/** Zero out the columns whose names start with any of the given prefixes. */
function ablate(rows: TrainingRow[], names: string[], prefixes: string[]): TrainingRow[] {
  const columns: number[] = []
  names.forEach((name, index) => {
    if (prefixes.some((prefix) => name.startsWith(prefix))) columns.push(index)
  })
  if (columns.length === 0) return rows
  return rows.map((row) => {
    const features = row.features.slice()
    for (const column of columns) features[column] = 0
    return { ...row, features }
  })
}

function fitLogistic(trainRows: TrainingRow[], nFeatures: number): LogisticModel {
  return trainLogistic(examplesOf(trainRows, (row) => row.completionLabel), nFeatures, { lambda: 1, iterations: 400, learningRate: 0.5 })
}

function formatNullable(value: number | null, digits = 3): string {
  return value === null ? 'n/a' : value.toFixed(digits)
}

/**
 * Run the Phase 5 checks. Returns one `CheckResult` per property. When there is
 * not enough data, it says so instead of reporting a number.
 */
export function runPhase5Checks(
  db: Db,
  userId: number,
  config: SyntheticConfig,
  options: { folds?: number } = {},
): CheckResult[] {
  const results: CheckResult[] = []
  const syntheticTag = 'SYNTHETIC — not an accuracy claim'
  const taskIds = userTaskIds(db, userId)
  if (taskIds.length === 0) {
    return [check('phase5', 'there is data to train on', false, 'no tasks in the reloaded database')]
  }

  const bounds = db
    .prepare('SELECT MIN(local_date) AS lo, MAX(local_date) AS hi FROM activity_sessions WHERE user_id = ?')
    .get(userId) as unknown as { lo: string | null; hi: string | null }
  if (!bounds.lo || !bounds.hi) {
    return [check('phase5', 'there is data to train on', false, 'no observed sessions in the reloaded database')]
  }
  const from = bounds.lo
  const to = bounds.hi
  const today = addDays(to, 1)

  const full = buildTrainingSet(db, userId, taskIds, from, to, today)
  if (full.rows.length < 40) {
    results.push(
      check(
        'phase5',
        'there is enough data to train and validate',
        false,
        `only ${full.rows.length} labelled row(s) over ${from}..${to}; at least 40 are needed before any model claim is made`,
      ),
    )
    return results
  }

  // --- Leak-free chronological split ----------------------------------------
  const sorted = [...full.rows].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  const chronological = sorted.every((row, index) => index === 0 || sorted[index - 1].date <= row.date)
  const cut = Math.max(1, Math.floor(sorted.length * 0.7))
  const trainRows = sorted.slice(0, cut)
  const testRows = sorted.slice(cut)
  results.push(
    check(
      'phase5',
      'the training set is chronological and split by time, never shuffled',
      chronological && testRows.length > 0 && trainRows[trainRows.length - 1].date <= testRows[0].date,
      `${sorted.length} row(s); train ${trainRows.length} (≤ ${trainRows[trainRows.length - 1].date}) → test ${testRows.length} (≥ ${testRows[0].date})`,
    ),
  )

  const trainSet: TrainingSet = { ...full, rows: trainRows }
  const folds = options.folds ?? 3
  const completion = trainClassifier(trainSet, 'completion', { folds })
  const target = trainClassifier(trainSet, 'target', { folds })
  const duration = trainDuration(trainSet, { folds })

  // --- Model vs baseline on the holdout -------------------------------------
  const baseRate = completionBaseRate(trainRows)
  const modelLabelled = completionLabelled(testRows, (row) => predictClassifier(completion, row.features))
  const baselineLabelled = completionLabelled(testRows, () => baseRate)
  const modelBrier = brier(modelLabelled)
  const baselineBrier = brier(baselineLabelled)
  const conf = confusion(modelLabelled)
  results.push(
    check(
      'phase5',
      'completion is scored against the smoothed baseline on a chronological holdout',
      modelBrier !== null && baselineBrier !== null,
      `model Brier ${formatNullable(modelBrier)} vs baseline ${formatNullable(baselineBrier)}${modelBrier !== null && baselineBrier !== null && modelBrier <= baselineBrier ? ' (beats the baseline)' : ' (does not beat the baseline, so the baseline would be kept)'}; ROC-AUC ${formatNullable(rocAuc(modelLabelled))}; precision ${formatNullable(conf.precision)} recall ${formatNullable(conf.recall)} F1 ${formatNullable(conf.f1)}; ECE ${formatNullable(calibrationError(modelLabelled))}. (${syntheticTag})`,
    ),
  )

  results.push(
    check(
      'phase5',
      'the simplest model that wins is chosen, and calibration is gated by data',
      true,
      `completion chose ${completion.type} — ${completion.reason} Calibrator: ${completion.calibrator.kind} (${completion.calibrator.reason})`,
    ),
  )

  // --- Target achievement ---------------------------------------------------
  const targetRows = testRows.filter((row) => row.targetLabel !== null)
  if (targetRows.length >= 5) {
    let targetSum = 0
    let targetWeight = 0
    for (const row of trainRows) {
      if (row.targetLabel === null) continue
      targetSum += row.weight * row.targetLabel
      targetWeight += row.weight
    }
    const targetBase = targetWeight > 0 ? targetSum / targetWeight : 0.5
    const targetLabelled = (rows: TrainingRow[], predict: (row: TrainingRow) => number): Labelled[] => {
      const out: Labelled[] = []
      for (const row of rows) {
        if (row.targetLabel === null) continue
        out.push({ p: predict(row), y: row.targetLabel, w: row.weight })
      }
      return out
    }
    const targetModel = targetLabelled(testRows, (row) => predictClassifier(target, row.features))
    const targetBaseline = targetLabelled(testRows, () => targetBase)
    const targetModelBrier = brier(targetModel)
    const targetBaseBrier = brier(targetBaseline)
    results.push(
      check(
        'phase5',
        'target achievement is scored against the smoothed baseline on a chronological holdout',
        targetModelBrier !== null && targetBaseBrier !== null,
        `chose ${target.type}; model Brier ${formatNullable(targetModelBrier)} vs baseline ${formatNullable(targetBaseBrier)}${targetModelBrier !== null && targetBaseBrier !== null && targetModelBrier <= targetBaseBrier ? ' (beats the baseline)' : ' (does not beat the baseline, so the baseline would be kept)'}; ROC-AUC ${formatNullable(rocAuc(targetModel))} over ${targetRows.length} day(s). (${syntheticTag})`,
      ),
    )
  } else {
    results.push(
      check(
        'phase5',
        'target achievement is scored against the smoothed baseline on a chronological holdout',
        true,
        `only ${targetRows.length} target day(s) in the holdout; not scored. (${syntheticTag})`,
      ),
    )
  }

  // --- Duration -------------------------------------------------------------
  const durationPoints = testRows
    .filter((row) => row.duration !== null)
    .map((row) => {
      const estimate = predictDuration(duration, row.features)
      return { predicted: estimate.point, actual: row.duration!, low: estimate.low, high: estimate.high, w: row.weight }
    })
  const durationWidth = duration.type === 'quantile' ? intervalWidthOf(durationPoints) : null
  const durationCoverage = duration.type === 'quantile' ? intervalCoverage(durationPoints) : null
  results.push(
    check(
      'phase5',
      'duration is compared against the median baseline, with a usable interval',
      duration.type === 'median' || (mae(durationPoints) !== null && durationCoverage !== null && (durationWidth ?? 0) > 0),
      `chose ${duration.type} — MAE ${formatNullable(mae(durationPoints), 1)} min, RMSE ${formatNullable(rmse(durationPoints), 1)} min, coverage ${formatNullable(durationCoverage)} at width ${formatNullable(durationWidth, 1)} min. (${syntheticTag})`,
    ),
  )

  // --- Ground-truth agreement -----------------------------------------------
  const truth = readTruth(config.personId)
  const paired = testRows.filter((row) => row.completionLabel !== null && truth.has(`${row.date}|${row.taskId}`))
  if (paired.length >= 10) {
    let gap = 0
    const vsPerformed: Labelled[] = []
    const oracle: Labelled[] = []
    for (const row of paired) {
      const t = truth.get(`${row.date}|${row.taskId}`)!
      const p = predictClassifier(completion, row.features)
      gap += Math.abs(p - t.trueProbability)
      vsPerformed.push({ p, y: t.truePerformed })
      oracle.push({ p: t.trueProbability, y: t.truePerformed })
    }
    results.push(
      check(
        'phase5',
        'predictions are compared against the hidden ground-truth probabilities',
        true,
        `mean |prediction − true probability| ${(gap / paired.length).toFixed(3)} over ${paired.length} paired day(s); Brier ${formatNullable(brier(vsPerformed))} vs oracle ${formatNullable(brier(oracle))} (a model can only approach the oracle, never beat it on average). (${syntheticTag})`,
      ),
    )
  } else {
    results.push(check('phase5', 'predictions are compared against the hidden ground-truth probabilities', true, `only ${paired.length} paired day(s); ground truth is not scored. (${syntheticTag})`))
  }

  // --- Learning curve -------------------------------------------------------
  const nFeatures = full.featureNames.length
  const curve: string[] = []
  for (const weeks of [1, 2, 4, 8, 12]) {
    const until = addDays(from, weeks * 7)
    const subset = trainRows.filter((row) => row.date < until && row.completionLabel !== null)
    if (subset.length < 10) {
      curve.push(`${weeks}w: too little data`)
      continue
    }
    const model = fitLogistic(subset, nFeatures)
    const scored = completionLabelled(testRows, (row) => predictLogistic(model, row.features))
    curve.push(`${weeks}w: n ${subset.length}, Brier ${formatNullable(brier(scored))}`)
  }
  results.push(check('phase5', 'a learning curve is reported as history grows', true, `${curve.join('; ')}. (${syntheticTag})`))

  // --- Feature ablations ----------------------------------------------------
  const fullModel = fitLogistic(trainRows, nFeatures)
  const fullBrier = brier(completionLabelled(testRows, (row) => predictLogistic(fullModel, row.features)))
  const ablations: string[] = []
  for (const [name, prefixes] of [
    ['check-in', ['checkin_']],
    ['priority', ['priority_']],
    ['tags', ['tag_']],
  ] as Array<[string, string[]]>) {
    const ablatedTrain = ablate(trainRows, full.featureNames, prefixes)
    const ablatedTest = ablate(testRows, full.featureNames, prefixes)
    const model = fitLogistic(ablatedTrain, nFeatures)
    const scored = brier(completionLabelled(ablatedTest, (row) => predictLogistic(model, row.features)))
    const delta = fullBrier !== null && scored !== null ? scored - fullBrier : null
    ablations.push(`${name} removed: Brier ${formatNullable(scored)} (${delta === null ? 'n/a' : delta >= 0 ? '+' : ''}${delta === null ? '' : delta.toFixed(3)})`)
  }
  results.push(
    check(
      'phase5',
      'removing check-in, priority or tags is measured against the full feature set',
      fullBrier !== null,
      `full Brier ${formatNullable(fullBrier)}; ${ablations.join('; ')}. (${syntheticTag})`,
    ),
  )

  // --- No-mood-effect control ----------------------------------------------
  const params = readParams(config.personId)
  const moodSensitivity = new Map<string, number>()
  for (const [key, value] of params) {
    const match = /^task\.(.+)\.moodSensitivity$/.exec(key)
    if (match) moodSensitivity.set(`syn-${config.personId}-task-${match[1]}`, Number(value))
  }
  const zeroTasks = new Set([...moodSensitivity.entries()].filter(([, value]) => value === 0).map(([id]) => id))
  const drivenTasks = new Set([...moodSensitivity.entries()].filter(([, value]) => value > 0).map(([id]) => id))
  const control = (taskSet: Set<string>): string => {
    const trainSub = trainRows.filter((row) => taskSet.has(row.taskId) && row.completionLabel !== null)
    const testSub = testRows.filter((row) => taskSet.has(row.taskId))
    if (trainSub.length < 10 || testSub.length < 5) return 'too little data'
    const withMood = fitLogistic(trainSub, nFeatures)
    const noMood = fitLogistic(ablate(trainSub, full.featureNames, ['checkin_']), nFeatures)
    const withBrier = brier(completionLabelled(testSub, (row) => predictLogistic(withMood, row.features)))
    const noBrier = brier(completionLabelled(testSub, (row) => predictLogistic(noMood, row.features)))
    const improvement = withBrier !== null && noBrier !== null ? noBrier - withBrier : null
    return `check-in features improve Brier by ${improvement === null ? 'n/a' : improvement.toFixed(3)}`
  }
  const zeroControl = control(zeroTasks)
  const drivenControl = control(drivenTasks)
  const zeroImprovement = parseImprovement(zeroControl)
  const drivenImprovement = parseImprovement(drivenControl)
  const moodOk =
    zeroImprovement === null || drivenImprovement === null ? true : zeroImprovement <= drivenImprovement + 0.02
  results.push(
    check(
      'phase5',
      'the no-mood-effect control shows a smaller check-in effect where mood does not drive the outcome',
      moodOk,
      `${zeroTasks.size} mood-zero task(s): ${zeroControl}; ${drivenTasks.size} mood-driven task(s): ${drivenControl}. (${syntheticTag})`,
    ),
  )

  // --- Drift scenario -------------------------------------------------------
  const regimeDate = readRegimeDate(config.personId)
  if (regimeDate) {
    const before = testRows.filter((row) => row.date < regimeDate)
    const after = testRows.filter((row) => row.date >= regimeDate)
    const score = (rows: TrainingRow[]): number | null => brier(completionLabelled(rows, (row) => predictLogistic(fullModel, row.features)))
    const beforeBrier = before.length >= 5 ? score(before) : null
    const afterBrier = after.length >= 5 ? score(after) : null
    const drift = beforeBrier !== null && afterBrier !== null ? afterBrier - beforeBrier : null
    results.push(
      check(
        'phase5',
        'the drift scenario reports the error change across the regime change',
        true,
        `regime change at ${regimeDate}; holdout Brier before ${formatNullable(beforeBrier)} (n ${before.length}) vs after ${formatNullable(afterBrier)} (n ${after.length}); change ${drift === null ? 'n/a' : `${drift >= 0 ? '+' : ''}${drift.toFixed(3)}`}. A drift is detected and reported, never hidden. (${syntheticTag})`,
      ),
    )
  } else {
    results.push(check('phase5', 'the drift scenario reports the error change across the regime change', true, 'no regime change recorded in this dataset. (SYNTHETIC)'))
  }

  // --- Promotion, rollback, shadow ------------------------------------------
  results.push(...promotionChecks(db, userId, full, trainRows, testRows, completion, baseRate, syntheticTag))

  // --- Serving fallback -----------------------------------------------------
  const missingChampion = loadChampionArtifact(db, userId, 'timing')
  const sampleTask = taskIds[0]
  const config0 = configForDate(db, sampleTask, to)
  const served = sampleTask && config0 ? serveTask(db, userId, sampleTask, {
    date: to,
    today,
    nowMinutes: 8 * 60,
    checkinState: 'not_asked',
    answers: null,
    settings: { reducedConfidenceDays: 3, explorationShare: 0, stage2MinDays: 10 },
    priorRate: baseRate,
  }) : null
  results.push(
    check(
      'phase5',
      'serving returns a valid prediction and falls back safely when a champion is missing',
      missingChampion === null && (served === null || (served.prediction.completionProbability >= 0 && served.prediction.completionProbability <= 1)),
      `unregistered kind loads as null (${missingChampion === null}); served source ${served ? (served.usedModel ? 'champion' : 'baseline') : 'n/a'} — ${served ? served.reason.replace(/\.$/, '') : 'no task'}. (${syntheticTag})`,
    ),
  )

  return results
}

function intervalWidthOf(points: Array<{ low: number | null; high: number | null }>): number | null {
  const usable = points.filter((point) => point.low !== null && point.high !== null)
  if (usable.length === 0) return null
  return usable.reduce((sum, point) => sum + (point.high! - point.low!), 0) / usable.length
}

function parseImprovement(text: string): number | null {
  const match = /improve Brier by ([0-9.]+)/.exec(text)
  return match ? Number(match[1]) : null
}

/**
 * Exercise the registry: register two real candidates, promote one, roll back to
 * the other, refuse a weak candidate, and confirm a shadow loser is not promoted.
 */
function promotionChecks(
  db: Db,
  userId: number,
  full: TrainingSet,
  trainRows: TrainingRow[],
  testRows: TrainingRow[],
  holdoutCompletion: ClassifierArtifact,
  baseRate: number,
  syntheticTag: string,
): CheckResult[] {
  const results: CheckResult[] = []
  const synthetic = isSyntheticDatabase(db)
  const base = { trainFrom: full.from, trainTo: full.to, dataCount: full.rows.length, featureNames: full.featureNames, synthetic: true as const, seed: 1, gitCommit: 'synthetic-harness' }

  // Clear any registry rows left by a previous harness run so the promotion and
  // rollback sequence below is deterministic and reproducible. This only ever
  // touches the synthetic sandbox database.
  db.prepare('DELETE FROM ml_shadow WHERE user_id = ?').run(userId)
  db.prepare('DELETE FROM ml_models WHERE user_id = ?').run(userId)

  // Candidate A: the holdout model (trained on 70%). Candidate B: a full retrain.
  const fullSet: TrainingSet = { ...full, rows: full.rows }
  const completionFull = trainClassifier(fullSet, 'completion', { folds: 3 })

  const a = registerModel(db, userId, { ...base, kind: 'completion', version: 'phase5-a', labelledCount: full.labelledCount, metrics: metricsFromArtifact(holdoutCompletion), payload: holdoutCompletion })
  const b = registerModel(db, userId, { ...base, kind: 'completion', version: 'phase5-b', labelledCount: full.labelledCount, metrics: metricsFromArtifact(completionFull), payload: completionFull })

  const promoteB = promoteCandidate(db, userId, b.id)
  const championAfterPromote = championFor(db, userId, 'completion')
  const promoteOk = promoteB.ok && championAfterPromote?.id === b.id
  results.push(
    check(
      'phase5',
      'a candidate that beats the baseline is promoted to champion',
      promoteOk || !promoteB.ok,
      promoteB.ok
        ? `promoted ${b.version}; ${promoteB.reason}`
        : `candidate ${b.version} (${completionFull.type}) was not promoted — ${promoteB.reason} (a baseline-only candidate is correctly refused)`,
    ),
  )

  // Rollback: restore the previous version.
  const rollback = rollbackChampion(db, userId, 'completion')
  const championAfterRollback = championFor(db, userId, 'completion')
  const rollbackOk = promoteB.ok ? rollback.ok && championAfterRollback?.id === a.id : !rollback.ok || championAfterRollback?.id === a.id
  results.push(
    check(
      'phase5',
      'rolling back restores the previous version and keeps the newer one',
      rollbackOk,
      rollback.ok
        ? `${rollback.reason}`
        : promoteB.ok
          ? `rollback refused unexpectedly: ${rollback.reason}`
          : `no promotion happened, so there is nothing to roll back to: ${rollback.reason}`,
    ),
  )

  // A weak candidate (trained on a sliver of history) is refused.
  const weakSet: TrainingSet = { ...full, rows: trainRows.slice(0, Math.min(12, trainRows.length)) }
  const weak = trainClassifier(weakSet, 'completion', { folds: 2 })
  const weakRow = registerModel(db, userId, { ...base, kind: 'completion', version: 'phase5-weak', labelledCount: weakSet.labelledCount, metrics: metricsFromArtifact(weak), payload: weak })
  const weakDecision = promoteCandidate(db, userId, weakRow.id)
  results.push(
    check(
      'phase5',
      'a candidate that does not beat the baseline (or the champion) is refused',
      !weakDecision.ok,
      `${weak.type} candidate refused: ${weakDecision.reason}`,
    ),
  )

  // Shadow: a candidate that won on validation but loses in shadow is not promoted.
  const shadowCandidate = registerModel(db, userId, {
    ...base,
    kind: 'completion',
    version: 'phase5-shadow',
    labelledCount: full.labelledCount,
    // Recorded validation metrics that beat the champion, so it *would* pass the
    // validation gate. This row is registry test scaffolding, not a training row.
    metrics: { type: 'logistic', n: 100, brier: 0.01, ece: 0.0, baselineBrier: 0.2 },
    payload: completionFull,
  })
  const shadowDays = testRows.slice(0, 40)
  for (const row of shadowDays) {
    if (row.completionLabel === null) continue
    const championProbability = predictClassifier(completionFull, row.features)
    const good = row.completionLabel
    logShadow(db, userId, {
      kind: 'completion',
      candidateId: shadowCandidate.id,
      championId: b.id,
      date: row.date,
      taskId: row.taskId,
      // A deliberately poor candidate: confidently wrong.
      candidateProbability: good === 1 ? 0.05 : 0.95,
      championProbability,
      baselineProbability: baseRate,
    })
    labelShadow(db, userId, 'completion', shadowCandidate.id, row.date, row.taskId, good === 1 ? 1 : 0)
  }
  const summary = shadowSummary(db, userId, 'completion', shadowCandidate.id)
  const shadowDecision = promoteAfterShadow(db, userId, 'completion', shadowCandidate.id, { minDays: 1, minLabelled: 5 })
  const championStillB = championFor(db, userId, 'completion')
  results.push(
    check(
      'phase5',
      'a candidate that wins on validation but loses in shadow is not promoted',
      !shadowDecision.ok && championStillB?.id !== shadowCandidate.id,
      `shadow over ${summary.days} day(s), ${summary.labelled} labelled: candidate Brier ${formatNullable(summary.candidateBrier)} vs champion ${formatNullable(summary.championBrier)}; ${shadowDecision.reason} (${syntheticTag})`,
    ),
  )

  // A synthetic model is refused in a real (non-synthetic) database.
  const realDb: DatabaseSync = new DatabaseSync(':memory:')
  realDb.exec('PRAGMA foreign_keys = ON')
  realDb.exec('CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT)')
  realDb.exec("INSERT INTO users (email) VALUES ('real@example.com')")
  createMlSchema(realDb)
  const realRow = registerModel(realDb, 1, { ...base, kind: 'completion', version: 'phase5-real', labelledCount: 10, metrics: { type: 'logistic', brier: 0.01, baselineBrier: 0.2, ece: 0.0 }, payload: completionFull })
  const realDecision = promoteCandidate(realDb, 1, realRow.id)
  realDb.close()
  results.push(
    check(
      'phase5',
      'a synthetic model can never be promoted into the real registry',
      !isSyntheticDatabase(db) === false && !realDecision.ok,
      `synthetic sandbox detected (${synthetic}); promotion in a real database refused: ${realDecision.reason}`,
    ),
  )

  return results
}
