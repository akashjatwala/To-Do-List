import { endOfDay, isSameDay, startOfDay } from '@/api'

const DAY = 24 * 60 * 60 * 1000

/** Short label for a task due date, e.g. "Today", "Tomorrow", "Mon", "Jul 4". */
export function formatDue(timestamp: number, now = new Date()): string {
  const date = new Date(timestamp)
  const today = startOfDay(now)
  const dueDay = startOfDay(date)
  const diff = Math.round((dueDay - today) / DAY)

  if (diff === 0) return 'Today'
  if (diff === 1) return 'Tomorrow'
  if (diff === -1) return 'Yesterday'
  if (diff > 1 && diff < 7) {
    return date.toLocaleDateString(undefined, { weekday: 'short' })
  }
  if (date.getFullYear() === now.getFullYear()) {
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  }
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

export type DueState = 'overdue' | 'today' | 'soon' | 'later'

export function dueState(timestamp: number, now = new Date()): DueState {
  const date = new Date(timestamp)
  if (endOfDay(date) < startOfDay(now)) return 'overdue'
  if (isSameDay(date, now)) return 'today'
  if (startOfDay(date) - startOfDay(now) <= 2 * DAY) return 'soon'
  return 'later'
}

/** Value for <input type="date"> in the user's local timezone. */
export function dateInputValue(timestamp: number | null): string {
  if (timestamp === null) return ''
  const date = new Date(timestamp)
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/** Today's date as a <input type="date"> value. */
export function todayDateValue(now = new Date()): string {
  return dateInputValue(now.getTime())
}

/** Friendly label for a date value: "Today · Sat, Nov 14" or "Tue, Nov 18". */
export function formatDateValue(value: string, now = new Date()): string {
  const timestamp = dueFromDateInput(value)
  if (timestamp === null) return ''
  const date = new Date(timestamp)
  const sameYear = date.getFullYear() === now.getFullYear()
  const label = date.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  })
  return isSameDay(date, now) ? `Today · ${label}` : label
}

/** Convert a date input value to the end of that day (local time). */
export function dueFromDateInput(value: string): number | null {
  if (!value) return null
  const [year, month, day] = value.split('-').map(Number)
  if (!year || !month || !day) return null
  return endOfDay(new Date(year, month - 1, day))
}

export function timeAgo(timestamp: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000))
  if (seconds < 60) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days < 7) return `${days}d ago`
  return new Date(timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function fullDate(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

export function initials(email: string): string {
  const name = email.split('@')[0] ?? email
  const parts = name.split(/[._-]+/).filter(Boolean)
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase()
  return name.slice(0, 2).toUpperCase()
}

/** Stable pastel color for a user avatar, based on their email. */
export function avatarColor(seed: string): string {
  const palette = [
    'bg-rose-500',
    'bg-orange-500',
    'bg-amber-500',
    'bg-emerald-500',
    'bg-teal-500',
    'bg-sky-500',
    'bg-indigo-500',
    'bg-violet-500',
    'bg-fuchsia-500',
  ]
  let hash = 0
  for (let i = 0; i < seed.length; i += 1) hash = (hash * 31 + seed.charCodeAt(i)) % 100000
  return palette[hash % palette.length]
}
