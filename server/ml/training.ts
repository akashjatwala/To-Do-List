import { type Example } from './model/math'
import { trainLogistic, predictLogistic, type LogisticModel } from './model/logistic'
import { trainGbm, predictGbm, type GbmModel } from './model/gbm'
import { trainLinearQuantile, predictQuantile, type LinearQuantileModel } from './model/quantile'
import { applyCalibrator, fitCalibrator, type Calibrator } from './calibration'
import {
  brier,
  calibrationError,
  confusion,
  intervalCoverage,
  intervalWidth,
  logLoss,
  mae,
  rmse,
  rocAuc,
  type Labelled,
} from './metrics'
import { MIN_ROWS_PER_FEATURE, type FeatureVocabulary } from './features'
import type { TrainingRow, TrainingSet } from './dataset'

export { MIN_ROWS_PER_FEATURE }

/**
 * Candidate training, chronological validation and calibration.
 *
 * The order of preference is fixed and simple:
 * - **Completion / target achievement**: smoothed baseline → regularised
 *   logistic → gradient boosting *only if it beats logistic* on the chronological
 *   validation windows. XGBoost/CatBoost are never used; the data does not
 *   justify them.
 * - **Duration**: median baseline → linear quantile regression. Boosted quantiles
 *   are left out on purpose.
 *
 * Splits are **chronological only** — expanding-window folds, never a random
 * split. Recent rows are weighted more, but older rows are kept. Calibration is
 * fitted on out-of-fold predictions and only when there is enough data; otherwise
 * it is skipped and the reason recorded. Below the minimum data thresholds no
 * model is trained at all and the baseline is used, with the limitation stated.
 */

export type ModelKind = 'completion' | 'target' | 'duration' | 'timing'
export type ClassifierType = 'baseline' | 'logistic' | 'gbm'
export type DurationType = 'median' | 'quantile'

export const MIN_COMPLETION_ROWS = 40
export const MIN_TARGET_ROWS = 40
export const MIN_DURATION_ROWS = 20
export const DEFAULT_FOLDS = 3
export const DEFAULT_VALID_FRACTION = 0.35
/** Gradient boosting must beat logistic by at least this much to be chosen. */
export const GBM_MARGIN = 0.005
/** The largest expected calibration error a model may show and still be trusted. */
export const MAX_ECE = 0.12
export const DECISION_THRESHOLD = 0.5

export interface ClassifierMetrics {
  n: number
  positives: number
  brier: number | null
  logLoss: number | null
  rocAuc: number | null
  precision: number | null
  recall: number | null
  f1: number | null
  accuracy: number | null
  ece: number | null
  baseRate: number
}

export interface DurationMetrics {
  n: number
  mae: number | null
  rmse: number | null
  coverage: number | null
  intervalWidth: number | null
  baselineMae: number | null
}

export interface ClassifierArtifact {
  kind: 'completion' | 'target'
  type: ClassifierType
  featureNames: string[]
  vocabulary: FeatureVocabulary
  /** Local minutes-of-day the model was trained at; serving must snap to these. */
  predictionMinutes: number[]
  logistic: LogisticModel | null
  gbm: GbmModel | null
  calibrator: Calibrator
  baselineRate: number
  metrics: {
    validation: ClassifierMetrics
    baseline: ClassifierMetrics
    perTask: Record<string, ClassifierMetrics>
    folds: number
  }
  smallData: boolean
  reason: string
}

export interface DurationArtifact {
  kind: 'duration'
  type: DurationType
  featureNames: string[]
  vocabulary: FeatureVocabulary
  /** Local minutes-of-day the model was trained at; serving must snap to these. */
  predictionMinutes: number[]
  median: number
  q10: LinearQuantileModel | null
  q50: LinearQuantileModel | null
  q90: LinearQuantileModel | null
  metrics: DurationMetrics
  smallData: boolean
  reason: string
}

export type ModelArtifact = ClassifierArtifact | DurationArtifact

export interface TrainOptions {
  folds?: number
  validFraction?: number
  seed?: number
}

interface Fold {
  train: number[]
  valid: number[]
}

function range(start: number, end: number): number[] {
  const out: number[] = []
  for (let i = start; i < end; i += 1) out.push(i)
  return out
}

/**
 * Expanding-window folds over chronological rows. Boundaries are snapped to
 * date edges: every (task, prediction-time) row for a given date lands in the
 * same fold, so a shared day cannot leak between training and validation. The
 * last fold ends at `n`.
 */
