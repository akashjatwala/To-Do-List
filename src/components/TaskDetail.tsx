import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { api } from '@/api'
import type {
  ActivitySession,
  Comment,
  Member,
  Priority,
  Recurrence,
  RecurrenceConfig,
  Subtask,
  Task,
} from '@/types'
import {
  dateInputValue,
  dueFromDateInput,
  formatDateValue,
  fullDate,
  timeAgo,
} from '@/lib/date'
import {
  COMMON_TAGS,
  PRIORITY_META,
  RECURRENCE_META,
  RECURRENCE_VALUES,
  TAG_LIMIT,
  describeRecurrence,
  tagTint,
} from '@/lib/taskmeta'
import { Avatar, Spinner, useBodyScrollLock, useConfirm } from './ui'
import RecurrenceEditor from './RecurrenceEditor'
import {
  CalendarIcon,
  CheckIcon,
  ChevronDownIcon,
  ClockIcon,
  ListChecksIcon,
  LockIcon,
  MessageIcon,
  PlusIcon,
  RepeatIcon,
  TrashIcon,
  UsersIcon,
  XIcon,
} from './Icons'

const DURATION_MAX = 60 * 24 * 7

const headerChipClass =
  'inline-flex items-center gap-1.5 rounded-full bg-[#F8FBFE]/90 px-2.5 py-1 text-[11px] font-semibold text-[#2E3742] ring-1 ring-white/70'

/** Combine a YYYY-MM-DD date and an HH:mm time into a local epoch timestamp. */
function entryTimestamp(date: string, time: string): number | null {
  const [year, month, day] = date.split('-').map(Number)
  const [hours, minutes] = time.split(':').map(Number)
  if (
    !year ||
    !month ||
    !day ||
    !Number.isFinite(hours) ||
    !Number.isFinite(minutes) ||
    hours < 0 ||
    hours > 23 ||
    minutes < 0 ||
    minutes > 59
  ) {
    return null
  }
  return new Date(year, month - 1, day, hours, minutes, 0, 0).getTime()
}

function shortEntryDate(date: string): string {
  const [year, month, day] = date.split('-').map(Number)
  const value = new Date(year, month - 1, day)
  const today = new Date()
  if (value.toDateString() === today.toDateString()) return 'Today'
  return value.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(value.getFullYear() === today.getFullYear() ? {} : { year: 'numeric' }),
  })
}

function clockTime(timestamp: number): string {
  const date = new Date(timestamp)
  return `${`${date.getHours()}`.padStart(2, '0')}:${`${date.getMinutes()}`.padStart(2, '0')}`
}

function durationLabel(minutes: number): string {
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  const remainder = minutes % 60
  return remainder ? `${hours}h ${remainder}m` : `${hours}h`
}

interface TaskDetailProps {
  task: Task
  currentUserId: number
  canModerate: boolean
  canDelete: boolean
  members: Member[]
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
    preferredTime?: string | null
  }) => Promise<boolean>
  onSetAssignees: (userIds: number[]) => Promise<boolean>
  onDelete: () => Promise<void>
  onAddSubtask: (text: string, assigneeId: number | null) => Promise<boolean>
  onToggleSubtask: (subtask: Subtask) => void
  onAssignSubtask: (subtask: Subtask, assigneeId: number | null) => Promise<boolean>
  onDeleteSubtask: (subtask: Subtask) => void
  onAddComment: (text: string) => Promise<boolean>
  onDeleteComment: (comment: Comment) => void
}

function DetailPillRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-2.5">
      <p className="w-[72px] shrink-0 text-xs font-bold text-[#5F6165]">{label}</p>
      <div className="flex min-h-8 min-w-0 flex-1 items-center rounded-xl bg-white px-2.5 py-1 text-xs font-semibold text-[#2E3742] shadow-[0_1px_2px_rgba(21,24,30,0.04)]">
        {children}
      </div>
    </div>
  )
}

