import { useCallback, useState } from 'react'
import type { DailyState, DayReviewAnswer, ToastTone } from '@/types'
import { labelForKey } from '@/lib/checkin'
import { api, errorMessage } from '@/api'
import { GaugeIcon, SparklesIcon } from './Icons'

/**
 * The daily state summary (Phase 2a) — a read-only card.
 *
 * It describes today in plain words from the answered fields, compares the
 * readiness score with the user's own recent baseline, and offers clearly
 * labelled, display-only estimates for anything skipped. It never changes what
 * the user reported and never presents a score as a judgement of worth.
 *
 * The user can hide the summary and the estimates at any time.
 */
interface DailyStateCardProps {
  state: DailyState
  notify: (message: string, tone?: ToastTone) => void
  onState: (next: DailyState) => void
}

const REVIEW_LABELS: Record<DayReviewAnswer, string> = {
  much_better: 'Much better',
  better: 'Better',
  about_same: 'About the same',
  worse: 'Worse',
  much_worse: 'Much worse',
}

const REVIEW_ORDER: DayReviewAnswer[] = ['much_better', 'better', 'about_same', 'worse', 'much_worse']

const SUB_SCORE_LABELS: Record<string, string> = {
  physical: 'Physical',
  mental: 'Mood & focus',
  capacity: 'Capacity',
}

function scoreTone(score: number): string {
  if (score >= 70) return 'text-emerald-600 dark:text-emerald-400'
  if (score >= 45) return 'text-amber-600 dark:text-amber-400'
  return 'text-rose-600 dark:text-rose-400'
}

