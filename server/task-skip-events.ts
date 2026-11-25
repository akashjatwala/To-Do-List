import type { DatabaseSync } from 'node:sqlite'
import { dueAtDate, nextWorkingDate, offDayRanges } from './off-day-task-moves'
import {
  localDateValue,
  parseRecurrence,
  readRecurrenceConfig,
  repeatsOnDate,
} from './recurrence'

/**
 * Skip for today.
 *
 * Skipping is a real reschedule, not a hidden occurrence: the note's due date
 * moves to the first date after the skipped date that is not marked off. One
 * move produces one note on the target date, including for repeats. The event
 * row is kept only so teammates can see the change in the in-app notification
 * centre; it never hides a task or changes an occurrence on its own.
 */

export const TASK_SKIP_EVENTS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS task_skip_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL,
    actor_id INTEGER NOT NULL,
    from_date TEXT NOT NULL,
    to_date TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
    FOREIGN KEY (actor_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_task_skip_events_created ON task_skip_events(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_task_skip_events_task ON task_skip_events(task_id);
`

export function createTaskSkipEventsSchema(database: DatabaseSync): void {
  database.exec(TASK_SKIP_EVENTS_SCHEMA)
}

export interface SkippableTaskRow {
  id: string
  done: number
  due: number | null
  recurrence: string
  recurrence_config: string | null
}

export interface TaskSkipResult {
  taskId: string
  fromDate: string
  toDate: string
  due: number
}

/** Only an open note actually scheduled on `date` can be skipped. */
export function canSkipTaskOnDate(task: SkippableTaskRow, date: string): boolean {
  if (task.done !== 0 || task.due === null) return false
  const recurrence = parseRecurrence(task.recurrence)
  if (!recurrence) return false
  const config = readRecurrenceConfig(task.recurrence_config)
  return recurrence === 'none'
    ? localDateValue(task.due) === date
    : repeatsOnDate(task.due, recurrence, config, date)
}

/**
 * Move a scheduled note to the next non-off date and record who moved it.
 * Returns null when the task is not skippable on that date.
 */
export function skipTaskDate(
  database: DatabaseSync,
  task: SkippableTaskRow,
  userId: number,
  date: string,
): TaskSkipResult | null {
  if (!canSkipTaskOnDate(task, date)) return null
  const target = nextWorkingDate(offDayRanges(database, userId), date)
  if (!target || task.due === null) return null

  const movedDue = dueAtDate(task.due, target)
  const now = Date.now()
  database.exec('BEGIN')
  try {
    database.prepare('UPDATE tasks SET due = ? WHERE id = ?').run(movedDue, task.id)
    database
      .prepare(
        `INSERT INTO task_skip_events (task_id, actor_id, from_date, to_date, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(task.id, userId, date, target, now)
    database.exec('COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
  return { taskId: task.id, fromDate: date, toDate: target, due: movedDue }
}
