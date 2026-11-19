import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { api, errorMessage } from '@/api'
import type { DaySchedule, PredictionPlan, RescheduleResult, TaskPrediction, ToastTone } from '@/types'
import { formatDateValue } from '@/lib/date'
import { AlertIcon, CalendarIcon, CheckIcon, ListChecksIcon, SparklesIcon, XIcon } from './Icons'

/**
 * Today's plan and predictions.
 *
 * The server produces and logs every prediction; this card only displays them
 * and records what the user did with them. The rules it keeps on screen:
 * - The plan is gated on today's check-in. Until that is answered or skipped the
 *   card asks for the check-in first and shows no numbers.
 * - An off day shows "off day" and no predictions at all.
 * - Everything is a suggestion: each row is overridable and the "followed"
 *   controls are optional. Nothing here writes an outcome.
 */

interface PredictionPanelProps {
  /** The selected local date (`YYYY-MM-DD`). */
  date: string
  /** The user's current local date. */
  today: string
  notify: (message: string, tone?: ToastTone) => void
  /** Open the check-in when the plan is gated. */
  onOpenCheckin?: () => void
  /** Changes when the check-in or a task changed, so the plan reloads. */
  refreshKey?: unknown
}

const CONFIDENCE_STYLE: Record<string, string> = {
  low: 'bg-slate-100 text-slate-600',
  medium: 'bg-indigo-50 text-indigo-600',
  high: 'bg-emerald-50 text-emerald-600',
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`
}

/** Local `HH:MM` for an epoch timestamp. */
function clockTime(timestamp: number): string {
  const date = new Date(timestamp)
  const hours = `${date.getHours()}`.padStart(2, '0')
  const minutes = `${date.getMinutes()}`.padStart(2, '0')
  return `${hours}:${minutes}`
}

function windowLabel(prediction: TaskPrediction): string | null {
  if (prediction.recommendedStart === null || prediction.recommendedEnd === null) return null
  return `${clockTime(prediction.recommendedStart)}–${clockTime(prediction.recommendedEnd)}`
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <span className="insight-pill bg-slate-50 text-slate-700 ring-1 ring-slate-100">
      <span className="font-medium text-slate-400">{label}</span>
      <span className="font-bold">{value}</span>
    </span>
  )
}

export default function PredictionPanel({
  date,
  today,
  notify,
  onOpenCheckin,
  refreshKey,
}: PredictionPanelProps) {
  const [loading, setLoading] = useState(true)
  const [gate, setGate] = useState(false)
  const [offDay, setOffDay] = useState(false)
  const [plan, setPlan] = useState<PredictionPlan | null>(null)
  const [schedule, setSchedule] = useState<DaySchedule | null>(null)
  const [reschedules, setReschedules] = useState<RescheduleResult | null>(null)
  const [busyTask, setBusyTask] = useState<string | null>(null)
  const [answered, setAnswered] = useState<Record<string, boolean | null>>({})
  const shownLoggedFor = useRef<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const result = await api.getPlan(date, today)
      setGate(result.gate)
      setOffDay(result.offDay)
      setPlan(result.plan)
      setSchedule(result.schedule)
      setReschedules(result.reschedules)
    } catch (error) {
      notify(errorMessage(error), 'error')
    } finally {
      setLoading(false)
    }
  }, [date, today, notify])

  useEffect(() => {
    void load()
  }, [load, refreshKey])

  // Record that each time recommendation was shown, once per plan load. The log
  // lives apart from both the predictions and the outcomes.
  useEffect(() => {
    if (!plan || plan.offDay || plan.entries.length === 0) return
    const key = `${date}:${plan.entries.length}`
    if (shownLoggedFor.current === key) return
    shownLoggedFor.current = key
    void Promise.allSettled(
      plan.entries.map((entry) =>
        api.savePredictionFeedback({
          date,
          taskId: entry.taskId,
          kind: 'time',
          exploratory: entry.prediction.exploratory,
          shown: true,
        }),
      ),
    )
  }, [plan, date])

  const markFollowed = useCallback(
    async (taskId: string, exploratory: boolean, followed: boolean) => {
      setBusyTask(taskId)
      try {
        await api.savePredictionFeedback({
          date,
          taskId,
          kind: 'time',
          exploratory,
          shown: true,
          followed,
        })
        setAnswered((prev) => ({ ...prev, [taskId]: followed }))
      } catch (error) {
        notify(errorMessage(error), 'error')
      } finally {
        setBusyTask(null)
      }
    },
    [date, notify],
  )

  const answerSuggestion = useCallback(
    async (taskId: string, kind: 'reschedule' | 'drop', choice: 'accepted' | 'dismissed') => {
      setBusyTask(taskId)
      try {
        await api.saveSuggestionChoice(date, `${kind}:${taskId}`, choice)
        await api.savePredictionFeedback({
          date,
          taskId,
          kind,
          shown: true,
          followed: choice === 'accepted',
        })
        notify(choice === 'accepted' ? 'Noted — it is your call either way.' : 'Kept it as it is.', 'success')
      } catch (error) {
        notify(errorMessage(error), 'error')
      } finally {
        setBusyTask(null)
      }
    },
    [date, notify],
  )

  const answerReschedule = useCallback(
    async (taskId: string, choice: 'accepted' | 'dismissed') => {
      setBusyTask(taskId)
      try {
        await api.saveSuggestionChoice(date, `reschedule:${taskId}`, choice)
        await api.savePredictionFeedback({ date, taskId, kind: 'reschedule', shown: true, followed: choice === 'accepted' })
        notify(choice === 'accepted' ? 'Noted — your task has not been moved.' : 'Kept as it is.', 'success')
      } catch (error) {
        notify(errorMessage(error), 'error')
      } finally {
        setBusyTask(null)
      }
    },
    [date, notify],
  )

  const headline = useMemo(() => {
    if (offDay) return 'Off day'
    return "Today's plan"
  }, [offDay])

  if (loading) {
    return (
      <div className="insight-card flex items-center gap-3 px-4 py-4">
        <span className="insight-icon bg-violet-50 text-violet-500">
          <ListChecksIcon className="h-4 w-4" />
        </span>
        <div>
          <p className="insight-eyebrow">Daily plan</p>
          <p className="insight-title">Working out today&apos;s plan…</p>
        </div>
      </div>
    )
  }

  const sideColumn: ReactNode = (
    <div className="order-1 min-w-0 space-y-3 lg:order-2">
      {schedule?.overloaded && schedule.warning && (
        <div className="flex items-start gap-2.5 rounded-2xl border border-amber-100 bg-amber-50/80 px-3.5 py-3 text-xs leading-relaxed text-amber-800 shadow-sm">
          <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-amber-100 text-amber-700">
            <AlertIcon className="h-3.5 w-3.5" />
          </span>
          <span>{schedule.warning}</span>
        </div>
      )}

      {schedule?.available && schedule.slots.length > 0 && (
        <div className="insight-section">
          <div className="flex items-center justify-between gap-2">
            <p className="insight-section-title">Proposed flow</p>
            <span className="insight-pill bg-indigo-50 text-indigo-700 ring-1 ring-indigo-100">
              {schedule.plannedMinutes} min
            </span>
          </div>
          <ol className="mt-3.5">
            {schedule.slots.map((slot, index) => (
              <li key={slot.taskId} className="relative flex gap-3 pb-3.5 last:pb-0">
                {index < schedule.slots.length - 1 && (
                  <span className="absolute top-5 bottom-0 left-[4px] w-px bg-slate-200" />
                )}
                <span className="relative z-10 mt-1 h-2.5 w-2.5 shrink-0 rounded-full bg-indigo-400 ring-4 ring-indigo-50" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <p className="min-w-0 truncate text-xs font-semibold text-slate-700">
                      {slot.text}
                    </p>
                    <span className="shrink-0 font-mono text-[10px] text-slate-400">
                      {clockTime(slot.start)}–{clockTime(slot.end)}
                    </span>
                  </div>
                  <p className="mt-0.5 text-[10px] text-slate-400">
                    {slot.shifted ? 'Nudged to avoid a clash' : `${slot.duration} min slot`}
                  </p>
                </div>
              </li>
            ))}
          </ol>
          {schedule.unplaced.length > 0 && (
            <p className="insight-hint mt-3 rounded-xl bg-slate-50 px-3 py-2">
              No slot found today: {schedule.unplaced.map((item) => item.text).join(', ')}.
            </p>
          )}
          <p className="insight-hint mt-3 border-t border-slate-100 pt-2.5">
            {schedule.reason}
          </p>
        </div>
      )}
    </div>
  )

  const mainColumn: ReactNode = (
    <div className="order-2 min-w-0 space-y-3 lg:order-1">
      {plan && plan.entries.length === 0 && (
        <p className="insight-hint rounded-xl bg-slate-50 px-3 py-4 text-center">
          Nothing to plan for today yet.
        </p>
      )}

      {plan && plan.entries.length > 0 && (
        <ul className="space-y-3">
          {plan.entries.map((entry) => {
            const prediction = entry.prediction
            const window = windowLabel(prediction)
            const duration = prediction.expectedDuration === null ? null : `${prediction.expectedDuration} min`
            const state = answered[entry.taskId]
            return (
              <li key={entry.taskId} className="insight-section transition hover:border-indigo-100">
                <div className="flex items-start justify-between gap-3">
                  <p className="min-w-0 text-sm font-semibold text-slate-800">
                    {entry.text}
                  </p>
                  <span
                    className={`insight-pill shrink-0 ${
                      CONFIDENCE_STYLE[prediction.confidence] ?? CONFIDENCE_STYLE.low
                    }`}
                  >
                    {prediction.confidence} confidence
                  </span>
                </div>

                <div className="mt-3 flex flex-wrap gap-2">
                  <Metric label="Likely" value={percent(prediction.completionProbability)} />
                  {prediction.targetProbability !== null && (
                    <Metric label="Target" value={percent(prediction.targetProbability)} />
                  )}
                  {duration && <Metric label="Length" value={duration} />}
                  {window && <Metric label="Best window" value={window} />}
                  {prediction.durationLow !== null &&
                    prediction.durationHigh !== null &&
                    prediction.durationLow !== prediction.durationHigh && (
                      <Metric label="Usually" value={`${prediction.durationLow}–${prediction.durationHigh} min`} />
                    )}
                  {prediction.exploratory && (
                    <span className="insight-pill bg-amber-50 text-amber-700 ring-1 ring-amber-100">
                      <SparklesIcon className="h-3 w-3" />
                      Trying a new time
                    </span>
                  )}
                </div>

                <p className="mt-3 rounded-xl bg-slate-50/80 px-3 py-2 text-[11px] leading-relaxed text-slate-500 ring-1 ring-slate-100">
                  {prediction.explanation}
                </p>

                <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3">
                  {state === undefined ? (
                    <>
                      <button
                        type="button"
                        disabled={busyTask === entry.taskId}
                        onClick={() => void markFollowed(entry.taskId, prediction.exploratory, true)}
                        className="insight-primary"
                      >
                        <CheckIcon className="h-3 w-3" />
                        Followed this time
                      </button>
                      <button
                        type="button"
                        disabled={busyTask === entry.taskId}
                        onClick={() => void markFollowed(entry.taskId, prediction.exploratory, false)}
                        className="insight-quiet"
                      >
                        Not this time
                      </button>
                    </>
                  ) : (
                    <span className="insight-hint">{state ? 'Marked as followed.' : 'Marked as not followed.'}</span>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}

      {plan && plan.suggestions.length > 0 && (
        <div className="space-y-2.5">
          <p className="insight-section-title flex items-center gap-1.5 px-0.5">
            <SparklesIcon className="h-3 w-3" />
            Worth a look
          </p>
          {plan.suggestions.map((suggestion) => (
            <div
              key={`${suggestion.kind}:${suggestion.taskId}`}
              className="rounded-2xl border border-amber-100 bg-amber-50/60 p-3.5 shadow-sm"
            >
              <p className="text-xs leading-relaxed text-amber-900">
                {suggestion.message}
              </p>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  disabled={busyTask === suggestion.taskId}
                  onClick={() => void answerSuggestion(suggestion.taskId, suggestion.kind, 'accepted')}
                  className="insight-primary"
                >
                  {suggestion.kind === 'drop' ? 'Drop it' : 'Move it'}
                </button>
                <button
                  type="button"
                  disabled={busyTask === suggestion.taskId}
                  onClick={() => void answerSuggestion(suggestion.taskId, suggestion.kind, 'dismissed')}
                  className="insight-quiet"
                >
                  <XIcon className="h-3 w-3" />
                  Keep it
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {reschedules?.available && reschedules.suggestions.length > 0 && (
        <div className="space-y-2.5">
          <div className="flex items-center justify-between gap-2 px-0.5">
            <p className="insight-section-title flex items-center gap-1.5">
              <CalendarIcon className="h-3 w-3" />
              Better days for skipped tasks
            </p>
            <span className="insight-pill bg-slate-50 text-slate-400 ring-1 ring-slate-100">
              {reschedules.suggestions.length} ideas
            </span>
          </div>
          {reschedules.suggestions.map((item) => {
            const time =
              item.suggestedStart === null
                ? ''
                : ` · ${clockTime(item.suggestedStart)}${
                    item.suggestedEnd === null ? '' : `–${clockTime(item.suggestedEnd)}`
                  }`
            return (
              <div key={item.taskId} className="insight-section">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-slate-800">{item.text}</p>
                    <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-indigo-600">
                      <span aria-hidden="true">→</span>
                      <span className="font-semibold">{formatDateValue(item.suggestedDate)}</span>
                      {time && <span className="text-slate-400">{time}</span>}
                    </p>
                  </div>
                  <span className="insight-pill bg-indigo-50 text-indigo-700 ring-1 ring-indigo-100">
                    Idea
                  </span>
                </div>
                <p className="mt-2 text-[11px] leading-relaxed text-slate-500">{item.reason}</p>
                <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3">
                  <button
                    type="button"
                    disabled={busyTask === item.taskId}
                    onClick={() => void answerReschedule(item.taskId, 'accepted')}
                    className="insight-primary"
                  >
                    Note it
                  </button>
                  <button
                    type="button"
                    disabled={busyTask === item.taskId}
                    onClick={() => void answerReschedule(item.taskId, 'dismissed')}
                    className="insight-quiet"
                  >
                    <XIcon className="h-3 w-3" />
                    Keep it
                  </button>
                </div>
              </div>
            )
          })}
          <p className="insight-hint px-0.5">{reschedules.reason}</p>
        </div>
      )}
    </div>
  )

  return (
    <section className="insight-card" aria-label="Today's plan">
      <div className="flex items-start gap-3 border-b border-slate-100 px-4 py-4">
        <span className="insight-icon bg-violet-50 text-violet-500">
          <ListChecksIcon className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="insight-eyebrow">Daily plan</p>
          <h2 className="insight-title">{headline}</h2>
          {plan && !offDay && <p className="insight-subtitle">{plan.note}</p>}
        </div>
        {!gate && !offDay && plan && plan.entries.length > 0 && (
          <span className="insight-pill hidden bg-violet-50 text-violet-700 ring-1 ring-violet-100 sm:inline-flex">
            {plan.entries.length} tasks
          </span>
        )}
      </div>

      {offDay && (
        <div className="px-4 pt-4">
          <p className="rounded-2xl border border-slate-100 bg-white/70 px-4 py-3 text-xs leading-relaxed text-slate-600">
            No predictions are shown on an off day. You can still check in if you like.
          </p>
        </div>
      )}

      {gate && !offDay && (
        <div className="px-4 pt-4">
          <div className="rounded-2xl border border-indigo-100 bg-indigo-50/60 px-4 py-3.5">
            <p className="text-xs leading-relaxed text-indigo-900">
              Answer today&apos;s check-in to see what you&apos;re likely to get done, and when.
            </p>
            {onOpenCheckin && (
              <button type="button" onClick={onOpenCheckin} className="insight-primary mt-3">
                <SparklesIcon className="h-3 w-3" />
                Check in
              </button>
            )}
          </div>
        </div>
      )}

      {!gate && !offDay && (
        <div className="grid gap-4 p-4 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
          {mainColumn}
          {sideColumn}
        </div>
      )}
    </section>
  )
}
