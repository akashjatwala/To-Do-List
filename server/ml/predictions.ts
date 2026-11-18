import type { DatabaseSync } from 'node:sqlite'
import type { TaskPrediction, PlanResult } from './predictors'

/**
 * The prediction log and the feedback trail.
 *
 * Predictions are written **only** by the system, into their own table, and are
 * never written back as an observed outcome. The feedback trail records whether
 * a recommendation was shown, whether it was exploratory and whether the user
 * followed it — again in its own table, apart from both the predictions and the
 * outcomes. The user's own reschedule/drop choice stays in
 * `state_suggestion_choices`.
 *
 * One row per (user, local date, task, model version): re-running a prediction
 * the same day updates that row rather than piling up duplicates.
 */

export interface PredictionRow {
  id: number
  user_id: number
  local_date: string
  task_id: string
  source: string
  model_version: string
  checkin_state: string
  completion_probability: number | null
  target_probability: number | null
  expected_duration: number | null
  duration_low: number | null
  duration_high: number | null
  recommended_start: number | null
  recommended_end: number | null
  confidence: string
  data_sufficiency_days: number
  stage: number
  exploratory: number
  explanation: string | null
  inputs_json: string | null
  created_at: number
  updated_at: number
}

export type FeedbackKind = 'time' | 'plan' | 'reschedule' | 'drop'

export interface FeedbackRow {
  id: number
  user_id: number
  local_date: string
  task_id: string
  kind: FeedbackKind
  exploratory: number
  shown: number
  followed: number | null
  created_at: number
  updated_at: number
}

/** Log one prediction, replacing any earlier row for the same task/day/version. */
export function logPrediction(
  db: DatabaseSync,
  userId: number,
  prediction: TaskPrediction,
  checkinState: string,
  now = Date.now(),
): void {
  db.prepare(
    `INSERT INTO predictions
       (user_id, local_date, task_id, source, model_version, checkin_state,
        completion_probability, target_probability, expected_duration, duration_low,
        duration_high, recommended_start, recommended_end, confidence,
        data_sufficiency_days, stage, exploratory, explanation, inputs_json,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, local_date, task_id, model_version) DO UPDATE SET
       source = excluded.source,
       checkin_state = excluded.checkin_state,
       completion_probability = excluded.completion_probability,
       target_probability = excluded.target_probability,
       expected_duration = excluded.expected_duration,
       duration_low = excluded.duration_low,
       duration_high = excluded.duration_high,
       recommended_start = excluded.recommended_start,
       recommended_end = excluded.recommended_end,
       confidence = excluded.confidence,
       data_sufficiency_days = excluded.data_sufficiency_days,
       stage = excluded.stage,
       exploratory = excluded.exploratory,
       explanation = excluded.explanation,
       inputs_json = excluded.inputs_json,
       updated_at = excluded.updated_at`,
  ).run(
    userId,
    prediction.date,
    prediction.taskId,
    prediction.source,
    prediction.modelVersion,
    checkinState,
    prediction.completionProbability,
    prediction.targetProbability,
    prediction.expectedDuration,
    prediction.durationLow,
    prediction.durationHigh,
    prediction.recommendedStart,
    prediction.recommendedEnd,
    prediction.confidence,
    prediction.dataSufficiencyDays,
    prediction.stage,
    prediction.exploratory ? 1 : 0,
    prediction.explanation,
    JSON.stringify(prediction.inputs),
    now,
    now,
  )
}

/** Log every prediction the plan produced. Returns how many rows were written. */
export function logPlanPredictions(db: DatabaseSync, userId: number, plan: PlanResult, now = Date.now()): number {
  for (const entry of plan.entries) {
    logPrediction(db, userId, entry.prediction, plan.checkinState, now)
  }
  return plan.entries.length
}

/** Stored predictions for one day, most confident first. */
export function listPredictions(db: DatabaseSync, userId: number, date: string): PredictionRow[] {
  return db
    .prepare(
      `SELECT * FROM predictions
       WHERE user_id = ? AND local_date = ?
       ORDER BY completion_probability DESC, task_id`,
    )
    .all(userId, date) as unknown as PredictionRow[]
}

/** Log a prediction by hand (used when a single task is predicted outside a plan). */
export function logTaskPrediction(
  db: DatabaseSync,
  userId: number,
  prediction: TaskPrediction,
  checkinState: string,
  now = Date.now(),
): void {
  logPrediction(db, userId, prediction, checkinState, now)
}

export interface FeedbackInput {
  date: string
  taskId: string
  kind: FeedbackKind
  exploratory?: boolean
  shown?: boolean
  followed?: boolean | null
}

/**
 * Record feedback on a recommendation. `followed` stays null when the user has
 * not yet acted, so "not answered" is never recorded as "not followed".
 */
export function recordFeedback(db: DatabaseSync, userId: number, input: FeedbackInput, now = Date.now()): void {
  db.prepare(
    `INSERT INTO prediction_feedback
       (user_id, local_date, task_id, kind, exploratory, shown, followed, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, local_date, task_id, kind) DO UPDATE SET
       exploratory = excluded.exploratory,
       shown = excluded.shown,
       followed = excluded.followed,
       updated_at = excluded.updated_at`,
  ).run(
    userId,
    input.date,
    input.taskId,
    input.kind,
    input.exploratory ? 1 : 0,
    input.shown ? 1 : 0,
    input.followed === undefined ? null : input.followed === null ? null : input.followed ? 1 : 0,
    now,
    now,
  )
}

/** Feedback rows for one day. */
export function listFeedback(db: DatabaseSync, userId: number, date: string): FeedbackRow[] {
  return db
    .prepare('SELECT * FROM prediction_feedback WHERE user_id = ? AND local_date = ? ORDER BY kind, task_id')
    .all(userId, date) as unknown as FeedbackRow[]
}

/** Parse a feedback payload. Returns null when invalid. */
export function parseFeedback(value: unknown): Omit<FeedbackInput, 'date'> | null {
  if (typeof value !== 'object' || value === null) return null
  const body = value as Record<string, unknown>
  if (typeof body.taskId !== 'string' || !body.taskId) return null
  const kind = body.kind
  if (kind !== 'time' && kind !== 'plan' && kind !== 'reschedule' && kind !== 'drop') return null
  const out: Omit<FeedbackInput, 'date'> = { taskId: body.taskId, kind }
  if (body.exploratory !== undefined) {
    if (typeof body.exploratory !== 'boolean') return null
    out.exploratory = body.exploratory
  }
  if (body.shown !== undefined) {
    if (typeof body.shown !== 'boolean') return null
    out.shown = body.shown
  }
  if (body.followed !== undefined && body.followed !== null) {
    if (typeof body.followed !== 'boolean') return null
    out.followed = body.followed
  } else if (body.followed === null) {
    out.followed = null
  }
  return out
}
