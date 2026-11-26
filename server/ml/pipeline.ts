import type { DatabaseSync } from 'node:sqlite'
import { buildTrainingSet } from './dataset'
import {
  evaluateTimingProfile,
  trainClassifier,
  type ClassifierArtifact,
  type ModelKind,
  type TimingEvaluation,
} from './training'
import {
  markTrained,
  metricsFromArtifact,
  registerModel,
  type RegistryMetrics,
  type StoredModelRow,
} from './registry'
import { TIMING_BINS, gatherTaskDays, timingProfile, userTaskIds } from './statistics'
import type { FeatureVocabulary } from './features'

/**
 * Training orchestration.
 *
 * One function ties the separate modules together for a single user: it builds
 * the chronological training set, trains the completion candidate, evaluates
 * the timing profile, and (optionally) registers the candidate in the registry
 * and updates the retrain bookkeeping. It holds no model logic of its own —
 * everything is delegated — so the pieces stay independent.
 *
 * Nothing here trains on real data unless it is given real data, and nothing
 * here fabricates rows: with too little data the trainer returns a baseline
 * artifact and says so.
 */

export interface TrainModelsOptions {
  taskIds?: string[]
  from?: string
  to?: string
  today?: string
  version?: string
  register?: boolean
  gitCommit?: string | null
  seed?: number
  folds?: number
  validFraction?: number
}

export interface TrainedCandidate {
  kind: ModelKind
  version: string
  id: number | null
  chosenType: string
  smallData: boolean
  reason: string
  metrics: RegistryMetrics
}

export interface TrainModelsResult {
  userId: number
  from: string
  to: string
  today: string
  monthsOfData: number
  rows: number
  labelledCount: number
  vocabulary: FeatureVocabulary
  featureNames: string[]
  completion: ClassifierArtifact
  timing: TimingEvaluation[]
  candidates: TrainedCandidate[]
  notes: string[]
}

function bounds(db: DatabaseSync, userId: number): { lo: string | null; hi: string | null } {
  return db
    .prepare('SELECT MIN(local_date) AS lo, MAX(local_date) AS hi FROM activity_sessions WHERE user_id = ?')
    .get(userId) as unknown as { lo: string | null; hi: string | null }
}

/** Record the hyperparameters of the artifact actually chosen, not a guess. */
function hyperparamsFromArtifact(artifact: ClassifierArtifact): Record<string, unknown> {
  const out: Record<string, unknown> = { type: artifact.type }
  if (artifact.logistic) {
    out.lambda = artifact.logistic.lambda
    out.iterations = artifact.logistic.iterations
    out.learningRate = artifact.logistic.learningRate
  }
  if (artifact.gbm) {
    out.nTrees = artifact.gbm.nTrees
    out.learningRate = artifact.gbm.learningRate
    out.maxDepth = artifact.gbm.maxDepth
    out.minSamplesLeaf = artifact.gbm.minSamplesLeaf
    out.l2 = artifact.gbm.l2
    out.maxBins = artifact.gbm.maxBins
    out.featureRatio = artifact.gbm.featureRatio
    out.seed = artifact.gbm.seed
  }
  return out
}

/** Train every candidate model for one user. */
export function trainUserModels(db: DatabaseSync, userId: number, options: TrainModelsOptions = {}): TrainModelsResult {
  const taskIds = options.taskIds ?? userTaskIds(db, userId)
  const span = bounds(db, userId)
  const from = options.from ?? span.lo ?? options.today ?? '1970-01-01'
  const to = options.to ?? span.hi ?? from
  const today = options.today ?? to
  const version = options.version ?? `model-${to}`
  const register = options.register ?? true
  const notes: string[] = []

  const set = buildTrainingSet(db, userId, taskIds, from, to, today, {
    priorRate: undefined,
    recentHalfLifeDays: undefined,
  })

  const completion = trainClassifier(set, { folds: options.folds, validFraction: options.validFraction })

  // Timing profile: evaluate the learned peak against simple baselines per task.
  const timing: TimingEvaluation[] = []
  for (const taskId of taskIds) {
    const days = gatherTaskDays(db, userId, taskId, from, to, today)
    const starts = days.filter((day) => !day.offDay && day.performed === true).flatMap((day) => day.sessionStarts)
    const profile = timingProfile(starts)
    timing.push(evaluateTimingProfile(taskId, starts, profile.peakBin, TIMING_BINS))
  }

  const candidates: TrainedCandidate[] = []
  const registerOne = (kind: ModelKind, artifact: ClassifierArtifact, labelledCount: number): void => {
    const metrics = metricsFromArtifact(artifact)
    let id: number | null = null
    if (register) {
      const row: StoredModelRow = registerModel(db, userId, {
        kind,
        version,
        trainFrom: from,
        trainTo: to,
        dataCount: set.rows.length,
        labelledCount,
        featureNames: set.featureNames,
        hyperparams: hyperparamsFromArtifact(artifact),
        seed: options.seed ?? 0,
        metrics,
        gitCommit: options.gitCommit ?? null,
        payload: artifact,
        notes: artifact.reason,
      })
      id = row.id
    }
    candidates.push({
      kind,
      version,
      id,
      chosenType: artifact.type,
      smallData: artifact.smallData,
      reason: artifact.reason,
      metrics,
    })
  }

  registerOne('completion', completion, set.labelledCount)

  if (register) {
    markTrained(db, userId, 'completion', set.labelledCount)
  }

  if (completion.smallData) notes.push(`Completion: ${completion.reason}`)

  return {
    userId,
    from,
    to,
    today,
    monthsOfData: set.monthsOfData,
    rows: set.rows.length,
    labelledCount: set.labelledCount,
    vocabulary: set.vocabulary,
    featureNames: set.featureNames,
    completion,
    timing,
    candidates,
    notes,
  }
}
