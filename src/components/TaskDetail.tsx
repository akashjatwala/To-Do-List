import { useEffect, useRef, useState, type FormEvent } from 'react'
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
import { dateInputValue, formatDateValue, fullDate } from '@/lib/date'
import {
  COMMON_TAGS,
  PRIORITY_META,
  TAG_LIMIT,
  describeRecurrence,
  repeatsOnDate,
  tagTint,
} from '@/lib/taskmeta'
import { Spinner, useBodyScrollLock, useConfirm } from './ui'
import {
  CalendarIcon,
  CheckIcon,
  LockIcon,
  RepeatIcon,
  TrashIcon,
  UsersIcon,
  XIcon,
} from './Icons'
import { DURATION_MAX, headerChipClass } from './task-detail/helpers'
import TaskAssigneesSection from './task-detail/TaskAssigneesSection'
import TaskDetailsSidebar from './task-detail/TaskDetailsSidebar'
import TaskNotesSection from './task-detail/TaskNotesSection'
import TaskSubtasksSection from './task-detail/TaskSubtasksSection'
import TaskTimeEntries from './task-detail/TaskTimeEntries'

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
  selectedDate?: string
  onSkipDay?: () => Promise<void>
  onAddSubtask: (text: string, assigneeId: number | null) => Promise<boolean>
  onToggleSubtask: (subtask: Subtask) => void
  onAssignSubtask: (subtask: Subtask, assigneeId: number | null) => Promise<boolean>
  onDeleteSubtask: (subtask: Subtask) => void
  onAddComment: (text: string) => Promise<boolean>
  onDeleteComment: (comment: Comment) => void
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
  selectedDate = '',
  onSkipDay = async () => undefined,
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
    const value = tagInput.trim().replace(/\s+/g, ' ').toLowerCase()
    setTagInput('')
    if (!value || task.tags.includes(value) || task.tags.length >= TAG_LIMIT) return
    void onUpdate({ tags: [...task.tags, value] })
  }

  const toggleTag = (rawTag: string) => {
    const tag = rawTag.trim().replace(/\s+/g, ' ').toLowerCase()
    if (!tag) return
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
  const canSkipDay =
    !task.done &&
    task.due !== null &&
    (task.recurrence === 'none'
      ? dateInputValue(task.due) === selectedDate
      : repeatsOnDate(task.due, task.recurrence, task.recurrenceConfig, selectedDate))

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

                <TaskAssigneesSection
                  task={task}
                  members={members}
                  assignees={assignees}
                  assigneeBusy={assigneeBusy}
                  showAssigneePicker={showAssigneePicker}
                  setShowAssigneePicker={setShowAssigneePicker}
                  toggleAssignee={toggleAssignee}
                />

                <TaskNotesSection
                  task={task}
                  currentUserId={currentUserId}
                  canModerate={canModerate}
                  commentText={commentText}
                  setCommentText={setCommentText}
                  commentBusy={commentBusy}
                  submitComment={submitComment}
                  onDeleteComment={onDeleteComment}
                />

                <TaskSubtasksSection
                  task={task}
                  members={members}
                  subtaskText={subtaskText}
                  setSubtaskText={setSubtaskText}
                  subtaskBusy={subtaskBusy}
                  subtaskAssignee={subtaskAssignee}
                  setSubtaskAssignee={setSubtaskAssignee}
                  submitSubtask={submitSubtask}
                  onToggleSubtask={onToggleSubtask}
                  onAssignSubtask={onAssignSubtask}
                  onDeleteSubtask={onDeleteSubtask}
                />

                <TaskTimeEntries
                  task={task}
                  currentUserId={currentUserId}
                  sessions={sessions}
                  sessionsLoading={sessionsLoading}
                  entryError={entryError}
                  setEntryError={setEntryError}
                  setSessions={setSessions}
                  confirm={confirm}
                />

              </div>

              <TaskDetailsSidebar
                task={task}
                listLabel={listLabel}
                dueLabel={dueLabel}
                durationValue={durationValue}
                customRepeat={customRepeat}
                onUpdate={onUpdate}
                setDurationValue={setDurationValue}
                commitDuration={commitDuration}
                changeRecurrence={changeRecurrence}
                changeCustomRepeat={changeCustomRepeat}
              />
            </div>
          </div>

          <footer className="shrink-0 border-t border-slate-200/80 bg-white px-5 py-3 sm:px-7">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex min-w-0 flex-wrap items-center gap-3">
                {canSkipDay && (
                  <>
                    <button
                      type="button"
                      onClick={() => void onSkipDay()}
                      className="inline-flex items-center gap-1.5 rounded-xl px-2.5 py-2 text-xs font-bold text-[#35506B] transition hover:bg-[#EAF2FB]"
                      aria-label="Skip for today"
                    >
                      <CalendarIcon className="h-3.5 w-3.5" />
                      Skip for today
                    </button>
                  </>
                )}
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
