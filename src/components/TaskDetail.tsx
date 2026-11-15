import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { Comment, Priority, Recurrence, RecurrenceConfig, Subtask, Task } from '@/types'
import { dateInputValue, dueFromDateInput, fullDate, timeAgo } from '@/lib/date'
import {
  COMMON_TAGS,
  PRIORITY_META,
  PRIORITY_VALUES,
  RECURRENCE_META,
  RECURRENCE_VALUES,
  TAG_LIMIT,
  tagTint,
} from '@/lib/taskmeta'
import { Avatar, Spinner } from './ui'
import RecurrenceEditor from './RecurrenceEditor'
import { PriorityBadge, RecurrenceBadge, TagChips } from './TaskBadges'
import {
  CalendarIcon,
  CheckIcon,
  ClockIcon,
  FlagIcon,
  GaugeIcon,
  ListChecksIcon,
  PlusIcon,
  RepeatIcon,
  TagIcon,
  TrashIcon,
  XIcon,
} from './Icons'

const DURATION_MAX = 60 * 24 * 7

interface TaskDetailProps {
  task: Task
  currentUserId: number
  canModerate: boolean
  canDelete: boolean
  onClose: () => void
  onUpdate: (patch: {
    text?: string
    done?: boolean
    due?: number | null
    progress?: number
    priority?: Priority
    tags?: string[]
    recurrence?: Recurrence
    recurrenceConfig?: RecurrenceConfig | null
    duration?: number | null
  }) => Promise<boolean>
  onDelete: () => Promise<void>
  onAddSubtask: (text: string) => Promise<boolean>
  onToggleSubtask: (subtask: Subtask) => void
  onDeleteSubtask: (subtask: Subtask) => void
  onAddComment: (text: string) => Promise<boolean>
  onDeleteComment: (comment: Comment) => void
}

