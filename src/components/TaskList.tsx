import { useState } from 'react'
import type { Task } from '@/types'
import { dueState, formatDue } from '@/lib/date'
import {
  CalendarIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ListChecksIcon,
  MessageIcon,
  TrashIcon,
} from './Icons'

interface TaskListProps {
  tasks: Task[]
  currentUserId: number
  showOwner: boolean
  emptyTitle: string
  emptyText: string
  canDelete: (task: Task) => boolean
  onOpen: (task: Task) => void
  onToggle: (task: Task) => void
  onDelete: (task: Task) => void
}

export default function TaskList({
  tasks,
  currentUserId,
  showOwner,
  emptyTitle,
  emptyText,
  canDelete,
  onOpen,
  onToggle,
  onDelete,
}: TaskListProps) {
  const [showDone, setShowDone] = useState(true)

  const open = tasks.filter((task) => !task.done)
  const done = tasks.filter((task) => task.done)

  if (tasks.length === 0) {
    return (
      <div className="animate-in flex flex-col items-center justify-center rounded-2xl border border-dashed border-slate-200 px-6 py-14 text-center dark:border-slate-800">
        <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-indigo-50 text-indigo-500 dark:bg-indigo-500/10 dark:text-indigo-400">
          <ListChecksIcon className="h-6 w-6" />
        </div>
        <h3 className="mt-4 text-sm font-semibold text-slate-700 dark:text-slate-200">
          {emptyTitle}
        </h3>
        <p className="mt-1 max-w-xs text-sm text-slate-500 dark:text-slate-400">{emptyText}</p>
      </div>
    )
  }

  return (
    <div className="space-y-7">
      {open.length > 0 && (
        <section>
          <div className="mb-2 flex items-center gap-2 px-1">
            <h2 className="text-xs font-bold tracking-wider text-slate-400 uppercase dark:text-slate-500">
              Open
            </h2>
            <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-500 dark:bg-slate-800 dark:text-slate-400">
              {open.length}
            </span>
          </div>
          <div className="space-y-0.5">
            {open.map((task) => (
              <TaskItem
                key={task.id}
                task={task}
                currentUserId={currentUserId}
                showOwner={showOwner}
                canDelete={canDelete(task)}
                onOpen={onOpen}
                onToggle={onToggle}
                onDelete={onDelete}
              />
            ))}
          </div>
        </section>
      )}

      {done.length > 0 && (
        <section>
          <button
            type="button"
            onClick={() => setShowDone((value) => !value)}
            className="mb-2 flex items-center gap-2 rounded-lg px-1 py-0.5 text-xs font-bold tracking-wider text-slate-400 uppercase transition hover:text-slate-600 dark:text-slate-500 dark:hover:text-slate-300"
          >
            {showDone ? (
              <ChevronDownIcon className="h-3.5 w-3.5" />
            ) : (
              <ChevronRightIcon className="h-3.5 w-3.5" />
            )}
            Completed
            <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-500 dark:bg-slate-800 dark:text-slate-400">
              {done.length}
            </span>
          </button>
          {showDone && (
            <div className="space-y-0.5">
              {done.map((task) => (
                <TaskItem
                  key={task.id}
                  task={task}
                  currentUserId={currentUserId}
                  showOwner={showOwner}
                  canDelete={canDelete(task)}
                  onOpen={onOpen}
                  onToggle={onToggle}
                  onDelete={onDelete}
                />
              ))}
            </div>
          )}
        </section>
      )}

      {open.length === 0 && done.length > 0 && (
        <p className="px-1 text-center text-sm text-slate-400 dark:text-slate-500">
          All caught up — nice work.
        </p>
      )}
    </div>
  )
}

