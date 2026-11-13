import type { Priority, Recurrence } from '@/types'
import { PRIORITY_META, RECURRENCE_META, tagTint } from '@/lib/taskmeta'
import { FlagIcon, RepeatIcon, TagIcon } from './Icons'

export function PriorityBadge({
  priority,
  withLabel = true,
}: {
  priority: Priority
  withLabel?: boolean
}) {
  if (priority === 'none') return null
  const meta = PRIORITY_META[priority]
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-semibold ${meta.chip}`}
      title={`${meta.label} priority`}
    >
      <FlagIcon className="h-3 w-3" />
      {withLabel ? meta.label : null}
    </span>
  )
}

export function TagChips({ tags, max }: { tags: string[]; max?: number }) {
  if (tags.length === 0) return null
  const shown = max ? tags.slice(0, max) : tags
  return (
    <>
      {shown.map((tag) => (
        <span
          key={tag}
          className={`inline-flex max-w-[10rem] items-center gap-1 truncate rounded-md px-1.5 py-0.5 text-[10px] font-medium ${tagTint(tag)}`}
        >
          <TagIcon className="h-2.5 w-2.5 shrink-0" />
          <span className="truncate">{tag}</span>
        </span>
      ))}
      {max && tags.length > max ? (
        <span className="text-[10px] font-medium text-slate-400 dark:text-slate-500">
          +{tags.length - max}
        </span>
      ) : null}
    </>
  )
}

export function RecurrenceBadge({ recurrence }: { recurrence: Recurrence }) {
  if (recurrence === 'none') return null
  return (
    <span
      className="inline-flex items-center gap-1"
      title={`Repeats ${RECURRENCE_META[recurrence].short.toLowerCase()}`}
    >
      <RepeatIcon className="h-3.5 w-3.5" />
      {RECURRENCE_META[recurrence].short}
    </span>
  )
}