export default function TaskDetail({
  task,
  currentUserId,
  canModerate,
  canDelete,
  onClose,
  onUpdate,
  onDelete,
  onAddSubtask,
  onToggleSubtask,
  onDeleteSubtask,
  onAddComment,
  onDeleteComment,
}: TaskDetailProps) {
  const [title, setTitle] = useState(task.text)
  const [titleBusy, setTitleBusy] = useState(false)
  const titleRef = useRef<HTMLInputElement>(null)
  const [subtaskText, setSubtaskText] = useState('')
  const [subtaskBusy, setSubtaskBusy] = useState(false)
  const [commentText, setCommentText] = useState('')
  const [commentBusy, setCommentBusy] = useState(false)
  const [progressValue, setProgressValue] = useState(task.progress ?? 0)
  const [tagInput, setTagInput] = useState('')
  const [durationValue, setDurationValue] = useState(task.duration ? String(task.duration) : '')
  const [customRepeat, setCustomRepeat] = useState<RecurrenceConfig>(() =>
    task.recurrenceConfig ?? { mode: 'weekly', days: [new Date().getDay()] },
  )

  useEffect(() => {
    setTitle(task.text)
  }, [task.id, task.text])

  useEffect(() => {
    setProgressValue(task.progress ?? 0)
  }, [task.id, task.progress])

  useEffect(() => {
    setDurationValue(task.duration ? String(task.duration) : '')
  }, [task.id, task.duration])

  useEffect(() => {
    if (task.recurrenceConfig) setCustomRepeat(task.recurrenceConfig)
  }, [task.id, task.recurrenceConfig])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const saveTitle = async () => {
    const value = title.trim()
    if (!value) {
      setTitle(task.text)
      return
    }
    if (value === task.text) return
    setTitleBusy(true)
    const ok = await onUpdate({ text: value })
    setTitleBusy(false)
    if (!ok) setTitle(task.text)
  }

  const submitSubtask = async (event: FormEvent) => {
    event.preventDefault()
    const value = subtaskText.trim()
    if (!value || subtaskBusy) return
    setSubtaskBusy(true)
    const ok = await onAddSubtask(value)
    setSubtaskBusy(false)
    if (ok) setSubtaskText('')
  }

  const submitComment = async (event: FormEvent) => {
    event.preventDefault()
    const value = commentText.trim()
    if (!value || commentBusy) return
    setCommentBusy(true)
    const ok = await onAddComment(value)
    setCommentBusy(false)
    if (ok) setCommentText('')
  }

  const doneSubtasks = task.subtasks.filter((subtask) => subtask.done).length
  const subtaskPercent = task.subtasks.length ? (doneSubtasks / task.subtasks.length) * 100 : 0

  const commitProgress = (value: number) => {
    const next = Math.max(0, Math.min(100, Math.round(value)))
    if (next === (task.progress ?? 0)) return
    setProgressValue(next)
    void onUpdate({ progress: next }).then((ok) => {
      if (!ok) setProgressValue(task.progress ?? 0)
    })
  }

  const commitDuration = () => {
    const trimmed = durationValue.trim()
    if (!trimmed) {
      if (task.duration !== null) void onUpdate({ duration: null })
      return
    }
    const minutes = Number.parseInt(trimmed, 10)
    if (!Number.isFinite(minutes) || minutes < 1) {
      setDurationValue(task.duration ? String(task.duration) : '')
      return
    }
    const next = Math.min(minutes, DURATION_MAX)
    setDurationValue(String(next))
    if (next === task.duration) return
    void onUpdate({ duration: next }).then((ok) => {
      if (!ok) setDurationValue(task.duration ? String(task.duration) : '')
    })
  }

  const changeRecurrence = (value: Recurrence) => {
    if (value === 'custom') {
      const config = task.recurrenceConfig ?? customRepeat
      setCustomRepeat(config)
      void onUpdate({ recurrence: 'custom', recurrenceConfig: config })
    } else {
      void onUpdate({ recurrence: value, recurrenceConfig: null })
    }
  }

  const changeCustomRepeat = (config: RecurrenceConfig) => {
    setCustomRepeat(config)
    void onUpdate({ recurrence: 'custom', recurrenceConfig: config })
  }

  const addTag = (event: FormEvent) => {
    event.preventDefault()
    const value = tagInput.trim().replace(/\s+/g, ' ')
    setTagInput('')
    if (!value || task.tags.includes(value) || task.tags.length >= TAG_LIMIT) return
    void onUpdate({ tags: [...task.tags, value] })
  }

  const toggleTag = (tag: string) => {
    if (task.tags.includes(tag)) {
      void onUpdate({ tags: task.tags.filter((item) => item !== tag) })
    } else if (task.tags.length < TAG_LIMIT) {
      void onUpdate({ tags: [...task.tags, tag] })
    }
  }

  const removeTag = (tag: string) => {
    void onUpdate({ tags: task.tags.filter((item) => item !== tag) })
  }

  const customTags = task.tags.filter((tag) => !COMMON_TAGS.includes(tag))

  return (
    <>
      <div
        className="animate-fade fixed inset-0 z-40 bg-slate-950/30 backdrop-blur-[2px]"
        onClick={onClose}
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="Task details"
        className="animate-drawer fixed inset-y-0 right-0 z-50 flex w-full max-w-md flex-col border-l border-slate-200 bg-white shadow-2xl dark:border-slate-800 dark:bg-slate-900"
      >
        <header className="flex h-16 shrink-0 items-center justify-between border-b border-slate-100 px-5 dark:border-slate-800">
          <p className="text-[11px] font-bold tracking-wider text-slate-400 uppercase dark:text-slate-500">
            Task details
          </p>
          <button type="button" onClick={onClose} className="icon-btn -mr-1.5" aria-label="Close">
            <XIcon className="h-5 w-5" />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto">
          <div className="p-5">
            <div className="flex items-start gap-3">
              <button
                type="button"
                onClick={() => onUpdate({ done: !task.done })}
                role="checkbox"
                aria-checked={task.done}
                aria-label={task.done ? 'Mark as not done' : 'Mark as done'}
                className={`mt-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2 transition active:scale-90 ${
                  task.done
                    ? 'border-emerald-500 bg-emerald-500 text-white'
                    : 'border-slate-300 text-transparent hover:border-emerald-400 hover:text-emerald-300 dark:border-slate-600'
                }`}
              >
                <CheckIcon className="h-3.5 w-3.5" strokeWidth={3} />
              </button>

              <div className="min-w-0 flex-1">
                <input
                  ref={titleRef}
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  onBlur={saveTitle}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      titleRef.current?.blur()
                    }
                  }}
                  maxLength={500}
                  aria-label="Task title"
                  className={`w-full rounded-lg border border-transparent bg-transparent px-1.5 py-0.5 text-lg leading-snug font-bold tracking-tight outline-none transition hover:border-slate-200 focus:border-indigo-300 focus:bg-white focus:ring-4 focus:ring-indigo-500/10 dark:hover:border-slate-700 dark:focus:border-indigo-500 dark:focus:bg-slate-950 ${
                    task.done
                      ? 'text-slate-400 line-through decoration-slate-300 dark:text-slate-500'
                      : ''
                  }`}
                />
                <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 px-1.5 text-xs text-slate-400 dark:text-slate-500">
                  {titleBusy && <Spinner className="h-3 w-3" />}
                  <span>Added by {task.userId === currentUserId ? 'you' : task.ownerEmail}</span>
                  <span aria-hidden="true">·</span>
                  <span>{fullDate(task.createdAt)}</span>
                  {task.teamName && (
                    <>
                      <span aria-hidden="true">·</span>
                      <span className="font-medium text-indigo-500 dark:text-indigo-400">
                        {task.teamName}
                      </span>
                    </>
                  )}
                  {task.priority !== 'none' && <PriorityBadge priority={task.priority} />}
                  <RecurrenceBadge recurrence={task.recurrence} config={task.recurrenceConfig} />
                  <TagChips tags={task.tags} />
                </p>
              </div>
            </div>

            <div className="mt-5 rounded-xl border border-slate-200 p-3.5 dark:border-slate-800">
              <label
                htmlFor="task-due"
                className="mb-1.5 flex items-center gap-1.5 text-[11px] font-bold tracking-wider text-slate-400 uppercase dark:text-slate-500"
              >
                <CalendarIcon className="h-3.5 w-3.5" />
                Due date
              </label>
              <div className="flex items-center gap-2">
                <input
                  id="task-due"
                  type="date"
                  value={dateInputValue(task.due)}
                  onChange={(event) => onUpdate({ due: dueFromDateInput(event.target.value) })}
                  className="w-full cursor-pointer rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-sm text-slate-700 outline-none transition focus:border-indigo-400 focus:ring-4 focus:ring-indigo-500/10 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
                />
                {task.due !== null && (
                  <button
                    type="button"
                    onClick={() => onUpdate({ due: null })}
                    className="rounded-lg px-2 py-1.5 text-xs font-medium text-slate-400 transition hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-800 dark:hover:text-slate-300"
                  >
                    Clear
                  </button>
                )}
              </div>

              <label className="mt-3 block border-t border-slate-100 pt-3 dark:border-slate-800">
                <span className="mb-1.5 flex items-center gap-1.5 text-[11px] font-bold tracking-wider text-slate-400 uppercase dark:text-slate-500">
                  <ClockIcon className="h-3.5 w-3.5" />
                  Ideal duration
                </span>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    inputMode="numeric"
                    value={durationValue}
                    onChange={(event) =>
                      setDurationValue(event.target.value.replace(/\D/g, '').slice(0, 5))
                    }
                    onBlur={commitDuration}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault()
                        event.currentTarget.blur()
                      }
                    }}
                    placeholder="No estimate"
                    aria-label="Ideal duration in minutes"
                    className="w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-sm text-slate-700 outline-none transition focus:border-indigo-400 focus:ring-4 focus:ring-indigo-500/10 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
                  />
                  <span className="shrink-0 text-xs font-medium text-slate-400 dark:text-slate-500">
                    min
                  </span>
                </div>
              </label>
            </div>

            {/* Priority & repeat */}
            <section className="mt-5 rounded-xl border border-slate-200 p-3.5 dark:border-slate-800">
              <p className="mb-2.5 flex items-center gap-1.5 text-[11px] font-bold tracking-wider text-slate-400 uppercase dark:text-slate-500">
                <FlagIcon className="h-3.5 w-3.5" />
                Priority
              </p>
              <div className="flex flex-wrap gap-1.5">
                {PRIORITY_VALUES.map((value) => {
                  const meta = PRIORITY_META[value]
                  const active = task.priority === value
                  return (
                    <button
                      key={value}
                      type="button"
                      onClick={() => void onUpdate({ priority: value })}
                      className={`inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs font-semibold transition ${
                        active
                          ? meta.chip
                          : 'bg-slate-100 text-slate-500 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:hover:bg-slate-700'
                      }`}
                    >
                      <span className={`h-2 w-2 rounded-full ${meta.dot}`} />
                      {meta.label}
                    </button>
                  )
                })}
              </div>

              <label className="mt-4 block">
                <span className="mb-1.5 flex items-center gap-1.5 text-[11px] font-bold tracking-wider text-slate-400 uppercase dark:text-slate-500">
                  <RepeatIcon className="h-3.5 w-3.5" />
                  Repeats
                </span>
                <select
                  value={task.recurrence}
                  onChange={(event) => changeRecurrence(event.target.value as Recurrence)}
                  className="field cursor-pointer py-2! text-sm"
                >
                  {RECURRENCE_VALUES.map((value) => (
                    <option key={value} value={value}>
                      {RECURRENCE_META[value].label}
                    </option>
                  ))}
                </select>
                {task.recurrence === 'custom' && (
                  <div className="mt-2">
                    <RecurrenceEditor config={customRepeat} onChange={changeCustomRepeat} />
                  </div>
                )}
                {task.recurrence !== 'none' && (
                  <span className="mt-1.5 block text-[11px] text-slate-400 dark:text-slate-500">
                    Completing this task creates the next occurrence automatically.
                  </span>
                )}
              </label>
            </section>

            {/* Tags */}
            <section className="mt-5 rounded-xl border border-slate-200 p-3.5 dark:border-slate-800">
              <p className="mb-2.5 flex items-center gap-1.5 text-[11px] font-bold tracking-wider text-slate-400 uppercase dark:text-slate-500">
                <TagIcon className="h-3.5 w-3.5" />
                Tags
              </p>
              <div className="mb-2.5 flex flex-wrap gap-1.5">
                {COMMON_TAGS.map((tag) => {
                  const active = task.tags.includes(tag)
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
              </div>
              {customTags.length > 0 && (
                <div className="mb-2.5 flex flex-wrap gap-1.5">
                  {customTags.map((tag) => (
                    <span
                      key={tag}
                      className={`inline-flex items-center gap-1 rounded-md py-0.5 pr-1 pl-1.5 text-[11px] font-medium ${tagTint(tag)}`}
                    >
                      {tag}
                      <button
                        type="button"
                        onClick={() => removeTag(tag)}
                        className="rounded p-0.5 opacity-50 transition hover:opacity-100"
                        aria-label={`Remove tag ${tag}`}
                      >
                        <XIcon className="h-3 w-3" />
                      </button>
                    </span>
                  ))}
                </div>
              )}
              <form onSubmit={addTag} className="flex items-center gap-2">
                <input
                  value={tagInput}
                  onChange={(event) => setTagInput(event.target.value)}
                  placeholder="Add a tag…"
                  maxLength={24}
                  className="w-full rounded-lg border border-transparent bg-transparent px-1 py-1.5 text-sm outline-none placeholder:text-slate-400 hover:border-slate-200 focus:border-indigo-300 focus:ring-2 focus:ring-indigo-500/10 dark:hover:border-slate-700 dark:focus:border-indigo-500"
                />
                {tagInput.trim() && (
                  <button
                    type="submit"
                    className="rounded-lg bg-indigo-600 px-2.5 py-1 text-xs font-semibold text-white transition hover:bg-indigo-500"
                  >
                    Add
                  </button>
                )}
              </form>
            </section>

            {/* Manual progress */}
            <section className="mt-5 rounded-xl border border-slate-200 p-3.5 dark:border-slate-800">
              <div className="mb-3 flex items-center justify-between">
                <p className="flex items-center gap-1.5 text-[11px] font-bold tracking-wider text-slate-400 uppercase dark:text-slate-500">
                  <GaugeIcon className="h-3.5 w-3.5" />
                  Progress
                </p>
                <span
                  className={`rounded-full px-2 py-0.5 text-xs font-bold tabular-nums ${
                    progressValue === 100
                      ? 'bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-400'
                      : 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400'
                  }`}
                >
                  {progressValue}%
                </span>
              </div>

              <div className="mb-3 h-2 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
                <div
                  className={`h-full rounded-full transition-all duration-200 ${
                    progressValue === 100
                      ? 'bg-emerald-400 dark:bg-emerald-500'
                      : 'bg-gradient-to-r from-indigo-500 to-violet-500'
                  }`}
                  style={{ width: `${progressValue}%` }}
                />
              </div>

              <input
                type="range"
                min={0}
                max={100}
                step={5}
                value={progressValue}
                onChange={(event) => setProgressValue(Number(event.target.value))}
                onPointerUp={(event) => commitProgress(Number(event.currentTarget.value))}
                onKeyUp={(event) => commitProgress(Number(event.currentTarget.value))}
                onBlur={(event) => commitProgress(Number(event.currentTarget.value))}
                aria-label="Task completion percentage"
                className="progress-range w-full"
              />

              <div className="mt-2 flex flex-wrap gap-1.5">
                {[0, 25, 50, 75, 100].map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    onClick={() => commitProgress(preset)}
                    className={`rounded-lg px-2 py-1 text-xs font-semibold transition ${
                      progressValue === preset
                        ? 'bg-indigo-500 text-white shadow-sm shadow-indigo-500/30'
                        : 'bg-slate-100 text-slate-500 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:hover:bg-slate-700'
                    }`}
                  >
                    {preset}%
                  </button>
                ))}
              </div>

              <p className="mt-2.5 text-[11px] text-slate-400 dark:text-slate-500">
                {progressValue === 100
                  ? 'Great — this task is marked done.'
                  : 'Set 100% to complete the task, or any lower value to keep it open.'}
              </p>
            </section>

            {/* Subtasks */}
            <section className="mt-7">
              <div className="mb-2.5 flex items-center justify-between">
                <h3 className="flex items-center gap-2 text-sm font-bold text-slate-800 dark:text-slate-100">
                  <ListChecksIcon className="h-4 w-4 text-indigo-500" />
                  Subtasks
                  {task.subtasks.length > 0 && (
                    <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                      {doneSubtasks}/{task.subtasks.length}
                    </span>
                  )}
                </h3>
              </div>

              {task.subtasks.length > 0 && (
                <div className="mb-3 h-1.5 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-indigo-500 to-violet-500 transition-all duration-300"
                    style={{ width: `${subtaskPercent}%` }}
                  />
                </div>
              )}

              <div className="space-y-1">
                {task.subtasks.map((subtask) => (
                  <div
                    key={subtask.id}
                    className="group flex items-center gap-2.5 rounded-lg px-1 py-1.5 hover:bg-slate-50 dark:hover:bg-slate-800/60"
                  >
                    <button
                      type="button"
                      onClick={() => onToggleSubtask(subtask)}
                      role="checkbox"
                      aria-checked={subtask.done}
                      className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border transition ${
                        subtask.done
                          ? 'border-indigo-600 bg-indigo-600 text-white'
                          : 'border-slate-300 text-transparent hover:border-indigo-400 dark:border-slate-600'
                      }`}
                      aria-label={subtask.done ? 'Mark subtask incomplete' : 'Complete subtask'}
                    >
                      <CheckIcon className="h-2.5 w-2.5" strokeWidth={3.5} />
                    </button>
                    <span
                      className={`flex-1 text-sm ${
                        subtask.done
                          ? 'text-slate-400 line-through dark:text-slate-500'
                          : 'text-slate-700 dark:text-slate-200'
                      }`}
                    >
                      {subtask.text}
                    </span>
                    <button
                      type="button"
                      onClick={() => onDeleteSubtask(subtask)}
                      className="rounded p-1 text-slate-300 opacity-0 transition group-hover:opacity-100 hover:text-rose-500 focus:opacity-100 dark:text-slate-600"
                      aria-label="Delete subtask"
                    >
                      <TrashIcon className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>

              <form onSubmit={submitSubtask} className="mt-2 flex items-center gap-2">
                <PlusIcon className="ml-1 h-3.5 w-3.5 shrink-0 text-slate-400" />
                <input
                  value={subtaskText}
                  onChange={(event) => setSubtaskText(event.target.value)}
                  placeholder="Add a subtask…"
                  maxLength={200}
                  className="w-full rounded-lg border border-transparent bg-transparent px-1 py-1.5 text-sm outline-none placeholder:text-slate-400 hover:border-slate-200 focus:border-indigo-300 focus:ring-2 focus:ring-indigo-500/10 dark:hover:border-slate-700 dark:focus:border-indigo-500"
                />
                {subtaskText.trim() && (
                  <button
                    type="submit"
                    className="rounded-lg bg-indigo-600 px-2.5 py-1 text-xs font-semibold text-white transition hover:bg-indigo-500"
                    disabled={subtaskBusy}
                  >
                    {subtaskBusy ? <Spinner className="h-3 w-3" /> : 'Add'}
                  </button>
                )}
              </form>
            </section>

            {/* Comments */}
            <section className="mt-8 border-t border-slate-100 pt-6 dark:border-slate-800">
              <h3 className="mb-3 text-sm font-bold text-slate-800 dark:text-slate-100">
                Comments
                {task.comments.length > 0 && (
                  <span className="ml-2 rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                    {task.comments.length}
                  </span>
                )}
              </h3>

              {task.comments.length === 0 ? (
                <p className="rounded-xl bg-slate-50 px-3.5 py-3 text-xs leading-relaxed text-slate-400 dark:bg-slate-800/50 dark:text-slate-500">
                  No comments yet. Leave an update for your team, ask a question, or drop a link.
                </p>
              ) : (
                <div className="space-y-4">
                  {task.comments.map((comment) => (
                    <div key={comment.id} className="group flex gap-2.5">
                      <Avatar email={comment.email} size="sm" />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline gap-2">
                          <span className="truncate text-xs font-semibold text-slate-700 dark:text-slate-200">
                            {comment.userId === currentUserId ? 'You' : comment.email.split('@')[0]}
                          </span>
                          <span className="shrink-0 text-[10px] text-slate-400 dark:text-slate-500">
                            {timeAgo(comment.createdAt)}
                          </span>
                          {(comment.userId === currentUserId || canModerate) && (
                            <button
                              type="button"
                              onClick={() => onDeleteComment(comment)}
                              className="ml-auto rounded p-0.5 text-slate-300 opacity-0 transition group-hover:opacity-100 hover:text-rose-500 focus:opacity-100 dark:text-slate-600"
                              aria-label="Delete comment"
                            >
                              <TrashIcon className="h-3.5 w-3.5" />
                            </button>
                          )}
                        </div>
                        <p className="mt-0.5 text-sm leading-relaxed break-words whitespace-pre-wrap text-slate-600 dark:text-slate-300">
                          {comment.text}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              <form onSubmit={submitComment} className="mt-4">
                <textarea
                  value={commentText}
                  onChange={(event) => setCommentText(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault()
                      submitComment(event)
                    }
                  }}
                  rows={2}
                  maxLength={2000}
                  placeholder="Write a comment…  (Enter to send)"
                  className="field resize-none text-sm"
                />
                <div className="mt-2 flex justify-end">
                  <button
                    type="submit"
                    className="btn-primary px-3! py-1.5! text-xs"
                    disabled={!commentText.trim() || commentBusy}
                  >
                    {commentBusy ? <Spinner className="h-3.5 w-3.5" /> : <PlusIcon className="h-3.5 w-3.5" />}
                    Comment
                  </button>
                </div>
              </form>
            </section>
          </div>
        </div>

        <footer className="flex shrink-0 items-center justify-between border-t border-slate-100 px-5 py-3.5 dark:border-slate-800">
          <span className="text-[11px] text-slate-400 dark:text-slate-500">
            {task.createdAt ? `Created ${fullDate(task.createdAt)}` : ''}
          </span>
          {canDelete && (
            <button
              type="button"
              onClick={async () => {
                if (window.confirm('Delete this task and all its subtasks and comments?')) {
                  await onDelete()
                }
              }}
              className="btn-danger px-2.5! py-1.5! text-xs"
            >
              <TrashIcon className="h-3.5 w-3.5" />
              Delete task
            </button>
          )}
        </footer>
      </aside>
    </>
  )
}
