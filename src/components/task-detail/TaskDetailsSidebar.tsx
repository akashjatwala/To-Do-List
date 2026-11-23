import type { Recurrence, RecurrenceConfig, Task } from '@/types'
import { dateInputValue, dueFromDateInput } from '@/lib/date'
import { RECURRENCE_META, RECURRENCE_VALUES } from '@/lib/taskmeta'
import RecurrenceEditor from '../RecurrenceEditor'
import { ChevronDownIcon, XIcon } from '../Icons'
import DetailPillRow from './DetailPillRow'

interface TaskDetailsSidebarProps {
  task: Task
  listLabel: string
  dueLabel: string
  durationValue: string
  customRepeat: RecurrenceConfig
  onUpdate: (patch: {
    due?: number | null
    duration?: number | null
    recurrence?: Recurrence
    recurrenceConfig?: RecurrenceConfig | null
  }) => Promise<boolean> | void
  setDurationValue: (value: string) => void
  commitDuration: () => void
  changeRecurrence: (value: Recurrence) => void
  changeCustomRepeat: (config: RecurrenceConfig) => void
}

export default function TaskDetailsSidebar({
  task,
  listLabel,
  dueLabel,
  durationValue,
  customRepeat,
  onUpdate,
  setDurationValue,
  commitDuration,
  changeRecurrence,
  changeCustomRepeat,
}: TaskDetailsSidebarProps) {
  return (
    <aside className="border-t border-slate-200/80 bg-[#F6F6F4] px-5 py-6 sm:px-6 md:border-t-0 md:border-l">
      <section>
        <h3 className="text-sm font-bold text-[#15181E]">Details</h3>
        <div className="mt-3 space-y-2.5">
          <DetailPillRow label="List">
            <span className="min-w-0 flex-1 truncate">
              {listLabel}
              {!task.teamName && <span className="text-[#7B8190]"> private</span>}
            </span>
            <ChevronDownIcon className="h-3.5 w-3.5 shrink-0 text-[#7B8190]" />
          </DetailPillRow>

          <DetailPillRow label="Due">
            <div className="flex min-w-0 flex-1 items-center gap-1.5">
              <input
                id="task-due"
                type="date"
                value={dateInputValue(task.due)}
                onChange={(event) => void onUpdate({ due: dueFromDateInput(event.target.value) })}
                aria-label="Due date"
                className="min-w-0 flex-1 bg-transparent text-[11px] font-semibold text-[#2E3742] outline-none"
              />
              <span className="sr-only">{dueLabel}</span>
            </div>
            {task.due !== null && (
              <button
                type="button"
                onClick={() => void onUpdate({ due: null })}
                aria-label="Clear due date"
                className="rounded p-0.5 text-[#7B8190] transition hover:text-[#15181E]"
              >
                <XIcon className="h-3.5 w-3.5" />
              </button>
            )}
          </DetailPillRow>

          <DetailPillRow label="Duration">
            <input
              type="text"
              inputMode="numeric"
              value={durationValue}
              onChange={(event) => setDurationValue(event.target.value.replace(/\D/g, '').slice(0, 5))}
              onBlur={commitDuration}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  event.currentTarget.blur()
                }
              }}
              placeholder="—"
              aria-label="Ideal duration in minutes"
              className="w-10 bg-transparent text-right text-xs font-bold text-[#2E3742] outline-none placeholder:text-[#7B8190]"
            />
            <span className="ml-1 text-xs font-semibold text-[#5F6165]">min</span>
            <ChevronDownIcon className="ml-auto h-3.5 w-3.5 shrink-0 text-[#7B8190]" />
          </DetailPillRow>

          <DetailPillRow label="Repeats">
            <select
              value={task.recurrence}
              onChange={(event) => changeRecurrence(event.target.value as Recurrence)}
              aria-label="Repeat rule"
              className="min-w-0 flex-1 appearance-none bg-transparent text-xs font-bold text-[#2E3742] outline-none"
            >
              {RECURRENCE_VALUES.map((value) => (
                <option key={value} value={value}>
                  {RECURRENCE_META[value].label}
                </option>
              ))}
            </select>
            <ChevronDownIcon className="h-3.5 w-3.5 shrink-0 text-[#7B8190]" />
          </DetailPillRow>
          {task.recurrence === 'custom' && (
            <div className="pl-[82px]">
              <RecurrenceEditor config={customRepeat} onChange={changeCustomRepeat} />
            </div>
          )}
        </div>
      </section>
    </aside>
  )
}
