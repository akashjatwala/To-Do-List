import type { Priority, Recurrence, RecurrenceConfig } from '@/types'
import { dateInputValue } from './date'

/**
 * Whether a repeating task is scheduled on a given local date (YYYY-MM-DD).
 * The due date itself always matches; later dates match only when they satisfy
 * the repeat rule. Past dates never match. This mirrors the server's
 * `advanceDue` rules for display purposes only — no task rows are created.
 */
export function repeatsOnDate(
  due: number | null,
  recurrence: Recurrence,
  config: RecurrenceConfig | null,
  dateValue: string,
): boolean {
  if (due === null || recurrence === 'none' || !dateValue) return false
  const dueValue = dateInputValue(due)
  if (dateValue < dueValue) return false
  if (dateValue === dueValue) return true

  const dueDate = new Date(due)
  const [year, month, day] = dateValue.split('-').map(Number)
  const target = new Date(year, month - 1, day)

  switch (recurrence) {
    case 'daily':
      return true
    case 'weekly':
      return target.getDay() === dueDate.getDay()
    case 'monthly': {
      const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate()
      return target.getDate() === Math.min(dueDate.getDate(), lastDay)
    }
    case 'custom': {
      if (!config) return false
      if (config.mode === 'weekly') return config.days.includes(target.getDay())
      if (target.getDay() !== config.weekday) return false
      const firstOfMonth = new Date(target.getFullYear(), target.getMonth(), 1)
      const weekdayOffset = (config.weekday - firstOfMonth.getDay() + 7) % 7
      const nth = Math.floor((target.getDate() - 1 - weekdayOffset) / 7) + 1
      if (config.nth === 5) {
        const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate()
        return target.getDate() + 7 > lastDay
      }
      return nth === config.nth
    }
    default:
      return false
  }
}

export const PRIORITY_VALUES: Priority[] = ['none', 'low', 'medium', 'high']

export const PRIORITY_META: Record<
  Priority,
  { label: string; dot: string; chip: string; text: string }
> = {
  none: {
    label: 'No priority',
    dot: 'bg-slate-300',
    chip: 'bg-slate-100 text-slate-500',
    text: 'text-slate-400',
  },
  low: {
    label: 'Low',
    dot: 'bg-emerald-400',
    chip: 'bg-emerald-50 text-emerald-600',
    text: 'text-emerald-500',
  },
  medium: {
    label: 'Medium',
    dot: 'bg-amber-400',
    chip: 'bg-amber-50 text-amber-600',
    text: 'text-amber-500',
  },
  high: {
    label: 'High',
    dot: 'bg-rose-400',
    chip: 'bg-rose-50 text-rose-500',
    text: 'text-rose-500',
  },
}

/**
 * Sticky-note palette: gray for no priority, green for low, yellow for medium,
 * light red for high. Bright pastel paper with dark ink keeps the notes soft
 * and readable without an outline.
 */
export const STICKY_META: Record<
  Priority,
  { note: string; tape: string; chip: string; muted: string; check: string }
> = {
  none: {
    note: 'bg-[#E6E8EB] text-[#3A404B]',
    tape: 'bg-slate-200/90',
    chip: 'bg-white/65 ring-1 ring-black/5',
    muted: 'text-[#3A404B]/85',
    check: 'border-[#7B8190] text-transparent hover:border-[#3A404B] hover:text-[#3A404B]',
  },
  low: {
    note: 'bg-[#4aa96c]/30 text-[#14532d]',
    tape: 'bg-emerald-100/90',
    chip: 'bg-white/65 ring-1 ring-black/5',
    muted: 'text-[#166534]/85',
    check: 'border-[#4aa96c] text-transparent hover:border-[#166534] hover:text-[#166534]',
  },
  medium: {
    note: 'bg-[#fdf5e6] text-[#713f12]',
    tape: 'bg-[#f3e4c8]/90',
    chip: 'bg-white/65 ring-1 ring-black/5',
    muted: 'text-[#854d0e]/85',
    check: 'border-[#d9a520] text-transparent hover:border-[#854d0e] hover:text-[#854d0e]',
  },
  high: {
    note: 'bg-[#e0716a]/30 text-[#7f1d1d]',
    tape: 'bg-rose-100/90',
    chip: 'bg-white/65 ring-1 ring-black/5',
    muted: 'text-[#991b1b]/85',
    check: 'border-[#e0716a] text-transparent hover:border-[#991b1b] hover:text-[#991b1b]',
  },
}

