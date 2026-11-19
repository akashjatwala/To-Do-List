import { useEffect, useRef, useState, type CSSProperties, type DragEvent } from 'react'
import type { Task } from '@/types'
import { formatDuration, PRIORITY_META, STICKY_META, recurrenceShort } from '@/lib/taskmeta'
import { noteTilt, pinClass } from '@/lib/notes'
import {
  CheckIcon,
  ClockIcon,
  GripIcon,
  ListChecksIcon,
  MessageIcon,
  RepeatIcon,
  TrashIcon,
} from './Icons'

interface BoardProps {
  tasks: Task[]
  currentUserId: number
  showOwner: boolean
  canDelete: (task: Task) => boolean
  onOpen: (task: Task) => void
  onToggle: (task: Task) => void
  onDelete: (task: Task) => void
}

/**
 * A decorative push-pin, centred on a note's top edge. It is not interactive
 * (the note still drags and double-clicks as before) and is hidden from screen
 * readers; the colour is chosen by a stable rule so a note keeps its pin.
 */
function PushPin({ taskId }: { taskId: string }) {
  return (
    <span
      aria-hidden="true"
      className={`sticky-pin pointer-events-none absolute -top-3 left-1/2 z-20 -translate-x-1/2 ${pinClass(taskId)}`}
    >
      <svg viewBox="0 0 24 24" className="h-5 w-5 drop-shadow-sm" fill="none">
        <ellipse cx="12" cy="21.5" rx="3.2" ry="1.1" className="fill-slate-900/15" />
        <path d="M12 15.5v5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        <circle cx="12" cy="9.5" r="6.2" fill="currentColor" />
        <circle cx="9.9" cy="7.4" r="2.1" className="fill-white/60" />
      </svg>
    </span>
  )
}

