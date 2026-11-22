import { dateInputValue, dueFromDateInput } from '@/lib/date'
import type { Task } from '@/types'
import { ArrowRightIcon, CalendarIcon, CheckIcon } from './Icons'

/**
 * A reminder for open tasks whose due date has passed. It mirrors the
 * Invitations card in shape and colour; the actions are ordinary task edits, so
 * nothing here changes a prediction or writes an outcome. On a team board the
 * responsible people are shown as well.
 */
export interface OverdueCardProps {
  tasks: Task[]
  /** The user's current local date (`YYYY-MM-DD`). */
  today: string
  /** Team tasks show who is responsible; personal tasks do not need it. */
  showAssignees?: boolean
  onOpen: (task: Task) => void
  onDone: (task: Task) => void
  onMoveToToday: (task: Task) => void
}

function dueLabel(due: number, today: string): string {
  const date = new Date(due)
  const shortDate = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  const todayEnd = dueFromDateInput(today)
  const dueEnd = dueFromDateInput(dateInputValue(due))
  const daysAgo =
    todayEnd !== null && dueEnd !== null ? Math.round((todayEnd - dueEnd) / 86_400_000) : 0
  if (daysAgo <= 0) return `Due ${shortDate}`
  return `Due ${shortDate} · ${daysAgo} ${daysAgo === 1 ? 'day' : 'days'} ago`
}

/** Named assignees; a team task with nobody assigned is explicitly unassigned. */
function responsibleNames(task: Task): string {
  const names = (task.assignees ?? []).map((person) => person.name || person.email.split('@')[0])
  return names.length > 0 ? names.join(', ') : 'Unassigned'
}

export default function OverdueCard({
  tasks,
  today,
  showAssignees = false,
  onOpen,
  onDone,
  onMoveToToday,
}: OverdueCardProps) {
  return (
    <section className="rounded-[24px] bg-[#F8E7C4] p-5" aria-label="Overdue tasks">
      <div className="mb-3 flex items-center gap-2">
        <h2 className="text-xl font-extrabold tracking-tight text-[#15181E]">Overdue tasks</h2>
        <span className="rounded-full bg-white/70 px-2 py-0.5 text-xs font-bold text-[#5C4B22]">
          {tasks.length}
        </span>
      </div>

      {tasks.length === 0 ? (
        <p className="text-xs leading-relaxed text-[#6B5A2E]">
          Nothing overdue — you&apos;re all caught up.
        </p>
      ) : (
        <div
          className="h-[7.75rem] space-y-2 snap-y snap-mandatory overflow-y-auto pr-1"
          aria-label="Overdue tasks, scroll for more"
        >
          {tasks.map((task) => (
            <div key={task.id} className="snap-start rounded-2xl bg-white/45 p-3">
              <div className="flex items-start gap-2">
                <CalendarIcon className="mt-0.5 h-3.5 w-3.5 shrink-0 opacity-70" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-semibold text-[#4B3F22]">{task.text}</p>
                  <p className="mt-0.5 text-[11px] text-[#6B5A2E]">
                    {dueLabel(task.due!, today)}
                  </p>
                  {showAssignees && (
                    <p className="mt-0.5 text-[11px] text-[#6B5A2E]">
                      Assigned to: {responsibleNames(task)}
                    </p>
                  )}
                </div>
              </div>
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => onOpen(task)}
                  className="rounded-full bg-white/70 px-3 py-1 text-[11px] font-semibold text-[#5C4B22] transition hover:bg-white"
                >
                  Open
                </button>
                <button
                  type="button"
                  onClick={() => onDone(task)}
                  className="inline-flex items-center gap-1 rounded-full bg-[#2F4A37] px-3 py-1 text-[11px] font-bold text-white transition hover:bg-[#233829]"
                >
                  <CheckIcon className="h-3 w-3" strokeWidth={3} />
                  Done
                </button>
                <button
                  type="button"
                  onClick={() => onMoveToToday(task)}
                  className="inline-flex items-center gap-1 rounded-full bg-white/70 px-3 py-1 text-[11px] font-semibold text-[#5C4B22] transition hover:bg-white"
                >
                  <ArrowRightIcon className="h-3 w-3" />
                  Move to today
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
