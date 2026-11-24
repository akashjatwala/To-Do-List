import type { Priority, Task, Team } from '@/types'
import { dateInputValue } from './date'

export type SearchStatus = 'all' | 'open' | 'completed' | 'repeating'
export type SearchDue = 'any' | 'overdue' | 'today' | 'future' | 'none'
export type SearchPriority = 'all' | Priority

export interface TaskSearchFilters {
  /** `all`, `personal`, or a team id. */
  scope: string
  status: SearchStatus
  priority: SearchPriority
  due: SearchDue
  /** Empty means every tag. */
  tag: string
  /** `any`, `me`, `unassigned`, or an assignee id as a string. */
  assignee: string
}

export interface SearchOption {
  value: string
  label: string
}

export const defaultTaskSearchFilters: TaskSearchFilters = {
  scope: 'all',
  status: 'all',
  priority: 'all',
  due: 'any',
  tag: '',
  assignee: 'any',
}

function normalized(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim()
}

export function searchTokens(query: string): string[] {
  return normalized(query).split(' ').filter(Boolean)
}

/**
 * Title suggestions for the Search field. This mirrors New Task autocomplete:
 * tokenized matching anywhere in a title, exact full matches excluded, ranked
 * by frequency then recency. Scope uses the same values as the Scope filter.
 */
export function suggestSearchTitles(
  tasks: Task[],
  query: string,
  scope: string,
  limit = 5,
): string[] {
  const needle = normalized(query)
  const tokens = needle ? needle.split(' ').filter(Boolean) : []
  if (!tokens.length) return []

  const matches = new Map<string, { title: string; count: number; last: number }>()
  for (const task of tasks) {
    if (scope === 'personal' && task.teamId !== null) continue
    if (scope !== 'all' && scope !== 'personal' && task.teamId !== scope) continue
    const title = task.text.trim().replace(/\s+/g, ' ')
    if (!title) continue
    const key = title.toLowerCase()
    if (key === needle || !tokens.every((token) => key.includes(token))) continue
    const last = task.due ?? task.createdAt
    const current = matches.get(key)
    if (current) {
      current.count += 1
      current.last = Math.max(current.last, last)
    } else {
      matches.set(key, { title, count: 1, last })
    }
  }

  return [...matches.values()]
    .sort((a, b) => b.count - a.count || b.last - a.last || a.title.localeCompare(b.title))
    .slice(0, limit)
    .map((match) => match.title)
}

interface SearchFields {
  title: string
  tags: string
  people: string
  details: string
}

function fieldsOf(task: Task): SearchFields {
  return {
    title: normalized(task.text),
    tags: normalized(task.tags.join(' ')),
    people: normalized(
      [
        ...task.assignees.flatMap((assignee) => [assignee.name, assignee.email]),
        task.ownerEmail,
      ].join(' '),
    ),
    details: normalized(
      [
        ...task.subtasks.map((subtask) => subtask.text),
        ...task.comments.flatMap((comment) => [comment.text, comment.email]),
      ].join(' '),
    ),
  }
}

/** Higher is a better field; `null` means the token did not match. */
function tokenScore(fields: SearchFields, token: string): number | null {
  if (fields.title === token) return 5
  if (fields.title.startsWith(token)) return 4
  if (fields.title.includes(token)) return 3
  if (fields.tags.includes(token)) return 2
  if (fields.people.includes(token)) return 1
  if (fields.details.includes(token)) return 0
  return null
}

function matchScore(task: Task, query: string, tokens: string[]): number | null {
  if (tokens.length === 0) return 0
  const fields = fieldsOf(task)
  let score = 0
  for (const token of tokens) {
    const value = tokenScore(fields, token)
    if (value === null) return null
    score += value
  }
  const whole = normalized(query)
  if (fields.title === whole) score += 10
  else if (fields.title.startsWith(whole)) score += 4
  return score
}

