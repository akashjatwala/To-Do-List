import type { Priority, Recurrence, RecurrenceConfig } from '@/types'

export const PRIORITY_VALUES: Priority[] = ['none', 'low', 'medium', 'high']

export const PRIORITY_META: Record<
  Priority,
  { label: string; dot: string; chip: string; text: string }
> = {
  none: {
    label: 'No priority',
    dot: 'bg-slate-300 dark:bg-slate-600',
    chip: 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400',
    text: 'text-slate-400 dark:text-slate-500',
  },
  low: {
    label: 'Low',
    dot: 'bg-emerald-400',
    chip: 'bg-emerald-50 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-300',
    text: 'text-emerald-500 dark:text-emerald-400',
  },
  medium: {
    label: 'Medium',
    dot: 'bg-amber-400',
    chip: 'bg-amber-50 text-amber-600 dark:bg-amber-500/15 dark:text-amber-300',
    text: 'text-amber-500 dark:text-amber-400',
  },
  high: {
    label: 'High',
    dot: 'bg-rose-400',
    chip: 'bg-rose-50 text-rose-500 dark:bg-rose-500/15 dark:text-rose-300',
    text: 'text-rose-500 dark:text-rose-400',
  },
  urgent: {
    label: 'Urgent',
    dot: 'bg-red-600',
    chip: 'bg-red-50 text-red-700 dark:bg-red-500/15 dark:text-red-300',
    text: 'text-red-600 dark:text-red-400',
  },
}

/**
 * Sticky-note palette: green for low, yellow for medium, light red for high,
 * deep red for urgent. Bright pastel paper with dark ink and a thick, inked
 * border gives the notes a cartoon sticker feel.
 */
export const STICKY_META: Record<
  Priority,
  { note: string; tape: string; chip: string; muted: string; check: string }
> = {
  none: {
    note: 'border-[#caa85c]/70 bg-[#fff7d6] text-[#6b4f1d] dark:border-amber-200/25 dark:bg-[#3a3324] dark:text-amber-50',
    tape: 'bg-amber-100/90 dark:bg-amber-200/30',
    chip: 'bg-white/65 ring-1 ring-black/5 dark:bg-white/10 dark:ring-white/10',
    muted: 'text-[#8a6a2f]/85 dark:text-amber-100/75',
    check: 'border-[#b08a45]/70 text-transparent hover:border-[#8a6a2f] hover:text-[#8a6a2f] dark:border-amber-200/40 dark:hover:text-amber-100',
  },
  low: {
    note: 'border-[#4aa96c]/70 bg-[#4aa96c]/30 text-[#14532d] dark:border-emerald-300/25 dark:bg-emerald-500/20 dark:text-emerald-50',
    tape: 'bg-emerald-100/90 dark:bg-emerald-200/30',
    chip: 'bg-white/65 ring-1 ring-black/5 dark:bg-white/10 dark:ring-white/10',
    muted: 'text-[#166534]/85 dark:text-emerald-100/80',
    check: 'border-[#4aa96c] text-transparent hover:border-[#166534] hover:text-[#166534] dark:border-emerald-300/50 dark:hover:text-emerald-100',
  },
  medium: {
    note: 'border-[#e0b23c]/80 bg-[#fff7d6] text-[#713f12] dark:border-amber-300/25 dark:bg-amber-500/20 dark:text-amber-50',
    tape: 'bg-amber-100/90 dark:bg-amber-200/30',
    chip: 'bg-white/65 ring-1 ring-black/5 dark:bg-white/10 dark:ring-white/10',
    muted: 'text-[#854d0e]/85 dark:text-amber-100/80',
    check: 'border-[#d9a520] text-transparent hover:border-[#854d0e] hover:text-[#854d0e] dark:border-amber-300/50 dark:hover:text-amber-100',
  },
  high: {
    note: 'border-[#e0716a]/80 bg-[#e0716a]/30 text-[#7f1d1d] dark:border-rose-300/25 dark:bg-rose-500/20 dark:text-rose-50',
    tape: 'bg-rose-100/90 dark:bg-rose-200/30',
    chip: 'bg-white/65 ring-1 ring-black/5 dark:bg-white/10 dark:ring-white/10',
    muted: 'text-[#991b1b]/85 dark:text-rose-100/80',
    check: 'border-[#e0716a] text-transparent hover:border-[#991b1b] hover:text-[#991b1b] dark:border-rose-300/50 dark:hover:text-rose-100',
  },
  urgent: {
    note: 'border-rose-950/40 bg-[#c81e3f] text-rose-50 dark:border-rose-950/60 dark:bg-[#8f1730]',
    tape: 'bg-white/30 dark:bg-white/20',
    chip: 'bg-white/15 ring-1 ring-white/10',
    muted: 'text-rose-100/80',
    check: 'border-rose-200/50 text-transparent hover:border-rose-50 hover:text-rose-50',
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
  'bg-indigo-50 text-indigo-600 dark:bg-indigo-500/15 dark:text-indigo-300',
  'bg-emerald-50 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-300',
  'bg-sky-50 text-sky-600 dark:bg-sky-500/15 dark:text-sky-300',
  'bg-amber-50 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300',
  'bg-rose-50 text-rose-600 dark:bg-rose-500/15 dark:text-rose-300',
  'bg-violet-50 text-violet-600 dark:bg-violet-500/15 dark:text-violet-300',
  'bg-teal-50 text-teal-600 dark:bg-teal-500/15 dark:text-teal-300',
  'bg-fuchsia-50 text-fuchsia-600 dark:bg-fuchsia-500/15 dark:text-fuchsia-300',
]

/** Stable tint for a tag name, so the same tag always looks the same. */
export function tagTint(tag: string): string {
  let hash = 0
  for (let i = 0; i < tag.length; i += 1) hash = (hash * 31 + tag.charCodeAt(i)) % 997
  return TAG_TINTS[hash % TAG_TINTS.length]
}

