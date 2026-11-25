import type { DatabaseSync } from 'node:sqlite'
import { addDays, listOffDays } from './ml/off-days'
import { localDateValue } from './recurrence'

/**
 * Off-day task handling.
 *
 * A marked-off date is not a working day. Every open task that is actually due
 * on such a date is moved to the next date that is not marked off. Repeating
 * tasks that merely project onto an off date are not copied forward: the board
 * hides that occurrence, and the same task still projects onto the next working
 * day. This keeps one instance per repeat instead of spawning a duplicate.
 *
 * Only open tasks move. Completed tasks keep their original due date because it
 * is part of the activity history and must not be rewritten.
 */

interface VisibleTaskRow {
  id: string
  due: number
}

export interface OffDayMoveResult {
  moved: number
}

export interface OffDayRange {
  start: string
  end: string
}

/** Off periods for one user, reduced to the date spans the movers need. */
export function offDayRanges(database: DatabaseSync, userId: number): OffDayRange[] {
  return listOffDays(database, userId).map((row) => ({ start: row.start_date, end: row.end_date }))
}

export function isOffDate(ranges: OffDayRange[], date: string): boolean {
  return ranges.some((range) => date >= range.start && date <= range.end)
}

/** First date after `date` that is not inside any marked-off span. */
export function nextWorkingDate(ranges: OffDayRange[], date: string): string | null {
  let candidate = addDays(date, 1)
  for (let guard = 0; guard < 3650 && isOffDate(ranges, candidate); guard += 1) {
    candidate = addDays(candidate, 1)
  }
  return isOffDate(ranges, candidate) ? null : candidate
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

/**
 * Move open tasks due on a marked-off date to the next non-off date.
 * Team tasks a user can see move too, so the shared board agrees for everyone.
 */
export function applyOffDayTaskMoves(database: DatabaseSync, userId: number): OffDayMoveResult {
  const ranges = offDayRanges(database, userId)
  if (ranges.length === 0) return { moved: 0 }

  const tasks = database
    .prepare(
      `SELECT t.id, t.due
       FROM tasks t
       WHERE t.done = 0 AND t.due IS NOT NULL
         AND (
           (t.user_id = ? AND t.team_id IS NULL)
           OR t.team_id IN (SELECT team_id FROM team_members WHERE user_id = ?)
         )`,
    )
    .all(userId, userId) as unknown as VisibleTaskRow[]

  let moved = 0
  const update = database.prepare('UPDATE tasks SET due = ? WHERE id = ?')
  for (const task of tasks) {
    const dueValue = localDateValue(task.due)
    if (!isOffDate(ranges, dueValue)) continue
    const target = nextWorkingDate(ranges, dueValue)
    if (!target) continue
    update.run(dueAtDate(task.due, target), task.id)
    moved += 1
  }
  return { moved }
}
