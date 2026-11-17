/**
 * Calendar helpers for the synthetic generator.
 *
 * All dates are the same local calendar strings the app uses (`YYYY-MM-DD`),
 * and all timestamps are local-midnight-based milliseconds, so the generated
 * data looks exactly like data the app produced on the user's own machine.
 */

export const DAY_MS = 24 * 60 * 60 * 1000

function pad(value: number): string {
  return `${value}`.padStart(2, '0')
}

export function toLocalDate(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** Local midnight for a `YYYY-MM-DD` string. */
export function startOfLocalDay(date: string): number {
  const [year, month, day] = date.split('-').map(Number)
  return new Date(year, month - 1, day, 0, 0, 0, 0).getTime()
}

/** The last millisecond of a local day. */
export function endOfLocalDay(date: string): number {
  return startOfLocalDay(date) + DAY_MS - 1
}

/** A local timestamp on a date, given minutes past midnight. */
export function atMinutes(date: string, minutes: number): number {
  return startOfLocalDay(date) + Math.round(minutes) * 60_000
}

export function addDays(date: string, days: number): string {
  return toLocalDate(new Date(startOfLocalDay(date) + days * DAY_MS))
}

/** Whole days from `a` to `b` (positive when b is later). */
export function daysBetween(a: string, b: string): number {
  return Math.round((startOfLocalDay(b) - startOfLocalDay(a)) / DAY_MS)
}

/** 0 = Sunday … 6 = Saturday, matching the app's recurrence handling. */
export function weekdayOf(date: string): number {
  return new Date(startOfLocalDay(date)).getDay()
}

export function isWeekend(date: string): boolean {
  const day = weekdayOf(date)
  return day === 0 || day === 6
}

/** Every date from `start` to `end`, inclusive. */
export function dateRange(start: string, end: string): string[] {
  const out: string[] = []
  let cursor = start
  let guard = 0
  while (cursor <= end && guard < 10_000) {
    out.push(cursor)
    cursor = addDays(cursor, 1)
    guard += 1
  }
  return out
}

/** Day of the year, 0-based. */
export function dayOfYear(date: string): number {
  const [year, month, day] = date.split('-').map(Number)
  const start = new Date(year, 0, 1).getTime()
  return Math.round((new Date(year, month - 1, day).getTime() - start) / DAY_MS)
}

/**
 * Seasonal phase in [-1, 1], peaking at mid-summer (northern hemisphere) and
 * troughing at mid-winter. Used to shift timing and completion for the
 * "seasonal" persona.
 */
export function seasonPhase(date: string): number {
  const [year] = date.split('-').map(Number)
  const days = new Date(year, 1, 29).getMonth() === 1 ? 366 : 365
  const phase = (dayOfYear(date) / days) * 2 * Math.PI
  // Peak around late July (day ~200 of 365).
  return Math.cos(phase - (200 / 365) * 2 * Math.PI)
}

export function monthOf(date: string): number {
  return Number(date.slice(5, 7))
}

/** Format minutes-past-midnight as `HH:MM`, clamped into a day. */
export function minutesToHHMM(minutes: number): string {
  const clamped = Math.max(0, Math.min(24 * 60 - 1, Math.round(minutes)))
  return `${pad(Math.floor(clamped / 60))}:${pad(clamped % 60)}`
}

export function hhmmToMinutes(value: string): number {
  const [hours, minutes] = value.split(':').map(Number)
  return hours * 60 + minutes
}
