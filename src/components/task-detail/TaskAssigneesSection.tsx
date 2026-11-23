import type { Member, Task } from '@/types'
import { Avatar } from '../ui'
import { CheckIcon, UsersIcon, XIcon } from '../Icons'

interface TaskAssigneesSectionProps {
  task: Task
  members: Member[]
  assignees: NonNullable<Task['assignees']>
  assigneeBusy: boolean
  showAssigneePicker: boolean
  setShowAssigneePicker: (value: boolean | ((current: boolean) => boolean)) => void
  toggleAssignee: (person: { id: number }) => Promise<void>
}

export default function TaskAssigneesSection({
  task,
  members,
  assignees,
  assigneeBusy,
  showAssigneePicker,
  setShowAssigneePicker,
  toggleAssignee,
}: TaskAssigneesSectionProps) {
  if (!task.teamId) return null

  return (
    <section className="mt-5 rounded-2xl bg-white p-4 ring-1 ring-slate-200/70">
      <div className="flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-sm font-bold text-[#15181E]">
          <UsersIcon className="h-4 w-4 text-[#7B8190]" />
          Assigned to
        </h3>
        <button
          type="button"
          onClick={() => setShowAssigneePicker((value) => !value)}
          aria-expanded={showAssigneePicker}
          className="rounded-lg bg-[#F6F6F4] px-2 py-1 text-[11px] font-bold text-[#3E4654] transition hover:bg-slate-200"
        >
          + Assign
        </button>
      </div>

      {assignees.length === 0 ? (
        <p className="mt-2 text-xs text-[#7B8190]">No one assigned yet.</p>
      ) : (
        <div className="mt-3 flex flex-wrap gap-2">
          {assignees.map((person) => (
            <span
              key={person.id}
              className="inline-flex items-center gap-1.5 rounded-full bg-[#DCEBDF] py-1 pr-1.5 pl-1 text-[11px] font-bold text-[#1F3A2A]"
            >
              <Avatar email={person.email} size="sm" className="h-5! w-5! text-[9px]!" />
              <span className="max-w-[10rem] truncate">{person.name}</span>
              <button
                type="button"
                onClick={() => void toggleAssignee(person)}
                disabled={assigneeBusy}
                aria-label={`Unassign ${person.name}`}
                className="rounded-full p-0.5 transition hover:bg-white/80 disabled:opacity-50"
              >
                <XIcon className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}

      {showAssigneePicker && (
        <div className="mt-3 rounded-xl border border-slate-200/80 bg-[#F6F6F4] p-2">
          {members.length === 0 ? (
            <p className="px-2 py-1 text-xs text-[#7B8190]">No teammates to assign yet.</p>
          ) : (
            members.map((member) => {
              const active = assignees.some((item) => item.id === member.id)
              return (
                <button
                  key={member.id}
                  type="button"
                  onClick={() => void toggleAssignee(member)}
                  disabled={assigneeBusy}
                  aria-pressed={active}
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs font-semibold text-[#2E3742] transition hover:bg-white disabled:opacity-50"
                >
                  <Avatar email={member.email} size="sm" />
                  <span className="min-w-0 flex-1 truncate">{member.email.split('@')[0]}</span>
                  <span className="text-[10px] font-bold capitalize text-[#7B8190]">{member.role}</span>
                  {active && <CheckIcon className="h-3.5 w-3.5 text-[#009688]" />}
                </button>
              )
            })
          )}
        </div>
      )}
    </section>
  )
}