export default function TaskDetail({
  task,
  currentUserId,
  canModerate,
  canDelete,
  members,
  onClose,
  onUpdate,
  onSetAssignees,
  onDelete,
  onAddSubtask,
  onToggleSubtask,
  onAssignSubtask,
  onDeleteSubtask,
  onAddComment,
  onDeleteComment,
}: TaskDetailProps) {
  const [title, setTitle] = useState(task.text)
  const [titleBusy, setTitleBusy] = useState(false)
  const titleRef = useRef<HTMLInputElement>(null)
  const [subtaskText, setSubtaskText] = useState('')
  const [subtaskBusy, setSubtaskBusy] = useState(false)
  const [subtaskAssignee, setSubtaskAssignee] = useState('')
  const [commentText, setCommentText] = useState('')
  const [commentBusy, setCommentBusy] = useState(false)
  const [sessions, setSessions] = useState<ActivitySession[]>([])
  const [sessionsLoading, setSessionsLoading] = useState(false)
  const [entryStart, setEntryStart] = useState('')
  const [entryEnd, setEntryEnd] = useState('')
  const [entryBusy, setEntryBusy] = useState(false)
  const [entryError, setEntryError] = useState('')
  const [tagInput, setTagInput] = useState('')
  const [showTagEditor, setShowTagEditor] = useState(false)
  const [showAssigneePicker, setShowAssigneePicker] = useState(false)
  const [assigneeBusy, setAssigneeBusy] = useState(false)
  const [durationValue, setDurationValue] = useState(task.duration ? String(task.duration) : '')
  const [customRepeat, setCustomRepeat] = useState<RecurrenceConfig>(() =>
    task.recurrenceConfig ?? { mode: 'weekly', days: [new Date().getDay()] },
  )
  const { confirm, dialog } = useConfirm()

  useEffect(() => {
    setTitle(task.text)
  }, [task.id, task.text])

  useEffect(() => {
    let cancelled = false
    setSessionsLoading(true)
    setEntryError('')
    api
      .listSessions(task.id, 200, Boolean(task.teamId))
      .then((result) => {
        if (!cancelled) setSessions(result.items)
      })
      .catch(() => {
        if (!cancelled) setEntryError('Could not load time entries.')
      })
      .finally(() => {
        if (!cancelled) setSessionsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [task.id, task.teamId])

  useEffect(() => {
    setDurationValue(task.duration ? String(task.duration) : '')
  }, [task.id, task.duration])

  useEffect(() => {
    if (task.recurrenceConfig) setCustomRepeat(task.recurrenceConfig)
  }, [task.id, task.recurrenceConfig])

  useBodyScrollLock(true)

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
    const ok = await onAddSubtask(value, subtaskAssignee ? Number(subtaskAssignee) : null)
    setSubtaskBusy(false)
    if (ok) {
      setSubtaskText('')
      setSubtaskAssignee('')
    }
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

  // Time entries always belong to the task's due date. There is no per-entry
  // date field, so a task without a due date cannot log time.
  const entryDate = dateInputValue(task.due)

  const submitEntry = async (event: FormEvent) => {
    event.preventDefault()
    setEntryError('')
    if (!entryDate) {
      setEntryError('Set a due date for this task before adding time.')
      return
    }
    const startedAt = entryTimestamp(entryDate, entryStart)
    const endedAt = entryTimestamp(entryDate, entryEnd)
    if (startedAt === null || endedAt === null) {
      setEntryError('Enter a valid start time and completion time.')
      return
    }
    if (endedAt <= startedAt) {
      setEntryError('Completion time must be after the start time.')
      return
    }
    if (startedAt > Date.now() || endedAt > Date.now()) {
      setEntryError('Time entries cannot be in the future.')
      return
    }
    setEntryBusy(true)
    try {
      await api.createSession({
        taskId: task.id,
        localDate: entryDate,
        startedAt,
        endedAt,
      })
      // Reload so a new entry has the same author fields as teammates' entries.
      const result = await api.listSessions(task.id, 200, Boolean(task.teamId))
      setSessions(result.items)
      setEntryStart('')
      setEntryEnd('')
    } catch (error) {
      setEntryError(error instanceof Error ? error.message : 'Could not save the time entry.')
    } finally {
      setEntryBusy(false)
    }
  }

  const deleteEntry = async (session: ActivitySession) => {
    if (
      !(await confirm({
        title: 'Delete time entry?',
        description: `Remove the entry from ${shortEntryDate(session.date)}, ${clockTime(session.startedAt)}–${clockTime(session.endedAt ?? session.startedAt)}?`,
        confirmLabel: 'Delete entry',
      }))
    ) {
      return
    }
    try {
      await api.deleteSession(session.id)
      setSessions((current) => current.filter((item) => item.id !== session.id))
    } catch {
      setEntryError('Could not delete the time entry.')
    }
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

  const assignees = task.assignees ?? []
  const toggleAssignee = async (person: { id: number }) => {
    if (assigneeBusy) return
    const next = assignees.some((item) => item.id === person.id)
      ? assignees.filter((item) => item.id !== person.id).map((item) => item.id)
      : [...assignees.map((item) => item.id), person.id]
    setAssigneeBusy(true)
    try {
      await onSetAssignees(next)
    } finally {
      setAssigneeBusy(false)
    }
  }

  const createdLabel = task.createdAt ? fullDate(task.createdAt) : ''
  const listLabel = task.teamName ?? 'My tasks'
  const description = describeRecurrence(task.recurrence, task.recurrenceConfig)
  const repeatLabel =
    task.recurrence === 'none'
      ? 'No repeat'
      : task.recurrence === 'daily'
        ? 'Repeats daily'
        : `Repeats ${description.toLowerCase()}`
  const dueLabel = task.due === null ? 'No due date' : formatDateValue(dateInputValue(task.due))

  return (
    <>
      <div
        className="animate-fade fixed inset-0 z-40 bg-[#15181E]/35 backdrop-blur-[3px]"
        onClick={onClose}
      />
      <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6">
        <section
          role="dialog"
          aria-modal="true"
          aria-label="Task details"
          className="animate-dialog pointer-events-auto flex max-h-full w-full max-w-5xl flex-col overflow-hidden rounded-[24px] border border-slate-200/80 bg-white shadow-[0_24px_80px_-24px_rgba(21,24,30,0.45)]"
        >
          <header className="shrink-0 bg-[#CFE3F7] px-5 py-4 sm:px-7 sm:py-5">
            <div className="flex items-center justify-between gap-3">
              <p className="text-[11px] font-bold tracking-[0.06em] text-[#3E4654]">
                Task details
              </p>
              <button
                type="button"
                onClick={onClose}
                className="icon-btn -mr-1.5 text-[#3E4654] hover:bg-white/60"
                aria-label="Close"
              >
                <XIcon className="h-5 w-5" />
              </button>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <span className={headerChipClass}>
                <span
                  className={`h-2 w-2 rounded-full ${PRIORITY_META[task.priority].dot}`}
                  aria-hidden="true"
                />
                {PRIORITY_META[task.priority].label}
              </span>
              <span className={headerChipClass}>
                {task.teamName ? <UsersIcon className="h-3.5 w-3.5" /> : <LockIcon className="h-3.5 w-3.5" />}
                {listLabel}
                {!task.teamName && <span className="text-[#7B8190]"> private</span>}
              </span>
              <span className={headerChipClass}>
                <RepeatIcon className="h-3.5 w-3.5" />
                {repeatLabel}
              </span>
              {createdLabel && (
                <span className={`${headerChipClass} hidden sm:inline-flex`}>
                  <CalendarIcon className="h-3.5 w-3.5" />
                  Created {createdLabel}
                </span>
              )}
            </div>
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="grid min-h-full grid-cols-1 md:grid-cols-[minmax(0,1fr)_300px] lg:grid-cols-[minmax(0,1fr)_340px]">
              <div className="px-5 py-6 sm:px-7">
                <div className="flex items-start gap-4">
                  <button
                    type="button"
                    onClick={() => onUpdate({ done: !task.done })}
                    role="checkbox"
                    aria-checked={task.done}
                    aria-label={task.done ? 'Mark as not done' : 'Mark as done'}
                    className={`mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border-2 transition active:scale-90 ${
                      task.done
                        ? 'border-[#009688] bg-[#009688] text-white'
                        : 'border-[#7B8190] text-transparent hover:border-[#009688] hover:text-[#009688]'
                    }`}
                  >
                    <CheckIcon className="h-4 w-4" strokeWidth={3} />
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
                      className="w-full rounded-xl border border-transparent bg-transparent px-2 py-1 text-2xl leading-tight font-extrabold tracking-tight text-[#15181E] outline-none transition hover:bg-white hover:ring-1 hover:ring-slate-200 focus:bg-white focus:ring-2 focus:ring-[#CFE3F7]"
                    />
                    <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 px-2 text-[11px] font-medium text-[#7B8190]">
                      {titleBusy && <Spinner className="h-3 w-3" />}
                      <span>Added by {task.userId === currentUserId ? 'you' : task.ownerEmail}</span>
                      <span aria-hidden="true">·</span>
                      <span>{createdLabel}</span>
                    </p>

                    <div className="mt-3 flex flex-wrap items-center gap-2 px-1">
                      {task.tags.map((tag) => (
                        <span
                          key={tag}
                          className="inline-flex max-w-[12rem] items-center gap-1 rounded-full bg-[#CFE3F7] px-2.5 py-1 text-[11px] font-semibold text-[#2E3742]"
                        >
                          <span className="truncate">#{tag.toLowerCase()}</span>
                          <button
                            type="button"
                            onClick={() => removeTag(tag)}
                            className="rounded-full p-0.5 text-[#2E3742]/50 transition hover:bg-white/70 hover:text-[#15181E]"
                            aria-label={`Remove tag ${tag}`}
                          >
                            <XIcon className="h-3 w-3" />
                          </button>
                        </span>
                      ))}
                      <button
                        type="button"
                        onClick={() => setShowTagEditor((value) => !value)}
                        aria-expanded={showTagEditor}
                        className="rounded-full border border-dashed border-slate-300 px-2.5 py-1 text-[11px] font-semibold text-[#7B8190] transition hover:border-[#7B8190] hover:text-[#15181E]"
                      >
                        + Add tag
                      </button>
                    </div>

                    {showTagEditor && (
                      <div className="mt-3 rounded-2xl border border-slate-200/80 bg-white p-3 shadow-sm">
                        <p className="mb-2 text-[10px] font-bold tracking-[0.06em] text-[#7B8190]">
                          Common tags
                        </p>
                        <div className="flex flex-wrap gap-1.5">
                          {COMMON_TAGS.map((tag) => {
                            const active = task.tags.includes(tag)
                            return (
                              <button
                                key={tag}
                                type="button"
                                onClick={() => toggleTag(tag)}
                                aria-pressed={active}
                                className={`rounded-lg px-2 py-1 text-[11px] font-semibold transition ${
                                  active
                                    ? tagTint(tag)
                                    : 'bg-[#F6F6F4] text-[#7B8190] hover:bg-slate-200'
                                }`}
                              >
                                {tag}
                              </button>
                            )
                          })}
                        </div>
                        <form onSubmit={addTag} className="mt-3 flex items-center gap-2">
                          <input
                            value={tagInput}
                            onChange={(event) => setTagInput(event.target.value)}
                            placeholder="New tag"
                            aria-label="New tag"
                            maxLength={24}
                            className="field py-1.5! text-sm"
                          />
                          {tagInput.trim() && (
                            <button
                              type="submit"
                              className="rounded-lg bg-[#15181E] px-3 py-1.5 text-[11px] font-bold text-white transition hover:bg-[#2E3742]"
                            >
                              Add
                            </button>
                          )}
                        </form>
                      </div>
                    )}
                  </div>
                </div>

                {task.teamId && (
                  <section className="mt-5 rounded-2xl bg-white p-4 ring-1 ring-slate-200/70">
                    <div className="flex items-center justify-between">
                      <h3 className="flex items-center gap-2 text-sm font-bold text-[#15181E]">
                        <UsersIcon className="h-4 w-4 text-[#7B8190]" />
                        Assigned to
                      </h3>
                      <button
                        type="button"
                        onClick={() => setShowAssigneePicker((value) => !value)}
                        aria-expanded={showAssigneePicker}
                        className="rounded-lg bg-[#F6F6F4] px-2 py-1 text-[11px] font-bold text-[#3E4654] transition hover:bg-slate-200"
                      >
                        + Assign
                      </button>
                    </div>

                    {assignees.length === 0 ? (
                      <p className="mt-2 text-xs text-[#7B8190]">No one assigned yet.</p>
                    ) : (
                      <div className="mt-3 flex flex-wrap gap-2">
                        {assignees.map((person) => (
                          <span
                            key={person.id}
                            className="inline-flex items-center gap-1.5 rounded-full bg-[#DCEBDF] py-1 pr-1.5 pl-1 text-[11px] font-bold text-[#1F3A2A]"
                          >
                            <Avatar email={person.email} size="sm" className="h-5! w-5! text-[9px]!" />
                            <span className="max-w-[10rem] truncate">{person.name}</span>
                            <button
                              type="button"
                              onClick={() => void toggleAssignee(person)}
                              disabled={assigneeBusy}
                              aria-label={`Unassign ${person.name}`}
                              className="rounded-full p-0.5 transition hover:bg-white/80 disabled:opacity-50"
                            >
                              <XIcon className="h-3 w-3" />
                            </button>
                          </span>
                        ))}
                      </div>
                    )}

                    {showAssigneePicker && (
                      <div className="mt-3 rounded-xl border border-slate-200/80 bg-[#F6F6F4] p-2">
                        {members.length === 0 ? (
                          <p className="px-2 py-1 text-xs text-[#7B8190]">
                            No teammates to assign yet.
                          </p>
                        ) : (
                          members.map((member) => {
                            const active = assignees.some((item) => item.id === member.id)
                            return (
                              <button
                                key={member.id}
                                type="button"
                                onClick={() => void toggleAssignee(member)}
                                disabled={assigneeBusy}
                                aria-pressed={active}
                                className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs font-semibold text-[#2E3742] transition hover:bg-white disabled:opacity-50"
                              >
                                <Avatar email={member.email} size="sm" />
                                <span className="min-w-0 flex-1 truncate">
                                  {member.email.split('@')[0]}
                                </span>
                                <span className="text-[10px] font-bold capitalize text-[#7B8190]">
                                  {member.role}
                                </span>
                                {active && (
                                  <CheckIcon className="h-3.5 w-3.5 text-[#009688]" />
                                )}
                              </button>
                            )
                          })
                        )}
                      </div>
                    )}
                  </section>
                )}

                <section className="mt-6 rounded-2xl bg-[#F6F6F4] p-4">
                  <div className="mb-3 flex items-center justify-between">
                    <h3 className="flex items-center gap-2 text-sm font-bold text-[#15181E]">
                      <MessageIcon className="h-4 w-4 text-[#7B8190]" />
                      Notes
                    </h3>
                    {task.comments.length > 0 && (
                      <span className="rounded-full bg-white px-2 py-0.5 text-[10px] font-bold text-[#7B8190]">
                        {task.comments.length}
                      </span>
                    )}
                  </div>

                  {task.comments.length === 0 ? (
                    <p className="rounded-xl bg-white px-3.5 py-3 text-xs leading-relaxed text-[#7B8190] ring-1 ring-slate-200/70">
                      No notes yet. Add context, a link, or an update for anyone who opens this task.
                    </p>
                  ) : (
                    <div className="space-y-3">
                      {task.comments.map((comment) => (
                        <div key={comment.id} className="group flex gap-2.5">
                          <Avatar email={comment.email} size="sm" />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-baseline gap-2">
                              <span className="truncate text-xs font-bold text-[#2E3742]">
                                {comment.userId === currentUserId ? 'You' : comment.email.split('@')[0]}
                              </span>
                              <span className="shrink-0 text-[10px] text-[#7B8190]">
                                {timeAgo(comment.createdAt)}
                              </span>
                              {(comment.userId === currentUserId || canModerate) && (
                                <button
                                  type="button"
                                  onClick={() => onDeleteComment(comment)}
                                  className="ml-auto rounded p-0.5 text-[#7B8190] opacity-70 transition hover:text-rose-500 focus:opacity-100"
                                  aria-label="Delete note"
                                >
                                  <TrashIcon className="h-3.5 w-3.5" />
                                </button>
                              )}
                            </div>
                            <p className="mt-0.5 text-sm leading-relaxed break-words whitespace-pre-wrap text-[#3E4654]">
                              {comment.text}
                            </p>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  <form onSubmit={submitComment} className="mt-3">
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
                      placeholder="Write a note…  (Enter to send)"
                      aria-label="New note"
                      className="field resize-none border-slate-200/80 bg-white text-sm"
                    />
                    <div className="mt-2 flex justify-end">
                      <button
                        type="submit"
                        disabled={!commentText.trim() || commentBusy}
                        className="inline-flex items-center justify-center gap-1.5 rounded-xl bg-[#15181E] px-3 py-1.5 text-[11px] font-bold text-white transition hover:bg-[#2E3742] disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {commentBusy ? <Spinner className="h-3.5 w-3.5" /> : <PlusIcon className="h-3.5 w-3.5" />}
                        Add note
                      </button>
                    </div>
                  </form>
                </section>

                <section className="mt-6">
                  <div className="mb-2 flex items-center justify-between">
                    <h3 className="flex items-center gap-2 text-sm font-bold text-[#15181E]">
                      <ListChecksIcon className="h-4 w-4 text-[#7B8190]" />
                      Subtasks
                      {task.subtasks.length > 0 && (
                        <span className="rounded-full bg-[#CFE3F7] px-1.5 py-0.5 text-[10px] font-bold text-[#2E3742]">
                          {doneSubtasks} of {task.subtasks.length}
                        </span>
                      )}
                    </h3>
                  </div>

                  {task.subtasks.length > 0 && (
                    <div className="mb-3 h-1.5 overflow-hidden rounded-full bg-slate-100">
                      <div
                        className="h-full rounded-full bg-[#009688] transition-all duration-300"
                        style={{ width: `${subtaskPercent}%` }}
                      />
                    </div>
                  )}

                  <div className="space-y-1">
                    {task.subtasks.map((subtask) => (
                      <div
                        key={subtask.id}
                        className="group flex items-center gap-2.5 rounded-lg px-1 py-1.5 hover:bg-white"
                      >
                        <button
                          type="button"
                          onClick={() => onToggleSubtask(subtask)}
                          role="checkbox"
                          aria-checked={subtask.done}
                          className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border transition ${
                            subtask.done
                              ? 'border-[#009688] bg-[#009688] text-white'
                              : 'border-[#7B8190] text-transparent hover:border-[#009688]'
                          }`}
                          aria-label={subtask.done ? 'Mark subtask incomplete' : 'Complete subtask'}
                        >
                          <CheckIcon className="h-2.5 w-2.5" strokeWidth={3.5} />
                        </button>
                        <span
                          className={`flex-1 text-sm ${
                            subtask.done ? 'text-[#7B8190]' : 'text-[#3E4654]'
                          }`}
                        >
                          {subtask.text}
                        </span>
                        {task.teamId && (
                          <select
                            value={subtask.assignee?.id ? String(subtask.assignee.id) : ''}
                            onChange={(event) =>
                              void onAssignSubtask(
                                subtask,
                                event.target.value ? Number(event.target.value) : null,
                              )
                            }
                            aria-label={`Assignee for ${subtask.text}`}
                            className="max-w-[8rem] shrink-0 rounded-md bg-[#F6F6F4] px-1.5 py-0.5 text-[10px] font-bold text-[#5F6165] outline-none"
                          >
                            <option value="">Unassigned</option>
                            {members.map((member) => (
                              <option key={member.id} value={member.id}>
                                {member.email.split('@')[0]}
                              </option>
                            ))}
                          </select>
                        )}
                        <button
                          type="button"
                          onClick={() => onDeleteSubtask(subtask)}
                          className="rounded p-1 text-[#7B8190] opacity-70 transition hover:text-rose-500 focus:opacity-100"
                          aria-label="Delete subtask"
                        >
                          <TrashIcon className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    ))}
                  </div>

                  <form onSubmit={submitSubtask} className="mt-2 flex items-center gap-2">
                    <PlusIcon className="ml-1 h-3.5 w-3.5 shrink-0 text-[#7B8190]" />
                    <input
                      value={subtaskText}
                      onChange={(event) => setSubtaskText(event.target.value)}
                      placeholder="+ Add a subtask"
                      maxLength={200}
                      aria-label="New subtask"
                      className="w-full rounded-lg border border-transparent bg-transparent px-1 py-1.5 text-sm text-[#2E3742] outline-none placeholder:text-[#7B8190] hover:bg-white focus:bg-white focus:ring-2 focus:ring-[#CFE3F7]"
                    />
                    {task.teamId && (
                      <select
                        value={subtaskAssignee}
                        onChange={(event) => setSubtaskAssignee(event.target.value)}
                        aria-label="Subtask assignee"
                        className="shrink-0 rounded-lg bg-[#F6F6F4] px-1.5 py-1 text-[11px] font-bold text-[#5F6165] outline-none"
                      >
                        <option value="">Unassigned</option>
                        {members.map((member) => (
                          <option key={member.id} value={member.id}>
                            {member.email.split('@')[0]}
                          </option>
                        ))}
                      </select>
                    )}
                    {subtaskText.trim() && (
                      <button
                        type="submit"
                        disabled={subtaskBusy}
                        className="rounded-lg bg-[#15181E] px-2.5 py-1 text-[11px] font-bold text-white transition hover:bg-[#2E3742] disabled:opacity-50"
                      >
                        {subtaskBusy ? <Spinner className="h-3 w-3" /> : 'Add'}
                      </button>
                    )}
                  </form>
                </section>

                <section className="mt-6 rounded-2xl bg-white p-4 ring-1 ring-slate-200/70">
                  <div className="flex items-center justify-between">
                    <h3 className="flex items-center gap-2 text-sm font-bold text-[#15181E]">
                      <ClockIcon className="h-4 w-4 text-[#7B8190]" />
                      Task time
                    </h3>
                    <span className="rounded-full bg-[#F6F6F4] px-2 py-0.5 text-[11px] font-bold text-[#2E3742] tabular-nums">
                      {sessions.length} {sessions.length === 1 ? 'entry' : 'entries'}
                    </span>
                  </div>
                  <p className="mt-1 text-[11px] leading-relaxed text-[#7B8190]">
                    {task.teamId
                      ? 'Start and completion times are shared with your teammates. Each entry stays owned by the person who logged it.'
                      : 'Log as many start and completion times as you need for this task.'}
                  </p>

                  <div className="mt-3 space-y-2">
                    {sessionsLoading && (
                      <p className="py-2 text-[11px] text-[#7B8190]">Loading time entries…</p>
                    )}
                    {!sessionsLoading && sessions.length === 0 && (
                      <p className="rounded-xl bg-[#F6F6F4] px-3 py-2.5 text-[11px] text-[#7B8190]">
                        No time entries yet. Add one below.
                      </p>
                    )}
                    {[...sessions]
                      .sort((a, b) => b.startedAt - a.startedAt)
                      .map((session) => {
                        const mine = !task.teamId || session.userId === currentUserId
                        return (
                          <div
                            key={session.id}
                            className="flex items-center gap-2 rounded-xl bg-[#F6F6F4] px-3 py-2"
                          >
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2 text-xs font-bold text-[#2E3742] tabular-nums">
                                <span className="rounded-md bg-white px-1.5 py-0.5 text-[10px] font-semibold text-[#5F6165]">
                                  {shortEntryDate(session.date)}
                                </span>
                                <span>
                                  {clockTime(session.startedAt)} –{' '}
                                  {clockTime(session.endedAt ?? session.startedAt)}
                                </span>
                                <span className="text-[10px] font-semibold text-[#7B8190]">
                                  ({durationLabel(session.durationMinutes)})
                                </span>
                              </div>
                              {task.teamId && session.authorEmail && (
                                <p className="mt-0.5 truncate text-[10px] font-medium text-[#7B8190]">
                                  {session.authorName || session.authorEmail}
                                </p>
                              )}
                            </div>
                            {mine && (
                              <button
                                type="button"
                                onClick={() => void deleteEntry(session)}
                                aria-label="Delete time entry"
                                className="shrink-0 rounded-lg p-1.5 text-[#7B8190] transition hover:bg-rose-50 hover:text-rose-600"
                              >
                                <TrashIcon className="h-3.5 w-3.5" />
                              </button>
                            )}
                          </div>
                        )
                      })}
                  </div>

                  <form onSubmit={submitEntry} className="mt-3 border-t border-slate-200/80 pt-3">
                    <p className="text-[11px] font-bold text-[#5F6165]">Add a time entry</p>
                    {entryDate ? (
                      <p className="mt-0.5 text-[10px] font-medium text-[#7B8190]">
                        Logged for this task's due date · {formatDateValue(entryDate)}
                      </p>
                    ) : (
                      <p className="mt-0.5 text-[10px] font-medium text-rose-600">
                        Set a due date for this task to add time.
                      </p>
                    )}
                    <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1fr_auto]">
                      <input
                        type="time"
                        value={entryStart}
                        onChange={(event) => setEntryStart(event.target.value)}
                        placeholder="Start"
                        aria-label="Start time"
                        className="min-w-0 rounded-lg bg-white px-2 py-1.5 text-[11px] font-semibold text-[#2E3742] ring-1 ring-slate-200 outline-none focus:ring-[#009688]"
                      />
                      <input
                        type="time"
                        value={entryEnd}
                        onChange={(event) => setEntryEnd(event.target.value)}
                        placeholder="Completion"
                        aria-label="Completion time"
                        className="min-w-0 rounded-lg bg-white px-2 py-1.5 text-[11px] font-semibold text-[#2E3742] ring-1 ring-slate-200 outline-none focus:ring-[#009688]"
                      />
                      <button
                        type="submit"
                        disabled={entryBusy || !entryStart || !entryEnd || !entryDate}
                        className="rounded-lg bg-[#15181E] px-3 py-1.5 text-[11px] font-bold text-white transition hover:bg-[#2E3742] disabled:opacity-50"
                      >
                        {entryBusy ? <Spinner className="h-3 w-3" /> : 'Add time'}
                      </button>
                    </div>
                    {entryError && (
                      <p className="mt-2 text-[11px] font-semibold text-rose-600">{entryError}</p>
                    )}
                  </form>
                </section>

              </div>

              <aside className="border-t border-slate-200/80 bg-[#F6F6F4] px-5 py-6 sm:px-6 md:border-t-0 md:border-l">
                <section>
                  <h3 className="text-sm font-bold text-[#15181E]">Details</h3>
                  <div className="mt-3 space-y-2.5">
                    <DetailPillRow label="List">
                      <span className="min-w-0 flex-1 truncate">
                        {listLabel}
                        {!task.teamName && <span className="text-[#7B8190]"> private</span>}
                      </span>
                      <ChevronDownIcon className="h-3.5 w-3.5 shrink-0 text-[#7B8190]" />
                    </DetailPillRow>

                    <DetailPillRow label="Due">
                      <div className="flex min-w-0 flex-1 items-center gap-1.5">
                        <input
                          id="task-due"
                          type="date"
                          value={dateInputValue(task.due)}
                          onChange={(event) =>
                            onUpdate({ due: dueFromDateInput(event.target.value) })
                          }
                          aria-label="Due date"
                          className="min-w-0 flex-1 bg-transparent text-[11px] font-semibold text-[#2E3742] outline-none"
                        />
                        <span className="sr-only">{dueLabel}</span>
                      </div>
                      {task.due !== null && (
                        <button
                          type="button"
                          onClick={() => void onUpdate({ due: null })}
                          aria-label="Clear due date"
                          className="rounded p-0.5 text-[#7B8190] transition hover:text-[#15181E]"
                        >
                          <XIcon className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </DetailPillRow>

                    <DetailPillRow label="Duration">
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
                        placeholder="—"
                        aria-label="Ideal duration in minutes"
                        className="w-10 bg-transparent text-right text-xs font-bold text-[#2E3742] outline-none placeholder:text-[#7B8190]"
                      />
                      <span className="ml-1 text-xs font-semibold text-[#5F6165]">min</span>
                      <ChevronDownIcon className="ml-auto h-3.5 w-3.5 shrink-0 text-[#7B8190]" />
                    </DetailPillRow>

                    <DetailPillRow label="Repeats">
                      <select
                        value={task.recurrence}
                        onChange={(event) => changeRecurrence(event.target.value as Recurrence)}
                        aria-label="Repeat rule"
                        className="min-w-0 flex-1 appearance-none bg-transparent text-xs font-bold text-[#2E3742] outline-none"
                      >
                        {RECURRENCE_VALUES.map((value) => (
                          <option key={value} value={value}>
                            {RECURRENCE_META[value].label}
                          </option>
                        ))}
                      </select>
                      <ChevronDownIcon className="h-3.5 w-3.5 shrink-0 text-[#7B8190]" />
                    </DetailPillRow>
                    {task.recurrence === 'custom' && (
                      <div className="pl-[82px]">
                        <RecurrenceEditor config={customRepeat} onChange={changeCustomRepeat} />
                      </div>
                    )}
                  </div>
                </section>
              </aside>
            </div>
          </div>

          <footer className="shrink-0 border-t border-slate-200/80 bg-white px-5 py-3 sm:px-7">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-3">
                {canDelete && (
                  <button
                    type="button"
                    onClick={async () => {
                      if (
                        await confirm({
                          title: 'Delete task?',
                          description: 'Delete this task and all its subtasks and comments?',
                          confirmLabel: 'Delete task',
                        })
                      ) {
                        await onDelete()
                      }
                    }}
                    className="inline-flex items-center gap-1.5 rounded-xl px-2.5 py-2 text-xs font-bold text-rose-600 transition hover:bg-rose-50"
                  >
                    <TrashIcon className="h-3.5 w-3.5" />
                    Delete task
                  </button>
                )}
                <p className="hidden text-[11px] text-[#7B8190] sm:block">
                  {task.teamName
                    ? `Visible to ${task.teamName}.`
                    : 'Only you can see this task.'}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button type="button" onClick={onClose} className="btn-ghost px-3! py-2! text-xs">
                  Close
                </button>
                <button
                  type="button"
                  onClick={() => void onUpdate({ done: !task.done })}
                  className="rounded-xl bg-[#15181E] px-4 py-2 text-xs font-bold text-white transition hover:bg-[#2E3742]"
                >
                  {task.done ? 'Mark not done' : 'Mark done for today'}
                </button>
              </div>
            </div>
          </footer>
        </section>
      </div>
      {dialog}
    </>
  )
}
