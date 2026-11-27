import type { Task } from '@/types'
import { ArrowRightIcon, RepeatIcon } from './Icons'

/**
 * A compact repeating card. Like Completed and Overdue, the count stays in the
 * action row and the notes live in a scope-wide modal rather than inline.
 */
export interface RepeatingCardProps {
  tasks: Task[]
  onViewAll: () => void
}

export default function RepeatingCard({ tasks, onViewAll }: RepeatingCardProps) {
  return (
    <section className="rounded-[24px] border border-[#D5E3F0] bg-[#E7F0F9] p-5" aria-label="Repeating">
      <div className="mb-3">
        <h2 className="text-xl font-extrabold tracking-tight text-[#15181E]">Repeating</h2>
      </div>

      <button
        type="button"
        onClick={onViewAll}
        className="flex w-full items-center gap-2 rounded-xl bg-white/45 px-3 py-2 text-left text-xs text-[#35506B] transition hover:bg-white"
      >
        <RepeatIcon className="h-3.5 w-3.5 shrink-0 opacity-70" />
        <span className="min-w-0 flex-1 font-semibold">View all repeating tasks</span>
        <span className="shrink-0 text-[10px] font-bold tracking-wide opacity-70">
          {tasks.length} Repeats
        </span>
        <ArrowRightIcon className="h-3.5 w-3.5 shrink-0 opacity-70" />
      </button>
    </section>
  )
}
