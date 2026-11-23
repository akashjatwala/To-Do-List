import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { api, errorMessage } from '@/api'
import type { PredictionPlan, TaskPrediction, ToastTone } from '@/types'
import { ListChecksIcon, SparklesIcon } from './Icons'

/**
 * Today's plan and predictions.
 *
 * The server produces and logs every prediction; this card only displays them
 * and records what the user did with them. The rules it keeps on screen:
 * - Today's tasks get a prediction straight away. An unanswered check-in is
 *   just one missing input, not a barrier.
 * - An off day shows "off day" and no predictions at all.
 * - Everything is a suggestion: nothing here writes an outcome.
 */

interface PredictionPanelProps {
  /** The selected local date (`YYYY-MM-DD`). */
  date: string
  /** The user's current local date. */
  today: string
  notify: (message: string, tone?: ToastTone) => void
  /** Changes when the check-in or a task changed, so the plan reloads. */
  refreshKey?: unknown
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`
}

/** Guard against an older plan request finishing after a newer one. */
export function isCurrentPlanLoad(generation: number, current: number): boolean {
  return generation === current
}

/** Ideal window from recorded start times, only when there is timing history. */
export function idealTime(prediction: TaskPrediction): string | null {
  const sessions = Number(prediction.inputs.timingSessions ?? 0)
  if (sessions <= 0 || prediction.recommendedStart === null || prediction.recommendedEnd === null) {
    return null
  }
  const format = (value: number) =>
    new Date(value).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  return `${format(prediction.recommendedStart)}–${format(prediction.recommendedEnd)}`
}

export default function PredictionPanel({
  date,
  today,
  notify,
  refreshKey,
}: PredictionPanelProps) {
  const [loading, setLoading] = useState(true)
  const [offDay, setOffDay] = useState(false)
  const [plan, setPlan] = useState<PredictionPlan | null>(null)
  const [busyTask, setBusyTask] = useState<string | null>(null)
  const shownLoggedFor = useRef<string | null>(null)
  const planGeneration = useRef(0)

  const load = useCallback(async () => {
    const generation = ++planGeneration.current
    setLoading(true)
    try {
      const result = await api.getPlan(date, today)
      if (!isCurrentPlanLoad(generation, planGeneration.current)) return
      setOffDay(result.offDay)
      setPlan(result.plan)
    } catch (error) {
      if (!isCurrentPlanLoad(generation, planGeneration.current)) return
      notify(errorMessage(error), 'error')
    } finally {
      if (isCurrentPlanLoad(generation, planGeneration.current)) setLoading(false)
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

  if (loading) {
    return (
      <div className="flex items-center gap-2.5 rounded-[24px] bg-[#E7E1F5] px-5 py-4">
        <span className="insight-icon h-8 w-8 bg-white/70 text-[#4A2C8A]">
          <ListChecksIcon className="h-4 w-4" />
        </span>
        <p className="insight-title">Working out today&apos;s plan…</p>
      </div>
    )
  }

  const mainColumn: ReactNode = (
    <div className="min-w-0 space-y-2">
      {plan && plan.entries.length === 0 && (
        <p className="rounded-2xl bg-white/70 px-3 py-3 text-center text-xs text-[#454B58]">
          Nothing to nudge you about today yet.
        </p>
      )}

      {plan && plan.entries.length > 0 && (
        <ul className="space-y-1.5">
          {plan.entries.map((entry) => {
            const ideal = idealTime(entry.prediction)
            return (
              <li
                key={entry.taskId}
                className="rounded-2xl bg-white/70 px-3 py-2.5 shadow-sm"
              >
                <div className="flex items-center justify-between gap-2">
                  <p className="min-w-0 truncate text-sm font-bold text-[#15181E]">
                    {entry.text}
                  </p>
                  <span className="shrink-0 text-lg leading-none font-extrabold text-[#4A2C8A]">
                    {percent(entry.prediction.completionProbability)}
                  </span>
                </div>
                <div className="mt-2 h-2 overflow-hidden rounded-full bg-white/70">
                  <div
                    className="h-full rounded-full bg-[#4A2C8A] transition-[width]"
                    style={{ width: percent(entry.prediction.completionProbability) }}
                  />
                </div>
                {ideal && (
                  <p className="mt-1.5 text-[10px] leading-snug text-[#454B58]">
                    <span className="font-bold">Ideal time:</span> {ideal}
                    <span className="block text-[#6C717A]">
                      From recorded start times for this task or similar tasks.
                    </span>
                  </p>
                )}
              </li>
            )
          })}
        </ul>
      )}

      {plan && plan.suggestions.length > 0 && (
        <div className="space-y-1.5">
          <p className="flex items-center gap-1.5 px-0.5 text-[10px] font-bold tracking-[0.14em] text-[#4A2C8A]">
            <SparklesIcon className="h-3 w-3" />
            Worth a look
          </p>
          {plan.suggestions.map((suggestion) => (
            <div
              key={`${suggestion.kind}:${suggestion.taskId}`}
              className="rounded-2xl bg-white/70 p-2.5 shadow-sm"
            >
              <p className="text-[11px] leading-snug text-[#454B58]">{suggestion.message}</p>
              <div className="mt-1.5 flex items-center gap-1.5">
                <button
                  type="button"
                  disabled={busyTask === suggestion.taskId}
                  onClick={() => void answerSuggestion(suggestion.taskId, suggestion.kind, 'accepted')}
                  className="rounded-lg bg-[#4A2C8A] px-2 py-0.5 text-[10px] font-semibold text-white transition hover:bg-[#5C3BA6] disabled:opacity-50"
                >
                  {suggestion.kind === 'drop' ? 'Drop it' : 'Move it'}
                </button>
                <button
                  type="button"
                  disabled={busyTask === suggestion.taskId}
                  onClick={() => void answerSuggestion(suggestion.taskId, suggestion.kind, 'dismissed')}
                  className="rounded-lg px-2 py-0.5 text-[10px] font-semibold text-[#454B58] transition hover:bg-white disabled:opacity-50"
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
    <section className="overflow-hidden rounded-[24px] bg-[#E7E1F5] p-5" aria-label="Today's plan">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-extrabold tracking-tight text-[#15181E]">Nudge</h2>
          <p className="mt-1 text-xs font-bold text-[#454B58]">Chance of finishing today</p>
        </div>
        <div className="group relative shrink-0">
          <button
            type="button"
            aria-label="About this prediction"
            aria-describedby="nudge-prediction-help"
            className="mt-0.5 rounded-full p-0.5 text-[#7C5BC4] transition hover:bg-white/70 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#7C5BC4]"
          >
            <SparklesIcon className="h-5 w-5" />
          </button>
          <div
            id="nudge-prediction-help"
            role="tooltip"
            className="pointer-events-none absolute top-full right-0 z-30 mt-2 w-64 rounded-xl bg-[#2E2446] px-3 py-2 text-[11px] leading-relaxed text-white opacity-0 shadow-lg transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
          >
            The chance of finishing today is an estimate based on your previously recorded
            activity and check-ins. It&apos;s a nudge, not a guarantee.
          </div>
        </div>
      </div>

      {offDay && (
        <p className="rounded-2xl bg-white/70 px-4 py-3 text-xs leading-relaxed text-[#454B58]">
          No predictions are shown on an off day. You can still check in if you like.
        </p>
      )}

      {!offDay && <div>{mainColumn}</div>}
    </section>
  )
}
