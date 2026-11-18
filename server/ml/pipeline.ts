import type { DatabaseSync } from 'node:sqlite'
import { buildTrainingSet } from './dataset'
import {
  evaluateTimingProfile,
  trainClassifier,
  trainDuration,
  type ClassifierArtifact,
  type DurationArtifact,
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
import { TIMING_BINS, gatherTaskDays, preferredTimePrior, timingProfile, userTaskIds } from './statistics'
import { configForDate } from './task-config'
import type { FeatureVocabulary } from './features'

/**
 * Training orchestration (Phase 5, §2/§3/§4).
 *
 * One function ties the separate modules together for a single user: it builds
 * the chronological training set, trains each candidate, evaluates the timing
 * profile, and (optionally) registers the candidates in the registry and updates
 * the retrain bookkeeping. It holds no model logic of its own — everything is
 * delegated — so the pieces stay independent.
 *
 * Nothing here trains on real data unless it is given real data, and nothing
 * here fabricates rows: with too little data each trainer returns a baseline
 * artifact and says so.
 */

export interface TrainModelsOptions {
  taskIds?: string[]
  from?: string
  to?: string
  today?: string
  version?: string
  register?: boolean
  synthetic?: boolean
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
  targetCount: number
  durationCount: number
  vocabulary: FeatureVocabulary
  featureNames: string[]
  completion: ClassifierArtifact
  target: ClassifierArtifact
  duration: DurationArtifact
  timing: TimingEvaluation[]
  candidates: TrainedCandidate[]
  notes: string[]
}

function bounds(db: DatabaseSync, userId: number): { lo: string | null; hi: string | null } {
  return db
    .prepare('SELECT MIN(local_date) AS lo, MAX(local_date) AS hi FROM activity_sessions WHERE user_id = ?')
    .get(userId) as unknown as { lo: string | null; hi: string | null }
}

function preferredBin(preferredTime: string | null): number | null {
  const weights = preferredTimePrior(preferredTime)
  if (!weights) return null
  let best = 0
  for (let i = 1; i < weights.length; i += 1) if (weights[i] > weights[best]) best = i
  return best
}

/** Train every candidate model for one user. */
export function trainUserModels(db: DatabaseSync, userId: number, options: TrainModelsOptions = {}): TrainModelsResult {
  const taskIds = options.taskIds ?? userTaskIds(db, userId)
  const span = bounds(db, userId)
  const from = options.from ?? span.lo ?? options.today ?? '1970-01-01'
  const to = options.to ?? span.hi ?? from
  const today = options.today ?? to
  const version = options.version ?? `phase5-${to}`
  const register = options.register ?? true
  const synthetic = options.synthetic ?? false
  const notes: string[] = []

  const set = buildTrainingSet(db, userId, taskIds, from, to, today, {
    priorRate: undefined,
    recentHalfLifeDays: undefined,
  })

  const completion = trainClassifier(set, 'completion', { folds: options.folds, validFraction: options.validFraction })
  const target = trainClassifier(set, 'target', { folds: options.folds, validFraction: options.validFraction })
  const duration = trainDuration(set, { folds: options.folds, validFraction: options.validFraction })

  // Timing profile: evaluate the learned peak against simple baselines per task.
  const timing: TimingEvaluation[] = []
  for (const taskId of taskIds) {
    const days = gatherTaskDays(db, userId, taskId, from, to, today)
    const starts = days.filter((day) => !day.offDay && day.performed === true).flatMap((day) => day.sessionStarts)
    const profile = timingProfile(starts)
    const config = configForDate(db, taskId, to)
    timing.push(evaluateTimingProfile(taskId, starts, profile.peakBin, TIMING_BINS, preferredBin(config?.preferred_time ?? null)))
  }

  const candidates: TrainedCandidate[] = []
  const registerOne = (kind: ModelKind, artifact: ClassifierArtifact | DurationArtifact, labelledCount: number): void => {
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
        hyperparams:
          artifact.kind === 'duration'
            ? { type: artifact.type }
            : { type: artifact.type, lambda: 1, iterations: 400, learningRate: 0.5, gbmTrees: 60 },
        seed: options.seed ?? 0,
        metrics,
        gitCommit: options.gitCommit ?? null,
        payload: artifact,
        notes: artifact.reason,
        synthetic,
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
  registerOne('target', target, set.targetCount)
  registerOne('duration', duration, set.durationCount)

  if (register) {
    markTrained(db, userId, 'completion', set.labelledCount)
    markTrained(db, userId, 'target', set.targetCount)
    markTrained(db, userId, 'duration', set.durationCount)
  }

  if (completion.smallData) notes.push(`Completion: ${completion.reason}`)
  if (target.smallData) notes.push(`Target: ${target.reason}`)
  if (duration.smallData) notes.push(`Duration: ${duration.reason}`)

  return {
    userId,
    from,
    to,
    today,
    monthsOfData: set.monthsOfData,
    rows: set.rows.length,
    labelledCount: set.labelledCount,
    targetCount: set.targetCount,
    durationCount: set.durationCount,
    vocabulary: set.vocabulary,
    featureNames: set.featureNames,
    completion,
    target,
    duration,
    timing,
    candidates,
    notes,
  }
}
