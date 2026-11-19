import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { api, errorMessage } from '@/api'
import type { ActivitySession, DailyActivity, DailyStatus, ExplicitDailyStatus, TaskConfig } from '@/types'
import { localDateString } from '@/lib/checkin'
import { todayDateValue } from '@/lib/date'
import { ClockIcon, PlusIcon, TrashIcon } from './Icons'
import { Spinner } from './ui'

/**
 * Activity log for a task.
 *
 * This is the collection surface for the learning data: it records real
 * sessions (several per day are fine), shows the derived day record, and lets
 * the user state a day as skipped or postponed. Nothing here predicts
 * anything — it only records what actually happened. Missing days stay
 * "no data" rather than being treated as zero.
 */
const STATUS_META: Record<DailyStatus, { label: string; cell: string; dot: string }> = {
  completed: {
    label: 'Completed',
    cell: 'bg-emerald-500',
    dot: 'bg-emerald-400',
  },
  partial: {
    label: 'Partial',
    cell: 'bg-amber-400',
    dot: 'bg-amber-400',
  },
  skipped: {
    label: 'Skipped',
    cell: 'bg-rose-400',
    dot: 'bg-rose-400',
  },
  postponed: {
    label: 'Postponed',
    cell: 'bg-violet-400',
    dot: 'bg-violet-400',
  },
  pending: {
    label: 'Pending',
    cell: 'bg-slate-300',
    dot: 'bg-slate-300',
  },
  unknown: {
    label: 'No data',
    cell: 'bg-slate-200',
    dot: 'bg-slate-200',
  },
}

const EXPLICIT_STATUSES: ExplicitDailyStatus[] = ['completed', 'partial', 'skipped', 'postponed']

const RANGE_DAYS = 14

function shiftDate(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number)
  const next = new Date(year, month - 1, day + days)
  return localDateString(next)
}

function shortDate(date: string): string {
  const [year, month, day] = date.split('-').map(Number)
  return new Date(year, month - 1, day).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  })
}

function weekdayLetter(date: string): string {
  const [year, month, day] = date.split('-').map(Number)
  return new Date(year, month - 1, day).toLocaleDateString(undefined, { weekday: 'narrow' })
}

/** A local timestamp for a date + "HH:MM". */
function timestampFor(date: string, time: string): number {
  const [year, month, day] = date.split('-').map(Number)
  const [hours, minutes] = time.split(':').map(Number)
  return new Date(year, month - 1, day, hours || 0, minutes || 0, 0, 0).getTime()
}

