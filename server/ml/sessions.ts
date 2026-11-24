import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { parseLocalDate } from '../checkins-store'

/**
 * Activity session store and validation.
 *
 * A session is one stretch of real activity for a task. Several sessions per
 * day are normal and they add up towards the day's target. Durations are whole
 * minutes and always positive; the end time is optional (you can log "20
 * minutes" without knowing exactly when it started and stopped).
 */
export const SESSION_MAX_MINUTES = 24 * 60
export const NOTE_MAX = 500

export interface SessionRow {
  id: string
  user_id: number
  task_id: string
  local_date: string
  started_at: number
  ended_at: number | null
  duration_minutes: number
  note: string | null
  source: string
  created_at: number
  updated_at: number
}

/** A time span used for overlap checks. */
export interface SessionRange {
  id?: string
  startedAt: number
  endedAt: number | null
  durationMinutes: number
}

export interface ValidSession {
  taskId: string
  localDate: string
  startedAt: number
  endedAt: number | null
  durationMinutes: number
  note: string | null
}

export type SessionValidation =
  | { ok: true; value: ValidSession }
  | { ok: false; error: string }

export function sessionRange(row: Pick<SessionRow, 'id' | 'started_at' | 'ended_at' | 'duration_minutes'>): SessionRange {
  return {
    id: row.id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    durationMinutes: row.duration_minutes,
  }
}

/** Half-open [start, end) comparison; an open end uses the duration. */
export function rangesOverlap(a: SessionRange, b: SessionRange): boolean {
  const aEnd = a.endedAt ?? a.startedAt + a.durationMinutes * 60_000
  const bEnd = b.endedAt ?? b.startedAt + b.durationMinutes * 60_000
  return a.startedAt < bEnd && b.startedAt < aEnd
}

function isWholeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value)
}

/**
 * Validate a session before it is stored.
 *
 * Rejects: bad dates, missing/negative/impossible durations, end-before-start,
 * future timestamps, exact duplicates, and overlapping sessions for the same
 * task. `existing` is every other range already recorded for that task;
 * `ignoreId` excludes the row being edited.
 */
export function validateSession(
  raw: unknown,
  ctx: { now: number; existing: SessionRange[]; ignoreId?: string },
): SessionValidation {
  if (typeof raw !== 'object' || raw === null) return { ok: false, error: 'Send a session to log.' }
  const input = raw as Record<string, unknown>

  const taskId = typeof input.taskId === 'string' ? input.taskId.trim() : ''
  if (!taskId) return { ok: false, error: 'A session needs a task.' }

  const localDate = parseLocalDate(input.localDate)
  if (!localDate) return { ok: false, error: 'Provide a valid local date as YYYY-MM-DD.' }

  if (!isWholeNumber(input.startedAt)) {
    return { ok: false, error: 'A session needs a start time.' }
  }
  const startedAt = input.startedAt

  let endedAt: number | null = null
  if (input.endedAt !== undefined && input.endedAt !== null) {
    if (!isWholeNumber(input.endedAt)) return { ok: false, error: 'That end time is not valid.' }
    endedAt = input.endedAt
  }

  if (startedAt > ctx.now) return { ok: false, error: 'A session cannot start in the future.' }
  if (endedAt !== null && endedAt > ctx.now) {
    return { ok: false, error: 'A session cannot end in the future.' }
  }

  let durationMinutes: number
  if (endedAt !== null) {
    if (endedAt <= startedAt) return { ok: false, error: 'A session cannot end before it starts.' }
    durationMinutes = Math.round((endedAt - startedAt) / 60_000)
    if (durationMinutes < 1) {
      return { ok: false, error: 'A session must last at least a minute.' }
    }
  } else {
    if (!isWholeNumber(input.durationMinutes)) {
      return { ok: false, error: 'Give a duration in minutes, or an end time.' }
    }
    durationMinutes = input.durationMinutes
    if (durationMinutes < 1) return { ok: false, error: 'A duration must be at least a minute.' }
  }

  if (durationMinutes > SESSION_MAX_MINUTES) {
    return { ok: false, error: 'That duration is longer than a day.' }
  }

  let note: string | null = null
  if (input.note !== undefined && input.note !== null) {
    if (typeof input.note !== 'string') return { ok: false, error: 'That note is not valid.' }
    const trimmed = input.note.trim()
    if (trimmed.length > NOTE_MAX) return { ok: false, error: `Keep notes under ${NOTE_MAX} characters.` }
    note = trimmed || null
  }

  const candidate: SessionRange = { startedAt, endedAt, durationMinutes }
  for (const existing of ctx.existing) {
    if (ctx.ignoreId && existing.id === ctx.ignoreId) continue
    if (!rangesOverlap(candidate, existing)) continue
    const exactDuplicate =
      existing.startedAt === startedAt &&
      (existing.endedAt ?? null) === endedAt &&
      existing.durationMinutes === durationMinutes
    return {
      ok: false,
      error: exactDuplicate
        ? 'That session has already been logged.'
        : 'This session overlaps one already logged for this task.',
    }
  }

  return { ok: true, value: { taskId, localDate, startedAt, endedAt, durationMinutes, note } }
}

