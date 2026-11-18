import type { DatabaseSync } from 'node:sqlite'
import type { ModelArtifact, ModelKind } from './training'
import { MAX_ECE } from './training'

/**
 * Model registry, promotion, rollback and retraining gates.
 *
 * This module is the only thing that decides what is served. The rules it
 * enforces, in code:
 *
 * - A trained model is stored as an append-only, versioned row with its full
 *   metadata: training date range, data counts, feature list, hyperparameters,
 *   seed, metrics and git commit, plus the serialised payload. Older versions are
 *   never overwritten, so any of them can be restored.
 * - Only one **champion** per (user, kind) is ever served. Promoting a candidate
 *   retires the old champion; it does not delete it.
 * - A candidate is promoted only when it beats both the baseline and the current
 *   champion on chronological validation **and** passes the reliability gate
 *   (calibration). Otherwise it is kept, or rejected, with the reason recorded.
 * - Retraining happens only once enough new labelled observations have
 *   accumulated, tracked in `ml_retrain_state`.
 *
 * Nothing here writes an observation, and nothing here treats a prediction as an
 * outcome.
 */

export type ModelStatus = 'candidate' | 'champion' | 'retired' | 'rejected'

export interface StoredModelRow {
  id: number
  user_id: number
  kind: ModelKind
  version: string
  status: ModelStatus
  train_from: string
  train_to: string
  data_count: number
  labelled_count: number
  feature_names: string
  hyperparams: string | null
  seed: number
  metrics: string | null
  git_commit: string | null
  payload: string | null
  notes: string | null
  created_at: number
  updated_at: number
}

/** The metadata recorded with every model. */
export interface RegistryMetrics {
  /** The candidate type actually chosen ('baseline' | 'logistic' | 'gbm' | 'median' | 'quantile' | ...). */
  type: string
  n?: number
  brier?: number | null
  ece?: number | null
  rocAuc?: number | null
  baselineBrier?: number | null
  mae?: number | null
  baselineMae?: number | null
}

export interface RegisterModelInput {
  kind: ModelKind
  version: string
  trainFrom: string
  trainTo: string
  dataCount: number
  labelledCount: number
  featureNames: string[]
  hyperparams?: unknown
  seed?: number
  metrics?: RegistryMetrics | null
  gitCommit?: string | null
  payload?: unknown
  notes?: string | null
}

/** Extract the small, comparable metric set the promotion gate reads. */
export function metricsFromArtifact(artifact: ModelArtifact): RegistryMetrics {
  if (artifact.kind === 'duration') {
    return {
      type: artifact.type,
      n: artifact.metrics.n,
      mae: artifact.metrics.mae,
      baselineMae: artifact.metrics.baselineMae,
    }
  }
  return {
    type: artifact.type,
    n: artifact.metrics.validation.n,
    brier: artifact.metrics.validation.brier,
    ece: artifact.metrics.validation.ece,
    rocAuc: artifact.metrics.validation.rocAuc,
    baselineBrier: artifact.metrics.baseline.brier,
  }
}

function parseMetrics(row: StoredModelRow): RegistryMetrics | null {
  if (!row.metrics) return null
  try {
    const value = JSON.parse(row.metrics) as RegistryMetrics
    return value && typeof value === 'object' ? value : null
  } catch {
    return null
  }
}

function rowOf(db: DatabaseSync, id: number): StoredModelRow | undefined {
  return db.prepare('SELECT * FROM ml_models WHERE id = ?').get(id) as unknown as StoredModelRow | undefined
}

export function getStoredModel(db: DatabaseSync, id: number): StoredModelRow | undefined {
  return rowOf(db, id)
}

/** The single model currently served for a kind, or undefined. */
export function championFor(db: DatabaseSync, userId: number, kind: ModelKind): StoredModelRow | undefined {
  return db
    .prepare("SELECT * FROM ml_models WHERE user_id = ? AND kind = ? AND status = 'champion' ORDER BY id DESC LIMIT 1")
    .get(userId, kind) as unknown as StoredModelRow | undefined
}

