import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
} from 'react'
import type { Task } from '@/types'
import { formatDuration, STICKY_META, recurrenceShort } from '@/lib/taskmeta'
import { noteTilt, pinClass } from '@/lib/notes'
import { useConfirm } from './ui'
import {
  CheckIcon,
  ClockIcon,
  GaugeIcon,
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

/** The small time label on a note, matching the sticky-note reference layout. */
function noteTime(task: Task): string {
  if (task.preferredTime) return task.preferredTime
  if (task.due !== null) {
    const label = new Date(task.due).toLocaleDateString(undefined, {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
    })
    return `@ ${label}`
  }
  return 'Anytime'
}

/**
 * A decorative push-pin, centred on a note's top edge. It is not interactive
 * (the note still opens on tap and drags from the grip) and is hidden from screen
 * readers; every pin uses the same red accent.
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
  // Pointer events batch state updates, so keep the live drop target in a ref too.
  const dropRef = useRef<{ id: string; side: 'before' | 'after' } | null>(null)
  // A floating copy follows the pointer with transform-only updates; React only
  // re-renders when the drop target actually changes.
  const ghostRef = useRef<HTMLElement | null>(null)
  const frameRef = useRef<number | null>(null)
  const pointerRef = useRef({ x: 0, y: 0 })
  const offsetRef = useRef({ x: 0, y: 0 })
  const tiltRef = useRef(0)
  // A press on the note body waits for a small movement before it becomes a
  // drag, so an ordinary click still opens the task.
  const pendingRef = useRef<{
    task: Task
    pointerId: number
    startX: number
    startY: number
  } | null>(null)
  const suppressClickUntilRef = useRef(0)
  const { confirm, dialog } = useConfirm()

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
      if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current)
      ghostRef.current?.remove()
    },
    [],
  )

  const removeGhost = () => {
    if (frameRef.current !== null) {
      window.cancelAnimationFrame(frameRef.current)
      frameRef.current = null
    }
    ghostRef.current?.remove()
    ghostRef.current = null
  }

  const clearDrag = () => {
    dragId.current = null
    pendingRef.current = null
    dropRef.current = null
    removeGhost()
    setDraggingId(null)
    setDropTarget(null)
  }

  const markDropTarget = (id: string, side: 'before' | 'after') => {
    if (dropRef.current?.id === id && dropRef.current.side === side) return
    const next = { id, side }
    dropRef.current = next
    setDropTarget(next)
  }

  const moveNote = (sourceId: string, targetId: string, side: 'before' | 'after') => {
    const next = [...ordered]
    const from = next.findIndex((item) => item.id === sourceId)
    if (from === -1 || sourceId === targetId) return
    const [moved] = next.splice(from, 1)
    const targetIndex = next.findIndex((item) => item.id === targetId)
    if (targetIndex === -1) return
    next.splice(targetIndex + (side === 'after' ? 1 : 0), 0, moved)
    setOrdered(next)
    onReorder(next.map((item) => item.id))
  }

  /** Keep the floating copy exactly under the pointer, without layout reads. */
  const positionGhost = () => {
    const ghost = ghostRef.current
    if (!ghost) return
    const { x, y } = pointerRef.current
    const offset = offsetRef.current
    ghost.style.transform =
      `translate3d(${x - offset.x}px, ${y - offset.y}px, 0) ` +
      `rotate(${tiltRef.current}deg) scale(1.03)`
  }

  /** Reorder preview is computed once per animation frame, not per pointer event. */
  const scheduleDragFrame = () => {
    if (frameRef.current !== null) return
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null
      positionGhost()
      const sourceId = dragId.current
      if (!sourceId) return
      const target = document
        .elementFromPoint(pointerRef.current.x, pointerRef.current.y)
        ?.closest('[data-note-id]') as HTMLElement | null
      const targetId = target?.dataset.noteId
      if (!targetId || targetId === sourceId) {
        if (dropRef.current) {
          dropRef.current = null
          setDropTarget(null)
        }
        return
      }
      const rect = target.getBoundingClientRect()
      const side = pointerRef.current.x < rect.left + rect.width / 2 ? 'before' : 'after'
      markDropTarget(targetId, side)
    })
  }

  /** Capture the pointer so moving outside the note still drags it. */
  const capturePointer = (element: HTMLElement, pointerId: number) => {
    try {
      element.setPointerCapture(pointerId)
    } catch {
      // Synthetic or cancelled pointers cannot be captured; dragging still works.
    }
  }

  /**
   * Starts the visual drag. `grabX/grabY` is where the pointer first touched the
   * note, so the floating copy keeps the same grip point even after the small
   * movement threshold that distinguishes a drag from a click.
   */
  const beginDrag = (
    event: PointerEvent<HTMLElement>,
    task: Task,
    note: HTMLElement,
    grabX = event.clientX,
    grabY = event.clientY,
  ) => {
    const rect = note.getBoundingClientRect()
    pointerRef.current = { x: event.clientX, y: event.clientY }
    offsetRef.current = { x: grabX - rect.left, y: grabY - rect.top }
    tiltRef.current = noteTilt(task.id)

    const ghost = note.cloneNode(true) as HTMLElement
    ghost.removeAttribute('data-note-id')
    ghost.setAttribute('aria-hidden', 'true')
    ghost.classList.add('drag-ghost')
    ghost.style.width = `${rect.width}px`
    ghost.style.height = `${rect.height}px`
    document.body.appendChild(ghost)
    ghostRef.current = ghost
    positionGhost()

    dragId.current = task.id
    setDraggingId(task.id)
    dropRef.current = null
    setDropTarget(null)
  }

  /** The grip starts a drag immediately and works for mouse and touch. */
  const handleGripDown = (event: PointerEvent<HTMLButtonElement>, task: Task) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    capturePointer(event.currentTarget, event.pointerId)
    const note = event.currentTarget.closest('[data-note-id]') as HTMLElement | null
    if (note) beginDrag(event, task, note)
  }

  /**
   * A press anywhere on the note body arms a drag. It only becomes a drag after
   * a 6px movement so clicking a note still opens its details.
   */
  const handleNoteDown = (event: PointerEvent<HTMLElement>, task: Task) => {
    if (event.pointerType !== 'mouse' || event.button !== 0) return
    if ((event.target as HTMLElement).closest('[data-note-action]')) return
    suppressClickUntilRef.current = 0
    pendingRef.current = {
      task,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
    }
    capturePointer(event.currentTarget, event.pointerId)
  }

  const handleNoteMove = (event: PointerEvent<HTMLElement>) => {
    const pending = pendingRef.current
    if (pending && !dragId.current && pending.pointerId === event.pointerId) {
      if (Math.hypot(event.clientX - pending.startX, event.clientY - pending.startY) < 6) return
      pendingRef.current = null
      beginDrag(event, pending.task, event.currentTarget, pending.startX, pending.startY)
    }
    if (!dragId.current) return
    pointerRef.current = { x: event.clientX, y: event.clientY }
    scheduleDragFrame()
  }

  const finishDrag = (event: PointerEvent<HTMLElement>) => {
    if (!dragId.current) {
      pendingRef.current = null
      return
    }
    const sourceId = dragId.current
    const target = dropRef.current
    try {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId)
      }
    } catch {
      // Capture may already have been released by the browser.
    }
    clearDrag()
    // A drag must not also open the task when the click event follows pointerup.
    suppressClickUntilRef.current = performance.now() + 350
    if (sourceId && target) moveNote(sourceId, target.id, target.side)
  }

  const handleGripMove = (event: PointerEvent<HTMLButtonElement>) => {
    if (!dragId.current) return
    pointerRef.current = { x: event.clientX, y: event.clientY }
    scheduleDragFrame()
  }

  const handleGripUp = (event: PointerEvent<HTMLButtonElement>) => finishDrag(event)

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
        const duration = task.duration !== null ? formatDuration(task.duration) : '—'
        const isDragging = draggingId === task.id
        const isDropTarget = dropTarget?.id === task.id
        const isNew = pressing.has(task.id)
        return (
          <article
            key={task.id}
            data-note-id={task.id}
            onPointerDown={(event) => handleNoteDown(event, task)}
            onPointerMove={handleNoteMove}
            onPointerUp={finishDrag}
            onPointerCancel={clearDrag}
            onClick={(event) => {
              if (performance.now() < suppressClickUntilRef.current) return
              if ((event.target as HTMLElement).closest('[data-note-action]')) return
              onOpen(task)
            }}
            onDoubleClick={(event) => {
              if ((event.target as HTMLElement).closest('[data-note-action]')) return
              onOpen(task)
            }}
            style={{ '--tilt': `${noteTilt(task.id)}deg` } as CSSProperties}
            title="Click to open · drag to rearrange"
            className={`sticky-note group relative flex min-h-[10rem] cursor-default select-none flex-col px-4 pt-7 pb-4 ${meta.note} ${
              isDragging ? 'sticky-note-dragging opacity-40' : ''
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

              <button
                type="button"
                data-note-action
                aria-label={`Drag to reorder ${task.text}`}
                title="Drag to reorder"
                onPointerDown={(event) => handleGripDown(event, task)}
                onPointerMove={handleGripMove}
                onPointerUp={handleGripUp}
                onPointerCancel={clearDrag}
                className={`mt-0.5 inline-flex shrink-0 cursor-default touch-none rounded-md p-1 opacity-40 transition hover:opacity-90 sm:opacity-25 sm:group-hover:opacity-60 ${meta.muted}`}
              >
                <GripIcon className="h-3.5 w-3.5" />
              </button>

              {canDelete(task) && (
                <button
                  type="button"
                  data-note-action
                  onClick={async () => {
                    if (
                      await confirm({
                        title: 'Delete task?',
                        description: `“${task.text}” will be removed from your list.`,
                        confirmLabel: 'Delete task',
                      })
                    ) {
                      onDelete(task)
                    }
                  }}
                  className={`-mt-1 -mr-1.5 rounded-lg p-1 opacity-60 transition hover:opacity-100 focus:opacity-100 sm:opacity-0 sm:group-hover:opacity-60 ${meta.muted}`}
                  aria-label="Delete task"
                  title="Delete task"
                >
                  <TrashIcon className="h-3.5 w-3.5" />
                </button>
              )}
            </div>

            <div className="mt-2 flex flex-wrap gap-1.5">
              {task.tags.slice(0, 2).map((tag) => (
                <span
                  key={tag}
                  className={`max-w-[9rem] truncate rounded-full px-1.5 py-0.5 text-[10px] font-bold ${meta.chip}`}
                >
                  #{tag}
                </span>
              ))}
              {task.tags.length > 2 && (
                <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-bold ${meta.chip}`}>
                  +{task.tags.length - 2}
                </span>
              )}
            </div>

            <span className="sticky-tear mt-auto block" />

            <div
              className={`mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[10px] font-bold ${meta.muted}`}
            >
              <span className="inline-flex items-center gap-1" title="Planned time">
                <ClockIcon className="h-3.5 w-3.5" />
                {noteTime(task)}
              </span>
              <span
                className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 ${meta.chip}`}
                title="Ideal duration"
              >
                <GaugeIcon className="h-3.5 w-3.5" />
                {duration}
              </span>
              {repeat && (
                <span
                  className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 ${meta.chip}`}
                  title="Repeats"
                >
                  <RepeatIcon className="h-3.5 w-3.5" />
                  {repeat}
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
      {dialog}
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
  const { confirm, dialog } = useConfirm()

  return (
    <section className="overflow-hidden rounded-[24px] bg-[#DCEBDF] p-5" aria-label="Completed">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-xl font-extrabold tracking-tight text-[#15181E]">Completed</h2>
        <span className="rounded-full bg-white/70 px-2 py-0.5 text-xs font-bold text-[#2F4A37]">
          {tasks.length}
        </span>
      </div>

      {tasks.length === 0 ? (
        <div className="flex flex-col items-center rounded-2xl bg-white/55 px-4 py-6 text-center shadow-sm ring-1 ring-[#2F4A37]/10">
          <span className="text-3xl" aria-hidden="true">
            ✅
          </span>
          <p className="mt-2 text-sm font-semibold text-[#2F4A37]">Nothing finished yet</p>
          <p className="mt-1 max-w-xs text-xs leading-relaxed text-[#2F4A37]/70">
            Finished tasks for this day will collect here.
          </p>
        </div>
      ) : (
        <ul className="space-y-1.5">
          {tasks.map((task) => {
            const repeat = recurrenceShort(task.recurrence, task.recurrenceConfig)
            return (
              <li
                key={task.id}
                className="group flex items-center gap-2 rounded-xl bg-white/55 px-3 py-2 shadow-sm ring-1 ring-[#2F4A37]/10"
              >
                <button
                  type="button"
                  onClick={() => onToggle(task)}
                  role="checkbox"
                  aria-checked
                  aria-label="Mark as not done"
                  className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2 border-[#2F6B45] bg-[#2F6B45] text-white transition hover:bg-[#2F4A37] active:scale-90"
                >
                  <CheckIcon className="h-2.5 w-2.5" strokeWidth={3.5} />
                </button>

                <button
                  type="button"
                  onClick={() => onOpen(task)}
                  className="min-w-0 flex-1 text-left"
                >
                  <p className="truncate text-[13px] font-semibold text-[#2F4A37]">
                    {task.text}
                  </p>
                </button>

                <div className="flex shrink-0 items-center gap-1.5">
                  {task.preferredTime && (
                    <span className="text-[11px] font-semibold text-[#2F4A37]/80">
                      {task.preferredTime}
                    </span>
                  )}
                  {repeat && (
                    <span className="insight-pill bg-white/70 text-[#2F4A37]">{repeat}</span>
                  )}
                  {showOwner && task.userId !== currentUserId && (
                    <span className="max-w-[8rem] truncate text-[10px] text-[#2F4A37]/70">
                      {task.ownerEmail.split('@')[0]}
                    </span>
                  )}
                </div>

                {canDelete(task) && (
                  <button
                    type="button"
                    onClick={async () => {
                      if (
                        await confirm({
                          title: 'Delete task?',
                          description: `“${task.text}” will be removed from your list.`,
                          confirmLabel: 'Delete task',
                        })
                      ) {
                        onDelete(task)
                      }
                    }}
                    className="rounded p-1 text-[#2F4A37]/50 opacity-70 transition hover:text-rose-600 focus:opacity-100 sm:opacity-0 sm:group-hover:opacity-100"
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
      {dialog}
    </section>
  )
}

/** Repeating tasks shown below Completed, matching the template's compact card. */
export function RepeatingColumn({
  tasks,
  currentUserId,
  showOwner,
  onOpen,
}: BoardProps) {
  return (
    <section className="overflow-hidden rounded-[24px] border border-[#E1E2E0] bg-white p-5" aria-label="Repeating">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-xl font-extrabold tracking-tight text-[#15181E]">Repeating</h2>
        <span className="rounded-full bg-[#F6F6F4] px-2 py-0.5 text-xs font-bold text-[#454B58]">
          {tasks.length}
        </span>
      </div>

      {tasks.length === 0 ? (
        <div className="flex flex-col items-center rounded-2xl bg-slate-50 px-4 py-6 text-center shadow-sm ring-1 ring-slate-200/80">
          <span className="text-3xl" aria-hidden="true">
            🔁
          </span>
          <p className="mt-2 text-sm font-semibold text-slate-700">No repeating tasks</p>
          <p className="mt-1 max-w-xs text-xs leading-relaxed text-slate-500">
            Tasks that repeat will be listed here.
          </p>
        </div>
      ) : (
        <ul className="space-y-0.5">
          {tasks.map((task) => {
            const repeat = recurrenceShort(task.recurrence, task.recurrenceConfig)
            return (
              <li
                key={task.id}
                className="group flex items-center gap-2 rounded-xl px-1.5 py-2 transition hover:bg-slate-50"
              >
                <button
                  type="button"
                  onClick={() => onOpen(task)}
                  className="min-w-0 flex-1 text-left"
                >
                  <p className="truncate text-[13px] font-semibold text-[#15181E]">{task.text}</p>
                  {showOwner && task.userId !== currentUserId && (
                    <p className="truncate text-[10px] text-slate-400">
                      {task.ownerEmail.split('@')[0]}
                    </p>
                  )}
                </button>
                {repeat && (
                  <span className="insight-pill shrink-0 bg-[#F6F6F4] text-[#454B58]">
                    <RepeatIcon className="h-3 w-3" />
                    {repeat}
                  </span>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
