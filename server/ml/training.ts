import { type Example } from './model/math'
import { trainLogistic, predictLogistic, type LogisticModel } from './model/logistic'
import { trainGbm, predictGbm, type GbmModel, type GbmOptions } from './model/gbm'
import { applyCalibrator, fitCalibrator, type Calibrator } from './calibration'
import {
  brier,
  calibrationError,
  confusion,
  logLoss,
  rocAuc,
  type Labelled,
} from './metrics'
import { MIN_ROWS_PER_FEATURE, type FeatureVocabulary } from './features'
import type { TrainingRow, TrainingSet } from './dataset'

export { MIN_ROWS_PER_FEATURE }

/**
 * Candidate training, chronological validation and calibration.
 *
 * The order of preference is fixed and simple: smoothed baseline → regularised
 * logistic → gradient boosting *only if it beats logistic* on the chronological
 * validation windows. Boosting searches a small, deterministic grid of tree
 * depths, leaf sizes and learning rates; XGBoost/CatBoost are never used because
 * they would add a toolchain and service the same sparse personal data no better.
 *
 * Splits are **chronological only** — expanding-window folds, never a random
 * split. Recent rows are weighted more, but older rows are kept. Calibration is
 * fitted on out-of-fold predictions and only when there is enough data; otherwise
 * it is skipped and the reason recorded. Below the minimum data thresholds no
 * model is trained at all and the baseline is used, with the limitation stated.
 */

export type ModelKind = 'completion'
export type ClassifierType = 'baseline' | 'logistic' | 'gbm'

export const MIN_COMPLETION_ROWS = 40
export const DEFAULT_FOLDS = 3
export const DEFAULT_VALID_FRACTION = 0.35
/** Gradient boosting must beat logistic by at least this much to be chosen. */
export const GBM_MARGIN = 0.005
/**
 * A deliberately small, reproducible hyperparameter grid. Each configuration
 * is scored on the same chronological folds; only the best boosted-tree
 * challenger is eligible to become the artifact.
 */
export const GBM_CONFIGS: readonly Required<GbmOptions>[] = [
  { nTrees: 48, learningRate: 0.07, maxDepth: 2, minSamplesLeaf: 24, l2: 4, maxBins: 24, featureRatio: 0.8, seed: 20261126 },
  { nTrees: 72, learningRate: 0.06, maxDepth: 3, minSamplesLeaf: 16, l2: 3, maxBins: 32, featureRatio: 0.85, seed: 20261126 },
  { nTrees: 96, learningRate: 0.04, maxDepth: 3, minSamplesLeaf: 12, l2: 2, maxBins: 40, featureRatio: 0.75, seed: 20261126 },
]
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

