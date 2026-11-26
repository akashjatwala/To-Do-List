import type { DatabaseSync } from 'node:sqlite'
import type { CheckinAnswerKey } from '../checkins-store'
import { minuteOfDay } from './statistics'
import { DEFAULT_SESSION_MINUTES, epochAtMinute, freeTimeBudget, type PlanResult } from './predictors'

/**
 * Arrange the day's predicted tasks into a proposed timeline.
 *
 * This is a pure, read-only layer on top of the plan. It never edits a task,
 * a due date or a prediction. Each task keeps its own recommended window as a
 * starting point; when two windows collide the later task is nudged to the next
 * free quarter-hour.
 *
 * The overload warning compares the planned minutes with the check-in's free
 * time answer. With no free-time answer there is no capacity to compare against,
 * so no claim of overload is made.
 */

export interface ScheduleSlot {
  taskId: string
  text: string
  start: number
  end: number
  duration: number
  /** True when the slot had to move away from its recommended window. */
  shifted: boolean
}

export interface ScheduleResult {
  available: boolean
  reason: string
  capacityMinutes: number | null
  plannedMinutes: number
  slots: ScheduleSlot[]
  unplaced: Array<{ taskId: string; text: string; duration: number }>
  overloaded: boolean
  warning: string | null
}

const STEP_MINUTES = 15
const DAY_MINUTES = 24 * 60

interface Interval {
  start: number
  end: number
}

/** First free quarter-hour at or after `desired`, wholly inside the day. */
function findSlot(desired: number, duration: number, occupied: Interval[]): number | null {
  const earliest = Math.max(0, Math.min(DAY_MINUTES - duration, Math.ceil(desired / STEP_MINUTES) * STEP_MINUTES))
  for (let start = earliest; start + duration <= DAY_MINUTES; start += STEP_MINUTES) {
    const overlaps = occupied.some((slot) => start < slot.end && start + duration > slot.start)
    if (!overlaps) return start
  }
  return null
}

export function buildDaySchedule(
  _db: DatabaseSync,
  _userId: number,
  plan: PlanResult,
  options: {
    date: string
    today: string
    nowMinutes: number
    answers?: Partial<Record<CheckinAnswerKey, number>> | null
  },
): ScheduleResult {
  const empty = (reason: string): ScheduleResult => ({
    available: false,
    reason,
    capacityMinutes: null,
    plannedMinutes: 0,
    slots: [],
    unplaced: [],
    overloaded: false,
    warning: null,
  })

  if (plan.offDay) return empty('Off days have no plan to arrange.')
  if (options.date < options.today) return empty('A past day cannot be planned again.')
  if (plan.entries.length === 0) return empty('There are no open tasks to arrange yet.')

  const remainingClock = Math.max(0, DAY_MINUTES - options.nowMinutes)
  const budget = freeTimeBudget(options.answers ?? null)
  const capacityMinutes = budget === null ? null : Math.min(budget, remainingClock)

  const occupied: Interval[] = []
  const slots: ScheduleSlot[] = []
  const unplaced: ScheduleResult['unplaced'] = []

  for (const entry of plan.entries) {
    const duration = Math.max(STEP_MINUTES, Math.round(entry.prediction.expectedDuration ?? DEFAULT_SESSION_MINUTES))
    const recommended =
      entry.prediction.recommendedStart === null ? null : minuteOfDay(entry.prediction.recommendedStart)
    const desired = recommended === null ? options.nowMinutes : Math.max(options.nowMinutes, recommended)

    let start = findSlot(desired, duration, occupied)
    let shifted = start !== null && start !== desired
    if (start === null && desired > options.nowMinutes) {
      start = findSlot(options.nowMinutes, duration, occupied)
      shifted = start !== null
    }
    if (start === null) {
      unplaced.push({ taskId: entry.taskId, text: entry.text, duration })
      continue
    }

    const interval = { start, end: start + duration }
    occupied.push(interval)
    slots.push({
      taskId: entry.taskId,
      text: entry.text,
      start: epochAtMinute(options.date, interval.start),
      end: epochAtMinute(options.date, interval.end),
      duration,
      shifted,
    })
  }

  slots.sort((a, b) => a.start - b.start)
  const plannedMinutes = slots.reduce((sum, slot) => sum + slot.duration, 0)
  const overloaded =
    unplaced.length > 0 || (capacityMinutes !== null && plannedMinutes > capacityMinutes)

  let warning: string | null = null
  if (overloaded) {
    const parts = [`${plannedMinutes} min planned`]
    if (capacityMinutes !== null) parts.push(`about ${capacityMinutes} min free`)
    if (unplaced.length > 0) parts.push(`${unplaced.length} task${unplaced.length === 1 ? '' : 's'} without a slot`)
    warning = `This plan looks overloaded: ${parts.join(', ')}. Nothing has been moved — you decide what to keep.`
  }

  return {
    available: true,
    reason:
      'Slots start from each task’s own suggested window and are nudged only when they collide. Nothing is applied to your tasks.',
    capacityMinutes,
    plannedMinutes,
    slots,
    unplaced,
    overloaded,
    warning,
  }
}
