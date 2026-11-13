import type { Priority, Recurrence } from '@/types'

export const PRIORITY_VALUES: Priority[] = ['none', 'low', 'medium', 'high', 'urgent']

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
    dot: 'bg-sky-400',
    chip: 'bg-sky-50 text-sky-600 dark:bg-sky-500/15 dark:text-sky-300',
    text: 'text-sky-500 dark:text-sky-400',
  },
  medium: {
    label: 'Medium',
    dot: 'bg-amber-400',
    chip: 'bg-amber-50 text-amber-600 dark:bg-amber-500/15 dark:text-amber-300',
    text: 'text-amber-500 dark:text-amber-400',
  },
  high: {
    label: 'High',
    dot: 'bg-orange-500',
    chip: 'bg-orange-50 text-orange-600 dark:bg-orange-500/15 dark:text-orange-300',
    text: 'text-orange-500 dark:text-orange-400',
  },
  urgent: {
    label: 'Urgent',
    dot: 'bg-rose-500',
    chip: 'bg-rose-50 text-rose-600 dark:bg-rose-500/15 dark:text-rose-300',
    text: 'text-rose-500 dark:text-rose-400',
  },
}

/** Ordered from most to least urgent, for the filter dropdown. */
export const PRIORITY_FILTERS: Array<{ value: Priority | 'all'; label: string }> = [
  { value: 'all', label: 'All priorities' },
  { value: 'urgent', label: 'Urgent' },
  { value: 'high', label: 'High' },
  { value: 'medium', label: 'Medium' },
  { value: 'low', label: 'Low' },
  { value: 'none', label: 'No priority' },
]

export const RECURRENCE_VALUES: Recurrence[] = ['none', 'daily', 'weekly', 'monthly']

export const RECURRENCE_META: Record<Recurrence, { label: string; short: string }> = {
  none: { label: 'Does not repeat', short: '' },
  daily: { label: 'Every day', short: 'Daily' },
  weekly: { label: 'Every week', short: 'Weekly' },
  monthly: { label: 'Every month', short: 'Monthly' },
}

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

/** Parse a comma-separated tag string into a clean, deduped list. */
export function parseTagInput(value: string): string[] {
  const out: string[] = []
  for (const piece of value.split(',')) {
    const tag = piece.trim().replace(/\s+/g, ' ')
    if (!tag) continue
    if (!out.includes(tag)) out.push(tag)
  }
  return out
}