/** Register a trained model as a candidate. Append-only; never overwrites. */
export function registerModel(db: DatabaseSync, userId: number, input: RegisterModelInput, now = Date.now()): StoredModelRow {
  db.prepare(
    `INSERT INTO ml_models
       (user_id, kind, version, status, train_from, train_to, data_count, labelled_count,
        feature_names, hyperparams, seed, metrics, git_commit, payload, notes, created_at, updated_at)
     VALUES (?, ?, ?, 'candidate', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, kind, version) DO UPDATE SET
       train_from = excluded.train_from,
       train_to = excluded.train_to,
       data_count = excluded.data_count,
       labelled_count = excluded.labelled_count,
       feature_names = excluded.feature_names,
       hyperparams = excluded.hyperparams,
       seed = excluded.seed,
       metrics = excluded.metrics,
       git_commit = excluded.git_commit,
       payload = excluded.payload,
       notes = excluded.notes,
       updated_at = excluded.updated_at`,
  ).run(
    userId,
    input.kind,
    input.version,
    input.trainFrom,
    input.trainTo,
    input.dataCount,
    input.labelledCount,
    JSON.stringify(input.featureNames),
    input.hyperparams === undefined ? null : JSON.stringify(input.hyperparams),
    input.seed ?? 0,
    input.metrics === undefined || input.metrics === null ? null : JSON.stringify(input.metrics),
    input.gitCommit ?? null,
    input.payload === undefined ? null : JSON.stringify(input.payload),
    input.notes ?? null,
    now,
    now,
  )
  return db
    .prepare('SELECT * FROM ml_models WHERE user_id = ? AND kind = ? AND version = ?')
    .get(userId, input.kind, input.version) as unknown as StoredModelRow
}

export interface PromotionDecision {
  ok: boolean
  reason: string
  /** The previous champion that was retired, when a promotion happened. */
  retiredId?: number
}

function beatsBaseline(metrics: RegistryMetrics): { ok: boolean; detail: string } {
  if (metrics.type === 'baseline' || metrics.type === 'median') {
    return { ok: false, detail: 'the candidate is itself the baseline, so there is nothing to promote' }
  }
  if (metrics.type === 'quantile') {
    if (metrics.mae === null || metrics.mae === undefined) return { ok: false, detail: 'the duration model has no validation MAE' }
    if (metrics.baselineMae === null || metrics.baselineMae === undefined) {
      return { ok: false, detail: 'there is no baseline MAE to compare against' }
    }
    return metrics.mae < metrics.baselineMae
      ? { ok: true, detail: `MAE ${metrics.mae.toFixed(1)} beats the median baseline ${metrics.baselineMae.toFixed(1)}` }
      : { ok: false, detail: `MAE ${metrics.mae.toFixed(1)} does not beat the median baseline ${metrics.baselineMae.toFixed(1)}` }
  }
  if (metrics.brier === null || metrics.brier === undefined) return { ok: false, detail: 'the candidate has no validation Brier score' }
  if (metrics.baselineBrier === null || metrics.baselineBrier === undefined) {
    return { ok: false, detail: 'there is no baseline Brier score to compare against' }
  }
  return metrics.brier < metrics.baselineBrier
    ? { ok: true, detail: `Brier ${metrics.brier.toFixed(3)} beats the baseline ${metrics.baselineBrier.toFixed(3)}` }
    : { ok: false, detail: `Brier ${metrics.brier.toFixed(3)} does not beat the baseline ${metrics.baselineBrier.toFixed(3)}` }
}

