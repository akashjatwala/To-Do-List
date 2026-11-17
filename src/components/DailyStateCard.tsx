import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  Checkin,
  CheckinAnswers,
  CheckinState,
  DailyState,
  DayReviewAnswer,
  ToastTone,
} from '@/types'
import { labelForKey } from '@/lib/checkin'
import {
  bandGradientClass,
  bandRingClass,
  displaySubScores,
  scoreBand,
  subScoreBarClass,
  subScoreTextClass,
  type EnergySubScore,
} from '@/lib/energy'
import { useReducedMotion } from '@/lib/useReducedMotion'
import { api, errorMessage } from '@/api'
import EnergyDetailSheet from './EnergyDetailSheet'
import { SparklesIcon } from './Icons'

/**
 * The Energy Level card (Phase 1b) — presentation only.
 *
 * It shows the Phase 2a readiness score as a large number with a band emoji and
 * four display sub-scores, always visible (there is no show/hide control and no
 * stored preference for it). The overall score, the grouping behind it and the
 * API are unchanged: the four sub-scores are a display re-grouping of the same
 * answered fields, computed from what the person reported and never invented.
 *
 * The estimates for skipped answers, the recent-pattern lines and the
 * days-like-today section are intentionally not shown here, but their code is
 * left in place below (behind `SHOW_HIDDEN_SECTIONS`) so nothing is lost.
 *
 * The Update button opens the Phase 1a check-in prefilled; the evening review
 * and low-capacity suggestions continue to work exactly as before.
 */
interface DailyStateCardProps {
  state: DailyState
  /** Today's stored check-in, or null when there is none. */
  checkin: Checkin | null
  /** Whether the day has no record, was skipped, or was answered. */
  checkinState: CheckinState
  /** True once, right after the person finishes a check-in. */
  celebrate?: boolean
  /** Called after the celebration has played so it is not repeated. */
  onCelebrated?: () => void
  /** Opens the Phase 1a check-in wizard (prefilled with the current answers). */
  onEditCheckin: () => void
  notify: (message: string, tone?: ToastTone) => void
  onState: (next: DailyState) => void
}

/** These Phase 2a sections stay in the code but are not shown on this card. */
const SHOW_HIDDEN_SECTIONS = false

const CELEBRATED_PREFIX = 'todo.energy.celebrated.'

function hasCelebrated(date: string): boolean {
  try {
    return localStorage.getItem(CELEBRATED_PREFIX + date) === '1'
  } catch {
    return false
  }
}

function markCelebrated(date: string): void {
  try {
    localStorage.setItem(CELEBRATED_PREFIX + date, '1')
  } catch {
    /* a private-mode failure is not fatal; the day simply may re-play once */
  }
}

const REVIEW_LABELS: Record<DayReviewAnswer, string> = {
  much_better: 'Much better',
  better: 'Better',
  about_same: 'About the same',
  worse: 'Worse',
  much_worse: 'Much worse',
}

const REVIEW_ORDER: DayReviewAnswer[] = ['much_better', 'better', 'about_same', 'worse', 'much_worse']

const RING_RADIUS = 34
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS

