import type { DatabaseSync } from 'node:sqlite'

/**
 * Shared record of automatic date moves.
 *
 * Off-day moves and "Skip for today" both change a task's due date. Keeping one
 * event table means the notification centre can show exactly what moved and can
 * undo a recent accidental skip. Events are local bookkeeping only: they never
 * hide a task or create an occurrence of their own.
 */

export type TaskMoveReason = 'skip' | 'off-day'

/** Skips stay undoable for a week; after that the notice is still visible. */
export const MOVE_UNDO_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

export const TASK_SKIP_EVENTS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS task_skip_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL,
    actor_id INTEGER NOT NULL,
    from_date TEXT NOT NULL,
    to_date TEXT NOT NULL,
    due INTEGER NOT NULL,
    reason TEXT NOT NULL DEFAULT 'skip' CHECK (reason IN ('skip', 'off-day')),
    undone INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
    FOREIGN KEY (actor_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_task_skip_events_created ON task_skip_events(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_task_skip_events_task ON task_skip_events(task_id);
`

/**
 * The actor index references `undone`, which older databases gain in migration
 * 20. Creating it here would fail before that migration can run, so the
 * migration owns this index.
 */

export function createTaskSkipEventsSchema(database: DatabaseSync): void {
  database.exec(TASK_SKIP_EVENTS_SCHEMA)
}

export interface TaskMoveRecord {
  id: number
  taskId: string
  actorId: number
  fromDate: string
  toDate: string
  due: number
  reason: TaskMoveReason
  undone: boolean
  createdAt: number
}

interface MoveRow {
  id: number
  task_id: string
  actor_id: number
  from_date: string
  to_date: string
  due: number
  reason: TaskMoveReason
  undone: number
  created_at: number
}

function toRecord(row: MoveRow): TaskMoveRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    actorId: row.actor_id,
    fromDate: row.from_date,
    toDate: row.to_date,
    due: row.due,
    reason: row.reason,
    undone: row.undone !== 0,
    createdAt: row.created_at,
  }
}

function hasTable(database: DatabaseSync, name: string): boolean {
  return Boolean(
    database
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(name),
  )
}

/** Move a timestamp to a local date while preserving its time of day. */
export function dueAtDate(timestamp: number, dateValue: string): number {
  const source = new Date(timestamp)
  const [year, month, day] = dateValue.split('-').map(Number)
  return new Date(
    year,
    month - 1,
    day,
    source.getHours(),
    source.getMinutes(),
    source.getSeconds(),
    source.getMilliseconds(),
  ).getTime()
}

/** Record a completed move. Returns null only on isolated test databases without the table. */
export function recordTaskMove(
  database: DatabaseSync,
  input: {
    taskId: string
    actorId: number
    fromDate: string
    toDate: string
    due: number
    reason: TaskMoveReason
  },
): TaskMoveRecord | null {
  if (!hasTable(database, 'task_skip_events')) return null
  const now = Date.now()
  const result = database
    .prepare(
      `INSERT INTO task_skip_events
         (task_id, actor_id, from_date, to_date, due, reason, undone, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
    )
    .run(
      input.taskId,
      input.actorId,
      input.fromDate,
      input.toDate,
      input.due,
      input.reason,
      now,
    )
  const row = database
    .prepare('SELECT * FROM task_skip_events WHERE id = ?')
    .get(Number(result.lastInsertRowid)) as unknown as MoveRow | undefined
  return row ? toRecord(row) : null
}

/**
 * Undo a recent skip made by this user. The task must still be open and still
 * on the recorded destination, so a later manual change is never overwritten.
 */
export function undoTaskSkip(
  database: DatabaseSync,
  eventId: number,
  userId: number,
  taskId?: string,
): TaskMoveRecord | null {
  if (!Number.isInteger(eventId) || !hasTable(database, 'task_skip_events')) return null
  const event = database
    .prepare('SELECT * FROM task_skip_events WHERE id = ?')
    .get(eventId) as unknown as MoveRow | undefined
  if (
    !event ||
    event.actor_id !== userId ||
    event.undone !== 0 ||
    event.reason !== 'skip' ||
    event.created_at < Date.now() - MOVE_UNDO_WINDOW_MS ||
    (taskId !== undefined && event.task_id !== taskId)
  ) {
    return null
  }

  const task = database
    .prepare('SELECT done, due FROM tasks WHERE id = ?')
    .get(event.task_id) as unknown as { done: number; due: number | null } | undefined
  if (!task || task.done !== 0 || task.due === null) return null

  const source = new Date(task.due)
  const [year, month, day] = event.from_date.split('-').map(Number)
  const restored = new Date(
    year,
    month - 1,
    day,
    source.getHours(),
    source.getMinutes(),
    source.getSeconds(),
    source.getMilliseconds(),
  ).getTime()
  const [targetYear, targetMonth, targetDay] = event.to_date.split('-').map(Number)
  const target = new Date(targetYear, targetMonth - 1, targetDay).getTime()
  const stillAtTarget =
    new Date(task.due).getFullYear() === targetYear &&
    new Date(task.due).getMonth() === targetMonth - 1 &&
    new Date(task.due).getDate() === targetDay
  if (!stillAtTarget || !Number.isFinite(restored) || !Number.isFinite(target)) return null

  database.exec('BEGIN')
  try {
    database.prepare('UPDATE tasks SET due = ? WHERE id = ?').run(restored, event.task_id)
    database.prepare('UPDATE task_skip_events SET undone = 1 WHERE id = ?').run(event.id)
    database.exec('COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
  return { ...toRecord(event), undone: true, due: restored }
}
