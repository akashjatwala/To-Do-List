import { useState, type FormEvent } from 'react'
import { api } from '@/api'
import type { ActivitySession, Task } from '@/types'
import { dateInputValue, formatDateValue } from '@/lib/date'
import { Spinner } from '../ui'
import { ClockIcon, TrashIcon } from '../Icons'
import { formatDuration } from '@/lib/taskmeta'
import { clockTime, entryTimestamp, shortEntryDate } from './helpers'

interface TaskTimeEntriesProps {
  task: Task
  currentUserId: number
  sessions: ActivitySession[]
  sessionsLoading: boolean
  entryError: string
  setEntryError: (value: string) => void
  setSessions: (value: ActivitySession[] | ((current: ActivitySession[]) => ActivitySession[])) => void
  confirm: (options: { title: string; description?: string; confirmLabel?: string }) => Promise<boolean>
}

export default function TaskTimeEntries({
  task,
  currentUserId,
  sessions,
  sessionsLoading,
  entryError,
  setEntryError,
  setSessions,
  confirm,
}: TaskTimeEntriesProps) {
  const [entryStart, setEntryStart] = useState('')
  const [entryEnd, setEntryEnd] = useState('')
  const [entryBusy, setEntryBusy] = useState(false)
  const entryDate = dateInputValue(task.due)

  const submitEntry = async (event: FormEvent) => {
    event.preventDefault()
    setEntryError('')
    if (!entryDate) {
      setEntryError('Set a due date for this task before adding time.')
      return
    }
    const startedAt = entryTimestamp(entryDate, entryStart)
    const endedAt = entryTimestamp(entryDate, entryEnd)
    if (startedAt === null || endedAt === null) {
      setEntryError('Enter a valid start time and completion time.')
      return
    }
    if (endedAt <= startedAt) {
      setEntryError('Completion time must be after the start time.')
      return
    }
    if (startedAt > Date.now() || endedAt > Date.now()) {
      setEntryError('Time entries cannot be in the future.')
      return
    }
    setEntryBusy(true)
    try {
      await api.createSession({
        taskId: task.id,
        localDate: entryDate,
        startedAt,
        endedAt,
      })
      // Reload so a new entry has the same author fields as teammates' entries.
      const result = await api.listSessions(task.id, 200, Boolean(task.teamId))
      setSessions(result.items)
      setEntryStart('')
      setEntryEnd('')
    } catch (error) {
      setEntryError(error instanceof Error ? error.message : 'Could not save the time entry.')
    } finally {
      setEntryBusy(false)
    }
  }

  const deleteEntry = async (session: ActivitySession) => {
    if (
      !(await confirm({
        title: 'Delete time entry?',
        description: `Remove the entry from ${shortEntryDate(session.date)}, ${clockTime(session.startedAt)}–${clockTime(session.endedAt ?? session.startedAt)}?`,
        confirmLabel: 'Delete entry',
      }))
    ) {
      return
    }
    try {
      await api.deleteSession(session.id)
      setSessions((current) => current.filter((item) => item.id !== session.id))
    } catch {
      setEntryError('Could not delete the time entry.')
    }
  }

  return (
    <section className="mt-6 rounded-2xl bg-white p-4 ring-1 ring-slate-200/70">
      <div className="flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-sm font-bold text-[#15181E]">
          <ClockIcon className="h-4 w-4 text-[#7B8190]" />
          Task time
        </h3>
        <span className="rounded-full bg-[#F6F6F4] px-2 py-0.5 text-[11px] font-bold text-[#2E3742] tabular-nums">
          {sessions.length} {sessions.length === 1 ? 'entry' : 'entries'}
        </span>
      </div>
      <p className="mt-1 text-[11px] leading-relaxed text-[#7B8190]">
        {task.teamId
          ? 'Start and completion times are shared with your teammates. Each entry stays owned by the person who logged it.'
          : 'Log as many start and completion times as you need for this task.'}
      </p>

      <div className="mt-3 space-y-2">
        {sessionsLoading && <p className="py-2 text-[11px] text-[#7B8190]">Loading time entries…</p>}
        {!sessionsLoading && sessions.length === 0 && (
          <p className="rounded-xl bg-[#F6F6F4] px-3 py-2.5 text-[11px] text-[#7B8190]">
            No time entries yet. Add one below.
          </p>
        )}
        {[...sessions]
          .sort((a, b) => b.startedAt - a.startedAt)
          .map((session) => {
            const mine = !task.teamId || session.userId === currentUserId
            return (
              <div key={session.id} className="flex items-center gap-2 rounded-xl bg-[#F6F6F4] px-3 py-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-xs font-bold text-[#2E3742] tabular-nums">
                    <span className="rounded-md bg-white px-1.5 py-0.5 text-[10px] font-semibold text-[#5F6165]">
                      {shortEntryDate(session.date)}
                    </span>
                    <span>
                      {clockTime(session.startedAt)} – {clockTime(session.endedAt ?? session.startedAt)}
                    </span>
                    <span className="text-[10px] font-semibold text-[#7B8190]">
                      ({formatDuration(session.durationMinutes)})
                    </span>
                  </div>
                  {task.teamId && session.authorEmail && (
                    <p className="mt-0.5 truncate text-[10px] font-medium text-[#7B8190]">
                      {session.authorName || session.authorEmail}
                    </p>
                  )}
                </div>
                {mine && (
                  <button
                    type="button"
                    onClick={() => void deleteEntry(session)}
                    aria-label="Delete time entry"
                    className="shrink-0 rounded-lg p-1.5 text-[#7B8190] transition hover:bg-rose-50 hover:text-rose-600"
                  >
                    <TrashIcon className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            )
          })}
      </div>

      <form onSubmit={submitEntry} className="mt-3 border-t border-slate-200/80 pt-3">
        <p className="text-[11px] font-bold text-[#5F6165]">Add a time entry</p>
        {entryDate ? (
          <p className="mt-0.5 text-[10px] font-medium text-[#7B8190]">
            Logged for this task's due date · {formatDateValue(entryDate)}
          </p>
        ) : (
          <p className="mt-0.5 text-[10px] font-medium text-rose-600">
            Set a due date for this task to add time.
          </p>
        )}
        <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1fr_auto]">
          <input
            type="time"
            value={entryStart}
            onChange={(event) => setEntryStart(event.target.value)}
            placeholder="Start"
            aria-label="Start time"
            className="min-w-0 rounded-lg bg-white px-2 py-1.5 text-[11px] font-semibold text-[#2E3742] ring-1 ring-slate-200 outline-none focus:ring-[#009688]"
          />
          <input
            type="time"
            value={entryEnd}
            onChange={(event) => setEntryEnd(event.target.value)}
            placeholder="Completion"
            aria-label="Completion time"
            className="min-w-0 rounded-lg bg-white px-2 py-1.5 text-[11px] font-semibold text-[#2E3742] ring-1 ring-slate-200 outline-none focus:ring-[#009688]"
          />
          <button
            type="submit"
            disabled={entryBusy || !entryStart || !entryEnd || !entryDate}
            className="rounded-lg bg-[#15181E] px-3 py-1.5 text-[11px] font-bold text-white transition hover:bg-[#2E3742] disabled:opacity-50"
          >
            {entryBusy ? <Spinner className="h-3 w-3" /> : 'Add time'}
          </button>
        </div>
        {entryError && <p className="mt-2 text-[11px] font-semibold text-rose-600">{entryError}</p>}
      </form>
    </section>
  )
}
