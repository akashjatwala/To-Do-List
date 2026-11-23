import type { Reminder, Task } from '@/types'
import { ArrowRightIcon, BellIcon, ListChecksIcon } from './Icons'

/**
 * A compact reminder card. It keeps the overdue count in the header and points
 * to the scope-wide overdue-task modal rather than listing tasks here.
 */
export interface OverdueCardProps {
  tasks: Task[]
  reminders: Reminder[]
  onViewAll: () => void
}

function reminderTime(createdAt: number): string {
  const minutes = Math.floor((Date.now() - createdAt) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  return new Date(createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export default function OverdueCard({ tasks, reminders, onViewAll }: OverdueCardProps) {
  return (
    <section className="rounded-[24px] bg-[#EEE7F7] p-5" aria-label="Overdue tasks">
      <div className="mb-3">
        <h2 className="text-xl font-extrabold tracking-tight text-[#15181E]">Overdue tasks</h2>
      </div>

      {reminders.length > 0 && (
        <div className="mb-3 space-y-1.5" aria-label="Sent reminders">
          {reminders.slice(0, 3).map((reminder) => (
            <div key={reminder.id} className="rounded-xl bg-white/45 px-3 py-2">
              <div className="flex items-center gap-2">
                <BellIcon className="h-3.5 w-3.5 shrink-0 opacity-70" />
                <p className="min-w-0 flex-1 truncate text-xs font-semibold text-[#4B3A66]">
                  {reminder.taskText}
                </p>
                <span className="shrink-0 text-[10px] text-[#6B5A80]">
                  {reminderTime(reminder.createdAt)}
                </span>
              </div>
              <p className="mt-0.5 text-[11px] text-[#6B5A80]">
                {reminder.recipients.length > 0
                  ? `Sent to ${reminder.recipients.map((person) => person.name).join(', ')}.`
                  : 'Reminder saved locally.'}
              </p>
            </div>
          ))}
        </div>
      )}

      <button
        type="button"
        onClick={onViewAll}
        className="flex w-full items-center gap-2 rounded-xl bg-white/45 px-3 py-2 text-left text-xs text-[#4B3A66] transition hover:bg-white"
      >
        <ListChecksIcon className="h-3.5 w-3.5 shrink-0 opacity-70" />
        <span className="min-w-0 flex-1 font-semibold">View all overdue tasks</span>
        <span className="shrink-0 text-[10px] font-bold tracking-wide opacity-70">
          {tasks.length} Overdue
        </span>
        <ArrowRightIcon className="h-3.5 w-3.5 shrink-0 opacity-70" />
      </button>
    </section>
  )
}
