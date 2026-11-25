import type { Priority, Recurrence, Task } from '@/types'

/**
 * Reusable task field sets, stored in this browser only.
 *
 * Favourites deliberately do not include a preferred time or an absolute date.
 * They speed up the fields people retype; the date still comes from the board,
 * so a reused note never inherits a stale day or a hidden time label.
 */
export interface TaskFavouriteFields {
  text: string
  priority: Priority
  tags: string[]
  recurrence: Recurrence
  duration: number | null
  teamId: string | null
}

export interface TaskFavourite extends TaskFavouriteFields {
  id: string
  name: string
}

export const FAVOURITE_LIMIT = 12

/**
 * Demo accounts start with a few built-in favourites so the Favourites section
 * is immediately visible. They are browser-local like every other favourite:
 * stable ids and names make them reseed-safe, and no date or time hint is copied.
 */
export const DEMO_FAVOURITE_EMAILS = new Set([
  'ml-demo@example.com',
  'ml-demo-mate@example.com',
  'ml-demo-priya@example.com',
])

export const DEMO_FAVOURITES: TaskFavourite[] = [
  {
    id: 'demo-favourite-weekly-review',
    name: 'Weekly review',
    text: 'Write weekly review',
    priority: 'medium',
    tags: ['work', 'follow-up'],
    recurrence: 'weekly',
    duration: 30,
    teamId: null,
  },
  {
    id: 'demo-favourite-launch-check',
    name: 'Launch check',
    text: 'Check launch checklist',
    priority: 'high',
    tags: ['work', 'demo'],
    recurrence: 'none',
    duration: 15,
    teamId: 'demo-launch-crew',
  },
  {
    id: 'demo-favourite-deep-work',
    name: 'Deep work',
    text: 'Deep work block',
    priority: 'none',
    tags: ['work'],
    recurrence: 'daily',
    duration: 75,
    teamId: null,
  },
  {
    id: 'demo-favourite-bill',
    name: 'Pay a bill',
    text: 'Pay electricity bill',
    priority: 'low',
    tags: ['finance', 'errand'],
    recurrence: 'monthly',
    duration: 15,
    teamId: null,
  },
]

const storageKey = (userId: number) => `duit.task-favourites.${userId}`
const legacyStorageKey = (userId: number) => `duit.task-templates.${userId}`

const PRIORITIES: Priority[] = ['none', 'low', 'medium', 'high']
const RECURRENCES: Recurrence[] = ['none', 'daily', 'weekly', 'monthly', 'custom']

function asFields(value: unknown): TaskFavouriteFields | null {
  if (!value || typeof value !== 'object') return null
  const row = value as Record<string, unknown>
  if (typeof row.text !== 'string' || !row.text.trim()) return null
  return {
    text: row.text.trim(),
    priority: PRIORITIES.includes(row.priority as Priority) ? (row.priority as Priority) : 'none',
    tags: Array.isArray(row.tags)
      ? row.tags.filter((tag): tag is string => typeof tag === 'string').slice(0, 8)
      : [],
    recurrence: RECURRENCES.includes(row.recurrence as Recurrence)
      ? (row.recurrence as Recurrence)
      : 'none',
    duration:
      typeof row.duration === 'number' && Number.isFinite(row.duration) && row.duration > 0
        ? Math.floor(row.duration)
        : null,
    teamId: typeof row.teamId === 'string' ? row.teamId : null,
  }
}

function parseFavourites(raw: string | null): TaskFavourite[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .flatMap((row): TaskFavourite[] => {
        const fields = asFields(row)
        if (!fields || !row || typeof row !== 'object') return []
        const record = row as Record<string, unknown>
        if (typeof record.id !== 'string' || typeof record.name !== 'string') return []
        return [{ ...fields, id: record.id, name: record.name.trim() || fields.text }]
      })
      .slice(0, FAVOURITE_LIMIT)
  } catch {
    return []
  }
}

/** Fresh copies; callers can edit tags without changing the built-in set. */
export function demoFavouritesForEmail(email: string | undefined): TaskFavourite[] {
  if (!email || !DEMO_FAVOURITE_EMAILS.has(email.trim().toLowerCase())) return []
  return DEMO_FAVOURITES.map((favourite) => ({ ...favourite, tags: [...favourite.tags] }))
}

/** Copy the reusable fields from a task; never its date, time hint or done state. */
export function taskFieldsFromTask(task: Task): TaskFavouriteFields {
  return {
    text: task.text,
    priority: task.priority,
    tags: [...task.tags],
    recurrence: task.recurrence,
    duration: task.duration,
    teamId: task.teamId,
  }
}

/** Read favourites from local storage. Corrupt or unavailable storage is ignored. */
export function readTaskFavourites(userId: number, userEmail?: string): TaskFavourite[] {
  const builtIns = demoFavouritesForEmail(userEmail)
  if (typeof window === 'undefined') return builtIns
  try {
    const current = window.localStorage.getItem(storageKey(userId))
    let stored = parseFavourites(current)
    // The feature used to be called Templates; carry saved entries forward once.
    if (!current) {
      const legacy = parseFavourites(window.localStorage.getItem(legacyStorageKey(userId)))
      if (legacy.length > 0) {
        stored = legacy
        writeTaskFavourites(userId, stored)
      }
    }

    // Built-ins fill the list without overwriting a saved favourite of the same
    // name or id. Writing them back keeps the demo stable across reloads.
    const storedIds = new Set(stored.map((favourite) => favourite.id))
    const storedNames = new Set(stored.map((favourite) => favourite.name.trim().toLowerCase()))
    const missingBuiltIns = builtIns.filter(
      (favourite) =>
        !storedIds.has(favourite.id) &&
        !storedNames.has(favourite.name.trim().toLowerCase()),
    )
    const next = [...missingBuiltIns, ...stored].slice(0, FAVOURITE_LIMIT)
    if (builtIns.length > 0 && JSON.stringify(next) !== JSON.stringify(stored)) {
      writeTaskFavourites(userId, next)
    }
    return next
  } catch {
    return builtIns
  }
}

/** Persist favourites in local storage, keeping the newest set bounded. */
export function writeTaskFavourites(
  userId: number,
  favourites: TaskFavourite[],
): TaskFavourite[] {
  const next = favourites.slice(0, FAVOURITE_LIMIT)
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(storageKey(userId), JSON.stringify(next))
    } catch {
      // Private browsing or a full quota must not block task creation.
    }
  }
  return next
}

/** Stable-enough id for a browser-local list; no server record is created. */
export function newFavouriteId(): string {
  return `fav-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}
