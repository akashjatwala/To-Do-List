import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { api, errorMessage } from '@/api'
import type { PredictionPlan, ToastTone } from '@/types'
import { ListChecksIcon, SparklesIcon } from './Icons'

/**
 * Today's plan and predictions.
 *
 * The server produces and logs every prediction; this card only displays them
 * and records what the user did with them. The rules it keeps on screen:
 * - The plan is gated on today's check-in. Until that is answered or skipped the
 *   card asks for the check-in first and shows no numbers.
 * - An off day shows "off day" and no predictions at all.
 * - Everything is a suggestion: nothing here writes an outcome.
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

function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <span className="inline-flex cursor-help items-baseline gap-1 whitespace-nowrap" title={hint}>
      <span className="text-[10px] text-slate-400">{label}</span>
      <span className="text-[11px] font-bold text-slate-700">{value}</span>
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
  const [busyTask, setBusyTask] = useState<string | null>(null)
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
    return "Today's plan"
  }, [offDay])

  if (loading) {
    return (
      <div className="insight-card flex items-center gap-2.5 px-3 py-2.5">
        <span className="insight-icon h-8 w-8 bg-violet-50 text-violet-500">
          <ListChecksIcon className="h-4 w-4" />
        </span>
        <p className="insight-title">Working out today&apos;s plan…</p>
      </div>
    )
  }

  const mainColumn: ReactNode = (
    <div className="min-w-0 space-y-2">
      {plan && plan.entries.length === 0 && (
        <p className="insight-hint rounded-xl bg-slate-50 px-3 py-3 text-center">
          Nothing to plan for today yet.
        </p>
      )}

      {plan && plan.entries.length > 0 && (
        <ul className="space-y-1.5">
          {plan.entries.map((entry) => {
            const prediction = entry.prediction
            const duration = prediction.expectedDuration === null ? null : `${prediction.expectedDuration} min`
            return (
              <li
                key={entry.taskId}
                className="rounded-xl border border-slate-100 bg-white/80 px-2.5 py-2 transition hover:border-indigo-100"
              >
                <div className="flex items-baseline justify-between gap-2">
                  <p className="min-w-0 truncate text-xs font-semibold text-slate-800">
                    {entry.text}
                  </p>
                  <span
                    className={`shrink-0 text-[9px] font-bold uppercase tracking-wide ${
                      CONFIDENCE_STYLE[prediction.confidence] ?? CONFIDENCE_STYLE.low
                    }`}
                  >
                    {prediction.confidence}
                  </span>
                </div>
                <div className="mt-1 flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
                  <Metric
                    label="Will finish"
                    value={percent(prediction.completionProbability)}
                    hint="Chance you'll get this done at all today, based on your own past completion history. Just a suggestion — not a promise."
                  />
                  {prediction.targetProbability !== null && (
                    <Metric
                      label="Full time goal"
                      value={percent(prediction.targetProbability)}
                      hint="Chance you'll log every minute of this task's time target today. Lower when the time left looks tight."
                    />
                  )}
                  {duration && (
                    <Metric
                      label="Est. time"
                      value={duration}
                      hint="Roughly how long this task usually takes, from your past sessions."
                    />
                  )}
                  {prediction.exploratory && (
                    <span className="text-[10px] font-semibold text-amber-600">New time</span>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}

      {plan && plan.suggestions.length > 0 && (
        <div className="space-y-1.5">
          <p className="insight-section-title flex items-center gap-1.5 px-0.5">
            <SparklesIcon className="h-3 w-3" />
            Worth a look
          </p>
          {plan.suggestions.map((suggestion) => (
            <div
              key={`${suggestion.kind}:${suggestion.taskId}`}
              className="rounded-xl border border-amber-100 bg-amber-50/60 p-2.5"
            >
              <p className="text-[11px] leading-snug text-amber-900">{suggestion.message}</p>
              <div className="mt-1.5 flex items-center gap-1.5">
                <button
                  type="button"
                  disabled={busyTask === suggestion.taskId}
                  onClick={() => void answerSuggestion(suggestion.taskId, suggestion.kind, 'accepted')}
                  className="rounded-lg bg-indigo-600 px-2 py-0.5 text-[10px] font-semibold text-white transition hover:bg-indigo-500 disabled:opacity-50"
                >
                  {suggestion.kind === 'drop' ? 'Drop it' : 'Move it'}
                </button>
                <button
                  type="button"
                  disabled={busyTask === suggestion.taskId}
                  onClick={() => void answerSuggestion(suggestion.taskId, suggestion.kind, 'dismissed')}
                  className="rounded-lg px-2 py-0.5 text-[10px] font-semibold text-slate-500 transition hover:bg-white disabled:opacity-50"
                >
                  Keep it
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

    </div>
  )

  return (
    <section className="insight-card" aria-label="Today's plan">
      <div className="flex items-center gap-2.5 border-b border-slate-100 px-3 py-2.5">
        <span className="insight-icon h-8 w-8 bg-violet-50 text-violet-500">
          <ListChecksIcon className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="insight-title">{headline}</h2>
          {plan && !offDay && <p className="truncate text-[10px] text-slate-400">{plan.note}</p>}
        </div>
        {!gate && !offDay && plan && plan.entries.length > 0 && (
          <span className="shrink-0 text-[10px] font-semibold text-violet-600">
            {plan.entries.length} tasks
          </span>
        )}
      </div>

      {offDay && (
        <div className="p-2.5">
          <p className="rounded-xl border border-slate-100 bg-white/70 px-2.5 py-2 text-[11px] leading-snug text-slate-600">
            No predictions are shown on an off day. You can still check in if you like.
          </p>
        </div>
      )}

      {gate && !offDay && (
        <div className="p-2.5">
          <div className="rounded-xl border border-indigo-100 bg-indigo-50/60 px-2.5 py-2">
            <p className="text-[11px] leading-snug text-indigo-900">
              Answer today&apos;s check-in to see what you&apos;re likely to get done, and when.
            </p>
            {onOpenCheckin && (
              <button type="button" onClick={onOpenCheckin} className="insight-primary mt-2">
                <SparklesIcon className="h-3 w-3" />
                Check in
              </button>
            )}
          </div>
        </div>
      )}

      {!gate && !offDay && <div className="p-2.5">{mainColumn}</div>}
    </section>
  )
}