function beatsChampion(candidate: RegistryMetrics, champion: RegistryMetrics): { ok: boolean; detail: string } {
  if (candidate.type === 'quantile') {
    if (champion.type === 'quantile' && champion.mae !== null && champion.mae !== undefined && candidate.mae !== null && candidate.mae !== undefined) {
      return candidate.mae < champion.mae
        ? { ok: true, detail: `MAE ${candidate.mae.toFixed(1)} beats the current model ${champion.mae.toFixed(1)}` }
        : { ok: false, detail: `MAE ${candidate.mae.toFixed(1)} does not beat the current model ${champion.mae.toFixed(1)}` }
    }
    return { ok: true, detail: 'the current model has no comparable duration metric' }
  }
  if (champion.brier !== null && champion.brier !== undefined && candidate.brier !== null && candidate.brier !== undefined) {
    return candidate.brier < champion.brier
      ? { ok: true, detail: `Brier ${candidate.brier.toFixed(3)} beats the current model ${champion.brier.toFixed(3)}` }
      : { ok: false, detail: `Brier ${candidate.brier.toFixed(3)} does not beat the current model ${champion.brier.toFixed(3)}` }
  }
  return { ok: true, detail: 'the current model has no comparable metric' }
}

/**
 * Promote a candidate to champion, but only when it beats the baseline and the
 * current champion and passes the reliability gate. Returns the decision either
 * way, with a plain-language reason.
 */
export function promoteCandidate(db: DatabaseSync, userId: number, candidateId: number): PromotionDecision {
  const candidate = rowOf(db, candidateId)
  if (!candidate) return { ok: false, reason: 'No such candidate.' }
  if (candidate.user_id !== userId) return { ok: false, reason: 'That model belongs to a different user.' }
  if (candidate.status === 'champion') return { ok: false, reason: 'This model is already the champion.' }

  const metrics = parseMetrics(candidate)
  if (!metrics) return { ok: false, reason: 'The candidate has no recorded metrics, so it cannot be gated.' }

  const baseline = beatsBaseline(metrics)
  if (!baseline.ok) return { ok: false, reason: `Not promoted: ${baseline.detail}.` }

  // Reliability gate: a classifier must be calibrated well enough to trust.
  if (metrics.brier !== undefined && metrics.ece !== null && metrics.ece !== undefined && metrics.ece > MAX_ECE) {
    return { ok: false, reason: `Not promoted: expected calibration error ${metrics.ece.toFixed(3)} exceeds the ${MAX_ECE} gate.` }
  }

  const champion = championFor(db, userId, candidate.kind)
  if (champion) {
    const championMetrics = parseMetrics(champion)
    if (championMetrics) {
      const vs = beatsChampion(metrics, championMetrics)
      if (!vs.ok) return { ok: false, reason: `Not promoted: ${vs.detail}.` }
    }
  }

  const now = Date.now()
  let retiredId: number | undefined
  if (champion) {
    db.prepare("UPDATE ml_models SET status = 'retired', updated_at = ? WHERE id = ?").run(now, champion.id)
    retiredId = champion.id
  }
  db.prepare("UPDATE ml_models SET status = 'champion', updated_at = ? WHERE id = ?").run(now, candidate.id)
  return {
    ok: true,
    reason: champion
      ? `Promoted: ${baseline.detail} and it beat the previous champion. The previous version is kept as retired.`
      : `Promoted: ${baseline.detail}. It is now the served model.`,
    retiredId,
  }
}

/**
 * Roll back to the previous champion. With no `toVersion`, the most recent
 * still-available older version of the same kind is restored. The current
 * champion is retired, not deleted.
 */