export default function DailyStateCard({ state, notify, onState }: DailyStateCardProps) {
  const [showPrefs, setShowPrefs] = useState(false)
  const [reviewDismissed, setReviewDismissed] = useState(false)
  const [changingReview, setChangingReview] = useState(false)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const next = await api.getState(state.date, state.today)
      onState(next)
    } catch (error) {
      notify(errorMessage(error), 'error')
    }
  }, [notify, onState, state.date, state.today])

  const setPref = useCallback(
    async (patch: { showSummary?: boolean; showEstimates?: boolean }) => {
      setBusy(true)
      try {
        await api.saveStatePrefs(patch)
        await refresh()
      } catch (error) {
        notify(errorMessage(error), 'error')
      } finally {
        setBusy(false)
      }
    },
    [notify, refresh],
  )

  const answerReview = useCallback(
    async (answer: DayReviewAnswer) => {
      setBusy(true)
      try {
        await api.saveDayReview(state.date, answer)
        setChangingReview(false)
        await refresh()
      } catch (error) {
        notify(errorMessage(error), 'error')
      } finally {
        setBusy(false)
      }
    },
    [notify, refresh, state.date],
  )

  const chooseSuggestion = useCallback(
    async (key: string, choice: 'accepted' | 'dismissed') => {
      setBusy(true)
      try {
        await api.saveSuggestionChoice(state.date, key, choice)
        await refresh()
      } catch (error) {
        notify(errorMessage(error), 'error')
      } finally {
        setBusy(false)
      }
    },
    [notify, refresh, state.date],
  )

  const { prefs, summary, estimates, similarDays, recentContext, association, review, advanced } = state
  const readiness = summary.readiness
  const isToday = state.date === state.today
  const isEvening = new Date().getHours() >= 17
  const showReviewPrompt = isToday && !review && isEvening && !reviewDismissed

  return (
    <section className="card overflow-hidden" aria-label="Today at a glance">
      <div className="flex items-center gap-2.5 border-b border-slate-100 px-4 py-3 dark:border-slate-800">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-indigo-50 text-indigo-500 dark:bg-indigo-500/10 dark:text-indigo-400">
          <GaugeIcon className="h-4.5 w-4.5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-bold tracking-tight">Today at a glance</p>
          <p className="truncate text-[11px] text-slate-400 dark:text-slate-500">
            From your check-in. Nothing here changes what you reported.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowPrefs((open) => !open)}
          aria-expanded={showPrefs}
          className="icon-btn"
          title="Show or hide the summary and estimates"
          aria-label="Summary and estimate settings"
        >
          <SparklesIcon className="h-4 w-4" />
        </button>
      </div>

      {showPrefs && (
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 bg-slate-50/60 px-4 py-2.5 text-xs dark:border-slate-800 dark:bg-slate-800/40">
          <span className="text-slate-500 dark:text-slate-400">Show:</span>
          <button
            type="button"
            onClick={() => setPref({ showSummary: !prefs.showSummary })}
            disabled={busy}
            aria-pressed={prefs.showSummary}
            className={`rounded-lg px-2.5 py-1 font-medium transition ${
              prefs.showSummary
                ? 'bg-indigo-600 text-white'
                : 'bg-white text-slate-600 ring-1 ring-slate-200 dark:bg-slate-900 dark:text-slate-300 dark:ring-slate-700'
            }`}
          >
            Summary
          </button>
          <button
            type="button"
            onClick={() => setPref({ showEstimates: !prefs.showEstimates })}
            disabled={busy}
            aria-pressed={prefs.showEstimates}
            className={`rounded-lg px-2.5 py-1 font-medium transition ${
              prefs.showEstimates
                ? 'bg-indigo-600 text-white'
                : 'bg-white text-slate-600 ring-1 ring-slate-200 dark:bg-slate-900 dark:text-slate-300 dark:ring-slate-700'
            }`}
          >
            Estimates
          </button>
        </div>
      )}

      <div className="space-y-4 px-4 py-4">
        {!prefs.showSummary ? (
          <p className="text-xs text-slate-400 dark:text-slate-500">
            The summary is hidden. Turn it back on from the settings above.
          </p>
        ) : readiness.state === 'none' ? (
          <p className="text-sm text-slate-500 dark:text-slate-400">{readiness.line}</p>
        ) : (
          <div>
            <div className="flex items-end gap-3">
              <div className="flex items-baseline gap-1">
                <span className={`text-3xl font-bold tabular-nums ${scoreTone(readiness.score ?? 0)}`}>
                  {readiness.score}
                </span>
                <span className="text-xs font-medium text-slate-400">/100</span>
              </div>
              <div className="min-w-0 flex-1 pb-0.5">
                <p className="text-[11px] text-slate-400 dark:text-slate-500">
                  Based on {readiness.answered} of {readiness.total} answers
                  {readiness.state === 'partial' && ' · partial'}
                </p>
              </div>
            </div>

            <p className="mt-2 text-sm text-slate-700 dark:text-slate-200">{readiness.line}</p>
            {summary.baseline.line && (
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{summary.baseline.line}</p>
            )}

            <div className="mt-3 grid gap-2 sm:grid-cols-3">
              {readiness.subScores.map((sub) => (
                <div key={sub.name} className="rounded-xl bg-slate-50 px-3 py-2 dark:bg-slate-800/50">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-semibold text-slate-500 dark:text-slate-400">
                      {SUB_SCORE_LABELS[sub.name]}
                    </span>
                    <span className="text-[11px] tabular-nums text-slate-400">
                      {sub.score === null ? '—' : sub.score}
                    </span>
                  </div>
                  <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700">
                    <div
                      className="h-full rounded-full bg-indigo-500 transition-all"
                      style={{ width: `${sub.score ?? 0}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {prefs.showEstimates && (
          <div className="rounded-xl border border-slate-100 px-3 py-2.5 dark:border-slate-800">
            <p className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-500 dark:text-slate-400">
              <SparklesIcon className="h-3.5 w-3.5" />
              Estimates for what you skipped
            </p>
            {estimates.shown && estimates.estimates.length > 0 ? (
              <>
                <ul className="mt-2 space-y-1.5">
                  {estimates.estimates.map((estimate) => (
                    <li key={estimate.key} className="flex items-baseline justify-between gap-2 text-xs">
                      <span className="text-slate-600 dark:text-slate-300">{labelForKey(estimate.key)}</span>
                      <span className="text-right text-slate-500 dark:text-slate-400">
                        about {estimate.value}
                        <span className="text-slate-400 dark:text-slate-500">
                          {' '}
                          (likely {estimate.range[0]}–{estimate.range[1]})
                        </span>
                        <span className="block text-[10px] text-slate-400 dark:text-slate-500">
                          {estimate.basis}
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
                <p className="mt-2 text-[10px] leading-snug text-slate-400 dark:text-slate-500">
                  Estimates are a guess from your own past check-ins. They are never saved as your answers
                  and are not used as if you had reported them.
                </p>
              </>
            ) : (
              <p className="mt-1.5 text-xs text-slate-400 dark:text-slate-500">
                {estimates.reason ?? 'Nothing needs estimating today.'}
              </p>
            )}
            {estimates.evaluationNote && estimates.shown && (
              <p className="mt-1.5 text-[10px] leading-snug text-slate-400 dark:text-slate-500">
                {estimates.evaluationNote}
              </p>
            )}
          </div>
        )}

        {recentContext.lines.length > 0 && (
          <div className="rounded-xl bg-amber-50/70 px-3 py-2.5 dark:bg-amber-500/5">
            <p className="text-[11px] font-semibold text-amber-700 dark:text-amber-300">Recent pattern</p>
            <ul className="mt-1 space-y-1">
              {recentContext.lines.map((line) => (
                <li key={line} className="text-xs text-amber-800 dark:text-amber-200/90">
                  {line}
                </li>
              ))}
            </ul>
            <p className="mt-1 text-[10px] text-amber-700/70 dark:text-amber-300/60">
              This is a pattern in what you reported, not a cause.
            </p>
          </div>
        )}

        {similarDays.available && similarDays.line && (
          <div className="rounded-xl bg-slate-50 px-3 py-2.5 dark:bg-slate-800/50">
            <p className="text-[11px] font-semibold text-slate-500 dark:text-slate-400">Days like today</p>
            <p className="mt-1 text-xs text-slate-600 dark:text-slate-300">{similarDays.line}</p>
            <p className="mt-1 text-[10px] text-slate-400 dark:text-slate-500">
              Based on {similarDays.dayCount} similar days. This is what happened before, not a promise.
            </p>
          </div>
        )}

        {advanced.lowCapacity.enabled && advanced.lowCapacity.suggestions.length > 0 && (
          <div className="rounded-xl border border-indigo-100 bg-indigo-50/60 px-3 py-2.5 dark:border-indigo-500/20 dark:bg-indigo-500/5">
            <p className="text-[11px] font-semibold text-indigo-700 dark:text-indigo-300">
              A lighter plan for a low-capacity day
            </p>
            <ul className="mt-2 space-y-2">
              {advanced.lowCapacity.suggestions.map((suggestion) => {
                const choice = advanced.lowCapacity.choices.find((item) => item.key === suggestion.key)
                return (
                  <li key={suggestion.key} className="flex flex-wrap items-center gap-2">
                    <span className="min-w-0 flex-1 text-xs text-indigo-900 dark:text-indigo-100">
                      {suggestion.label}
                    </span>
                    {choice ? (
                      <span className="text-[10px] font-medium text-indigo-600 dark:text-indigo-300">
                        {choice.choice === 'accepted' ? 'You picked this up' : 'Set aside'}
                      </span>
                    ) : (
                      <span className="flex gap-1.5">
                        <button
                          type="button"
                          onClick={() => chooseSuggestion(suggestion.key, 'accepted')}
                          disabled={busy}
                          className="rounded-lg bg-indigo-600 px-2.5 py-1 text-[11px] font-semibold text-white transition hover:bg-indigo-500"
                        >
                          Offer it to me
                        </button>
                        <button
                          type="button"
                          onClick={() => chooseSuggestion(suggestion.key, 'dismissed')}
                          disabled={busy}
                          className="rounded-lg px-2.5 py-1 text-[11px] font-medium text-indigo-700 transition hover:bg-white/70 dark:text-indigo-200 dark:hover:bg-slate-800"
                        >
                          Not today
                        </button>
                      </span>
                    )}
                  </li>
                )
              })}
            </ul>
            <p className="mt-1.5 text-[10px] text-indigo-700/70 dark:text-indigo-300/60">
              Only offered — nothing is changed or dropped for you.
            </p>
          </div>
        )}

        {(showReviewPrompt || review) && (
          <div className="rounded-xl border border-slate-100 px-3 py-2.5 dark:border-slate-800">
            {review && !changingReview ? (
              <p className="text-xs text-slate-500 dark:text-slate-400">
                This evening you said the day was{' '}
                <span className="font-semibold text-slate-700 dark:text-slate-200">
                  {REVIEW_LABELS[review.answer].toLowerCase()}
                </span>{' '}
                than this morning.{' '}
                <button
                  type="button"
                  onClick={() => setChangingReview(true)}
                  className="font-medium text-indigo-600 underline-offset-2 hover:underline dark:text-indigo-300"
                >
                  Change
                </button>
              </p>
            ) : (
              <>
                <p className="text-xs font-medium text-slate-600 dark:text-slate-300">
                  How did today go compared with how you felt this morning?
                </p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {REVIEW_ORDER.map((answer) => (
                    <button
                      key={answer}
                      type="button"
                      onClick={() => answerReview(answer)}
                      disabled={busy}
                      className="rounded-lg px-2.5 py-1 text-[11px] font-medium text-slate-600 ring-1 ring-slate-200 transition hover:bg-slate-100 dark:text-slate-300 dark:ring-slate-700 dark:hover:bg-slate-800"
                    >
                      {REVIEW_LABELS[answer]}
                    </button>
                  ))}
                </div>
                {showReviewPrompt && (
                  <button
                    type="button"
                    onClick={() => setReviewDismissed(true)}
                    className="mt-1.5 text-[10px] text-slate-400 hover:text-slate-600 dark:hover:text-slate-300"
                  >
                    Not now
                  </button>
                )}
              </>
            )}
          </div>
        )}

        {association.note && (
          <p className="text-[10px] leading-snug text-slate-400 dark:text-slate-500">{association.note}</p>
        )}
      </div>
    </section>
  )
}