export interface ClassifierArtifact {
  kind: 'completion'
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

export type ModelArtifact = ClassifierArtifact

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

interface CandidateEvaluation {
  /** Stable internal name; the artifact type stays the simpler ClassifierType. */
  name: string
  type: ClassifierType
  gbmOptions: GbmOptions | null
  oof: Labelled[]
  calibrated: Labelled[]
  brier: number
}

function describeGbmOptions(options: GbmOptions): string {
  return `${options.nTrees} trees, depth ${options.maxDepth}, leaf ≥${options.minSamplesLeaf}, L2 ${options.l2}, ${options.featureRatio ?? 1} of features`
}

/**
 * Train a completion classifier, choosing among the baseline, logistic
 * regression and gradient boosting by chronological validation. Returns a
 * baseline artifact (never a fitted model) when there is not enough data.
 */
export function trainClassifier(set: TrainingSet, options: TrainOptions = {}): ClassifierArtifact {
  const nFeatures = set.featureNames.length
  const minRows = Math.max(MIN_COMPLETION_ROWS, nFeatures * MIN_ROWS_PER_FEATURE)
  const label = (row: TrainingRow) => row.completionLabel
  const rows = set.rows.filter((row) => label(row) !== null)
  const folds = options.folds ?? DEFAULT_FOLDS
  const validFraction = options.validFraction ?? DEFAULT_VALID_FRACTION

  const baseArtifact = (reason: string): ClassifierArtifact => ({
    kind: 'completion',
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
      `Only ${rows.length} labelled completion row(s); at least ${minRows} are needed before a model is trained. The smoothed baseline is used and no accuracy is claimed.`,
    )
  }
  const foldList = chronologicalFolds(rows, folds, validFraction)
  if (foldList.length === 0) {
    return baseArtifact('Not enough chronological data to hold out a validation window; the baseline is used.')
  }

  // Out-of-fold predictions for every candidate. Logistic is trained once per
  // fold; each boosted-tree setting is trained on the same rows so the search is
  // a fair chronological comparison rather than a random hyperparameter draw.
  const candidates: CandidateEvaluation[] = [
    { name: 'baseline', type: 'baseline', gbmOptions: null, oof: [], calibrated: [], brier: Number.POSITIVE_INFINITY },
    { name: 'logistic', type: 'logistic', gbmOptions: null, oof: [], calibrated: [], brier: Number.POSITIVE_INFINITY },
    ...GBM_CONFIGS.map((options, index) => ({
      name: `gbm-${index + 1}`,
      type: 'gbm' as const,
      gbmOptions: options,
      oof: [] as Labelled[],
      calibrated: [] as Labelled[],
      brier: Number.POSITIVE_INFINITY,
    })),
  ]
  for (const fold of foldList) {
    const trainRows = fold.train.map((i) => rows[i])
    const validRows = fold.valid.map((i) => rows[i])
    const examples = toExamples(trainRows, label)
    const baselineRate = weightedBaseRate(trainRows, label)
    const logistic = trainLogistic(examples, nFeatures, { lambda: 1, iterations: 400, learningRate: 0.5 })
    const boosted = GBM_CONFIGS.map((options) => trainGbm(examples, nFeatures, options))
    for (const row of validRows) {
      const y = label(row)!
      const entry = { y, w: row.weight }
      candidates[0].oof.push({ ...entry, p: baselineRate })
      candidates[1].oof.push({ ...entry, p: predictLogistic(logistic, row.features) })
      boosted.forEach((model, index) => candidates[index + 2].oof.push({ ...entry, p: predictGbm(model, row.features) }))
    }
  }

  // Chronological calibration. For every fold, fit a calibrator only on out-of-
  // fold rows from *earlier* folds, then apply it to this fold. A calibration
  // curve is therefore never scored on the rows that were used to fit it, and
  // the final fold is a genuine untouched window for calibration.
  for (const candidate of candidates) {
    let offset = 0
    const earlier: Labelled[] = []
    for (const fold of foldList) {
      const calibrator = fitCalibrator(earlier)
      const current = candidate.oof.slice(offset, offset + fold.valid.length)
      for (const row of current) candidate.calibrated.push({ ...row, p: applyCalibrator(calibrator, row.p) })
      earlier.push(...current)
      offset += current.length
    }
    candidate.brier = brier(candidate.calibrated) ?? Number.POSITIVE_INFINITY
  }

  // Choose on the calibrated scores users would actually see, not on raw ones.
  const [baseline, logisticCandidate] = candidates
  const boostedCandidates = candidates.slice(2)
  const bestBoosted = boostedCandidates.reduce((best, candidate) => (candidate.brier < best.brier ? candidate : best), boostedCandidates[0])
  const baselineBrier = baseline.brier
  const logisticBrier = logisticCandidate.brier

  let chosen = baseline
  let reason = `The smoothed baseline held its ground on chronological validation (Brier ${baselineBrier.toFixed(3)}); no model was better, so the baseline is kept.`
  if (logisticBrier < baselineBrier) {
    chosen = logisticCandidate
    reason = `Regularised logistic regression beat the baseline on chronological validation (Brier ${logisticBrier.toFixed(3)} vs ${baselineBrier.toFixed(3)}).`
  }
  if (bestBoosted.brier < Math.min(baselineBrier, logisticBrier) - GBM_MARGIN) {
    chosen = bestBoosted
    reason = `Gradient boosting (${describeGbmOptions(bestBoosted.gbmOptions!)}) beat both the baseline and logistic regression on chronological validation (Brier ${bestBoosted.brier.toFixed(3)} vs logistic ${logisticBrier.toFixed(3)}, baseline ${baselineBrier.toFixed(3)}).`
  }

  // The served calibrator is fitted only after the model type is fixed. It uses
  // all out-of-fold scores, which are honest model outputs, but validation
  // metrics above never reuse those fit rows.
  const calibrator = fitCalibrator(chosen.oof)

  // Final model, trained on every row, using the winning boosted-tree settings.
  const allExamples = toExamples(rows, label)
  const logisticFinal = chosen.type === 'logistic' ? trainLogistic(allExamples, nFeatures, { lambda: 1, iterations: 400, learningRate: 0.5 }) : null
  const gbmFinal = chosen.type === 'gbm' ? trainGbm(allExamples, nFeatures, chosen.gbmOptions ?? {}) : null
  const baselineRate = weightedBaseRate(rows, label)

  // Validation metrics use the chronologically calibrated out-of-fold scores.
  const validationLabelled: Labelled[] = chosen.calibrated
  const baselineLabelled: Labelled[] = baseline.calibrated

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
        const source = chosen.calibrated[cursor]
        ;(taskByFold[row.taskId] ??= []).push({ p: source.p, y: source.y, w: source.w })
        cursor += 1
      }
    }
  }
  for (const [taskId, labelled] of Object.entries(taskByFold)) {
    perTask[taskId] = metricsFrom(labelled)
  }

  return {
    kind: 'completion',
    type: chosen.type,
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

/**
 * Evaluate the learned timing profile against simple baselines. The
 * "completed after recommendation" classifier is optional; it is reported as
 * skipped unless the caller has the labelled recommendation data for it.
 */
export interface TimingEvaluation {
  taskId: string
  sessions: number
  adherence: number | null
  historicalFrequencyBaseline: number | null
  note: string
}

export function evaluateTimingProfile(
  taskId: string,
  sessionStarts: number[],
  peakBin: number | null,
  bins: number,
): TimingEvaluation {
  if (sessionStarts.length === 0 || peakBin === null) {
    return {
      taskId,
      sessions: sessionStarts.length,
      adherence: null,
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

  return {
    taskId,
    sessions: sessionStarts.length,
    adherence,
    historicalFrequencyBaseline,
    note:
      'Following a recommended time is influenced by being shown it, so adherence is reported beside the busiest-bin baseline rather than as an accuracy claim.',
  }
}
