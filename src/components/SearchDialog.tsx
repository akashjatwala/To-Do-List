import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { Task, Team } from '@/types'
import {
  defaultTaskSearchFilters,
  searchAssigneeOptions,
  searchScopeOptions,
  searchTagOptions,
  searchTasks,
  suggestSearchTitles,
  type SearchDue,
  type SearchPriority,
  type SearchStatus,
  type TaskSearchFilters,
} from '@/lib/taskSearch'
import { StickyBoard } from './StickyBoard'
import { Modal } from './ui'
import { SearchIcon } from './Icons'

const STATUS_OPTIONS: { value: SearchStatus; label: string }[] = [
  { value: 'all', label: 'All statuses' },
  { value: 'open', label: 'Open' },
  { value: 'completed', label: 'Completed' },
  { value: 'repeating', label: 'Repeating' },
]

const PRIORITY_OPTIONS: { value: SearchPriority; label: string }[] = [
  { value: 'all', label: 'All priorities' },
  { value: 'none', label: 'None' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
]

const DUE_OPTIONS: { value: SearchDue; label: string }[] = [
  { value: 'any', label: 'Any due date' },
  { value: 'overdue', label: 'Overdue' },
  { value: 'today', label: 'Today' },
  { value: 'future', label: 'Future' },
  { value: 'none', label: 'No date' },
]

interface SearchDialogProps {
  open: boolean
  tasks: Task[]
  teams: Team[]
  currentUserId: number
  todayValue: string
  canDelete: (task: Task) => boolean
  onClose: () => void
  onOpenTask: (task: Task) => void
  onToggleTask: (task: Task) => void
  onDeleteTask: (task: Task) => void
  /** Optional starting criteria, mainly for tests and future deep links. */
  initialQuery?: string
  initialFilters?: TaskSearchFilters
}

/** Local-only task search over the bootstrap payload. No API or schema change. */
export default function SearchDialog({
  open,
  tasks,
  teams,
  currentUserId,
  todayValue,
  canDelete,
  onClose,
  onOpenTask,
  onToggleTask,
  onDeleteTask,
  initialQuery = '',
  initialFilters = defaultTaskSearchFilters,
}: SearchDialogProps) {
  const [query, setQuery] = useState(initialQuery)
  const [filters, setFilters] = useState<TaskSearchFilters>(initialFilters)
  const [suggestionsOpen, setSuggestionsOpen] = useState(false)
  const [highlight, setHighlight] = useState(-1)
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (!open) return
    setQuery(initialQuery)
    setFilters(initialFilters)
    setSuggestionsOpen(false)
    setHighlight(-1)
    inputRef.current?.focus()
  }, [open, initialQuery, initialFilters])

  const hasCriteria =
    query.trim().length > 0 ||
    (Object.keys(defaultTaskSearchFilters) as Array<keyof TaskSearchFilters>).some(
      (key) => filters[key] !== defaultTaskSearchFilters[key],
    )

  const suggestions = useMemo(
    () => suggestSearchTitles(tasks, query, filters.scope),
    [tasks, query, filters.scope],
  )
  const showSuggestions = suggestionsOpen && suggestions.length > 0

  // No criteria means no notes: the board only appears once the user searches.
  const results = useMemo(
    () => (hasCriteria ? searchTasks(tasks, query, filters, currentUserId, todayValue) : []),
    [hasCriteria, tasks, query, filters, currentUserId, todayValue],
  )
  const scopeOptions = useMemo(() => searchScopeOptions(tasks, teams), [tasks, teams])
  const tagOptions = useMemo(() => searchTagOptions(tasks), [tasks])
  const assigneeOptions = useMemo(
    () => searchAssigneeOptions(tasks, teams, currentUserId),
    [tasks, teams, currentUserId],
  )

  const setFilter = <K extends keyof TaskSearchFilters>(key: K, value: TaskSearchFilters[K]) => {
    setFilters((current) => ({ ...current, [key]: value }))
  }

  const chooseSuggestion = (title: string) => {
    setQuery(title)
    setSuggestionsOpen(false)
    setHighlight(-1)
    inputRef.current?.focus()
  }

  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (!showSuggestions) return
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setHighlight((current) => (current + 1) % suggestions.length)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setHighlight((current) => (current <= 0 ? suggestions.length - 1 : current - 1))
    } else if (event.key === 'Enter' && highlight >= 0) {
      event.preventDefault()
      chooseSuggestion(suggestions[highlight])
    } else if (event.key === 'Escape') {
      event.preventDefault()
      setSuggestionsOpen(false)
      setHighlight(-1)
    }
  }

  const clearSearch = () => {
    setQuery('')
    setFilters(defaultTaskSearchFilters)
    setSuggestionsOpen(false)
    setHighlight(-1)
    inputRef.current?.focus()
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Search tasks"
      width="max-w-6xl"
    >
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <div className="relative flex min-w-0 flex-1 items-center">
            <SearchIcon className="pointer-events-none absolute left-3 h-4 w-4 text-slate-400" />
            <input
              ref={inputRef}
              type="search"
              value={query}
              onChange={(event) => {
                const value = event.target.value
                setQuery(value)
                setHighlight(-1)
                setSuggestionsOpen(value.trim().length > 0)
              }}
              onFocus={() => setSuggestionsOpen(query.trim().length > 0)}
              onBlur={() => {
                setSuggestionsOpen(false)
                setHighlight(-1)
              }}
              onKeyDown={onSearchKeyDown}
              placeholder="Search titles, tags, people, subtasks or comments"
              aria-label="Search tasks"
              className="field text-base pl-9"
              autoComplete="off"
              role="combobox"
              aria-autocomplete="list"
              aria-expanded={showSuggestions}
              aria-controls="search-task-suggestions"
              aria-activedescendant={
                showSuggestions && highlight >= 0 ? `search-task-suggestion-${highlight}` : undefined
              }
            />
            {showSuggestions && (
              <div
                id="search-task-suggestions"
                role="listbox"
                aria-label="Task title suggestions"
                className="absolute top-full right-0 left-0 z-30 mt-1 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-lg"
              >
                <p className="px-3 pt-2 pb-1 text-[10px] font-bold tracking-wide text-slate-400">
                  From your tasks
                </p>
                {suggestions.map((title, index) => (
                  <button
                    key={title}
                    id={`search-task-suggestion-${index}`}
                    type="button"
                    role="option"
                    aria-selected={index === highlight}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => chooseSuggestion(title)}
                    className={`block w-full px-3 py-2 text-left text-sm transition ${
                      index === highlight
                        ? 'bg-[#FDF3E7] font-semibold text-[#8A3210]'
                        : 'text-[#3A404B] hover:bg-slate-50'
                    }`}
                  >
                    {title}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={clearSearch}
            disabled={!hasCriteria}
            aria-label="Clear search"
            className="btn-ghost shrink-0"
          >
            Clear search
          </button>
        </div>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
          <label className="block">
            <span className="mb-1 block text-[11px] font-semibold text-slate-500">Scope</span>
            <select
              className="field py-2 text-xs"
              value={filters.scope}
              onChange={(event) => setFilter('scope', event.target.value)}
              aria-label="Scope"
            >
              {scopeOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="mb-1 block text-[11px] font-semibold text-slate-500">Status</span>
            <select
              className="field py-2 text-xs"
              value={filters.status}
              onChange={(event) => setFilter('status', event.target.value as SearchStatus)}
              aria-label="Status"
            >
              {STATUS_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="mb-1 block text-[11px] font-semibold text-slate-500">Priority</span>
            <select
              className="field py-2 text-xs"
              value={filters.priority}
              onChange={(event) => setFilter('priority', event.target.value as SearchPriority)}
              aria-label="Priority"
            >
              {PRIORITY_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="mb-1 block text-[11px] font-semibold text-slate-500">Due date</span>
            <select
              className="field py-2 text-xs"
              value={filters.due}
              onChange={(event) => setFilter('due', event.target.value as SearchDue)}
              aria-label="Due date"
            >
              {DUE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="mb-1 block text-[11px] font-semibold text-slate-500">Tag</span>
            <select
              className="field py-2 text-xs"
              value={filters.tag}
              onChange={(event) => setFilter('tag', event.target.value)}
              aria-label="Tag"
            >
              <option value="">All tags</option>
              {tagOptions.map((tag) => (
                <option key={tag} value={tag}>
                  #{tag}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="mb-1 block text-[11px] font-semibold text-slate-500">Assignee</span>
            <select
              className="field py-2 text-xs"
              value={filters.assignee}
              onChange={(event) => setFilter('assignee', event.target.value)}
              aria-label="Assignee"
            >
              {assigneeOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        {hasCriteria ? (
          <StickyBoard
            tasks={results}
            emptyTitle="No matching tasks"
            emptyText="Try another search or filter."
            currentUserId={currentUserId}
            showOwner
            canDelete={canDelete}
            onOpen={onOpenTask}
            onToggle={onToggleTask}
            onDelete={onDeleteTask}
            onReorder={() => undefined}
            allowReorder={false}
          />
        ) : (
          <div className="rounded-2xl border border-dashed border-slate-200 bg-white px-6 py-10 text-center">
            <p className="text-sm font-semibold text-slate-700">Nothing to show yet</p>
            <p className="mt-1 text-xs text-slate-500">
              Enter a search term or choose a filter to see matching tasks.
            </p>
          </div>
        )}
      </div>
    </Modal>
  )
}
