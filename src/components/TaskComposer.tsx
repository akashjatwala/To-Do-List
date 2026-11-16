import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import type { Priority, Recurrence, RecurrenceConfig, Team } from '@/types'
import { dueFromDateInput } from '@/lib/date'
import {
  COMMON_TAGS,
  PRIORITY_META,
  PRIORITY_VALUES,
  RECURRENCE_META,
  RECURRENCE_VALUES,
  TAG_LIMIT,
  tagTint,
} from '@/lib/taskmeta'
import RecurrenceEditor from './RecurrenceEditor'
import {
  CalendarIcon,
  ClockIcon,
  FlagIcon,
  PlusIcon,
  RepeatIcon,
  TagIcon,
  UsersIcon,
  XIcon,
} from './Icons'
import { Spinner } from './ui'

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

export default function TaskComposer({
  contextLabel,
  teams,
  showTeamSelect,
  defaultTeamId,
  defaultDue = '',
  onAdd,
}: {
  contextLabel: string
  teams: Team[]
  showTeamSelect: boolean
  defaultTeamId: string | null
  defaultDue?: string
  onAdd: (input: NewTaskInput) => Promise<boolean>
}) {
  const [text, setText] = useState('')
  const [due, setDue] = useState(defaultDue)
  const [priority, setPriority] = useState<Priority>('none')
  const [recurrence, setRecurrence] = useState<Recurrence>('none')
  const [customRepeat, setCustomRepeat] = useState<RecurrenceConfig>(() => ({
    mode: 'weekly',
    days: [new Date().getDay()],
  }))
  const [duration, setDuration] = useState('')
  const [preferredTime, setPreferredTime] = useState('')
  const [tags, setTags] = useState<string[]>([])
  const [tagDraft, setTagDraft] = useState('')
  const [teamId, setTeamId] = useState<string | null>(defaultTeamId)
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  // Keep the target list in sync when the selected team changes.
  useEffect(() => {
    setTeamId(defaultTeamId)
  }, [defaultTeamId])

  // New tasks default to the day the page is showing.
  useEffect(() => {
    setDue(defaultDue)
  }, [defaultDue])

  const toggleTag = (tag: string) => {
    setTags((current) =>
      current.includes(tag)
        ? current.filter((item) => item !== tag)
        : current.length >= TAG_LIMIT
          ? current
          : [...current, tag],
    )
  }

  const commitDraft = () => {
    const value = tagDraft.trim().replace(/\s+/g, ' ')
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

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const value = text.trim()
    if (!value || busy) return
    const nextTags = tagDraft.trim()
      ? [...tags, tagDraft.trim().replace(/\s+/g, ' ')].slice(0, TAG_LIMIT)
      : tags
    const minutes = Number.parseInt(duration, 10)
    const durationValue =
      Number.isFinite(minutes) && minutes > 0 ? Math.min(minutes, DURATION_MAX) : null
    setBusy(true)
    const ok = await onAdd({
      text: value,
      due: dueFromDateInput(due),
      priority,
      tags: nextTags,
      recurrence,
      recurrenceConfig: recurrence === 'custom' ? customRepeat : null,
      duration: durationValue,
      preferredTime: preferredTime || null,
      teamId,
    })
    setBusy(false)
    if (ok) {
      setText('')
      setDue(defaultDue)
      setPriority('none')
      setRecurrence('none')
      setDuration('')
      setPreferredTime('')
      setTags([])
      setTagDraft('')
      inputRef.current?.focus()
    }
  }

  const selectClass =
    'cursor-pointer rounded-lg border-0 bg-transparent py-1.5 pr-6 pl-7 text-xs font-medium text-slate-600 outline-none transition hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800'

  const customTags = tags.filter((tag) => !COMMON_TAGS.includes(tag))

  return (
    <form
      onSubmit={submit}
      className="card p-2 transition focus-within:border-indigo-300 focus-within:ring-4 focus-within:ring-indigo-500/10 dark:focus-within:border-indigo-500/60"
    >
      <div className="flex items-center gap-2 px-2 pt-1">
        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 border-dashed border-slate-300 text-slate-400 dark:border-slate-600">
          <PlusIcon className="h-3 w-3" />
        </span>
        <input
          ref={inputRef}
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder={`Add a task to ${contextLabel}…`}
          maxLength={500}
          className="w-full border-0 bg-transparent py-2 text-[15px] text-slate-900 outline-none placeholder:text-slate-400 dark:text-slate-100 dark:placeholder:text-slate-500"
          aria-label="New task"
        />
      </div>

      <div className="mt-1 flex flex-wrap items-center gap-x-1 gap-y-2 border-t border-slate-100 px-2 pt-2 dark:border-slate-800">
        <label className="flex cursor-pointer items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-medium text-slate-500 transition hover:bg-slate-100 hover:text-slate-700 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200">
          <CalendarIcon className="h-4 w-4" />
          <input
            type="date"
            value={due}
            onChange={(event) => setDue(event.target.value)}
            className="max-w-[7.5rem] cursor-pointer border-0 bg-transparent p-0 text-xs font-medium text-slate-600 outline-none dark:text-slate-300"
            aria-label="Due date"
          />
        </label>

        <label className="relative flex items-center">
          <FlagIcon
            className={`pointer-events-none absolute left-2 h-4 w-4 ${PRIORITY_META[priority].text}`}
          />
          <select
            value={priority}
            onChange={(event) => setPriority(event.target.value as Priority)}
            className={selectClass}
            aria-label="Priority"
          >
            {PRIORITY_VALUES.map((value) => (
              <option key={value} value={value}>
                {value === 'none' ? 'None' : PRIORITY_META[value].label}
              </option>
            ))}
          </select>
        </label>

        <label className="relative flex items-center">
          <RepeatIcon
            className={`pointer-events-none absolute left-2 h-4 w-4 ${
              recurrence === 'none' ? 'text-slate-400' : 'text-indigo-500 dark:text-indigo-400'
            }`}
          />
          <select
            value={recurrence}
            onChange={(event) => setRecurrence(event.target.value as Recurrence)}
            className={selectClass}
            aria-label="Repeat"
          >
            {RECURRENCE_VALUES.map((value) => (
              <option key={value} value={value}>
                {value === 'none'
                  ? 'Never'
                  : value === 'custom'
                    ? 'Custom…'
                    : RECURRENCE_META[value].short}
              </option>
            ))}
          </select>
        </label>

        <label className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-medium text-slate-500 transition hover:bg-slate-100 hover:text-slate-700 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200">
          <ClockIcon className="h-4 w-4" />
          <input
            type="text"
            inputMode="numeric"
            value={duration}
            onChange={(event) => setDuration(event.target.value.replace(/\D/g, '').slice(0, 5))}
            placeholder="Duration"
            className="w-[4.5rem] border-0 bg-transparent p-0 text-xs font-medium text-slate-600 outline-none placeholder:text-slate-400 dark:text-slate-300 dark:placeholder:text-slate-500"
            aria-label="Ideal duration in minutes"
            title="Ideal duration of the task, in minutes"
          />
          <span className="text-[11px] text-slate-400 dark:text-slate-500">min</span>
        </label>

        <label
          className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-medium text-slate-500 transition hover:bg-slate-100 hover:text-slate-700 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200"
          title="Optional preferred time of day — a hint, never a deadline"
        >
          <ClockIcon className="h-4 w-4" />
          <input
            type="time"
            value={preferredTime}
            onChange={(event) => setPreferredTime(event.target.value)}
            className="w-[5.5rem] cursor-pointer border-0 bg-transparent p-0 text-xs font-medium text-slate-600 outline-none dark:text-slate-300"
            aria-label="Preferred time of day"
          />
        </label>

        {showTeamSelect && (
          <label className="relative flex items-center">
            <UsersIcon
              className={`pointer-events-none absolute left-2 h-4 w-4 ${
                teamId === null ? 'text-slate-400' : 'text-indigo-500 dark:text-indigo-400'
              }`}
            />
            <select
              value={teamId ?? ''}
              onChange={(event) => setTeamId(event.target.value || null)}
              className={selectClass}
              aria-label="Assign to list"
              title="Assign this task to a list"
            >
              <option value="">Personal</option>
              {teams.map((team) => (
                <option key={team.id} value={team.id}>
                  {team.name}
                </option>
              ))}
            </select>
          </label>
        )}

        <div className="ml-auto flex items-center gap-3">
          <span className="hidden text-[11px] text-slate-400 lg:inline">
            Press{' '}
            <kbd className="rounded border border-slate-200 px-1 py-0.5 font-sans text-[10px] dark:border-slate-700">
              Enter
            </kbd>
          </span>
          <button
            type="submit"
            className="btn-primary px-3! py-1.5! text-xs"
            disabled={!text.trim() || busy}
          >
            {busy ? <Spinner className="h-3.5 w-3.5" /> : <PlusIcon className="h-3.5 w-3.5" />}
            Add task
          </button>
        </div>
      </div>

      {recurrence === 'custom' && (
        <div className="mt-1 flex flex-wrap items-center gap-2 border-t border-slate-100 px-2 pt-2 dark:border-slate-800">
          <span className="flex items-center gap-1 pr-1 text-[11px] font-bold tracking-wider text-slate-400 uppercase dark:text-slate-500">
            <RepeatIcon className="h-3.5 w-3.5" />
            Custom repeat
          </span>
          <div className="min-w-0 flex-1">
            <RecurrenceEditor config={customRepeat} onChange={setCustomRepeat} />
          </div>
        </div>
      )}

      <div className="mt-1 flex flex-wrap items-center gap-1.5 border-t border-slate-100 px-2 pt-2 dark:border-slate-800">
        <span className="flex items-center gap-1 pr-1 text-[11px] font-bold tracking-wider text-slate-400 uppercase dark:text-slate-500">
          <TagIcon className="h-3.5 w-3.5" />
          Tags
        </span>
        {COMMON_TAGS.map((tag) => {
          const active = tags.includes(tag)
          return (
            <button
              key={tag}
              type="button"
              onClick={() => toggleTag(tag)}
              aria-pressed={active}
              className={`rounded-md px-2 py-0.5 text-[11px] font-medium transition ${
                active
                  ? tagTint(tag)
                  : 'bg-slate-100 text-slate-500 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:hover:bg-slate-700'
              }`}
            >
              {tag}
            </button>
          )
        })}
        {customTags.map((tag) => (
          <span
            key={tag}
            className={`inline-flex items-center gap-1 rounded-md py-0.5 pr-1 pl-2 text-[11px] font-medium ${tagTint(tag)}`}
          >
            {tag}
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
        <input
          value={tagDraft}
          onChange={(event) => setTagDraft(event.target.value)}
          onKeyDown={onDraftKeyDown}
          onBlur={commitDraft}
          placeholder="Custom tag…"
          maxLength={24}
          className="w-28 rounded-md border border-transparent bg-transparent px-1.5 py-0.5 text-[11px] font-medium text-slate-600 outline-none placeholder:text-slate-400 hover:bg-slate-100 focus:bg-slate-100 dark:text-slate-300 dark:placeholder:text-slate-500 dark:hover:bg-slate-800 dark:focus:bg-slate-800"
          aria-label="Custom tag"
        />
      </div>
    </form>
  )
}