export const RECURRENCE_VALUES: Recurrence[] = ['none', 'daily', 'weekly', 'monthly', 'custom']

export const RECURRENCE_META: Record<Recurrence, { label: string; short: string }> = {
  none: { label: 'Does not repeat', short: '' },
  daily: { label: 'Every day', short: 'Daily' },
  weekly: { label: 'Every week', short: 'Weekly' },
  monthly: { label: 'Every month', short: 'Monthly' },
  custom: { label: 'Custom…', short: 'Custom' },
}

export const WEEKDAY_LABELS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
]

export const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export const WEEKDAY_LETTERS = ['S', 'M', 'T', 'W', 'T', 'F', 'S']

export const NTH_LABELS = ['First', 'Second', 'Third', 'Fourth', 'Last']

/** Human sentence for a repeat rule, e.g. "Every Tue, Thu" or "First Tuesday of each month". */
export function describeRecurrence(
  recurrence: Recurrence,
  config: RecurrenceConfig | null,
): string {
  switch (recurrence) {
    case 'daily':
      return 'Every day'
    case 'weekly':
      return 'Every week'
    case 'monthly':
      return 'Every month'
    case 'custom': {
      if (!config) return 'Custom repeat'
      if (config.mode === 'weekly') {
        const days = [...config.days].sort((a, b) => a - b)
        if (days.length === 7) return 'Every day'
        if (days.length === 1) return `Every ${WEEKDAY_LABELS[days[0]]}`
        return `Every ${days.map((day) => WEEKDAY_SHORT[day]).join(', ')}`
      }
      const nth = NTH_LABELS[config.nth - 1] ?? 'First'
      return `${nth} ${WEEKDAY_LABELS[config.weekday]} of each month`
    }
    default:
      return ''
  }
}

/** Short label for badges on cards. */
export function recurrenceShort(recurrence: Recurrence, config: RecurrenceConfig | null): string {
  if (recurrence === 'custom' && config) {
    if (config.mode === 'weekly') {
      if (config.days.length === 7) return 'Daily'
      return [...config.days]
        .sort((a, b) => a - b)
        .map((day) => WEEKDAY_SHORT[day])
        .join(', ')
    }
    return `${NTH_LABELS[config.nth - 1] ?? 'First'} ${WEEKDAY_SHORT[config.weekday]}`
  }
  return RECURRENCE_META[recurrence].short
}

/** Format a minutes estimate as "45 min", "1 hr" or "1 hr 30 min". */
export function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `${hours} hr` : `${hours} hr ${rest} min`
}

/**
 * A short list of handy preset tags offered as one-tap chips, so tagging a task
 * is as quick as picking a priority.
 */
export const COMMON_TAGS = [
  'Work',
  'Personal',
  'Meeting',
  'Errand',
  'Shopping',
  'Health',
  'Finance',
  'Follow-up',
]

export const TAG_LIMIT = 8

const TAG_TINTS = [
  'bg-indigo-50 text-indigo-600',
  'bg-emerald-50 text-emerald-600',
  'bg-sky-50 text-sky-600',
  'bg-amber-50 text-amber-700',
  'bg-rose-50 text-rose-600',
  'bg-violet-50 text-violet-600',
  'bg-teal-50 text-teal-600',
  'bg-fuchsia-50 text-fuchsia-600',
]

/** Stable tint for a tag name, so the same tag always looks the same. */
export function tagTint(tag: string): string {
  let hash = 0
  for (let i = 0; i < tag.length; i += 1) hash = (hash * 31 + tag.charCodeAt(i)) % 997
  return TAG_TINTS[hash % TAG_TINTS.length]
}