function formatClock(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

function nowTime(): string {
  const now = new Date()
  return `${`${now.getHours()}`.padStart(2, '0')}:${`${now.getMinutes()}`.padStart(2, '0')}`
}

function durationLabel(minutes: number): string {
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest ? `${hours}h ${rest}m` : `${hours}h`
}

export default function ActivityLog({ taskId }: { taskId: string }) {
  const today = todayDateValue()
  const [range, setRange] = useState<DailyActivity[]>([])
  const [sessions, setSessions] = useState<ActivitySession[]>([])
  const [configs, setConfigs] = useState<TaskConfig[]>([])
  const [selectedDate, setSelectedDate] = useState(today)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [sessionDate, setSessionDate] = useState(today)
  const [startTime, setStartTime] = useState(nowTime)
  const [minutes, setMinutes] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const from = shiftDate(today, -(RANGE_DAYS - 1))
      const [rangeRes, sessionRes, configRes] = await Promise.all([
        api.getRange(taskId, from, today, today),
        api.listSessions(taskId, 30),
        api.listTaskConfigs(taskId),
      ])
      setRange(rangeRes.items)
      setSessions(sessionRes.items)
      setConfigs(configRes.items)
      setError(null)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setLoading(false)
    }
  }, [taskId, today])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    setSelectedDate(today)
    setSessionDate(today)
  }, [taskId, today])

  const selected = useMemo(
    () => range.find((day) => day.date === selectedDate) ?? null,
    [range, selectedDate],
  )

  const activeDays = range.filter((day) => day.totalMinutes > 0).length
  const totalMinutes = range.reduce((sum, day) => sum + day.totalMinutes, 0)

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true)
    try {
      await action()
      await load()
      setError(null)
      return true
    } catch (err) {
      setError(errorMessage(err))
      return false
    } finally {
      setBusy(false)
    }
  }

  const submitSession = async (event: FormEvent) => {
    event.preventDefault()
    const parsed = Number.parseInt(minutes, 10)
    if (!Number.isFinite(parsed) || parsed < 1) {
      setError('Give a duration in minutes.')
      return
    }
    const ok = await run(() =>
      api.createSession({
        taskId,
        localDate: sessionDate,
        startedAt: timestampFor(sessionDate, startTime),
        durationMinutes: Math.min(parsed, 24 * 60),
      }),
    )
    if (ok) setMinutes('')
  }

  const applyStatus = (status: ExplicitDailyStatus) =>
    run(() => api.setDayStatus({ taskId, date: selectedDate, status, today }))

  const clearStatus = () => run(() => api.clearDayStatus(taskId, selectedDate, today))

  return (
    <section className="mt-5 rounded-xl border border-slate-200 p-3.5">
      <div className="mb-3 flex items-center justify-between">
        <p className="flex items-center gap-1.5 text-[11px] font-bold tracking-wider text-slate-400 uppercase">
          <ClockIcon className="h-3.5 w-3.5" />
          Activity log
        </p>
        {busy && <Spinner className="h-3.5 w-3.5 text-slate-400" />}
      </div>

      {/* 14-day strip: the day record, at a glance */}
      <div className="flex items-end justify-between gap-1">
        {range.map((day) => {
          const meta = STATUS_META[day.status]
          const isSelected = day.date === selectedDate
          return (
            <button
              key={day.date}
              type="button"
              onClick={() => setSelectedDate(day.date)}
              title={`${shortDate(day.date)} · ${meta.label}${
                day.totalMinutes > 0 ? ` · ${durationLabel(day.totalMinutes)}` : ''
              }`}
              aria-label={`${shortDate(day.date)}: ${meta.label}`}
              aria-pressed={isSelected}
              className={`flex flex-1 flex-col items-center gap-1 rounded-lg px-0.5 py-1 transition hover:bg-slate-100 ${
                isSelected ? 'bg-slate-100 ring-1 ring-indigo-300' : ''
              }`}
            >
              <span className="text-[9px] font-semibold text-slate-400">
                {weekdayLetter(day.date)}
              </span>
              <span className={`h-6 w-full max-w-4 rounded ${meta.cell}`} />
            </button>
          )
        })}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-400">
        <span>
          Last {RANGE_DAYS} days: <span className="font-semibold text-slate-600">{activeDays}</span>{' '}
          with activity
        </span>
        <span aria-hidden="true">·</span>
        <span>
          <span className="font-semibold text-slate-600">{durationLabel(totalMinutes)}</span> total
        </span>
      </div>

      {/* Selected day */}
      <div className="mt-3 rounded-lg bg-slate-50 px-3 py-2.5">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold text-slate-600">
            {selectedDate === today ? 'Today' : shortDate(selectedDate)}
          </span>
          {selected && (
            <span className="flex items-center gap-1.5 text-[11px] font-medium text-slate-500">
              <span className={`h-2 w-2 rounded-full ${STATUS_META[selected.status].dot}`} />
              {STATUS_META[selected.status].label}
            </span>
          )}
        </div>
        <p className="mt-0.5 text-[11px] text-slate-400">
          {selected
            ? `${selected.sessionCount} session${selected.sessionCount === 1 ? '' : 's'} · ${durationLabel(
                selected.totalMinutes,
              )}${selected.targetMinutes ? ` of ${durationLabel(selected.targetMinutes)} target` : ''}`
            : 'No record for this day.'}
        </p>

        <div className="mt-2 flex flex-wrap gap-1.5">
          {EXPLICIT_STATUSES.map((status) => (
            <button
              key={status}
              type="button"
              disabled={busy}
              onClick={() => void applyStatus(status)}
              className="rounded-lg bg-white px-2 py-1 text-[11px] font-semibold text-slate-500 transition hover:bg-slate-100 disabled:opacity-50"
            >
              {STATUS_META[status].label}
            </button>
          ))}
          <button
            type="button"
            disabled={busy}
            onClick={() => void clearStatus()}
            className="rounded-lg px-2 py-1 text-[11px] font-medium text-slate-400 transition hover:text-slate-600 disabled:opacity-50"
          >
            Clear
          </button>
        </div>
      </div>

      {/* Log a session */}
      <form onSubmit={submitSession} className="mt-3 flex flex-wrap items-center gap-2">
        <input
          type="date"
          value={sessionDate}
          max={today}
          onChange={(event) => setSessionDate(event.target.value)}
          aria-label="Session date"
          className="rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-base text-slate-600 outline-none focus:border-indigo-400 sm:text-xs"
        />
        <input
          type="time"
          value={startTime}
          onChange={(event) => setStartTime(event.target.value)}
          aria-label="Session start time"
          className="rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-base text-slate-600 outline-none focus:border-indigo-400 sm:text-xs"
        />
        <input
          type="text"
          inputMode="numeric"
          value={minutes}
          onChange={(event) => setMinutes(event.target.value.replace(/\D/g, '').slice(0, 4))}
          placeholder="Minutes"
          aria-label="Session duration in minutes"
          className="w-20 rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-base text-slate-600 outline-none placeholder:text-slate-400 focus:border-indigo-400 sm:text-xs"
        />
        <button
          type="submit"
          disabled={busy || !minutes.trim()}
          className="btn-primary px-2.5! py-1.5! text-xs"
        >
          <PlusIcon className="h-3.5 w-3.5" />
          Log
        </button>
      </form>

      {error && <p className="mt-2 text-[11px] font-medium text-rose-500">{error}</p>}

      {/* Recent sessions */}
      {!loading && sessions.length > 0 && (
        <div className="mt-3 space-y-1 border-t border-slate-100 pt-3">
          {sessions.slice(0, 6).map((session) => (
            <div key={session.id} className="group flex items-center gap-2 text-xs">
              <span className="w-14 shrink-0 tabular-nums text-slate-400">
                {shortDate(session.date)}
              </span>
              <span className="text-slate-500">
                {session.endedAt
                  ? `${formatClock(session.startedAt)}–${formatClock(session.endedAt)}`
                  : formatClock(session.startedAt)}
              </span>
              <span className="font-semibold text-slate-600">
                {durationLabel(session.durationMinutes)}
              </span>
              <button
                type="button"
                disabled={busy}
                onClick={() => void run(() => api.deleteSession(session.id))}
                className="ml-auto rounded p-0.5 text-slate-300 opacity-70 transition hover:text-rose-500 disabled:opacity-0 sm:opacity-0 sm:group-hover:opacity-100"
                aria-label="Delete session"
              >
                <TrashIcon className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Config history: the target/priority/tags that applied, over time */}
      {configs.length > 1 && (
        <details className="mt-3 border-t border-slate-100 pt-3">
          <summary className="cursor-pointer text-[11px] font-semibold text-slate-400 transition hover:text-slate-600">
            {configs.length} configuration versions
          </summary>
          <ul className="mt-2 space-y-1">
            {configs.map((config) => (
              <li key={config.id} className="flex items-center gap-2 text-[11px] text-slate-500">
                <span className="flex h-4 w-4 items-center justify-center rounded-full bg-slate-100 text-[9px] font-bold text-slate-500">
                  {config.version}
                </span>
                <span className="w-16 shrink-0">{shortDate(localDateString(new Date(config.effectiveFrom)))}</span>
                <span>
                  {config.targetDuration ? `${config.targetDuration} min` : 'no target'}
                  {config.priority ? ` · ${config.priority}` : ''}
                  {config.preferredTime ? ` · ${config.preferredTime}` : ''}
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-1.5 text-[10px] text-slate-400">
            Every change is kept, so past days stay interpretable.
          </p>
        </details>
      )}

      {loading && (
        <p className="mt-2 flex items-center gap-1.5 text-[11px] text-slate-400">
          <Spinner className="h-3 w-3" />
          Loading activity…
        </p>
      )}
    </section>
  )
}