export function StickyBoard({
  tasks,
  emptyTitle,
  emptyText,
  currentUserId,
  showOwner,
  canDelete,
  onOpen,
  onToggle,
  onDelete,
  onReorder,
}: BoardProps & { emptyTitle: string; emptyText: string; onReorder: (orderedIds: string[]) => void }) {
  // Notes are kept in local order while dragging so the board can preview the
  // new arrangement; the parent persists it and refreshes the real order.
  const [ordered, setOrdered] = useState<Task[]>(tasks)
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<{ id: string; side: 'before' | 'after' } | null>(null)
  const dragId = useRef<string | null>(null)

  useEffect(() => {
    setOrdered(tasks)
  }, [tasks])

  // Notes already on screen when the board loads keep their pin still. A note
  // that appears later (a task added while the board is open) presses its pin
  // in once, briefly.
  const knownIds = useRef<Set<string>>(new Set(tasks.map((task) => task.id)))
  const [pressing, setPressing] = useState<Set<string>>(() => new Set())
  const pressTimers = useRef<number[]>([])

  useEffect(() => {
    const fresh = tasks.filter((task) => !knownIds.current.has(task.id))
    if (fresh.length === 0) return
    const ids = fresh.map((task) => task.id)
    for (const id of ids) knownIds.current.add(id)
    setPressing((prev) => new Set([...prev, ...ids]))
    const timer = window.setTimeout(() => {
      setPressing((prev) => {
        const next = new Set(prev)
        for (const id of ids) next.delete(id)
        return next
      })
    }, 320)
    pressTimers.current.push(timer)
  }, [tasks])

  useEffect(
    () => () => {
      for (const timer of pressTimers.current) window.clearTimeout(timer)
    },
    [],
  )

  const clearDrag = () => {
    dragId.current = null
    setDraggingId(null)
    setDropTarget(null)
  }

  const handleDragStart = (event: DragEvent<HTMLElement>, task: Task) => {
    dragId.current = task.id
    setDraggingId(task.id)
    setDropTarget(null)
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', task.id)
  }

  const handleDragOver = (event: DragEvent<HTMLElement>, task: Task) => {
    if (!dragId.current || dragId.current === task.id) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    const rect = event.currentTarget.getBoundingClientRect()
    const side = event.clientX < rect.left + rect.width / 2 ? 'before' : 'after'
    setDropTarget((current) =>
      current?.id === task.id && current.side === side ? current : { id: task.id, side },
    )
  }

  const handleDragLeave = (event: DragEvent<HTMLElement>, task: Task) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
    setDropTarget((current) => (current?.id === task.id ? null : current))
  }

  const handleDrop = (event: DragEvent<HTMLElement>, task: Task) => {
    event.preventDefault()
    const sourceId = dragId.current
    if (!sourceId || sourceId === task.id) {
      clearDrag()
      return
    }

    const rect = event.currentTarget.getBoundingClientRect()
    const side = event.clientX < rect.left + rect.width / 2 ? 'before' : 'after'
    const next = [...ordered]
    const from = next.findIndex((item) => item.id === sourceId)
    if (from === -1) {
      clearDrag()
      return
    }
    const [moved] = next.splice(from, 1)
    const targetIndex = next.findIndex((item) => item.id === task.id)
    next.splice(targetIndex + (side === 'after' ? 1 : 0), 0, moved)

    clearDrag()
    setOrdered(next)
    onReorder(next.map((item) => item.id))
  }

  if (ordered.length === 0) {
    return (
      <div className="animate-in relative flex flex-col items-center justify-center rounded-[28px] border-2 border-dashed border-amber-300/80 bg-[#fff7d6]/60 px-6 py-16 text-center">
        <div className="relative h-16 w-16 -rotate-3">
          <div className="absolute inset-0 translate-x-2 translate-y-2 rotate-6 rounded-2xl border-2 border-rose-300/70 bg-[#ffc9c0]" />
          <div className="absolute inset-0 translate-x-1 translate-y-1 -rotate-3 rounded-2xl border-2 border-amber-300/80 bg-[#ffe98f]" />
          <div className="absolute inset-0 flex items-center justify-center rounded-2xl border-2 border-emerald-400/60 bg-[#b8f2c8] text-emerald-700">
            <ListChecksIcon className="h-7 w-7" strokeWidth={2.5} />
          </div>
        </div>
        <h3 className="mt-5 text-base font-bold text-amber-900">
          {emptyTitle}
        </h3>
        <p className="mt-1 max-w-xs text-sm font-medium text-amber-800/70">
          {emptyText}
        </p>
      </div>
    )
  }

  return (
    <div className="sticky-board grid gap-x-4 gap-y-6 rounded-[28px] p-3 sm:grid-cols-2 sm:p-4 xl:grid-cols-3">
      {ordered.map((task) => {
        const meta = STICKY_META[task.priority]
        const doneSubtasks = task.subtasks.filter((subtask) => subtask.done).length
        const repeat = recurrenceShort(task.recurrence, task.recurrenceConfig)
        const isDragging = draggingId === task.id
        const isDropTarget = dropTarget?.id === task.id
        const isNew = pressing.has(task.id)
        return (
          <article
            key={task.id}
            draggable
            onDragStart={(event) => handleDragStart(event, task)}
            onDragEnd={clearDrag}
            onDragOver={(event) => handleDragOver(event, task)}
            onDragLeave={(event) => handleDragLeave(event, task)}
            onDrop={(event) => handleDrop(event, task)}
            onDoubleClick={(event) => {
              if ((event.target as HTMLElement).closest('[data-note-action]')) return
              onOpen(task)
            }}
            style={{ '--tilt': `${noteTilt(task.id)}deg` } as CSSProperties}
            title="Drag to rearrange · Double-click to open"
            className={`sticky-note group relative flex min-h-[10rem] cursor-grab flex-col border-2 px-4 pt-7 pb-4 active:cursor-grabbing ${meta.note} ${
              isDragging ? 'opacity-40' : ''
            } ${isNew ? 'sticky-pin-new' : ''}`}
          >
            <PushPin taskId={task.id} />
            <span
              aria-hidden="true"
              className={`sticky-tape pointer-events-none absolute -top-2.5 left-1/2 h-4 w-16 -translate-x-1/2 -rotate-2 rounded-[3px] opacity-95 ${meta.tape}`}
            />

            {isDropTarget && (
              <span
                aria-hidden="true"
                className={`pointer-events-none absolute inset-y-4 z-10 w-1 rounded-full bg-indigo-500 shadow-[0_0_0_3px_rgba(99,102,241,0.25)] ${
                  dropTarget.side === 'before' ? '-left-2.5' : '-right-2.5'
                }`}
              />
            )}

            <div className="flex items-start gap-2">
              <button
                type="button"
                data-note-action
                onClick={() => onToggle(task)}
                role="checkbox"
                aria-checked={false}
                aria-label="Mark as done"
                className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-[2.5px] transition duration-150 hover:rotate-6 active:scale-90 ${meta.check}`}
              >
                <CheckIcon className="h-3 w-3" strokeWidth={3.5} />
              </button>

              <div className="min-w-0 flex-1 text-left">
                <p className="text-base leading-snug font-bold tracking-tight break-words">
                  {task.text}
                </p>
              </div>

              <span
                aria-hidden="true"
                data-note-action
                className={`mt-0.5 hidden shrink-0 rounded-md p-1 opacity-25 transition group-hover:opacity-60 sm:inline-flex ${meta.muted}`}
              >
                <GripIcon className="h-3.5 w-3.5" />
              </span>

              {canDelete(task) && (
                <button
                  type="button"
                  data-note-action
                  onClick={() => {
                    if (window.confirm(`Delete “${task.text}”?`)) onDelete(task)
                  }}
                  className={`-mt-1 -mr-1.5 rounded-lg p-1 opacity-0 transition group-hover:opacity-60 hover:opacity-100 focus:opacity-100 ${meta.muted}`}
                  aria-label="Delete task"
                  title="Delete task"
                >
                  <TrashIcon className="h-3.5 w-3.5" />
                </button>
              )}
            </div>

            <div
              className={`mt-auto flex flex-wrap items-center gap-1.5 pt-3 text-[11px] font-semibold ${meta.muted}`}
            >
              {task.duration !== null && (
                <span
                  className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 ${meta.chip}`}
                  title="Ideal duration"
                >
                  <ClockIcon className="h-3.5 w-3.5" />
                  {formatDuration(task.duration)}
                </span>
              )}
              {repeat && (
                <span
                  className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 ${meta.chip}`}
                  title="Repeats"
                >
                  <RepeatIcon className="h-3.5 w-3.5" />
                  {repeat}
                </span>
              )}
              {task.tags.slice(0, 2).map((tag) => (
                <span
                  key={tag}
                  className={`max-w-[9rem] truncate rounded-full px-1.5 py-0.5 ${meta.chip}`}
                >
                  #{tag}
                </span>
              ))}
              {task.tags.length > 2 && (
                <span className={`rounded-full px-1.5 py-0.5 ${meta.chip}`}>
                  +{task.tags.length - 2}
                </span>
              )}
              {task.subtasks.length > 0 && (
                <span
                  className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 ${meta.chip}`}
                >
                  <ListChecksIcon className="h-3.5 w-3.5" />
                  {doneSubtasks}/{task.subtasks.length}
                </span>
              )}
              {task.comments.length > 0 && (
                <span
                  className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 ${meta.chip}`}
                >
                  <MessageIcon className="h-3.5 w-3.5" />
                  {task.comments.length}
                </span>
              )}
              {showOwner && task.userId !== currentUserId && (
                <span className={`max-w-[8rem] truncate rounded-full px-1.5 py-0.5 ${meta.chip}`}>
                  {task.ownerEmail.split('@')[0]}
                </span>
              )}
            </div>
          </article>
        )
      })}
    </div>
  )
}

export function CompletedColumn({
  tasks,
  currentUserId,
  showOwner,
  canDelete,
  onOpen,
  onToggle,
  onDelete,
}: BoardProps) {
  return (
    <aside className="lg:sticky lg:top-5">
      <div className="rounded-2xl border border-slate-200/80 bg-white/85 p-3 shadow-sm backdrop-blur">
        <div className="mb-2 flex items-center gap-2 px-1">
          <span className="flex h-5 w-5 items-center justify-center rounded-full bg-emerald-100 text-emerald-600">
            <CheckIcon className="h-3 w-3" strokeWidth={3} />
          </span>
          <h2 className="text-[11px] font-bold tracking-wider text-slate-500 uppercase">
            Completed
          </h2>
          <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-500">
            {tasks.length}
          </span>
        </div>

        {tasks.length === 0 ? (
          <p className="rounded-xl border border-dashed border-slate-200 px-3 py-6 text-center text-[11px] leading-relaxed text-slate-400">
            Finished tasks for this day will collect here.
          </p>
        ) : (
          <ul className="space-y-0.5">
            {tasks.map((task) => {
              const doneSubtasks = task.subtasks.filter((subtask) => subtask.done).length
              return (
                <li
                  key={task.id}
                  className="group flex items-start gap-2 rounded-xl px-1.5 py-2 transition hover:bg-slate-50"
                >
                  <button
                    type="button"
                    onClick={() => onToggle(task)}
                    role="checkbox"
                    aria-checked
                    aria-label="Mark as not done"
                    className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2 border-emerald-500 bg-emerald-500 text-white transition hover:bg-emerald-400 active:scale-90"
                  >
                    <CheckIcon className="h-2.5 w-2.5" strokeWidth={3.5} />
                  </button>

                  <button
                    type="button"
                    onClick={() => onOpen(task)}
                    className="min-w-0 flex-1 text-left"
                  >
                    <p className="text-[13px] leading-snug font-medium break-words text-slate-400 line-through decoration-slate-300">
                      {task.text}
                    </p>
                    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] font-medium text-slate-400">
                      {task.duration !== null && (
                        <span className="inline-flex items-center gap-0.5">
                          <ClockIcon className="h-3 w-3" />
                          {formatDuration(task.duration)}
                        </span>
                      )}
                      {task.priority !== 'none' && (
                        <span className="inline-flex items-center gap-1">
                          <span
                            className={`h-1.5 w-1.5 rounded-full ${PRIORITY_META[task.priority].dot}`}
                          />
                          {PRIORITY_META[task.priority].label}
                        </span>
                      )}
                      {task.subtasks.length > 0 && (
                        <span className="inline-flex items-center gap-0.5">
                          <ListChecksIcon className="h-3 w-3" />
                          {doneSubtasks}/{task.subtasks.length}
                        </span>
                      )}
                      {showOwner && task.userId !== currentUserId && (
                        <span className="truncate">{task.ownerEmail.split('@')[0]}</span>
                      )}
                    </div>
                  </button>

                  {canDelete(task) && (
                    <button
                      type="button"
                      onClick={() => {
                        if (window.confirm(`Delete “${task.text}”?`)) onDelete(task)
                      }}
                      className="mt-0.5 rounded p-1 text-slate-300 opacity-0 transition group-hover:opacity-100 hover:text-rose-500 focus:opacity-100"
                      aria-label="Delete task"
                      title="Delete task"
                    >
                      <TrashIcon className="h-3.5 w-3.5" />
                    </button>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </aside>
  )
}
