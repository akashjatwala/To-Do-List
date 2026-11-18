import type { DatabaseSync } from 'node:sqlite'
import { championFor, type StoredModelRow } from './registry'
import { MAX_ECE, type ModelKind } from './training'
import { brier, calibrationError, mae, type Labelled, type RegressionPoint } from './metrics'
import { addDays } from './off-days'
import { safeRun } from './logging'

/**
 * Live model health.
 *
 * A model that looked good on the historical validation window can still be
 * wrong on the user's own days. This module watches the model that is actually
 * being served, on the user's own logged predictions, and compares it against
 * the baseline predictor over the same days:
 *
 * - Every served model prediction is stored in `ml_health_predictions` beside
 *   the baseline's for the same (kind, day, task). The label stays NULL until
 *   the day is actually labelled from observed activity — a prediction is never
 *   written back as an outcome.
 * - `evaluateModelHealth` scores the two over a rolling window. It refuses to
 *   judge on too little data (no fallback on small noisy data), and only falls
 *   back to the baseline when the live model is clearly worse than the baseline
 *   or its calibration has drifted past the health gate.
 * - `clearFallback` resets the flag after a retrain, so the fresh model gets a
 *   fresh chance and has to prove itself in the window again.
 * - `modelHealthView` is a plain-words, informational summary. It reports; it
 *   never nags and it never hides a number it does not have.
 */

/** The rolling window, in days, over which health is judged. */
export const HEALTH_WINDOW_DAYS = 28
/** Below this many labelled predictions, no judgement is made either way. */
export const HEALTH_MIN_LABELLED = 12
/** How much worse than the baseline the live model may be before falling back. */
export const HEALTH_BRIER_MARGIN = 0.02
/** The duration equivalent of the Brier margin, in minutes. */
export const HEALTH_MAE_MARGIN = 1
/** The calibration gate, shared with the promotion gate. */
export const HEALTH_ECE_MAX = MAX_ECE
/** The kinds that are actually served from a model and therefore watched. */
export const HEALTH_KINDS: ModelKind[] = ['completion', 'target', 'duration']

export function isClassifierKind(kind: ModelKind): boolean {
  return kind === 'completion' || kind === 'target'
}

export interface ModelHealthRow {
  user_id: number
  kind: string
  window_days: number
  labelled_count: number
  model_brier: number | null
  baseline_brier: number | null
  model_ece: number | null
  baseline_ece: number | null
  model_mae: number | null
  baseline_mae: number | null
  fallback: number
  reason: string | null
  evaluated_at: number
  updated_at: number
}

