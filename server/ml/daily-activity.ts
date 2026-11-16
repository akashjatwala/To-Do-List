import type { DatabaseSync } from 'node:sqlite'
import { configForDate } from './task-config'
import { listSessions, type SessionRow } from './sessions'

/**
 * Daily activity derivation and labelling.
 *
 * Rules this module enforces, in code:
 * - Pending items are never negative labels. Until the user's local day is
 *   over, the day is `pending` unless the user said otherwise.
 * - Missing data is not zero. A past day with no sessions and no explicit
 *   statement is `unknown`, not `completed`/`partial`/`skipped`.
 * - `skipped`, `postponed`, `completed`, `partial` and `unknown` are distinct.
 * - Multiple sessions are aggregated; the target and the actual total are kept
 *   separate (the target is never folded into the actual).
 * - Labels use only data available at the cutoff. `asOf` lets a caller ask for
 *   the day as it stood at a moment in time, so later edits cannot leak back.
 */
export type DailyStatus = 'completed' | 'partial' | 'skipped' | 'postponed' | 'pending' | 'unknown'

/** The statuses a user can state explicitly for a day. */
export type ExplicitStatus = 'completed' | 'partial' | 'skipped' | 'postponed'

export interface DailyActivity {
  date: string
  /** The day's target in minutes, or null when the task has no target. */
  targetMinutes: number | null
  /** Sum of the day's session durations. */
  totalMinutes: number
  sessionCount: number
  /** true/false when known; null when there is no data either way. */
  performed: boolean | null
  /** true/false against the target; null when there is no target or no data. */
  targetAchieved: boolean | null
  status: DailyStatus
  reason: string | null
  /** The configuration version that applied that day, or null. */
  configVersionId: number | null
  /** That day's check-in id from Phase 1, or null when there was none. */
  checkinId: number | null
}

export interface DeriveInput {
  date: string
  /** The user's current local date, used as the evaluation cutoff. */
  today: string
  targetMinutes: number | null
  sessions: Array<{ durationMinutes: number }>
  explicitStatus: ExplicitStatus | null
  explicitReason: string | null
  configVersionId: number | null
  checkinId: number | null
}

export function deriveDailyActivity(input: DeriveInput): DailyActivity {
  const totalMinutes = input.sessions.reduce((sum, session) => sum + Math.max(0, session.durationMinutes), 0)
  const sessionCount = input.sessions.length
  const target = input.targetMinutes
  const explicit = input.explicitStatus

  let performed: boolean | null
  if (explicit === 'skipped' || explicit === 'postponed') performed = false
  else if (totalMinutes > 0) performed = true
  else if (explicit === 'completed' || explicit === 'partial') performed = true
  else performed = null

  let targetAchieved: boolean | null
  if (target === null) targetAchieved = null
  else if (totalMinutes >= target) targetAchieved = true
  else if (explicit === 'completed') targetAchieved = true
  else if (totalMinutes > 0) targetAchieved = false
  else if (explicit === 'partial') targetAchieved = false
  else targetAchieved = null

  let status: DailyStatus
  if (explicit) status = explicit
  else if (input.date >= input.today) status = 'pending'
  else if (target !== null) {
    if (totalMinutes >= target) status = 'completed'
    else if (totalMinutes > 0) status = 'partial'
    else status = 'unknown'
  } else {
    status = totalMinutes > 0 ? 'completed' : 'unknown'
  }

  return {
    date: input.date,
    targetMinutes: target,
    totalMinutes,
    sessionCount,
    performed,
    targetAchieved,
    status,
    reason: input.explicitReason,
    configVersionId: input.configVersionId,
    checkinId: input.checkinId,
  }
}

export interface DailyStatusRow {
  id: number
  user_id: number
  task_id: string
  local_date: string
  status: ExplicitStatus
  reason: string | null
  source: string
  created_at: number
  updated_at: number
}

export function getDailyStatus(
  db: DatabaseSync,
  userId: number,
  taskId: string,
  date: string,
): DailyStatusRow | undefined {
  return db
    .prepare('SELECT * FROM daily_activity_status WHERE user_id = ? AND task_id = ? AND local_date = ?')
    .get(userId, taskId, date) as unknown as DailyStatusRow | undefined
}

export function setDailyStatus(
  db: DatabaseSync,
  userId: number,
  taskId: string,
  date: string,
  status: ExplicitStatus,
  reason: string | null,
  source = 'user',
  now = Date.now(),
): DailyStatusRow {
  db.prepare(
    `INSERT INTO daily_activity_status (user_id, task_id, local_date, status, reason, source, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, task_id, local_date) DO UPDATE SET
       status = excluded.status,
       reason = excluded.reason,
       source = excluded.source,
       updated_at = excluded.updated_at`,
  ).run(userId, taskId, date, status, reason, source, now, now)
  return getDailyStatus(db, userId, taskId, date)!
}

export function clearDailyStatus(db: DatabaseSync, userId: number, taskId: string, date: string): boolean {
  const result = db
    .prepare('DELETE FROM daily_activity_status WHERE user_id = ? AND task_id = ? AND local_date = ?')
    .run(userId, taskId, date)
  return Number(result.changes) > 0
}

function checkinIdFor(db: DatabaseSync, userId: number, date: string): number | null {
  const row = db
    .prepare('SELECT id FROM checkins WHERE user_id = ? AND date = ?')
    .get(userId, date) as unknown as { id: number } | undefined
  return row?.id ?? null
}

export interface DailyActivityOptions {
  /** Only count sessions that had started by this timestamp (leak-free). */
  asOf?: number
}

export function dailyActivity(
  db: DatabaseSync,
  userId: number,
  taskId: string,
  date: string,
  today: string,
  options: DailyActivityOptions = {},
): DailyActivity {
  const config = configForDate(db, taskId, date)
  const sessions: SessionRow[] = listSessions(db, userId, {
    taskId,
    from: date,
    to: date,
    asOf: options.asOf,
    limit: 1000,
  })
  const explicit = getDailyStatus(db, userId, taskId, date)
  return deriveDailyActivity({
    date,
    today,
    targetMinutes: config?.target_duration ?? null,
    sessions: sessions.map((session) => ({ durationMinutes: session.duration_minutes })),
    explicitStatus: explicit?.status ?? null,
    explicitReason: explicit?.reason ?? null,
    configVersionId: config?.id ?? null,
    checkinId: checkinIdFor(db, userId, date),
  })
}

/** A run of daily records, oldest first — the shape the model will consume. */
export function dailyActivityRange(
  db: DatabaseSync,
  userId: number,
  taskId: string,
  dates: string[],
  today: string,
  options: DailyActivityOptions = {},
): DailyActivity[] {
  return dates.map((date) => dailyActivity(db, userId, taskId, date, today, options))
}
