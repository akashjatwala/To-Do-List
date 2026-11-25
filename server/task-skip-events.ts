import type { DatabaseSync } from 'node:sqlite'
import { nextWorkingDate, offDayRanges } from './off-day-task-moves'
import { dueAtDate, recordTaskMove } from './task-move-events'
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
 * row is kept so the move is visible in the notification centre and can be
 * undone while it is recent; it never hides a task or changes an occurrence on
 * its own.
 */

export { TASK_SKIP_EVENTS_SCHEMA, createTaskSkipEventsSchema } from './task-move-events'

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
  database.exec('BEGIN')
  try {
    database.prepare('UPDATE tasks SET due = ? WHERE id = ?').run(movedDue, task.id)
    recordTaskMove(database, {
      taskId: task.id,
      actorId: userId,
      fromDate: date,
      toDate: target,
      due: movedDue,
      reason: 'skip',
    })
    database.exec('COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
  return { taskId: task.id, fromDate: date, toDate: target, due: movedDue }
}