export function chronologicalFolds(rows: TrainingRow[], folds: number, validFraction: number): Fold[] {
  const n = rows.length
  if (n < 10) return []
  const validTotal = Math.min(n - 1, Math.max(folds * 5, Math.ceil(n * validFraction)))
  const start = n - validTotal
  const foldSize = Math.max(1, Math.floor(validTotal / folds))
  const dateStarts: number[] = []
  for (let i = 0; i < n; i += 1) {
    if (i === 0 || rows[i].date !== rows[i - 1].date) dateStarts.push(i)
  }
  const alignToDate = (index: number): number => {
    for (const dateStart of dateStarts) if (dateStart >= index) return dateStart
    return n
  }
  const out: Fold[] = []
  for (let k = 0; k < folds; k += 1) {
    const validStart = alignToDate(start + k * foldSize)
    const validEnd = k === folds - 1 ? n : alignToDate(start + (k + 1) * foldSize)
    if (validEnd - validStart < 1) continue
    const train = range(0, validStart)
    if (train.length < 5) continue
    out.push({ train, valid: range(validStart, validEnd) })
  }
  return out
}

function weightedBaseRate(rows: TrainingRow[], label: (row: TrainingRow) => number | null): number {
  let weightSum = 0
  let positive = 0
  for (const row of rows) {
    const y = label(row)
    if (y === null) continue
    weightSum += row.weight
    positive += row.weight * y
  }
  return weightSum > 0 ? positive / weightSum : 0.5
}

function toExamples(rows: TrainingRow[], label: (row: TrainingRow) => number | null): Example[] {
  const out: Example[] = []
  for (const row of rows) {
    const y = label(row)
    if (y === null) continue
    out.push({ x: row.features, y, w: row.weight })
  }
  return out
}

function metricsFrom(labelled: Labelled[]): ClassifierMetrics {
  const positives = labelled.filter((row) => row.y === 1).length
  const baseRate = labelled.length > 0 ? positives / labelled.length : 0
  const conf = confusion(labelled, DECISION_THRESHOLD)
  return {
    n: labelled.length,
    positives,
    brier: brier(labelled),
    logLoss: logLoss(labelled),
    rocAuc: rocAuc(labelled),
    precision: conf.precision,
    recall: conf.recall,
    f1: conf.f1,
    accuracy: conf.accuracy,
    ece: calibrationError(labelled),
    baseRate,
  }
}

function rawClassifierPredict(type: ClassifierType, logistic: LogisticModel | null, gbm: GbmModel | null, baseline: number, features: number[]): number {
  if (type === 'baseline') return baseline
  if (type === 'logistic') return predictLogistic(logistic!, features)
  return predictGbm(gbm!, features)
}

/**
 * Train a completion or target-achievement classifier, choosing among the
 * baseline, logistic regression and gradient boosting by chronological
 * validation. Returns a baseline artifact (never a fitted model) when there is
 * not enough data.
 */