/**
 * Session ranges already recorded for a task, for overlap checks.
 * When `userId` is given, only that author's ranges are considered so two
 * teammates can independently log overlapping stretches on a shared task.
 */
export function existingRanges(db: DatabaseSync, taskId: string, userId?: number): SessionRange[] {
  const rows = (userId === undefined
    ? db
        .prepare('SELECT id, started_at, ended_at, duration_minutes FROM activity_sessions WHERE task_id = ?')
        .all(taskId)
    : db
        .prepare(
          'SELECT id, started_at, ended_at, duration_minutes FROM activity_sessions WHERE task_id = ? AND user_id = ?',
        )
        .all(taskId, userId)) as unknown as Array<{
    id: string
    started_at: number
    ended_at: number | null
    duration_minutes: number
  }>
  return rows.map(sessionRange)
}

export function createSession(
  db: DatabaseSync,
  userId: number,
  value: ValidSession,
  source = 'user',
  now = Date.now(),
): SessionRow {
  const id = randomUUID()
  db.prepare(
    `INSERT INTO activity_sessions
       (id, user_id, task_id, local_date, started_at, ended_at, duration_minutes, note, source, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    userId,
    value.taskId,
    value.localDate,
    value.startedAt,
    value.endedAt,
    value.durationMinutes,
    value.note,
    source,
    now,
    now,
  )
  return db.prepare('SELECT * FROM activity_sessions WHERE id = ?').get(id) as unknown as SessionRow
}

export function getSession(db: DatabaseSync, userId: number, id: string): SessionRow | undefined {
  return db
    .prepare('SELECT * FROM activity_sessions WHERE id = ? AND user_id = ?')
    .get(id, userId) as unknown as SessionRow | undefined
}

export interface SessionFilter {
  taskId?: string
  from?: string
  to?: string
  asOf?: number
  limit?: number
}

export function listSessions(db: DatabaseSync, userId: number, filter: SessionFilter = {}): SessionRow[] {
  const clauses = ['user_id = ?']
  const values: Array<string | number> = [userId]
  if (filter.taskId) {
    clauses.push('task_id = ?')
    values.push(filter.taskId)
  }
  if (filter.from) {
    clauses.push('local_date >= ?')
    values.push(filter.from)
  }
  if (filter.to) {
    clauses.push('local_date <= ?')
    values.push(filter.to)
  }
  if (filter.asOf !== undefined) {
    // Only sessions that had started *and* been recorded by the cutoff. A
    // session logged after the fact cannot be known to a prediction made earlier.
    clauses.push('started_at <= ?')
    values.push(filter.asOf)
    clauses.push('created_at <= ?')
    values.push(filter.asOf)
  }
  const limit = Math.min(Math.max(filter.limit ?? 200, 1), 1000)
  values.push(limit)
  const rows = db
    .prepare(
      `SELECT * FROM activity_sessions WHERE ${clauses.join(' AND ')}
       ORDER BY local_date DESC, started_at DESC LIMIT ?`,
    )
    .all(...values) as unknown as SessionRow[]
  if (filter.asOf === undefined) return rows
  // Clip a session that was still running at the cutoff to the minutes actually
  // elapsed by then. Sessions with no recorded end keep their logged duration:
  // the user entered it before the cutoff, so it was knowable at that time.
  return rows.map((row) => {
    if (row.ended_at === null || row.ended_at <= filter.asOf!) return row
    const elapsed = Math.floor((filter.asOf! - row.started_at) / 60_000)
    const clipped = Math.max(0, Math.min(row.duration_minutes, elapsed))
    return clipped === row.duration_minutes ? row : { ...row, duration_minutes: clipped }
  })
}

/** Every session logged for a task, with its author, for teammates viewing that task. */
export function listTaskSessions(db: DatabaseSync, taskId: string): Array<SessionRow & { author_email: string; author_name: string | null }> {
  return db
    .prepare(
      `SELECT s.*, u.email AS author_email, u.name AS author_name
       FROM activity_sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.task_id = ?
       ORDER BY s.started_at ASC, s.rowid ASC`,
    )
    .all(taskId) as unknown as Array<SessionRow & { author_email: string; author_name: string | null }>
}

export function deleteSession(db: DatabaseSync, userId: number, id: string): boolean {
  const result = db.prepare('DELETE FROM activity_sessions WHERE id = ? AND user_id = ?').run(id, userId)
  return Number(result.changes) > 0
}