function matchesFilters(
  task: Task,
  filters: TaskSearchFilters,
  currentUserId: number,
  todayValue: string,
): boolean {
  if (filters.scope === 'personal' && task.teamId !== null) return false
  if (filters.scope !== 'all' && filters.scope !== 'personal' && task.teamId !== filters.scope) return false

  if (filters.status === 'open' && (task.done || task.recurrence !== 'none')) return false
  if (filters.status === 'completed' && (!task.done || task.recurrence !== 'none')) return false
  if (filters.status === 'repeating' && task.recurrence === 'none') return false

  if (filters.priority !== 'all' && task.priority !== filters.priority) return false

  if (filters.tag && !task.tags.some((tag) => normalized(tag) === normalized(filters.tag))) return false

  const dueDate = task.due === null ? '' : dateInputValue(task.due)
  if (filters.due === 'none' && task.due !== null) return false
  if (filters.due === 'overdue' && (dueDate === '' || dueDate >= todayValue || task.done)) return false
  if (filters.due === 'today' && dueDate !== todayValue) return false
  if (filters.due === 'future' && (dueDate === '' || dueDate <= todayValue)) return false

  if (filters.assignee === 'me') {
    const isMine =
      task.teamId === null
        ? task.userId === currentUserId
        : task.assignees.some((assignee) => assignee.id === currentUserId)
    if (!isMine) return false
  } else if (filters.assignee === 'unassigned') {
    if (task.assignees.length > 0) return false
  } else if (filters.assignee !== 'any') {
    if (!task.assignees.some((assignee) => String(assignee.id) === filters.assignee)) return false
  }

  return true
}

/** Filter and rank the tasks already present in `bootstrap`. */
export function searchTasks(
  tasks: Task[],
  query: string,
  filters: TaskSearchFilters,
  currentUserId: number,
  todayValue: string,
): Task[] {
  const tokens = searchTokens(query)
  const scored = tasks
    .filter((task) => matchesFilters(task, filters, currentUserId, todayValue))
    .map((task) => ({ task, score: matchScore(task, query, tokens) }))
    .filter((entry): entry is { task: Task; score: number } => entry.score !== null)

  scored.sort((a, b) => {
    if (tokens.length > 0 && a.score !== b.score) return b.score - a.score
    const dueA = a.task.due ?? Number.MAX_SAFE_INTEGER
    const dueB = b.task.due ?? Number.MAX_SAFE_INTEGER
    if (dueA !== dueB) return dueA - dueB
    return a.task.text.localeCompare(b.task.text)
  })

  return scored.map((entry) => entry.task)
}

export function searchScopeOptions(tasks: Task[], teams: Team[]): SearchOption[] {
  const teamIds = new Set(teams.map((team) => team.id))
  for (const task of tasks) if (task.teamId) teamIds.add(task.teamId)
  return [
    { value: 'all', label: 'All tasks' },
    { value: 'personal', label: 'Personal' },
    ...teams
      .filter((team) => teamIds.has(team.id))
      .map((team) => ({ value: team.id, label: team.name })),
  ]
}

export function searchTagOptions(tasks: Task[]): string[] {
  const tags = new Set<string>()
  for (const task of tasks) for (const tag of task.tags) tags.add(tag)
  return [...tags].sort((a, b) => a.localeCompare(b))
}

function personLabel(name: string, email: string): string {
  return name.trim() || email.split('@')[0]
}

export function searchAssigneeOptions(
  tasks: Task[],
  teams: Team[],
  currentUserId?: number,
): SearchOption[] {
  const people = new Map<number, string>()
  for (const task of tasks) {
    for (const assignee of task.assignees) {
      if (assignee.id === currentUserId) continue
      people.set(assignee.id, personLabel(assignee.name, assignee.email))
    }
  }
  for (const team of teams) {
    for (const member of team.members) {
      if (member.id === currentUserId) continue
      people.set(member.id, personLabel('', member.email))
    }
  }
  return [
    { value: 'any', label: 'Anyone' },
    { value: 'me', label: 'Me' },
    { value: 'unassigned', label: 'Unassigned' },
    ...[...people.entries()]
      .sort((a, b) => a[1].localeCompare(b[1]))
      .map(([id, label]) => ({ value: String(id), label })),
  ]
}