export function trainClassifier(set: TrainingSet, kind: 'completion' | 'target', options: TrainOptions = {}): ClassifierArtifact {
  const nFeatures = set.featureNames.length
  const minRows = Math.max(kind === 'completion' ? MIN_COMPLETION_ROWS : MIN_TARGET_ROWS, nFeatures * MIN_ROWS_PER_FEATURE)
  const label = kind === 'completion' ? (row: TrainingRow) => row.completionLabel : (row: TrainingRow) => row.targetLabel
  const rows = set.rows.filter((row) => label(row) !== null)
  const folds = options.folds ?? DEFAULT_FOLDS
  const validFraction = options.validFraction ?? DEFAULT_VALID_FRACTION

  const baseArtifact = (reason: string): ClassifierArtifact => ({
    kind,
    type: 'baseline',
    featureNames: set.featureNames,
    vocabulary: set.vocabulary,
    predictionMinutes: set.predictionMinutes,
    logistic: null,
    gbm: null,
    calibrator: { kind: 'none', a: 1, b: 0, thresholds: [], values: [], samples: 0, reason: 'No model trained.' },
    baselineRate: weightedBaseRate(rows, label),
    metrics: {
      validation: metricsFrom([]),
      baseline: metricsFrom([]),
      perTask: {},
      folds: 0,
    },
    smallData: true,
    reason,
  })

  if (rows.length < minRows) {
    return baseArtifact(
      `Only ${rows.length} labelled ${kind} row(s); at least ${minRows} are needed before a model is trained. The smoothed baseline is used and no accuracy is claimed.`,
    )
  }
  const foldList = chronologicalFolds(rows, folds, validFraction)
  if (foldList.length === 0) {
    return baseArtifact('Not enough chronological data to hold out a validation window; the baseline is used.')
  }

  // Out-of-fold predictions for each candidate.
  const oof: Record<ClassifierType, Labelled[]> = { baseline: [], logistic: [], gbm: [] }
  for (const fold of foldList) {
    const trainRows = fold.train.map((i) => rows[i])
    const validRows = fold.valid.map((i) => rows[i])
    const examples = toExamples(trainRows, label)
    const baselineRate = weightedBaseRate(trainRows, label)
    const logistic = trainLogistic(examples, nFeatures, { lambda: 1, iterations: 400, learningRate: 0.5 })
    const gbm = trainGbm(examples, nFeatures, {})
    for (const row of validRows) {
      const y = label(row)!
      oof.baseline.push({ p: baselineRate, y, w: row.weight })
      oof.logistic.push({ p: predictLogistic(logistic, row.features), y, w: row.weight })
      oof.gbm.push({ p: predictGbm(gbm, row.features), y, w: row.weight })
    }
  }

  // Chronological calibration. For every fold, fit a calibrator only on out-of-
  // fold rows from *earlier* folds, then apply it to this fold. A calibration
  // curve is therefore never scored on the rows that were used to fit it, and
  // the final fold is a genuine untouched window for calibration.
  const calibratedOof: Record<ClassifierType, Labelled[]> = { baseline: [], logistic: [], gbm: [] }
  const candidateTypes: ClassifierType[] = ['baseline', 'logistic', 'gbm']
  for (const type of candidateTypes) {
    let offset = 0
    const earlier: Labelled[] = []
    for (const fold of foldList) {
      const calibrator = fitCalibrator(earlier)
      const current = oof[type].slice(offset, offset + fold.valid.length)
      for (const row of current) calibratedOof[type].push({ ...row, p: applyCalibrator(calibrator, row.p) })
      earlier.push(...current)
      offset += current.length
    }
  }

  // Choose on the calibrated scores users would actually see, not on raw ones.
  const brierOf = (candidate: ClassifierType): number => brier(calibratedOof[candidate]) ?? Number.POSITIVE_INFINITY
  const baselineBrier = brierOf('baseline')
  const logisticBrier = brierOf('logistic')
  const gbmBrier = brierOf('gbm')

  let chosen: ClassifierType = 'baseline'
  let reason = `The smoothed baseline held its ground on chronological validation (Brier ${baselineBrier.toFixed(3)}); no model was better, so the baseline is kept.`
  if (logisticBrier < baselineBrier) {
    chosen = 'logistic'
    reason = `Regularised logistic regression beat the baseline on chronological validation (Brier ${logisticBrier.toFixed(3)} vs ${baselineBrier.toFixed(3)}).`
  }
  if (gbmBrier < Math.min(baselineBrier, logisticBrier) - GBM_MARGIN) {
    chosen = 'gbm'
    reason = `Gradient boosting beat both the baseline and logistic regression on chronological validation (Brier ${gbmBrier.toFixed(3)} vs logistic ${logisticBrier.toFixed(3)}, baseline ${baselineBrier.toFixed(3)}).`
  }

  // The served calibrator is fitted only after the model type is fixed. It uses
  // all out-of-fold scores, which are honest model outputs, but validation
  // metrics above never reuse those fit rows.
  const calibrator = fitCalibrator(oof[chosen])

  // Final model, trained on every row.
  const allExamples = toExamples(rows, label)
  const logisticFinal = chosen === 'logistic' ? trainLogistic(allExamples, nFeatures, { lambda: 1, iterations: 400, learningRate: 0.5 }) : null
  const gbmFinal = chosen === 'gbm' ? trainGbm(allExamples, nFeatures, {}) : null
  const baselineRate = weightedBaseRate(rows, label)

  // Validation metrics use the chronologically calibrated out-of-fold scores.
  const validationLabelled: Labelled[] = calibratedOof[chosen]
  const baselineLabelled: Labelled[] = calibratedOof.baseline

  // Per-task metrics from the pooled out-of-fold rows, tracked alongside. The
  // out-of-fold predictions were pushed fold by fold, so a cursor over the same
  // iteration order lines each one back up with its row.
  const perTask: Record<string, ClassifierMetrics> = {}
  const taskByFold: Record<string, Labelled[]> = {}
  {
    let cursor = 0
    for (const fold of foldList) {
      for (const i of fold.valid) {
        const row = rows[i]
        const source = calibratedOof[chosen][cursor]
        ;(taskByFold[row.taskId] ??= []).push({ p: source.p, y: source.y, w: source.w })
        cursor += 1
      }
    }
  }
  for (const [taskId, labelled] of Object.entries(taskByFold)) {
    perTask[taskId] = metricsFrom(labelled)
  }

  return {
    kind,
    type: chosen,
    featureNames: set.featureNames,
    vocabulary: set.vocabulary,
    predictionMinutes: set.predictionMinutes,
    logistic: logisticFinal,
    gbm: gbmFinal,
    calibrator,
    baselineRate,
    metrics: {
      validation: metricsFrom(validationLabelled),
      baseline: metricsFrom(baselineLabelled),
      perTask,
      folds: foldList.length,
    },
    smallData: false,
    reason,
  }
}