function localDate(now: number): string {
  const date = new Date(now)
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

// ---------------------------------------------------------------------------
// Logging what was served
// ---------------------------------------------------------------------------

export interface HealthPredictionInput {
  kind: ModelKind
  date: string
  taskId: string
  modelVersion: string
  modelProbability?: number | null
  baselineProbability?: number | null
  modelDuration?: number | null
  baselineDuration?: number | null
}

/**
 * Store one served model output beside the baseline's for the same day. Upserts
 * on (user, kind, day, task), so re-running a prediction the same day updates
 * the row. The label is never touched here.
 */
export function logHealthPrediction(
  db: DatabaseSync,
  userId: number,
  input: HealthPredictionInput,
  now = Date.now(),
): void {
  if (input.kind === 'timing') return
  db.prepare(
    `INSERT INTO ml_health_predictions
       (user_id, kind, local_date, task_id, model_version, model_probability,
        baseline_probability, model_duration, baseline_duration, label, label_duration,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)
     ON CONFLICT(user_id, kind, local_date, task_id) DO UPDATE SET
       model_version = excluded.model_version,
       model_probability = excluded.model_probability,
       baseline_probability = excluded.baseline_probability,
       model_duration = excluded.model_duration,
       baseline_duration = excluded.baseline_duration,
       updated_at = excluded.updated_at`,
  ).run(
    userId,
    input.kind,
    input.date,
    input.taskId,
    input.modelVersion,
    input.modelProbability ?? null,
    input.baselineProbability ?? null,
    input.modelDuration ?? null,
    input.baselineDuration ?? null,
    now,
    now,
  )
}

/** `logHealthPrediction` that never lets a logging failure break serving. */
export function logHealthPredictionSafe(
  db: DatabaseSync,
  userId: number,
  input: HealthPredictionInput,
): void {
  safeRun('health.log-prediction', () => logHealthPrediction(db, userId, input), undefined)
}

// ---------------------------------------------------------------------------
// Labelling from observed activity
// ---------------------------------------------------------------------------

export interface ObservedDay {
  performed: boolean | null
  targetAchieved: boolean | null
  totalMinutes: number
}

/**
 * Attach the **observed** outcome of one (task, day) to any stored health
 * predictions for it. Only ever fills a NULL label, so a label can never be
 * overwritten by a later prediction. Missing stays missing.
 */
export function labelHealthForDay(
  db: DatabaseSync,
  userId: number,
  date: string,
  taskId: string,
  observed: ObservedDay,
  now = Date.now(),
): number {
  let changes = 0
  if (observed.performed !== null) {
    const result = db
      .prepare(
        `UPDATE ml_health_predictions SET label = ?, updated_at = ?
         WHERE user_id = ? AND kind = 'completion' AND local_date = ? AND task_id = ? AND label IS NULL`,
      )
      .run(observed.performed ? 1 : 0, now, userId, date, taskId)
    changes += Number(result.changes)
  }
  if (observed.targetAchieved !== null) {
    const result = db
      .prepare(
        `UPDATE ml_health_predictions SET label = ?, updated_at = ?
         WHERE user_id = ? AND kind = 'target' AND local_date = ? AND task_id = ? AND label IS NULL`,
      )
      .run(observed.targetAchieved ? 1 : 0, now, userId, date, taskId)
    changes += Number(result.changes)
  }
  if (observed.performed === true) {
    const result = db
      .prepare(
        `UPDATE ml_health_predictions SET label_duration = ?, updated_at = ?
         WHERE user_id = ? AND kind = 'duration' AND local_date = ? AND task_id = ? AND label_duration IS NULL`,
      )
      .run(observed.totalMinutes, now, userId, date, taskId)
    changes += Number(result.changes)
  }
  return changes
}

/** Label one kind's stored predictions for a day. Returns rows changed. */
export function labelHealthPredictions(
  db: DatabaseSync,
  userId: number,
  kind: ModelKind,
  date: string,
  taskId: string,
  outcome: 0 | 1,
  now = Date.now(),
): boolean {
  if (kind === 'timing') return false
  const column = kind === 'duration' ? 'label_duration' : 'label'
  const result = db
    .prepare(
      `UPDATE ml_health_predictions SET ${column} = ?, updated_at = ?
       WHERE user_id = ? AND kind = ? AND local_date = ? AND task_id = ? AND ${column} IS NULL`,
    )
    .run(outcome, now, userId, kind, date, taskId)
  return Number(result.changes) > 0
}

// ---------------------------------------------------------------------------
// Rolling evaluation and fallback
// ---------------------------------------------------------------------------

export interface HealthEvalOptions {
  now?: number
  /** The user's local date; defaults to the newest stored prediction. */
  today?: string
  windowDays?: number
  minLabelled?: number
}

interface HealthPredictionRow {
  model_version: string
  model_probability: number | null
  baseline_probability: number | null
  model_duration: number | null
  baseline_duration: number | null
  label: number | null
  label_duration: number | null
}

function latestHealthDate(db: DatabaseSync, userId: number, kind: ModelKind): string | null {
  const row = db
    .prepare('SELECT MAX(local_date) AS d FROM ml_health_predictions WHERE user_id = ? AND kind = ?')
    .get(userId, kind) as unknown as { d: string | null }
  return row.d ?? null
}

export function readHealth(db: DatabaseSync, userId: number, kind: ModelKind): ModelHealthRow | undefined {
  return db
    .prepare('SELECT * FROM ml_health WHERE user_id = ? AND kind = ?')
    .get(userId, kind) as unknown as ModelHealthRow | undefined
}

function upsertHealth(db: DatabaseSync, row: ModelHealthRow, now: number): void {
  db.prepare(
    `INSERT INTO ml_health
       (user_id, kind, window_days, labelled_count, model_brier, baseline_brier,
        model_ece, baseline_ece, model_mae, baseline_mae, fallback, reason, evaluated_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, kind) DO UPDATE SET
       window_days = excluded.window_days,
       labelled_count = excluded.labelled_count,
       model_brier = excluded.model_brier,
       baseline_brier = excluded.baseline_brier,
       model_ece = excluded.model_ece,
       baseline_ece = excluded.baseline_ece,
       model_mae = excluded.model_mae,
       baseline_mae = excluded.baseline_mae,
       fallback = excluded.fallback,
       reason = excluded.reason,
       evaluated_at = excluded.evaluated_at,
       updated_at = excluded.updated_at`,
  ).run(
    row.user_id,
    row.kind,
    row.window_days,
    row.labelled_count,
    row.model_brier,
    row.baseline_brier,
    row.model_ece,
    row.baseline_ece,
    row.model_mae,
    row.baseline_mae,
    row.fallback,
    row.reason,
    row.evaluated_at,
    now,
  )
}

function emptyHealth(userId: number, kind: ModelKind, windowDays: number, now: number): ModelHealthRow {
  return {
    user_id: userId,
    kind,
    window_days: windowDays,
    labelled_count: 0,
    model_brier: null,
    baseline_brier: null,
    model_ece: null,
    baseline_ece: null,
    model_mae: null,
    baseline_mae: null,
    fallback: 0,
    reason: null,
    evaluated_at: now,
    updated_at: now,
  }
}

/**
 * Score the live model against the baseline over the rolling window and decide
 * whether to fall back. Writes the verdict to `ml_health` and returns it. With
 * too little labelled data it makes no judgement and preserves any existing
 * fallback (a model that already failed is not silently un-failed by a quiet
 * week).
 */
export function evaluateModelHealth(
  db: DatabaseSync,
  userId: number,
  kind: ModelKind,
  options: HealthEvalOptions = {},
): ModelHealthRow {
  const now = options.now ?? Date.now()
  const windowDays = options.windowDays ?? HEALTH_WINDOW_DAYS
  const minLabelled = options.minLabelled ?? HEALTH_MIN_LABELLED
  const previous = readHealth(db, userId, kind)

  const champion = kind === 'timing' ? undefined : championFor(db, userId, kind)
  if (!champion) {
    const row: ModelHealthRow = {
      ...emptyHealth(userId, kind, windowDays, now),
      reason: 'No model is served for this kind; the baseline is used, so there is nothing to fall back from.',
    }
    upsertHealth(db, row, now)
    return row
  }

  const today = options.today ?? latestHealthDate(db, userId, kind) ?? localDate(now)
  const windowStart = addDays(today, -(windowDays - 1))
  const rows = db
    .prepare(
      `SELECT model_version, model_probability, baseline_probability, model_duration,
              baseline_duration, label, label_duration
       FROM ml_health_predictions
       WHERE user_id = ? AND kind = ? AND model_version = ? AND local_date >= ? AND local_date <= ?`,
    )
    .all(userId, kind, champion.version, windowStart, today) as unknown as HealthPredictionRow[]

  const row = emptyHealth(userId, kind, windowDays, now)

  if (isClassifierKind(kind)) {
    const model: Labelled[] = []
    const baseline: Labelled[] = []
    for (const item of rows) {
      if (item.label === null || item.model_probability === null || item.baseline_probability === null) continue
      if (!Number.isFinite(item.model_probability) || !Number.isFinite(item.baseline_probability)) continue
      model.push({ p: item.model_probability, y: item.label })
      baseline.push({ p: item.baseline_probability, y: item.label })
    }
    row.labelled_count = model.length
    row.model_brier = brier(model)
    row.baseline_brier = brier(baseline)
    row.model_ece = calibrationError(model)
    row.baseline_ece = calibrationError(baseline)
  } else {
    const model: RegressionPoint[] = []
    const baseline: RegressionPoint[] = []
    for (const item of rows) {
      if (item.label_duration === null || item.model_duration === null || item.baseline_duration === null) continue
      if (!Number.isFinite(item.model_duration) || !Number.isFinite(item.baseline_duration)) continue
      model.push({ predicted: item.model_duration, actual: item.label_duration })
      baseline.push({ predicted: item.baseline_duration, actual: item.label_duration })
    }
    row.labelled_count = model.length
    row.model_mae = mae(model)
    row.baseline_mae = mae(baseline)
  }

  const { fallback, reason } = decideFallback(row, previous, windowDays, minLabelled)
  row.fallback = fallback ? 1 : 0
  row.reason = reason
  upsertHealth(db, row, now)
  return row
}

function decideFallback(
  row: ModelHealthRow,
  previous: ModelHealthRow | undefined,
  windowDays: number,
  minLabelled: number,
): { fallback: boolean; reason: string } {
  const held = previous?.fallback === 1
  if (row.labelled_count < minLabelled) {
    return {
      fallback: held,
      reason: held
        ? `The model is still on the baseline: only ${row.labelled_count} labelled day(s) in the last ${windowDays}, which is too few to re-judge it.`
        : `Only ${row.labelled_count} labelled day(s) in the last ${windowDays}; that is too few to judge the model, so nothing changes.`,
    }
  }

  if (row.kind === 'duration') {
    const worse = row.model_mae !== null && row.baseline_mae !== null && row.model_mae > row.baseline_mae + HEALTH_MAE_MARGIN
    if (worse) {
      return {
        fallback: true,
        reason: `The served model's average duration error (${row.model_mae!.toFixed(1)} min) is worse than the baseline's (${row.baseline_mae!.toFixed(1)} min) over the last ${windowDays} days, so the baseline is used for now.`,
      }
    }
    if (held) {
      return { fallback: true, reason: heldReason(windowDays) }
    }
    return {
      fallback: false,
      reason: `The served model's duration error is within the baseline's over the last ${windowDays} days.`,
    }
  }

  const worseThanBaseline =
    row.model_brier !== null && row.baseline_brier !== null && row.model_brier > row.baseline_brier + HEALTH_BRIER_MARGIN
  const miscalibrated = row.model_ece !== null && row.model_ece > HEALTH_ECE_MAX
  if (worseThanBaseline || miscalibrated) {
    const reason = miscalibrated && !worseThanBaseline
      ? `The served model's calibration error (${row.model_ece!.toFixed(3)}) has drifted past the ${HEALTH_ECE_MAX} gate over the last ${windowDays} days, so the baseline is used for now.`
      : `The served model (Brier ${row.model_brier?.toFixed(3) ?? 'n/a'}) is scoring worse than the baseline (${row.baseline_brier?.toFixed(3) ?? 'n/a'}) over the last ${windowDays} days, so the baseline is used for now.`
    return { fallback: true, reason }
  }
  // Once fallen back, the model is re-tried only after the next retrain (which
  // clears the flag) — it is not flipped back on a single good-looking window.
  if (held) return { fallback: true, reason: heldReason(windowDays) }
  return {
    fallback: false,
    reason: `The served model is holding up against the baseline over the last ${windowDays} days.`,
  }
}

function heldReason(windowDays: number): string {
  return `The baseline is still being used for this model until the next retrain, even though the last ${windowDays} days look no worse than the baseline.`
}

/** True when the live model for a kind is currently side-lined for the baseline. */
export function isFallbackActive(db: DatabaseSync, userId: number, kind: ModelKind): boolean {
  return readHealth(db, userId, kind)?.fallback === 1
}


/**
 * Reset the fallback after a retrain, so the fresh model is judged again from
 * scratch. It still has to prove itself in the window before it is trusted.
 */
export function clearFallback(db: DatabaseSync, userId: number, now = Date.now()): void {
  db.prepare(
    `UPDATE ml_health
     SET fallback = 0,
         reason = 'Reset after a retrain: the fresh model is being judged again.',
         evaluated_at = ?,
         updated_at = ?
     WHERE user_id = ?`,
  ).run(now, now, userId)
}

// ---------------------------------------------------------------------------
// Plain-words health view
// ---------------------------------------------------------------------------

export interface ModelHealthEntry {
  kind: ModelKind
  activeVersion: string | null
  activeType: string | null
  championSince: number | null
  fallback: boolean
  reason: string
  windowDays: number
  labelled: number
  modelBrier: number | null
  baselineBrier: number | null
  modelEce: number | null
  baselineEce: number | null
  modelMae: number | null
  baselineMae: number | null
  lastTrainedAt: number | null
  lastTrainedLabelled: number | null
  lastRetrainAt: number | null
  lastRetrainDetail: string | null
}

export interface ModelHealthView {
  userId: number
  generatedAt: number
  anyFallback: boolean
  entries: ModelHealthEntry[]
  note: string
}

function modelType(row: StoredModelRow): string | null {
  if (!row.metrics) return null
  try {
    const parsed = JSON.parse(row.metrics) as { type?: unknown }
    return typeof parsed.type === 'string' ? parsed.type : null
  } catch {
    return null
  }
}

function retrainState(db: DatabaseSync, userId: number, kind: ModelKind): { at: number; labelled: number } | null {
  const row = db
    .prepare('SELECT last_trained_at, last_labelled_count FROM ml_retrain_state WHERE user_id = ? AND kind = ?')
    .get(userId, kind) as unknown as { last_trained_at: number; last_labelled_count: number } | undefined
  return row ? { at: row.last_trained_at, labelled: row.last_labelled_count } : null
}

function lastRetrainLog(db: DatabaseSync, userId: number, kind: ModelKind): { at: number; detail: string | null } | null {
  const row = db
    .prepare('SELECT created_at, detail FROM ml_retrain_log WHERE user_id = ? AND kind = ? ORDER BY created_at DESC LIMIT 1')
    .get(userId, kind) as unknown as { created_at: number; detail: string | null } | undefined
  return row ? { at: row.created_at, detail: row.detail } : null
}

/**
 * A plain-words view of what the system is doing: which model is active, when
 * it last trained, how much data it has, and whether the baseline is being used
 * instead. Informational only.
 */
export function modelHealthView(db: DatabaseSync, userId: number, now = Date.now()): ModelHealthView {
  const entries: ModelHealthEntry[] = []
  for (const kind of HEALTH_KINDS) {
    const champion = championFor(db, userId, kind)
    const health = readHealth(db, userId, kind)
    const state = retrainState(db, userId, kind)
    const log = lastRetrainLog(db, userId, kind)
    entries.push({
      kind,
      activeVersion: champion?.version ?? null,
      activeType: champion ? modelType(champion) : null,
      championSince: champion?.updated_at ?? null,
      fallback: health?.fallback === 1,
      reason: health?.reason ?? 'This model has not been judged yet.',
      windowDays: health?.window_days ?? HEALTH_WINDOW_DAYS,
      labelled: health?.labelled_count ?? 0,
      modelBrier: health?.model_brier ?? null,
      baselineBrier: health?.baseline_brier ?? null,
      modelEce: health?.model_ece ?? null,
      baselineEce: health?.baseline_ece ?? null,
      modelMae: health?.model_mae ?? null,
      baselineMae: health?.baseline_mae ?? null,
      lastTrainedAt: state?.at ?? null,
      lastTrainedLabelled: state?.labelled ?? null,
      lastRetrainAt: log?.at ?? null,
      lastRetrainDetail: log?.detail ?? null,
    })
  }
  const anyFallback = entries.some((entry) => entry.fallback)
  return {
    userId,
    generatedAt: now,
    anyFallback,
    entries,
    note: anyFallback
      ? 'The baseline is being used for at least one model because it has been scoring better on your own recent days. The system will retry the model after the next retrain.'
      : 'Every served model is holding up against the simple baseline on your own recent days. This is information only — there is nothing you need to do.',
  }
}

