import type { DatabaseSync } from 'node:sqlite'
import { addDays, listOffDays } from './ml/off-days'
import { localDateValue } from './recurrence'
import { dueAtDate, recordTaskMove } from './task-move-events'

/**
 * Off-day task handling.
 *
 * A marked-off date is not a working day. Open personal tasks that are actually
 * due on such a date move to the next date that is not marked off. Team tasks
 * keep their shared due date — teammates are notified of the off day instead —
 * and completing a task never rewrites its history.
 *
 * Repeating personal tasks that merely project onto an off date are not copied
 * forward: the board hides that occurrence, and the same task still projects
 * onto the next working day. Each move is recorded so the notification centre
 * can show what changed. When an off-day record is removed or edited, the move
 * is reversed if the task is still on its destination and its original date is
 * no longer marked off. Historic team-task moves are reversed the same way.
 */

interface VisibleTaskRow {
  id: string
  due: number
}

export interface OffDayMove {
  taskId: string
  fromDate: string
  toDate: string
  due: number
}

export interface OffDayMoveResult {
  moved: number
  moves: OffDayMove[]
}

export interface OffDayRange {
  start: string
  end: string
}

export { dueAtDate } from './task-move-events'

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

/**
 * Move open personal tasks due on a marked-off date to the next non-off date.
 * Team tasks stay put: the shared due date belongs to the whole team, so the
 * off-day notice tells teammates instead of changing their board.
 */
export function applyOffDayTaskMoves(database: DatabaseSync, userId: number): OffDayMoveResult {
  const ranges = offDayRanges(database, userId)
  if (ranges.length === 0) return { moved: 0, moves: [] }

  const tasks = database
    .prepare(
      `SELECT t.id, t.due
       FROM tasks t
       WHERE t.done = 0 AND t.due IS NOT NULL
         AND t.user_id = ? AND t.team_id IS NULL`,
    )
    .all(userId) as unknown as VisibleTaskRow[]

  const moves: OffDayMove[] = []
  const update = database.prepare('UPDATE tasks SET due = ? WHERE id = ?')
  for (const task of tasks) {
    const dueValue = localDateValue(task.due)
    if (!isOffDate(ranges, dueValue)) continue
    const target = nextWorkingDate(ranges, dueValue)
    if (!target) continue
    const due = dueAtDate(task.due, target)
    update.run(due, task.id)
    recordTaskMove(database, {
      taskId: task.id,
      actorId: userId,
      fromDate: dueValue,
      toDate: target,
      due,
      reason: 'off-day',
    })
    moves.push({ taskId: task.id, fromDate: dueValue, toDate: target, due })
  }
  return { moved: moves.length, moves }
}

interface MoveEventRow {
  id: number
  task_id: string
  from_date: string
  to_date: string
}

/**
 * Reverse off-day moves that no longer apply.
 *
 * Deleting or editing an off-day record must bring its tasks back to the date
 * they left, otherwise a team note moved off the old off day stays stranded on
 * a future date after the day is marked working again. A move is only reversed
 * when the task is still open, still on the recorded destination, and its
 * original date is not covered by a remaining off period. Skip moves and later
 * manual edits are left alone.
 */
export function restoreOffDayTaskMoves(database: DatabaseSync, userId: number): OffDayMoveResult {
  const hasEvents = database
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'task_skip_events'")
    .get()
  if (!hasEvents) return { moved: 0, moves: [] }

  const ranges = offDayRanges(database, userId)
  const events = database
    .prepare(
      `SELECT s.id, s.task_id, s.from_date, s.to_date
       FROM task_skip_events s
       JOIN tasks t ON t.id = s.task_id
       WHERE s.actor_id = ? AND s.reason = 'off-day' AND s.undone = 0
         AND t.done = 0 AND t.due IS NOT NULL
       ORDER BY s.created_at DESC, s.id DESC`,
    )
    .all(userId) as unknown as MoveEventRow[]

  const moves: OffDayMove[] = []
  const loadTask = database.prepare('SELECT due FROM tasks WHERE id = ?')
  const updateTask = database.prepare('UPDATE tasks SET due = ? WHERE id = ?')
  const markUndone = database.prepare('UPDATE task_skip_events SET undone = 1 WHERE id = ?')

  database.exec('BEGIN')
  try {
    for (const event of events) {
      if (isOffDate(ranges, event.from_date)) continue
      const task = loadTask.get(event.task_id) as { due: number } | undefined
      if (!task || localDateValue(task.due) !== event.to_date) continue
      const due = dueAtDate(task.due, event.from_date)
      updateTask.run(due, event.task_id)
      markUndone.run(event.id)
      moves.push({ taskId: event.task_id, fromDate: event.to_date, toDate: event.from_date, due })
    }
    database.exec('COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }

  return { moved: moves.length, moves }
}