/** Predict a calibrated probability from a trained classifier artifact. */
export function predictClassifier(artifact: ClassifierArtifact, features: number[]): number {
  const raw = rawClassifierPredict(artifact.type, artifact.logistic, artifact.gbm, artifact.baselineRate, features)
  const calibrated = applyCalibrator(artifact.calibrator, raw)
  return Math.max(0, Math.min(1, calibrated))
}

/** Weighted median of a numeric series. */
export function weightedMedian(points: Array<{ value: number; weight: number }>): number {
  const sorted = [...points].sort((a, b) => a.value - b.value)
  let total = 0
  for (const point of sorted) total += point.weight
  let running = 0
  for (const point of sorted) {
    running += point.weight
    if (running >= total / 2) return point.value
  }
  return sorted.length > 0 ? sorted[sorted.length - 1].value : 0
}

/**
 * Train the duration model: a weighted median baseline, then a linear quantile
 * fit used only if it beats the baseline on chronological validation.
 */
export function trainDuration(set: TrainingSet, options: TrainOptions = {}): DurationArtifact {
  const rows = set.rows.filter((row) => row.duration !== null)
  const nFeatures = set.featureNames.length
  const minRows = Math.max(MIN_DURATION_ROWS, nFeatures * MIN_ROWS_PER_FEATURE)
  const folds = options.folds ?? DEFAULT_FOLDS
  const validFraction = options.validFraction ?? DEFAULT_VALID_FRACTION

  const baseArtifact = (reason: string): DurationArtifact => ({
    kind: 'duration',
    type: 'median',
    featureNames: set.featureNames,
    vocabulary: set.vocabulary,
    predictionMinutes: set.predictionMinutes,
    median: weightedMedian(rows.map((row) => ({ value: row.duration!, weight: row.weight }))),
    q10: null,
    q50: null,
    q90: null,
    metrics: { n: 0, mae: null, rmse: null, coverage: null, intervalWidth: null, baselineMae: null },
    smallData: true,
    reason,
  })

  if (rows.length < minRows) {
    return baseArtifact(
      `Only ${rows.length} completed-day duration(s); at least ${minRows} are needed. The median baseline is used and no interval is claimed.`,
    )
  }
  const foldList = chronologicalFolds(rows, folds, validFraction)
  if (foldList.length === 0) {
    return baseArtifact('Not enough chronological data to validate a duration model; the median baseline is used.')
  }

  const baselinePoints: Array<{ predicted: number; actual: number; w: number }> = []
  const quantilePoints: Array<{ predicted: number; actual: number; low: number; high: number; w: number }> = []
  for (const fold of foldList) {
    const trainRows = fold.train.map((i) => rows[i])
    const validRows = fold.valid.map((i) => rows[i])
    const examples: Example[] = trainRows.map((row) => ({ x: row.features, y: row.duration!, w: row.weight }))
    const median = weightedMedian(trainRows.map((row) => ({ value: row.duration!, weight: row.weight })))
    const q10 = trainLinearQuantile(examples, nFeatures, 0.1)
    const q50 = trainLinearQuantile(examples, nFeatures, 0.5)
    const q90 = trainLinearQuantile(examples, nFeatures, 0.9)
    for (const row of validRows) {
      const actual = row.duration!
      baselinePoints.push({ predicted: median, actual, w: row.weight })
      const point = Math.max(0, predictQuantile(q50, row.features))
      const low = Math.max(0, Math.min(point, predictQuantile(q10, row.features)))
      const high = Math.max(point, predictQuantile(q90, row.features))
      quantilePoints.push({ predicted: point, actual, low, high, w: row.weight })
    }
  }

  const baselineMae = mae(baselinePoints) ?? Number.POSITIVE_INFINITY
  const quantileMae = mae(quantilePoints) ?? Number.POSITIVE_INFINITY
  const useQuantile = quantileMae < baselineMae

  const median = weightedMedian(rows.map((row) => ({ value: row.duration!, weight: row.weight })))
  const allExamples: Example[] = rows.map((row) => ({ x: row.features, y: row.duration!, w: row.weight }))
  const q10 = useQuantile ? trainLinearQuantile(allExamples, nFeatures, 0.1) : null
  const q50 = useQuantile ? trainLinearQuantile(allExamples, nFeatures, 0.5) : null
  const q90 = useQuantile ? trainLinearQuantile(allExamples, nFeatures, 0.9) : null

  const points = useQuantile ? quantilePoints : baselinePoints
  const metrics: DurationMetrics = {
    n: points.length,
    mae: mae(points),
    rmse: rmse(points),
    coverage: useQuantile ? intervalCoverage(quantilePoints) : null,
    intervalWidth: useQuantile ? intervalWidth(quantilePoints) : null,
    baselineMae: mae(baselinePoints),
  }

  return {
    kind: 'duration',
    type: useQuantile ? 'quantile' : 'median',
    featureNames: set.featureNames,
    vocabulary: set.vocabulary,
    predictionMinutes: set.predictionMinutes,
    median,
    q10,
    q50,
    q90,
    metrics,
    smallData: false,
    reason: useQuantile
      ? `Linear quantile regression beat the median baseline on chronological validation (MAE ${quantileMae.toFixed(1)} vs ${baselineMae.toFixed(1)}).`
      : `The median baseline held up on chronological validation (MAE ${baselineMae.toFixed(1)}); the quantile fit was not better, so the baseline is kept.`,
  }
}

