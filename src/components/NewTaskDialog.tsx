import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import type { Priority, Recurrence, RecurrenceConfig, Task, Team } from '@/types'
import { dueFromDateInput, formatDateValue } from '@/lib/date'
import { parseQuickAdd } from '@/lib/quickAdd'
import {
  COMMON_TAGS,
  PRIORITY_META,
  PRIORITY_VALUES,
  RECURRENCE_META,
  STICKY_META,
  TAG_LIMIT,
  tagTint,
} from '@/lib/taskmeta'
import {
  CalendarIcon,
  PlusIcon,
  RepeatIcon,
  SparklesIcon,
  TagIcon,
  UsersIcon,
  XIcon,
} from './Icons'
import { Modal, Spinner } from './ui'

export interface NewTaskInput {
  text: string
  due: number | null
  priority: Priority
  tags: string[]
  recurrence: Recurrence
  recurrenceConfig: RecurrenceConfig | null
  duration: number | null
  preferredTime: string | null
  teamId: string | null
}

const DURATION_MAX = 60 * 24 * 7
const DURATION_PRESETS = [15, 30, 45, 60, 120]
const RECURRENCE_CHOICES: Recurrence[] = ['none', 'daily', 'weekly', 'monthly']

/** Pastel paper palette, with None and Medium adjusted to stay distinct from the preview. */
const PRIORITY_CHIP: Record<Priority, string> = {
  none: 'border-[#7B8190]/80 bg-[#E6E8EB] text-[#3A404B]',
  low: STICKY_META.low.note,
  medium: 'border-[#D9A520]/80 bg-[#F5E9A8] text-[#6B5400]',
  high: STICKY_META.high.note,
}

const FIELD_LABEL = 'label normal-case tracking-normal'

const chipClass = (active: boolean) =>
  `rounded-lg px-3 py-1.5 text-xs font-semibold transition focus-visible:ring-4 focus-visible:ring-[#D9480F]/20 focus-visible:outline-none ${
    active
      ? 'bg-[#D9480F] text-white shadow-sm'
      : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
  }`

function previewDate(value: string): string {
  const timestamp = dueFromDateInput(value)
  if (timestamp === null) return 'No date'
  return new Date(timestamp).toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  })
}

