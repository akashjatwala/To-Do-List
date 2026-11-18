import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, errorMessage } from '@/api'
import type { PredictionPlan, TaskPrediction, ToastTone } from '@/types'
import { CheckIcon, ListChecksIcon, XIcon } from './Icons'

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
  low: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300',
  medium: 'bg-indigo-50 text-indigo-600 dark:bg-indigo-500/10 dark:text-indigo-300',
  high: 'bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-300',
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

function durationLabel(prediction: TaskPrediction): string | null {
  if (prediction.expectedDuration === null) return null
  const base = `${prediction.expectedDuration} min`
  if (prediction.durationLow === null || prediction.durationHigh === null) return base
  if (prediction.durationLow === prediction.durationHigh) return base
  return `${base} (usually ${prediction.durationLow}–${prediction.durationHigh})`
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

  const headline = useMemo(() => {
    if (offDay) return 'Off day'
    if (gate) return "Today's plan"
    return "Today's plan"
  }, [offDay, gate])

  if (loading) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white/70 px-4 py-3 text-sm text-slate-400 dark:border-slate-800 dark:bg-slate-900/60 dark:text-slate-500">
        Working out today's plan…
      </div>
    )
  }

  return (
    <div className="rounded-2xl border border-slate-200 bg-white/70 p-4 dark:border-slate-800 dark:bg-slate-900/60">
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-indigo-50 text-indigo-500 dark:bg-indigo-500/10 dark:text-indigo-400">
          <ListChecksIcon className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-slate-700 dark:text-slate-200">{headline}</p>
          {plan && !offDay && (
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{plan.note}</p>
          )}
        </div>
      </div>

      {offDay && (
        <p className="mt-3 rounded-xl bg-slate-50 px-3 py-2 text-xs text-slate-600 dark:bg-slate-800/60 dark:text-slate-300">
          No predictions are shown on an off day. You can still check in if you like.
        </p>
      )}

      {gate && !offDay && (
        <div className="mt-3 rounded-xl bg-slate-50 px-3 py-3 dark:bg-slate-800/60">
          <p className="text-xs text-slate-600 dark:text-slate-300">
            Answer today's check-in to see what you're likely to get done, and when.
          </p>
          {onOpenCheckin && (
            <button
              type="button"
              onClick={onOpenCheckin}
              className="mt-2 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-indigo-500"
            >
              Check in
            </button>
          )}
        </div>
      )}

      {!gate && !offDay && plan && plan.entries.length === 0 && (
        <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
          Nothing to plan for today yet.
        </p>
      )}

      {!gate && !offDay && plan && plan.entries.length > 0 && (
        <ul className="mt-3 space-y-2.5">
          {plan.entries.map((entry) => {
            const prediction = entry.prediction
            const window = windowLabel(prediction)
            const duration = durationLabel(prediction)
            const state = answered[entry.taskId]
            return (
              <li
                key={entry.taskId}
                className="rounded-xl border border-slate-100 px-3 py-2.5 dark:border-slate-800"
              >
                <div className="flex items-start justify-between gap-2">
                  <p className="min-w-0 truncate text-sm font-medium text-slate-700 dark:text-slate-200">
                    {entry.text}
                  </p>
                  <span
                    className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                      CONFIDENCE_STYLE[prediction.confidence] ?? CONFIDENCE_STYLE.low
                    }`}
                  >
                    {prediction.confidence} confidence
                  </span>
                </div>

                <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-600 dark:text-slate-300">
                  <span>
                    <span className="font-semibold text-slate-800 dark:text-slate-100">
                      {percent(prediction.completionProbability)}
                    </span>{' '}
                    likely to happen
                  </span>
                  {prediction.targetProbability !== null && (
                    <span>
                      <span className="font-semibold text-slate-800 dark:text-slate-100">
                        {percent(prediction.targetProbability)}
                      </span>{' '}
                      to hit the target
                    </span>
                  )}
                  {duration && <span>usually {duration}</span>}
                  {window && <span>suggested {window}</span>}
                </div>

                {prediction.exploratory && (
                  <p className="mt-1.5 inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-700 dark:bg-amber-500/10 dark:text-amber-300">
                    Trying a new time
                  </p>
                )}

                <p className="mt-1.5 text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">
                  {prediction.explanation}
                </p>

                <div className="mt-2 flex items-center gap-1.5">
                  {state === undefined ? (
                    <>
                      <button
                        type="button"
                        disabled={busyTask === entry.taskId}
                        onClick={() => void markFollowed(entry.taskId, prediction.exploratory, true)}
                        className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2 py-1 text-[11px] font-semibold text-slate-600 transition hover:bg-white disabled:opacity-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                      >
                        <CheckIcon className="h-3 w-3" />
                        Followed this time
                      </button>
                      <button
                        type="button"
                        disabled={busyTask === entry.taskId}
                        onClick={() => void markFollowed(entry.taskId, prediction.exploratory, false)}
                        className="rounded-lg px-2 py-1 text-[11px] font-medium text-slate-400 transition hover:text-slate-600 disabled:opacity-50 dark:text-slate-500 dark:hover:text-slate-300"
                      >
                        Not this time
                      </button>
                    </>
                  ) : (
                    <span className="text-[11px] text-slate-400 dark:text-slate-500">
                      {state ? 'Marked as followed.' : 'Marked as not followed.'}
                    </span>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}

      {!offDay && plan && plan.suggestions.length > 0 && (
        <div className="mt-3 space-y-2 border-t border-slate-100 pt-3 dark:border-slate-800">
          {plan.suggestions.map((suggestion) => (
            <div
              key={`${suggestion.kind}:${suggestion.taskId}`}
              className="rounded-xl bg-slate-50 px-3 py-2 dark:bg-slate-800/60"
            >
              <p className="text-[11px] leading-relaxed text-slate-600 dark:text-slate-300">
                {suggestion.message}
              </p>
              <div className="mt-1.5 flex items-center gap-1.5">
                <button
                  type="button"
                  disabled={busyTask === suggestion.taskId}
                  onClick={() => void answerSuggestion(suggestion.taskId, suggestion.kind, 'accepted')}
                  className="rounded-lg bg-indigo-600 px-2.5 py-1 text-[11px] font-semibold text-white transition hover:bg-indigo-500 disabled:opacity-50"
                >
                  {suggestion.kind === 'drop' ? 'Drop it' : 'Move it'}
                </button>
                <button
                  type="button"
                  disabled={busyTask === suggestion.taskId}
                  onClick={() => void answerSuggestion(suggestion.taskId, suggestion.kind, 'dismissed')}
                  className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-[11px] font-medium text-slate-500 transition hover:text-slate-700 disabled:opacity-50 dark:text-slate-400 dark:hover:text-slate-200"
                >
                  <XIcon className="h-3 w-3" />
                  Keep it
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