export default function DailyStateCard({
  state,
  checkin,
  checkinState,
  celebrate = false,
  onCelebrated,
  onEditCheckin,
  notify,
  onState,
}: DailyStateCardProps) {
  const [reviewDismissed, setReviewDismissed] = useState(false)
  const [changingReview, setChangingReview] = useState(false)
  const [busy, setBusy] = useState(false)
  const [openSub, setOpenSub] = useState<EnergySubScore | null>(null)
  const [history, setHistory] = useState<Array<{ answers: CheckinAnswers }>>([])
  const historyLoaded = useRef(false)
  const reducedMotion = useReducedMotion()

  const { summary, estimates, similarDays, recentContext, association, review, advanced } = state
  const readiness = summary.readiness
  const score = readiness.score
  const band = scoreBand(score)
  const answers = checkin?.answers ?? {}
  const subScores = useMemo(() => displaySubScores(answers), [answers])

  const [displayScore, setDisplayScore] = useState<number>(() => score ?? 0)
  const [celebrating, setCelebrating] = useState(false)
  const celebratedRef = useRef(onCelebrated)
  celebratedRef.current = onCelebrated

  // Count the score up once, right after a finished check-in. Skips are not a
  // celebration, edits are not a celebration (the day is already marked), and
  // reduced motion turns it off entirely.
  useEffect(() => {
    if (score === null) {
      setDisplayScore(0)
      return
    }
    const wantsCelebration = celebrate && !reducedMotion && !hasCelebrated(state.date)
    if (!wantsCelebration) {
      setDisplayScore(score)
      if (celebrate) celebratedRef.current?.()
      return
    }
    markCelebrated(state.date)
    setCelebrating(true)
    setDisplayScore(0)
    const duration = 950
    const start = performance.now()
    let frame = 0
    const tick = (now: number) => {
      const progress = Math.min(1, (now - start) / duration)
      const eased = 1 - Math.pow(1 - progress, 3)
      setDisplayScore(Math.round(eased * score))
      if (progress < 1) {
        frame = requestAnimationFrame(tick)
      } else {
        setCelebrating(false)
        celebratedRef.current?.()
      }
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [score, celebrate, reducedMotion, state.date])

  const refresh = useCallback(async () => {
    try {
      const next = await api.getState(state.date, state.today)
      onState(next)
    } catch (error) {
      notify(errorMessage(error), 'error')
    }
  }, [notify, onState, state.date, state.today])

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

  const openDetail = useCallback(
    (sub: EnergySubScore) => {
      setOpenSub(sub)
      if (historyLoaded.current) return
      historyLoaded.current = true
      void api
        .getCheckinHistory(60)
        .then((result) =>
          setHistory(
            result.items
              .filter((item) => item.date !== state.date)
              .map((item) => ({ answers: item.answers })),
          ),
        )
        .catch(() => {
          /* with no history, the sheet simply shows the answers without a comparison */
        })
    },
    [state.date],
  )

  const isToday = state.date === state.today
  const isEvening = new Date().getHours() >= 17
  const showReviewPrompt = isToday && !review && isEvening && !reviewDismissed

  const dashOffset = RING_CIRCUMFERENCE * (1 - Math.max(0, Math.min(100, displayScore)) / 100)
  const noCheckin = checkinState === 'not_asked'
  const skipped = checkinState === 'skipped'
  const hasScore = readiness.state !== 'none' && score !== null

  return (
    <section
      className={`card overflow-hidden bg-gradient-to-br ${bandGradientClass(band.tone)}`}
      aria-label="Energy Level"
    >
      <div className="flex items-center gap-2.5 px-4 py-3">
        <span
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white/70 text-base dark:bg-slate-800/60"
          aria-hidden="true"
        >
          ⚡
        </span>
        <p className="min-w-0 flex-1 text-sm font-bold tracking-tight">Energy Level</p>
        {!noCheckin && (
          <button
            type="button"
            onClick={onEditCheckin}
            className="rounded-lg px-2.5 py-1 text-[11px] font-semibold text-slate-600 ring-1 ring-slate-200/80 transition hover:bg-white/70 dark:text-slate-300 dark:ring-slate-700 dark:hover:bg-slate-800"
          >
            Update
          </button>
        )}
      </div>

      <div className="space-y-4 px-4 pb-4">
        {noCheckin ? (
          <div className="flex flex-col items-center rounded-2xl bg-white/60 px-4 py-6 text-center dark:bg-slate-900/40">
            <span className="text-3xl" aria-hidden="true">
              🌤️
            </span>
            <p className="mt-2 text-sm font-semibold text-slate-700 dark:text-slate-200">
              No check-in yet today
            </p>
            <p className="mt-1 max-w-xs text-xs text-slate-500 dark:text-slate-400">
              A few quick taps set the scene for today. Nothing here changes what you report.
            </p>
            <button type="button" onClick={onEditCheckin} className="btn-primary mt-4 text-xs!">
              Take your check-in
            </button>
          </div>
        ) : skipped ? (
          <div className="flex flex-col items-center rounded-2xl bg-white/60 px-4 py-6 text-center dark:bg-slate-900/40">
            <span className="text-2xl" aria-hidden="true">
              🍃
            </span>
            <p className="mt-2 text-sm font-semibold text-slate-600 dark:text-slate-300">
              No check-in today
            </p>
            <p className="mt-1 max-w-xs text-xs text-slate-500 dark:text-slate-400">
              That is completely fine. You can add one any time.
            </p>
          </div>
        ) : !hasScore ? (
          <div className="rounded-2xl bg-white/60 px-4 py-5 text-center dark:bg-slate-900/40">
            <p className="text-sm text-slate-600 dark:text-slate-300">{readiness.line}</p>
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              A few more answers are needed before a score is shown.
            </p>
          </div>
        ) : (
          <div className="flex items-center gap-4">
            <div className="relative flex h-24 w-24 shrink-0 items-center justify-center">
              <svg viewBox="0 0 80 80" className="h-24 w-24 -rotate-90" aria-hidden="true">
                <circle
                  cx="40"
                  cy="40"
                  r={RING_RADIUS}
                  fill="none"
                  strokeWidth="8"
                  className="stroke-slate-200/80 dark:stroke-slate-700/60"
                />
                <circle
                  cx="40"
                  cy="40"
                  r={RING_RADIUS}
                  fill="none"
                  strokeWidth="8"
                  strokeLinecap="round"
                  stroke="currentColor"
                  strokeDasharray={RING_CIRCUMFERENCE}
                  strokeDashoffset={dashOffset}
                  className={`transition-[stroke-dashoffset] duration-700 ease-out ${bandRingClass(band.tone)}`}
                />
              </svg>
              <div className="absolute inset-0 flex flex-col items-center justify-center">
                <span className="text-2xl font-bold tabular-nums text-slate-900 dark:text-white">
                  {displayScore}
                </span>
                <span className="text-[10px] font-medium text-slate-400 dark:text-slate-500">
                  /100
                </span>
              </div>
              {celebrating && (
                <span className="energy-sparkles pointer-events-none absolute inset-0" aria-hidden="true">
                  <span className="energy-sparkle" style={{ top: '2%', left: '14%' }}>✦</span>
                  <span className="energy-sparkle" style={{ top: '12%', right: '6%' }}>✧</span>
                  <span className="energy-sparkle" style={{ bottom: '6%', left: '4%' }}>✧</span>
                  <span className="energy-sparkle" style={{ bottom: '2%', right: '16%' }}>✦</span>
                </span>
              )}
            </div>

            <div className="min-w-0 flex-1">
              <p className="flex items-center gap-1.5 text-base font-bold tracking-tight text-slate-800 dark:text-slate-100">
                <span className="text-lg" aria-hidden="true">
                  {band.emoji}
                </span>
                {band.label}
              </p>
              <p className="mt-0.5 text-sm text-slate-600 dark:text-slate-300">{readiness.line}</p>
              {summary.baseline.line && (
                <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                  {summary.baseline.line}
                </p>
              )}
            </div>
          </div>
        )}

        {hasScore && !noCheckin && !skipped && (
          <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
            {subScores.map((sub) => (
              <button
                key={sub.key}
                type="button"
                onClick={() => openDetail(sub)}
                disabled={sub.score === null}
                aria-label={`${sub.label}: ${
                  sub.score === null ? 'nothing answered yet' : `${sub.score} out of 100`
                }. Show what is behind it.`}
                className="rounded-2xl bg-white/70 px-3 py-2.5 text-left transition hover:bg-white disabled:cursor-default disabled:hover:bg-white/70 dark:bg-slate-900/50 dark:hover:bg-slate-900/80 dark:disabled:hover:bg-slate-900/50"
              >
                <div className="flex items-center justify-between gap-1">
                  <span className="flex items-center gap-1 text-[11px] font-semibold text-slate-500 dark:text-slate-400">
                    <span aria-hidden="true">{sub.emoji}</span>
                    {sub.label}
                  </span>
                  <span className={`text-sm font-bold tabular-nums ${subScoreTextClass(sub.score)}`}>
                    {sub.score ?? '—'}
                  </span>
                </div>
                <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700">
                  <div
                    className={`h-full rounded-full transition-all duration-700 ease-out ${subScoreBarClass(sub.score)}`}
                    style={{ width: `${sub.score ?? 0}%` }}
                  />
                </div>
              </button>
            ))}
          </div>
        )}

        {SHOW_HIDDEN_SECTIONS && estimates.shown && (
          <div className="rounded-xl border border-slate-100 px-3 py-2.5 dark:border-slate-800">
            <p className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-500 dark:text-slate-400">
              <SparklesIcon className="h-3.5 w-3.5" />
              Estimates for what you skipped
            </p>
            {estimates.estimates.length > 0 ? (
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
            ) : (
              <p className="mt-1.5 text-xs text-slate-400 dark:text-slate-500">
                {estimates.reason ?? 'Nothing needs estimating today.'}
              </p>
            )}
          </div>
        )}

        {SHOW_HIDDEN_SECTIONS && recentContext.lines.length > 0 && (
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

        {SHOW_HIDDEN_SECTIONS && similarDays.available && similarDays.line && (
          <div className="rounded-xl bg-slate-50 px-3 py-2.5 dark:bg-slate-800/50">
            <p className="text-[11px] font-semibold text-slate-500 dark:text-slate-400">Days like today</p>
            <p className="mt-1 text-xs text-slate-600 dark:text-slate-300">{similarDays.line}</p>
            <p className="mt-1 text-[10px] text-slate-400 dark:text-slate-500">
              Based on {similarDays.dayCount} similar days. This is what happened before, not a promise.
            </p>
          </div>
        )}

        {advanced.lowCapacity.enabled && advanced.lowCapacity.suggestions.length > 0 && (
          <div className="rounded-xl border border-indigo-100 bg-white/70 px-3 py-2.5 dark:border-indigo-500/20 dark:bg-indigo-500/5">
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
          <div className="rounded-xl border border-slate-100 bg-white/60 px-3 py-2.5 dark:border-slate-800 dark:bg-slate-900/40">
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
                      className="rounded-lg bg-white/70 px-2.5 py-1 text-[11px] font-medium text-slate-600 ring-1 ring-slate-200 transition hover:bg-white dark:text-slate-300 dark:ring-slate-700 dark:hover:bg-slate-800"
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

      {openSub && (
        <EnergyDetailSheet
          subScore={openSub}
          answers={answers}
          history={history}
          onClose={() => setOpenSub(null)}
        />
      )}
    </section>
  )
}
