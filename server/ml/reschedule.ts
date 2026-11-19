import type { DatabaseSync } from 'node:sqlite'
import { addDays, getPredictionSettings, offDayContext } from './off-days'
import { DEFAULT_SESSION_MINUTES, recommendWindow } from './predictors'
import {
  activityStatistics,
  userCompletionPrior,
  userTaskIds,
  weekdayOf,
} from './statistics'

/**
 * A better day for a task that was just skipped or postponed.
 *
 * Triggered by what the user actually recorded — an explicit `skipped` or
 * `postponed` status — not by a low prediction on its own. The candidate day is
 * chosen from the task's own weekday history, off days are ruled out, and the
 * time comes from the same timing profile the predictor uses.
 *
 * Nothing is moved. The result is a proposal with a plain-language reason, and
 * a previous answer for that task on the same day hides the suggestion.
 */

export interface RescheduleSuggestion {
  taskId: string
  text: string
  skippedDate: string
  skippedKind: 'skipped' | 'postponed'
  suggestedDate: string
  suggestedStart: number | null
  suggestedEnd: number | null
  reason: string
}

export interface RescheduleResult {
  available: boolean
  reason: string
  suggestions: RescheduleSuggestion[]
}

/** How far back a skip/postpone still counts as "just happened". */
const RECENT_DAYS = 7
/** How far ahead a proposal may look. */
const LOOKAHEAD_DAYS = 7
const MAX_SUGGESTIONS = 3

export function rescheduleSuggestions(
  db: DatabaseSync,
  userId: number,
  options: { date: string; today: string },
): RescheduleResult {
  const { date, today } = options
  if (date < today) {
    return { available: false, reason: 'Reschedule ideas are only offered for today or a future day.', suggestions: [] }
  }

  const settings = getPredictionSettings(db, userId)
  const priorRate = userCompletionPrior(db, userId, userTaskIds(db, userId), today)
  const recent = db
    .prepare(
      `SELECT task_id, local_date, status FROM daily_activity_status
       WHERE user_id = ? AND status IN ('skipped', 'postponed') AND local_date >= ? AND local_date <= ?
       ORDER BY local_date DESC`,
    )
    .all(userId, addDays(date, -RECENT_DAYS), addDays(date, -1)) as unknown as Array<{
      task_id: string
      local_date: string
      status: 'skipped' | 'postponed'
    }>

  const latest = new Map<string, { local_date: string; status: 'skipped' | 'postponed' }>()
  for (const row of recent) {
    if (!latest.has(row.task_id)) latest.set(row.task_id, { local_date: row.local_date, status: row.status })
  }

  const answered = db
    .prepare('SELECT suggestion_key FROM state_suggestion_choices WHERE user_id = ? AND local_date = ?')
    .all(userId, date) as unknown as Array<{ suggestion_key: string }>
  const answeredKeys = new Set(answered.map((row) => row.suggestion_key))
  const taskRow = db.prepare('SELECT text FROM tasks WHERE id = ? AND user_id = ? AND done = 0')

  const suggestions: RescheduleSuggestion[] = []
  for (const [taskId, event] of latest) {
    if (answeredKeys.has(`reschedule:${taskId}`)) continue
    const task = taskRow.get(taskId, userId) as unknown as { text: string } | undefined
    if (!task) continue

    const stats = activityStatistics(db, userId, taskId, today, priorRate, { to: date })
    const candidates: Array<{ date: string; rate: number }> = []
    for (let offset = 1; offset <= LOOKAHEAD_DAYS; offset += 1) {
      const candidate = addDays(date, offset)
      if (offDayContext(db, userId, candidate, settings).onOffDay) continue
      const weekday = stats.weekdayRates[weekdayOf(candidate)]
      const rate = weekday && weekday.labelled > 0 ? weekday.rate : priorRate
      candidates.push({ date: candidate, rate })
    }
    if (candidates.length === 0) continue
    candidates.sort((a, b) => b.rate - a.rate || a.date.localeCompare(b.date))
    const best = candidates[0]

    const duration = Math.round(stats.duration.median ?? DEFAULT_SESSION_MINUTES)
    const window = recommendWindow(stats.timing, best.date, 0, duration, null)
    const evidence = stats.weekdayRates.reduce((sum, row) => sum + row.labelled, 0)
    const basis = evidence === 0
      ? 'There is not enough history to name a better weekday yet, so this is simply the next free day.'
      : `Days like ${best.date} have worked better for this before, based on ${evidence} recorded day${evidence === 1 ? '' : 's'}.`

    suggestions.push({
      taskId,
      text: task.text,
      skippedDate: event.local_date,
      skippedKind: event.status,
      suggestedDate: best.date,
      suggestedStart: window.start,
      suggestedEnd: window.end,
      reason: `You ${event.status} this on ${event.local_date}. ${basis} Just an idea — nothing was moved.`,
    })
    if (suggestions.length >= MAX_SUGGESTIONS) break
  }

  return {
    available: suggestions.length > 0,
    reason: suggestions.length === 0
      ? 'No recently skipped or postponed task needs a new day right now.'
      : 'Offered from your own history. Accepting only records your choice; nothing is rescheduled automatically.',
    suggestions,
  }
}
