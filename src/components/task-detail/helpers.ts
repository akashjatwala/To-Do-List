export const DURATION_MAX = 60 * 24 * 7

export const headerChipClass =
  'inline-flex items-center gap-1.5 rounded-full bg-[#F8FBFE]/90 px-2.5 py-1 text-[11px] font-semibold text-[#2E3742] ring-1 ring-white/70'

/** Combine a YYYY-MM-DD date and an HH:mm time into a local epoch timestamp. */
export function entryTimestamp(date: string, time: string): number | null {
  const [year, month, day] = date.split('-').map(Number)
  const [hours, minutes] = time.split(':').map(Number)
  if (
    !year ||
    !month ||
    !day ||
    !Number.isFinite(hours) ||
    !Number.isFinite(minutes) ||
    hours < 0 ||
    hours > 23 ||
    minutes < 0 ||
    minutes > 59
  ) {
    return null
  }
  return new Date(year, month - 1, day, hours, minutes, 0, 0).getTime()
}

export function shortEntryDate(date: string): string {
  const [year, month, day] = date.split('-').map(Number)
  const value = new Date(year, month - 1, day)
  const today = new Date()
  if (value.toDateString() === today.toDateString()) return 'Today'
  return value.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(value.getFullYear() === today.getFullYear() ? {} : { year: 'numeric' }),
  })
}

export function clockTime(timestamp: number): string {
  const date = new Date(timestamp)
  return `${`${date.getHours()}`.padStart(2, '0')}:${`${date.getMinutes()}`.padStart(2, '0')}`
}
