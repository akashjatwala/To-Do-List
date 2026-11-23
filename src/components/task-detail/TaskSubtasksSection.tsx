import type { FormEvent } from 'react'
import type { Member, Subtask, Task } from '@/types'
import { Spinner } from '../ui'
import { CheckIcon, ListChecksIcon, PlusIcon, TrashIcon } from '../Icons'

interface TaskSubtasksSectionProps {
  task: Task
  members: Member[]
  subtaskText: string
  setSubtaskText: (value: string) => void
  subtaskBusy: boolean
  subtaskAssignee: string
  setSubtaskAssignee: (value: string) => void
  submitSubtask: (event: FormEvent) => Promise<void>
  onToggleSubtask: (subtask: Subtask) => void
  onAssignSubtask: (subtask: Subtask, assigneeId: number | null) => Promise<boolean>
  onDeleteSubtask: (subtask: Subtask) => void
}

export default function TaskSubtasksSection({
  task,
  members,
  subtaskText,
  setSubtaskText,
  subtaskBusy,
  subtaskAssignee,
  setSubtaskAssignee,
  submitSubtask,
  onToggleSubtask,
  onAssignSubtask,
  onDeleteSubtask,
}: TaskSubtasksSectionProps) {
  const doneSubtasks = task.subtasks.filter((subtask) => subtask.done).length
  const subtaskPercent = task.subtasks.length ? (doneSubtasks / task.subtasks.length) * 100 : 0

  return (
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
          <div key={subtask.id} className="group flex items-center gap-2.5 rounded-lg px-1 py-1.5 hover:bg-white">
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
            <span className={`flex-1 text-sm ${subtask.done ? 'text-[#7B8190]' : 'text-[#3E4654]'}`}>
              {subtask.text}
            </span>
            {task.teamId && (
              <select
                value={subtask.assignee?.id ? String(subtask.assignee.id) : ''}
                onChange={(event) =>
                  void onAssignSubtask(subtask, event.target.value ? Number(event.target.value) : null)
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
  )
}
