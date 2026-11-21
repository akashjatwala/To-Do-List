import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import type {
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
  GaugeIcon,
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
  const [progressValue, setProgressValue] = useState(task.progress ?? 0)
  const [tagInput, setTagInput] = useState('')
  const [showTagEditor, setShowTagEditor] = useState(false)
  const [showAssigneePicker, setShowAssigneePicker] = useState(false)
  const [assigneeBusy, setAssigneeBusy] = useState(false)
  const [durationValue, setDurationValue] = useState(task.duration ? String(task.duration) : '')
  const [preferredTime, setPreferredTime] = useState(task.preferredTime ?? '')
  const [customRepeat, setCustomRepeat] = useState<RecurrenceConfig>(() =>
    task.recurrenceConfig ?? { mode: 'weekly', days: [new Date().getDay()] },
  )
  const { confirm, dialog } = useConfirm()

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
    setPreferredTime(task.preferredTime ?? '')
  }, [task.id, task.preferredTime])

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
                      <GaugeIcon className="h-4 w-4 text-[#7B8190]" />
                      Progress
                    </h3>
                    <span className="rounded-full bg-[#F6F6F4] px-2 py-0.5 text-[11px] font-bold text-[#2E3742] tabular-nums">
                      {progressValue}%
                    </span>
                  </div>
                  <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-slate-100">
                    <div
                      className="h-full rounded-full bg-[#009688] transition-all duration-200"
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
                    className="progress-range mt-2 w-full"
                  />
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {[0, 25, 50, 75, 100].map((preset) => (
                      <button
                        key={preset}
                        type="button"
                        onClick={() => commitProgress(preset)}
                        className={`rounded-lg px-2 py-1 text-[11px] font-bold transition ${
                          progressValue === preset
                            ? 'bg-[#15181E] text-white'
                            : 'bg-[#F6F6F4] text-[#7B8190] hover:bg-slate-200'
                        }`}
                      >
                        {preset}%
                      </button>
                    ))}
                  </div>
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
                        <input
                          type="time"
                          value={preferredTime}
                          onChange={(event) => {
                            setPreferredTime(event.target.value)
                            void onUpdate({ preferredTime: event.target.value || null })
                          }}
                          aria-label="Preferred time of day"
                          className="w-[62px] shrink-0 bg-transparent text-[11px] font-semibold text-[#2E3742] outline-none"
                        />
                        <span className="sr-only">{dueLabel}</span>
                      </div>
                      {(task.due !== null || preferredTime) && (
                        <button
                          type="button"
                          onClick={() => {
                            if (task.due !== null) void onUpdate({ due: null })
                            if (preferredTime) {
                              setPreferredTime('')
                              void onUpdate({ preferredTime: null })
                            }
                          }}
                          aria-label="Clear due date and time"
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

                <section className="mt-5 rounded-[20px] bg-[#E7E1F5] p-4 text-[#37344B]">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-bold">Nudge</p>
                  </div>
                  <div className="mt-3 flex items-center justify-between gap-2">
                    <p className="text-sm font-bold">Chance of finishing today</p>
                    <span className="text-xl leading-none font-extrabold">71%</span>
                  </div>
                  <div className="mt-2 h-2 overflow-hidden rounded-full bg-white/70">
                    <div className="h-full w-[71%] rounded-full bg-[#37344B]" />
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
