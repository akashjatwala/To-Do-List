import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
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

function percent(value: number): string {
  return `${Math.round(value * 100)}%`
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
          {plan.entries.map((entry) => (
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
            </li>
          ))}
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
      <div className="mb-3">
        <h2 className="text-xl font-extrabold tracking-tight text-[#15181E]">Nudge</h2>
        <p className="mt-1 text-xs font-bold text-[#454B58]">Chance of finishing today</p>
      </div>

      {offDay && (
        <p className="rounded-2xl bg-white/70 px-4 py-3 text-xs leading-relaxed text-[#454B58]">
          No predictions are shown on an off day. You can still check in if you like.
        </p>
      )}

      {gate && !offDay && (
        <div className="rounded-2xl bg-white/70 p-4">
          <p className="text-xs leading-relaxed text-[#454B58]">
            Answer today&apos;s check-in to see what you&apos;re likely to get done, and when.
          </p>
          {onOpenCheckin && (
            <button
              type="button"
              onClick={onOpenCheckin}
              className="mt-3 inline-flex items-center justify-center gap-1.5 rounded-xl bg-[#4A2C8A] px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-[#5C3BA6] focus-visible:ring-4 focus-visible:ring-[#4A2C8A]/20 focus-visible:outline-none"
            >
              <SparklesIcon className="h-3 w-3" />
              Check in
            </button>
          )}
        </div>
      )}

      {!gate && !offDay && <div>{mainColumn}</div>}
    </section>
  )
}