function TaskItem({
  task,
  currentUserId,
  showOwner,
  canDelete,
  onOpen,
  onToggle,
  onDelete,
}: {
  task: Task
  currentUserId: number
  showOwner: boolean
  canDelete: boolean
  onOpen: (task: Task) => void
  onToggle: (task: Task) => void
  onDelete: (task: Task) => void
}) {
  const doneSubtasks = task.subtasks.filter((subtask) => subtask.done).length

  return (
    <div className="group flex items-start gap-3 rounded-xl border border-transparent px-2.5 py-2.5 transition hover:border-slate-200 hover:bg-white hover:shadow-sm dark:hover:border-slate-800 dark:hover:bg-slate-900">
      <button
        type="button"
        onClick={() => onToggle(task)}
        role="checkbox"
        aria-checked={task.done}
        aria-label={task.done ? 'Mark as not done' : 'Mark as done'}
        className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 transition-all duration-150 active:scale-90 ${
          task.done
            ? 'border-indigo-600 bg-indigo-600 text-white shadow-sm shadow-indigo-600/30'
            : 'border-slate-300 bg-white text-transparent hover:border-indigo-400 hover:text-indigo-300 dark:border-slate-600 dark:bg-slate-900 dark:hover:border-indigo-500'
        }`}
      >
        <CheckIcon className="h-3 w-3" strokeWidth={3} />
      </button>

      <button type="button" onClick={() => onOpen(task)} className="min-w-0 flex-1 text-left">
        <p
          className={`text-[14.5px] leading-snug font-medium break-words transition-colors ${
            task.done
              ? 'text-slate-400 line-through decoration-slate-300 dark:text-slate-500 dark:decoration-slate-600'
              : 'text-slate-800 dark:text-slate-100'
          }`}
        >
          {task.text}
        </p>

        {(task.due !== null ||
          task.subtasks.length > 0 ||
          task.comments.length > 0 ||
          (showOwner && task.userId !== currentUserId)) && (
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-400 dark:text-slate-500">
            {task.due !== null && <DueBadge due={task.due} done={task.done} />}
            {task.subtasks.length > 0 && (
              <span className="inline-flex items-center gap-1">
                <ListChecksIcon className="h-3.5 w-3.5" />
                {doneSubtasks}/{task.subtasks.length}
              </span>
            )}
            {task.comments.length > 0 && (
              <span className="inline-flex items-center gap-1">
                <MessageIcon className="h-3.5 w-3.5" />
                {task.comments.length}
              </span>
            )}
            {showOwner && task.userId !== currentUserId && (
              <span className="inline-flex items-center gap-1">
                <span className="flex h-4 w-4 items-center justify-center rounded-full bg-slate-100 text-[8px] font-bold text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                  {task.ownerEmail.slice(0, 1).toUpperCase()}
                </span>
                {task.ownerEmail.split('@')[0]}
              </span>
            )}
          </div>
        )}

        {task.progress > 0 && (
          <div className="mt-2 flex items-center gap-2">
            <div className="h-1.5 w-24 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
              <div
                className={`h-full rounded-full transition-all duration-300 ${
                  task.done
                    ? 'bg-emerald-400 dark:bg-emerald-500'
                    : 'bg-gradient-to-r from-indigo-500 to-violet-500'
                }`}
                style={{ width: `${task.progress}%` }}
              />
            </div>
            <span
              className={`text-[10px] font-semibold ${
                task.done
                  ? 'text-emerald-500 dark:text-emerald-400'
                  : 'text-slate-400 dark:text-slate-500'
              }`}
            >
              {task.progress}%
            </span>
          </div>
        )}
      </button>

      {canDelete && (
        <button
          type="button"
          onClick={() => {
            if (window.confirm(`Delete “${task.text}”?`)) onDelete(task)
          }}
          className="rounded-lg p-1.5 text-slate-300 opacity-0 transition group-hover:opacity-100 hover:bg-rose-50 hover:text-rose-500 focus:opacity-100 dark:text-slate-600 dark:hover:bg-rose-500/10 dark:hover:text-rose-400"
          aria-label="Delete task"
          title="Delete task"
        >
          <TrashIcon className="h-4 w-4" />
        </button>
      )}
    </div>
  )
}

function DueBadge({ due, done }: { due: number; done: boolean }) {
  const state = done ? 'later' : dueState(due)
  const classes = done
    ? 'text-slate-400 dark:text-slate-500'
    : state === 'overdue'
      ? 'text-rose-600 dark:text-rose-400'
      : state === 'today'
        ? 'text-amber-600 dark:text-amber-400'
        : 'text-slate-400 dark:text-slate-500'

  return (
    <span className={`inline-flex items-center gap-1 font-medium ${classes}`}>
      <CalendarIcon className="h-3.5 w-3.5" />
      {formatDue(due)}
    </span>
  )
}
