import type { Task } from '@/types'
import { ArrowRightIcon, CheckIcon } from './Icons'

/**
 * A compact completed card. Mirrors the Overdue card: the count stays in the
 * action row and the notes live in a scope-wide modal rather than inline.
 */
export interface CompletedCardProps {
  tasks: Task[]
  onViewAll: () => void
}

export default function CompletedCard({ tasks, onViewAll }: CompletedCardProps) {
  return (
    <section className="rounded-[24px] bg-[#DCEBDF] p-5" aria-label="Completed">
      <div className="mb-3">
        <h2 className="text-xl font-extrabold tracking-tight text-[#15181E]">Completed</h2>
      </div>

      <button
        type="button"
        onClick={onViewAll}
        className="flex w-full items-center gap-2 rounded-xl bg-white/45 px-3 py-2 text-left text-xs text-[#2F4A37] transition hover:bg-white"
      >
        <CheckIcon className="h-3.5 w-3.5 shrink-0 opacity-70" strokeWidth={2.8} />
        <span className="min-w-0 flex-1 font-semibold">View all completed tasks</span>
        <span className="shrink-0 text-[10px] font-bold tracking-wide opacity-70">
          {tasks.length} Done
        </span>
        <ArrowRightIcon className="h-3.5 w-3.5 shrink-0 opacity-70" />
      </button>
    </section>
  )
}
