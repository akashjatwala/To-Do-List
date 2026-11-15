const DAY = 24 * 60 * 60 * 1000

export const RECURRENCES = ['none', 'daily', 'weekly', 'monthly', 'custom'] as const
export type Recurrence = (typeof RECURRENCES)[number]

/**
 * Extra rules for a custom repeat:
 * - weekly: repeat on these weekdays (0 = Sunday … 6 = Saturday)
 * - monthly: repeat on the nth weekday of every month (nth 5 means the last one)
 */
export type RecurrenceConfig =
  | { mode: 'weekly'; days: number[] }
  | { mode: 'monthly'; nth: number; weekday: number }

export function parseRecurrence(value: unknown): Recurrence | null {
  if (value === undefined) return 'none'
  return typeof value === 'string' && (RECURRENCES as readonly string[]).includes(value)
    ? (value as Recurrence)
    : null
}

/** Returns null when there is no config, undefined when the value is invalid. */
export function parseRecurrenceConfig(value: unknown): RecurrenceConfig | null | undefined {
  if (value === undefined || value === null) return null
  if (typeof value !== 'object' || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>

  if (raw.mode === 'weekly') {
    if (!Array.isArray(raw.days) || raw.days.length === 0) return undefined
    const days: number[] = []
    for (const item of raw.days) {
      if (typeof item !== 'number' || !Number.isInteger(item) || item < 0 || item > 6) {
        return undefined
      }
      if (!days.includes(item)) days.push(item)
    }
    if (days.length === 0) return undefined
    return { mode: 'weekly', days: days.sort((a, b) => a - b) }
  }

  if (raw.mode === 'monthly') {
    const { nth, weekday } = raw
    if (typeof nth !== 'number' || !Number.isInteger(nth) || nth < 1 || nth > 5) return undefined
    if (typeof weekday !== 'number' || !Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
      return undefined
    }
    return { mode: 'monthly', nth, weekday }
  }

  return undefined
}

/** Read a config back from its JSON column, tolerating blank or broken values. */
export function readRecurrenceConfig(value: string | null | undefined): RecurrenceConfig | null {
  if (!value) return null
  try {
    return parseRecurrenceConfig(JSON.parse(value)) ?? null
  } catch {
    return null
  }
}

/** Day of the month for the nth weekday, with nth = 5 meaning the last one. */
function nthWeekday(weekday: number, nth: number, year: number, month: number): number {
  const lastDay = new Date(year, month + 1, 0)
  if (nth === 5) {
    const diff = (lastDay.getDay() - weekday + 7) % 7
    return lastDay.getDate() - diff
  }
  const first = new Date(year, month, 1)
  return 1 + ((weekday - first.getDay() + 7) % 7) + (nth - 1) * 7
}

/** First selected weekday strictly after the current due date. */
function nextWeekly(due: number, days: number[]): number {
  for (let step = 1; step <= 7; step += 1) {
    const candidate = new Date(due)
    candidate.setDate(candidate.getDate() + step)
    if (days.includes(candidate.getDay())) return candidate.getTime()
  }
  return due + 7 * DAY
}

/** First nth-weekday occurrence strictly after the current due date. */
function nextMonthlyOnWeekday(due: number, weekday: number, nth: number): number {
  const start = new Date(due)
  let year = start.getFullYear()
  let month = start.getMonth()

  for (let i = 0; i < 24; i += 1) {
    const day = nthWeekday(weekday, nth, year, month)
    const lastDay = new Date(year, month + 1, 0).getDate()
    if (day <= lastDay) {
      const candidate = new Date(
        year,
        month,
        day,
        start.getHours(),
        start.getMinutes(),
        start.getSeconds(),
        start.getMilliseconds(),
      )
      if (candidate.getTime() > due) return candidate.getTime()
    }
    month += 1
    if (month > 11) {
      month = 0
      year += 1
    }
  }
  return due + 28 * DAY
}

/** Move a due date forward by one recurrence interval, keeping the time of day. */
export function advanceDue(
  due: number,
  recurrence: Recurrence,
  config: RecurrenceConfig | null,
): number {
  const date = new Date(due)

  if (recurrence === 'daily') {
    date.setDate(date.getDate() + 1)
    return date.getTime()
  }

  if (recurrence === 'weekly') {
    date.setDate(date.getDate() + 7)
    return date.getTime()
  }

  if (recurrence === 'monthly') {
    const day = date.getDate()
    date.setDate(1)
    date.setMonth(date.getMonth() + 1)
    const lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate()
    date.setDate(Math.min(day, lastDay))
    return date.getTime()
  }

  if (recurrence === 'custom' && config) {
    if (config.mode === 'weekly') return nextWeekly(due, config.days)
    return nextMonthlyOnWeekday(due, config.weekday, config.nth)
  }

  return due
}