/** Point estimate and interval from a duration artifact. */
export function predictDuration(artifact: DurationArtifact, features: number[]): { point: number; low: number | null; high: number | null } {
  if (artifact.type === 'quantile' && artifact.q50) {
    const point = Math.max(0, predictQuantile(artifact.q50, features))
    const low = artifact.q10 ? Math.max(0, Math.min(point, predictQuantile(artifact.q10, features))) : null
    const high = artifact.q90 ? Math.max(point, predictQuantile(artifact.q90, features)) : null
    return { point, low, high }
  }
  return { point: artifact.median, low: null, high: null }
}

/**
 * Evaluate the learned timing profile against simple baselines. The
 * "completed after recommendation" classifier is optional; it is reported as
 * skipped unless the caller has the labelled recommendation data for it.
 */
export interface TimingEvaluation {
  taskId: string
  sessions: number
  adherence: number | null
  preferredTimeBaseline: number | null
  historicalFrequencyBaseline: number | null
  note: string
}

export function evaluateTimingProfile(
  taskId: string,
  sessionStarts: number[],
  peakBin: number | null,
  bins: number,
  preferredTimeBin: number | null,
): TimingEvaluation {
  if (sessionStarts.length === 0 || peakBin === null) {
    return {
      taskId,
      sessions: sessionStarts.length,
      adherence: null,
      preferredTimeBaseline: null,
      historicalFrequencyBaseline: null,
      note: 'No completed sessions yet, so the timing profile cannot be evaluated.',
    }
  }
  const binMinutes = 1440 / bins
  const binOf = (minute: number) => Math.max(0, Math.min(bins - 1, Math.floor(minute / binMinutes)))
  const inBin = (bin: number) => sessionStarts.filter((minute) => binOf(minute) === bin).length
  const adherence = inBin(peakBin) / sessionStarts.length

  // Historical-frequency baseline: always recommend the busiest bin seen so far.
  const counts = new Array<number>(bins).fill(0)
  for (const minute of sessionStarts) counts[binOf(minute)] += 1
  const busiest = counts.indexOf(Math.max(...counts))
  const historicalFrequencyBaseline = counts[busiest] / sessionStarts.length

  const preferredTimeBaseline = preferredTimeBin === null ? null : inBin(preferredTimeBin) / sessionStarts.length
  return {
    taskId,
    sessions: sessionStarts.length,
    adherence,
    preferredTimeBaseline,
    historicalFrequencyBaseline,
    note:
      'Following a recommended time is influenced by being shown it, so adherence is reported beside the preferred-time and busiest-bin baselines rather than as an accuracy claim.',
  }
}