/** Titles already used in this list, ranked by frequency then recency. */
export function suggestTaskTitles(
  tasks: Task[],
  query: string,
  teamId: string | null,
  limit = 5,
): string[] {
  const needle = query.trim().replace(/\s+/g, ' ').toLowerCase()
  const tokens = needle ? needle.split(' ').filter(Boolean) : []
  const matches = new Map<string, { title: string; count: number; last: number }>()

  for (const task of tasks) {
    if (task.teamId !== teamId) continue
    const title = task.text.trim().replace(/\s+/g, ' ')
    if (!title) continue
    const key = title.toLowerCase()
    if (tokens.length > 0 && (key === needle || !tokens.every((token) => key.includes(token)))) continue
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

export default function NewTaskDialog({
  open,
  onClose,
  teams,
  historyTasks = [],
  defaultTeamId,
  defaultDue,
  onAdd,
}: {
  open: boolean
  onClose: () => void
  teams: Team[]
  historyTasks?: Task[]
  defaultTeamId: string | null
  defaultDue: string
  onAdd: (input: NewTaskInput) => Promise<boolean>
}) {
  const [text, setText] = useState('')
  const [due, setDue] = useState(defaultDue)
  const [preferredTime, setPreferredTime] = useState<string | null>(null)
  const [quickFillNote, setQuickFillNote] = useState('')
  const [priority, setPriority] = useState<Priority>('none')
  const [recurrence, setRecurrence] = useState<Recurrence>('none')
  const [duration, setDuration] = useState<number | null>(null)
  const [customDuration, setCustomDuration] = useState('')
  const [customOpen, setCustomOpen] = useState(false)
  const [tags, setTags] = useState<string[]>([])
  const [tagDraft, setTagDraft] = useState('')
  const [teamId, setTeamId] = useState<string | null>(defaultTeamId)
  const [addAnother, setAddAnother] = useState(false)
  const [busy, setBusy] = useState(false)
  const [suggestionsOpen, setSuggestionsOpen] = useState(false)
  const [highlight, setHighlight] = useState(-1)
  const textRef = useRef<HTMLInputElement>(null)

  const suggestions = useMemo(
    () => suggestTaskTitles(historyTasks, text, teamId),
    [historyTasks, text, teamId],
  )
  const showSuggestions = suggestionsOpen && suggestions.length > 0

  useEffect(() => {
    if (!open) return
    setText('')
    setDue(defaultDue)
    setPreferredTime(null)
    setQuickFillNote('')
    setPriority('none')
    setRecurrence('none')
    setDuration(null)
    setCustomDuration('')
    setCustomOpen(false)
    setTags([])
    setTagDraft('')
    setTeamId(defaultTeamId)
    setAddAnother(false)
    setSuggestionsOpen(false)
    setHighlight(-1)
    const timer = window.setTimeout(() => textRef.current?.focus(), 0)
    return () => window.clearTimeout(timer)
  }, [open, defaultDue, defaultTeamId])

  const toggleTag = (rawTag: string) => {
    const tag = rawTag.trim().replace(/\s+/g, ' ').toLowerCase()
    if (!tag) return
    setTags((current) =>
      current.includes(tag)
        ? current.filter((item) => item !== tag)
        : current.length >= TAG_LIMIT
          ? current
          : [...current, tag],
    )
  }

  const commitDraft = () => {
    const value = tagDraft.trim().replace(/\s+/g, ' ').toLowerCase()
    setTagDraft('')
    if (!value || tags.includes(value) || tags.length >= TAG_LIMIT) return
    setTags((current) => [...current, value])
  }

  const onDraftKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault()
      commitDraft()
    }
  }

  const chooseSuggestion = (title: string) => {
    setText(title)
    setQuickFillNote('')
    setSuggestionsOpen(false)
    setHighlight(-1)
    textRef.current?.focus()
  }

  const quickFill = () => {
    if (!text.trim()) {
      setQuickFillNote('Type a task first, e.g. “Submit report tomorrow 3pm #work”.')
      return
    }
    const parsed = parseQuickAdd(text, undefined, teams)
    const nextTags = [...tags]
    for (const tag of parsed.tags) {
      if (nextTags.length >= TAG_LIMIT) break
      if (!nextTags.includes(tag)) nextTags.push(tag)
    }
    const addedTags = nextTags.slice(tags.length)

    setText(parsed.text)
    if (parsed.due) setDue(parsed.due)
    if (parsed.preferredTime) setPreferredTime(parsed.preferredTime)
    if (parsed.teamId) setTeamId(parsed.teamId)
    setTags(nextTags)
    if (parsed.duration !== null) {
      if (DURATION_PRESETS.includes(parsed.duration)) {
        setDuration(parsed.duration)
        setCustomDuration('')
        setCustomOpen(false)
      } else {
        setDuration(null)
        setCustomDuration(String(parsed.duration))
        setCustomOpen(true)
      }
    }

    setSuggestionsOpen(false)
    setHighlight(-1)
    const parts: string[] = []
    if (parsed.text !== text.trim().replace(/\s+/g, ' ')) parts.push('title')
    if (parsed.due) parts.push('date')
    if (parsed.preferredTime) parts.push('time')
    if (addedTags.length) parts.push(addedTags.map((tag) => `#${tag}`).join(', '))
    if (parsed.duration !== null) parts.push(`${parsed.duration} min`)
    if (parsed.teamId) {
      const team = teams.find((item) => item.id === parsed.teamId)
      if (team) parts.push(`team: ${team.name}`)
    }
    setQuickFillNote(
      parts.length > 0
        ? `Filled ${parts.join(', ')}.`
        : 'No date, time, tags, duration or team found.',
    )
    textRef.current?.focus()
  }

  const onTitleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // Keep the removed shortcut from falling through to form submission.
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault()
      return
    }
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

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const value = text.trim()
    if (!value || busy) return
    const draft = tagDraft.trim().replace(/\s+/g, ' ')
    const nextTags = draft && !tags.includes(draft) ? [...tags, draft].slice(0, TAG_LIMIT) : tags
    const customMinutes = Number.parseInt(customDuration, 10)
    const minutes =
      duration ??
      (Number.isFinite(customMinutes) && customMinutes > 0
        ? Math.min(customMinutes, DURATION_MAX)
        : null)

    setBusy(true)
    const ok = await onAdd({
      text: value,
      due: dueFromDateInput(due),
      preferredTime,
      priority,
      tags: nextTags,
      recurrence,
      recurrenceConfig: null,
      duration: minutes,
      teamId,
    })
    setBusy(false)

    if (!ok) return
    if (addAnother) {
      setText('')
      setPreferredTime(null)
      setQuickFillNote('')
      setTags([])
      setTagDraft('')
      setSuggestionsOpen(false)
      setHighlight(-1)
      textRef.current?.focus()
    } else {
      onClose()
    }
  }

  const customTags = tags.filter(
    (tag) => !COMMON_TAGS.some((common) => common.toLowerCase() === tag.toLowerCase()),
  )
  const selectedDuration = duration ?? (customDuration.trim() ? Number(customDuration) : null)

  return (
    <Modal open={open} onClose={onClose} title="New task" width="max-w-5xl">
      <form onSubmit={submit}>
        <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_19rem]">
          <div className="min-w-0 space-y-5">
            <section className="relative">
              <div className="flex items-center justify-between gap-2">
                <label className={FIELD_LABEL} htmlFor="new-task-title">
                  Task
                </label>
                <div className="group relative">
                  <button
                    type="button"
                    onClick={quickFill}
                    aria-describedby="quick-fill-hint"
                    className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-semibold text-[#8A3210] transition hover:bg-[#FDF3E7] focus-visible:ring-2 focus-visible:ring-[#D9480F]/30 focus-visible:outline-none"
                    aria-label="Quick fill task fields"
                  >
                    <SparklesIcon className="h-3.5 w-3.5" />
                    Quick fill
                  </button>
                  <div
                    id="quick-fill-hint"
                    role="tooltip"
                    className="pointer-events-none absolute top-full right-0 z-40 mt-1 hidden w-max max-w-[16rem] rounded-lg border border-[#E3E1DC] bg-white px-3 py-2 text-left text-[11px] leading-snug text-slate-500 shadow-lg group-hover:block group-focus-within:block"
                  >
                    Try “Submit report tomorrow 3pm #work”
                  </div>
                </div>
              </div>
              <input
                id="new-task-title"
                ref={textRef}
                value={text}
                onChange={(event) => {
                  const value = event.target.value
                  setText(value)
                  setQuickFillNote('')
                  setHighlight(-1)
                  setSuggestionsOpen(value.trim().length > 0)
                }}
                onFocus={() => setSuggestionsOpen(text.trim().length > 0)}
                onBlur={() => {
                  setSuggestionsOpen(false)
                  setHighlight(-1)
                }}
                onKeyDown={onTitleKeyDown}
                placeholder="What needs doing?"
                maxLength={500}
                autoComplete="off"
                role="combobox"
                aria-autocomplete="list"
                aria-expanded={showSuggestions}
                aria-controls="new-task-suggestions"
                aria-activedescendant={
                  showSuggestions && highlight >= 0 ? `new-task-suggestion-${highlight}` : undefined
                }
                className="field text-base"
                aria-label="New task"
              />
              {quickFillNote && (
                <p aria-live="polite" className="mt-1 text-[11px] font-medium text-[#8A3210]">
                  {quickFillNote}
                </p>
              )}
              {showSuggestions && (
                <div
                  id="new-task-suggestions"
                  role="listbox"
                  aria-label="Task suggestions"
                  className="absolute top-full right-0 left-0 z-30 mt-1 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-lg"
                >
                  <p className="px-3 pt-2 pb-1 text-[10px] font-bold tracking-wide text-slate-400">
                    From your history
                  </p>
                  {suggestions.map((title, index) => (
                    <button
                      key={title}
                      id={`new-task-suggestion-${index}`}
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
            </section>

            <section>
              <p className={FIELD_LABEL}>Priority</p>
              <div className="flex flex-wrap gap-2" role="group" aria-label="Priority">
                {PRIORITY_VALUES.map((value) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setPriority(value)}
                    aria-pressed={priority === value}
                    className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition focus-visible:ring-4 focus-visible:ring-[#D9480F]/20 focus-visible:outline-none ${
                      PRIORITY_CHIP[value]
                    } ${priority === value ? 'ring-2 ring-[#D9480F] ring-offset-1' : 'opacity-75 hover:opacity-100'}`}
                  >
                    {value === 'none' ? 'None' : PRIORITY_META[value].label}
                  </button>
                ))}
              </div>
            </section>

            <div className="grid gap-4 sm:grid-cols-2">
              <section>
                <label className={FIELD_LABEL} htmlFor="new-task-due">
                  Due date
                </label>
                <label className="relative flex items-center">
                  <CalendarIcon className="pointer-events-none absolute left-3 h-4 w-4 text-slate-400" />
                  <input
                    id="new-task-due"
                    type="date"
                    value={due}
                    onChange={(event) => setDue(event.target.value)}
                    className="field pl-9"
                    aria-label="Due date"
                  />
                </label>
              </section>
            </div>

            <section>
              <p className={FIELD_LABEL}>How long will it take?</p>
              <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Duration">
                {DURATION_PRESETS.map((minutes) => (
                  <button
                    key={minutes}
                    type="button"
                    onClick={() => {
                      setDuration(duration === minutes ? null : minutes)
                      setCustomDuration('')
                      setCustomOpen(false)
                    }}
                    aria-pressed={duration === minutes}
                    className={chipClass(duration === minutes)}
                  >
                    {minutes < 60 ? `${minutes} min` : `${minutes / 60}h`}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => {
                    setDuration(null)
                    setCustomOpen(true)
                  }}
                  aria-pressed={customOpen}
                  className={chipClass(customOpen)}
                >
                  Custom
                </button>
                {customOpen && (
                  <label className="flex items-center gap-1.5 text-xs font-medium text-slate-500">
                    <input
                      type="number"
                      min={1}
                      max={DURATION_MAX}
                      value={customDuration}
                      onChange={(event) => setCustomDuration(event.target.value)}
                      className="field w-20! py-1.5! text-xs"
                      aria-label="Custom duration in minutes"
                    />
                    min
                  </label>
                )}
              </div>
            </section>

            <section>
              <p className={FIELD_LABEL}>Repeats</p>
              <div className="flex flex-wrap gap-2" role="group" aria-label="Repeats">
                {RECURRENCE_CHOICES.map((value) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setRecurrence(value)}
                    aria-pressed={recurrence === value}
                    className={chipClass(recurrence === value)}
                  >
                    {value === 'none' ? 'Never' : RECURRENCE_META[value].short}
                  </button>
                ))}
              </div>
            </section>

            <section>
              <p className={FIELD_LABEL}>Add to</p>
              <div className="flex flex-wrap gap-2" role="group" aria-label="Add to">
                <button
                  type="button"
                  onClick={() => setTeamId(null)}
                  aria-pressed={teamId === null}
                  className={chipClass(teamId === null)}
                >
                  My tasks
                </button>
                {teams.map((team) => (
                  <button
                    key={team.id}
                    type="button"
                    onClick={() => setTeamId(team.id)}
                    aria-pressed={teamId === team.id}
                    className={chipClass(teamId === team.id)}
                  >
                    {team.name}
                  </button>
                ))}
              </div>
              {teams.length === 0 && (
                <p className="mt-2 flex items-center gap-1.5 text-[11px] text-slate-400">
                  <UsersIcon className="h-3.5 w-3.5" />
                  Create a team to share tasks.
                </p>
              )}
            </section>

            <section>
              <div className="flex items-center justify-between">
                <p className={`${FIELD_LABEL} mb-0`}>Tags</p>
                <span className="text-[11px] text-slate-400">
                  {tags.length}/{TAG_LIMIT}
                </span>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2" role="group" aria-label="Tags">
                {COMMON_TAGS.map((tag) => {
                  const value = tag.toLowerCase()
                  return (
                  <button
                    key={tag}
                    type="button"
                    onClick={() => toggleTag(value)}
                    aria-pressed={tags.includes(value)}
                    className={`rounded-md px-2 py-1 text-[11px] font-medium transition ${
                      tags.includes(value) ? tagTint(value) : 'bg-slate-100 text-slate-500 hover:bg-slate-200'
                    }`}
                  >
                    #{value}
                  </button>
                  )
                })}
                {customTags.map((tag) => (
                  <span
                    key={tag}
                    className={`inline-flex items-center gap-1 rounded-md py-1 pr-1 pl-2 text-[11px] font-medium ${tagTint(tag)}`}
                  >
                    #{tag.toLowerCase()}
                    <button
                      type="button"
                      onClick={() => toggleTag(tag)}
                      className="rounded p-0.5 opacity-60 transition hover:opacity-100"
                      aria-label={`Remove tag ${tag}`}
                    >
                      <XIcon className="h-3 w-3" />
                    </button>
                  </span>
                ))}
                <label className="flex items-center gap-1 rounded-md border border-slate-200 px-2 py-1 text-[11px] text-slate-500 transition focus-within:border-[#D9480F]">
                  <TagIcon className="h-3.5 w-3.5" />
                  <input
                    value={tagDraft}
                    onChange={(event) => setTagDraft(event.target.value)}
                    onKeyDown={onDraftKeyDown}
                    onBlur={commitDraft}
                    placeholder="Add tag"
                    maxLength={24}
                    className="w-20 border-0 bg-transparent p-0 text-[11px] outline-none placeholder:text-slate-400"
                    aria-label="Add tag"
                  />
                </label>
              </div>
            </section>
          </div>

          <aside className="min-w-0">
            <p className={FIELD_LABEL}>Preview</p>
            <div className="rounded-2xl bg-[#FDF3E7] p-5 text-[#15181E] shadow-sm ring-1 ring-[#D9480F]/15">
              {priority !== 'none' && (
                <span
                  className={`mb-3 inline-block rounded-md px-2 py-0.5 text-[10px] font-bold normal-case tracking-wide ${PRIORITY_CHIP[priority]}`}
                >
                  {PRIORITY_META[priority].label}
                </span>
              )}
              <h3 className="text-base leading-snug font-bold break-words">
                {text.trim() || 'Your task title'}
              </h3>
              {(tags.length > 0 || tagDraft.trim()) && (
                <p className="mt-2 text-[11px] font-medium text-[#6B4F1D]">
                  {[...tags, tagDraft.trim()].filter(Boolean).map((tag) => `#${tag.toLowerCase()}`).join('  ')}
                </p>
              )}
              <div className="mt-4 space-y-1.5 text-xs font-medium text-[#6B4F1D]">
                <p>
                  {previewDate(due)}
                  {preferredTime ? ` · ${preferredTime}` : ''}
                </p>
                <p>{selectedDuration ? `${selectedDuration} min` : 'No duration yet'}</p>
                {recurrence !== 'none' && <p>{RECURRENCE_META[recurrence].label}</p>}
                <p>
                  {teamId
                    ? teams.find((team) => team.id === teamId)?.name ?? 'Team task'
                    : 'My tasks'}
                </p>
              </div>
            </div>
            <p className="mt-3 flex items-start gap-1.5 text-[11px] leading-snug text-slate-400">
              <RepeatIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {formatDateValue(due) || 'Pick a date'} · {getListLabel(teamId, teams)}
            </p>
          </aside>
        </div>

        <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-4">
          <label className="flex cursor-pointer items-center gap-2 text-xs font-medium text-slate-600">
            <input
              type="checkbox"
              checked={addAnother}
              onChange={(event) => setAddAnother(event.target.checked)}
              className="h-4 w-4 rounded border-slate-300 text-[#D9480F] accent-[#D9480F]"
            />
            Add and create another
          </label>
          <div className="flex items-center gap-2">
            <button type="button" className="btn-ghost" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button
              type="submit"
              disabled={!text.trim() || busy}
              className="inline-flex items-center justify-center gap-2 rounded-xl bg-[#D9480F] px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-[#C23E0C] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? <Spinner className="h-4 w-4" /> : <PlusIcon className="h-4 w-4" />}
              Add task
            </button>
          </div>
        </div>
      </form>
    </Modal>
  )
}

function getListLabel(teamId: string | null, teams: Team[]): string {
  if (!teamId) return 'Personal list'
  return teams.find((team) => team.id === teamId)?.name ?? 'Team task'
}