export function rollbackChampion(
  db: DatabaseSync,
  userId: number,
  kind: ModelKind,
  options: { toVersion?: string } = {},
): PromotionDecision {
  const current = championFor(db, userId, kind)
  if (!current) return { ok: false, reason: 'There is no champion to roll back from.' }

  const target = options.toVersion
    ? (db
        .prepare("SELECT * FROM ml_models WHERE user_id = ? AND kind = ? AND version = ? AND id != ?")
        .get(userId, kind, options.toVersion, current.id) as unknown as StoredModelRow | undefined)
    : (db
        .prepare(
          `SELECT * FROM ml_models
           WHERE user_id = ? AND kind = ? AND id != ? AND id < ?
           ORDER BY id DESC LIMIT 1`,
        )
        .get(userId, kind, current.id, current.id) as unknown as StoredModelRow | undefined)

  if (!target) return { ok: false, reason: 'No previous version is available to roll back to.' }

  const now = Date.now()
  db.prepare("UPDATE ml_models SET status = 'retired', updated_at = ? WHERE id = ?").run(now, current.id)
  db.prepare("UPDATE ml_models SET status = 'champion', updated_at = ? WHERE id = ?").run(now, target.id)
  return {
    ok: true,
    reason: `Rolled back from ${current.version} to ${target.version}. The newer version is kept as retired.`,
    retiredId: current.id,
  }
}

// ---------------------------------------------------------------------------
// Retraining gate
// ---------------------------------------------------------------------------

export interface RetrainGate {
  /** New labelled observations required before retraining. */
  minNewLabelled?: number
  /** Optional maximum staleness, in days, that also triggers a retrain. */
  maxDays?: number
}

export interface RetrainDecision {
  should: boolean
  reason: string
  newLabelled: number
}

export const DEFAULT_MIN_NEW_LABELLED = 20

/** Decide whether enough new labelled data has accumulated to retrain. */
export function shouldRetrain(
  db: DatabaseSync,
  userId: number,
  kind: ModelKind,
  currentLabelledCount: number,
  options: RetrainGate = {},
  now = Date.now(),
): RetrainDecision {
  const minNew = options.minNewLabelled ?? DEFAULT_MIN_NEW_LABELLED
  const state = db
    .prepare('SELECT * FROM ml_retrain_state WHERE user_id = ? AND kind = ?')
    .get(userId, kind) as unknown as { last_trained_at: number; last_labelled_count: number } | undefined
  if (!state) return { should: true, reason: 'No model has been trained for this activity yet.', newLabelled: currentLabelledCount }

  const newLabelled = currentLabelledCount - state.last_labelled_count
  if (newLabelled >= minNew) {
    return { should: true, reason: `${newLabelled} new labelled observation(s) since the last training (threshold ${minNew}).`, newLabelled }
  }
  if (options.maxDays !== undefined) {
    const days = (now - state.last_trained_at) / 86_400_000
    if (days >= options.maxDays) {
      return { should: true, reason: `${days.toFixed(0)} day(s) since the last training (staleness limit ${options.maxDays}).`, newLabelled }
    }
  }
  return { should: false, reason: `Only ${newLabelled} new labelled observation(s) since the last training (threshold ${minNew}); no retrain yet.`, newLabelled }
}

/** Record that a training run happened, and how much labelled data it saw. */
export function markTrained(db: DatabaseSync, userId: number, kind: ModelKind, labelledCount: number, now = Date.now()): void {
  db.prepare(
    `INSERT INTO ml_retrain_state (user_id, kind, last_trained_at, last_labelled_count)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, kind) DO UPDATE SET
       last_trained_at = excluded.last_trained_at,
       last_labelled_count = excluded.last_labelled_count`,
  ).run(userId, kind, now, labelledCount)
}

// ---------------------------------------------------------------------------
// Loading a champion for serving
// ---------------------------------------------------------------------------

export interface LoadedArtifact<T extends ModelArtifact = ModelArtifact> {
  row: StoredModelRow
  artifact: T
}

/**
 * Load the champion artifact for a kind. Returns null (never throws) when there
 * is no champion or its payload cannot be parsed, so the caller can fall back to
 * the baseline.
 */
export function loadChampionArtifact(db: DatabaseSync, userId: number, kind: ModelKind): LoadedArtifact | null {
  const row = championFor(db, userId, kind)
  if (!row || !row.payload) return null
  try {
    const artifact = JSON.parse(row.payload) as ModelArtifact
    if (!artifact || typeof artifact !== 'object') return null
    return { row, artifact }
  } catch {
    return null
  }
}
