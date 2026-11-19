import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import type { Checkin, CheckinStatus, ToastTone } from '@/types'
import {
  CHECKIN_QUESTIONS,
  answeredCount,
  clampStep,
  firstUnansweredIndex,
  greetingForHour,
  type CheckinAnswerKey,
  type CheckinAnswerValues,
} from '@/lib/checkin'
import { api, errorMessage } from '@/api'
import { useReducedMotion } from '@/lib/useReducedMotion'
import { ArrowRightIcon, CheckIcon, ChevronRightIcon, XIcon } from './Icons'
import { Spinner } from './ui'

/**
 * The daily check-in wizard.
 *
 * It uses the same questions, the same 1–5 scale and the same check-in API as
 * before; only how it looks and flows has changed. One question per screen, a
 * large header emoji, emoji-labelled options, tap-to-answer with a brief
 * highlight and automatic advance, a progress indicator, Back, and always
 * available "Skip question" / "Skip check-in".
 *
 * Nothing is pre-selected. Leaving midway saves what was answered and the next
 * open resumes at the first unanswered question. Data is never invented: a
 * skipped question is stored as missing, never as a neutral value.
 */
interface CheckinModalProps {
  mode: 'prompt' | 'edit'
  date: string
  initial: Checkin | null
  onClose: () => void
  onChanged: (status: CheckinStatus) => void
  /**
   * Called once, only when the person finishes the check-in (not when they
   * skip it or leave midway). Used to play the Energy Level celebration.
   */
  onFinished?: (status: CheckinStatus) => void
  notify: (message: string, tone?: ToastTone) => void
  /** Only used if the app already knows the user's name. */
  name?: string | null
}

const ADVANCE_MS = 250

/** Turn a stored answer map into the full nine-key shape the API expects. */
function toFullAnswers(answers: CheckinAnswerValues): Record<CheckinAnswerKey, number | null> {
  const full = {} as Record<CheckinAnswerKey, number | null>
  for (const question of CHECKIN_QUESTIONS) full[question.key] = answers[question.key] ?? null
  return full
}

/** Seed a partial answer map from a stored check-in. */
function fromCheckin(initial: Checkin | null): Partial<Record<CheckinAnswerKey, number>> {
  const next: Partial<Record<CheckinAnswerKey, number>> = {}
  if (!initial) return next
  for (const question of CHECKIN_QUESTIONS) {
    const value = initial.answers[question.key]
    if (value !== null) next[question.key] = value
  }
  return next
}

function sameAnswers(
  a: Partial<Record<CheckinAnswerKey, number>>,
  initial: Checkin | null,
): boolean {
  for (const question of CHECKIN_QUESTIONS) {
    const before = initial?.answers[question.key] ?? null
    const now = a[question.key] ?? null
    if (before !== now) return false
  }
  return true
}

export default function CheckinModal({
  mode,
  date,
  initial,
  onClose,
  onChanged,
  onFinished,
  notify,
  name = null,
}: CheckinModalProps) {
  const reducedMotion = useReducedMotion()
  const total = CHECKIN_QUESTIONS.length

  const [answers, setAnswers] = useState<Partial<Record<CheckinAnswerKey, number>>>(() => fromCheckin(initial))
  const [context, setContext] = useState(() => initial?.context ?? '')
  const [step, setStep] = useState(() =>
    clampStep(mode === 'prompt' ? firstUnansweredIndex(fromCheckin(initial)) : 0, total),
  )
  const [justPicked, setJustPicked] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)

  const timer = useRef<number | null>(null)
  const seededFor = useRef<number | null>(initial?.id ?? null)

  // Re-seed only when a genuinely different day's record arrives.
  useEffect(() => {
    const id = initial?.id ?? null
    if (seededFor.current === id) return
    seededFor.current = id
    setAnswers(fromCheckin(initial))
    setContext(initial?.context ?? '')
    setStep(clampStep(mode === 'prompt' ? firstUnansweredIndex(fromCheckin(initial)) : 0, total))
  }, [initial, mode, total])

  const clearTimer = useCallback(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current)
      timer.current = null
    }
  }, [])

  useEffect(() => clearTimer, [clearTimer])

  const advance = useCallback(() => {
    clearTimer()
    setJustPicked(null)
    setStep((current) => clampStep(current + 1, total))
  }, [clearTimer, total])

  const goBack = useCallback(() => {
    clearTimer()
    setJustPicked(null)
    setStep((current) => clampStep(current - 1, total))
  }, [clearTimer, total])

  const haptic = useCallback(() => {
    const vibrate = navigator.vibrate?.bind(navigator)
    if (!vibrate) return
    try {
      vibrate(8)
    } catch {
      /* haptics are a nice-to-have; never let them break the flow */
    }
  }, [])

  const pick = useCallback(
    (key: CheckinAnswerKey, value: number) => {
      clearTimer()
      setAnswers((current) => ({ ...current, [key]: value }))
      setJustPicked(value)
      haptic()
      if (reducedMotion) advance()
      else timer.current = window.setTimeout(advance, ADVANCE_MS)
    },
    [advance, clearTimer, haptic, reducedMotion],
  )

  const skipQuestion = useCallback(() => {
    clearTimer()
    const question = CHECKIN_QUESTIONS[step]
    if (question) {
      setAnswers((current) => {
        const next = { ...current }
        delete next[question.key]
        return next
      })
    }
    advance()
  }, [advance, clearTimer, step])

  const save = useCallback(
    async (options: { notifyOnDone: boolean }) => {
      const status = await api.saveCheckin({ date, answers: toFullAnswers(answers), context: context.trim() || null })
      onChanged(status)
      if (options.notifyOnDone) {
        notify(
          status.state === 'completed' ? 'Check-in saved.' : 'Saved what you shared so far.',
          'success',
        )
      }
      return status
    },
    [answers, context, date, notify, onChanged],
  )

  const finish = useCallback(async () => {
    if (busy) return
    clearTimer()
    setBusy(true)
    try {
      const status = await save({ notifyOnDone: true })
      // Only a finished check-in celebrates; skipping and leaving do not.
      onFinished?.(status)
      onClose()
    } catch (error) {
      notify(errorMessage(error), 'error')
    } finally {
      setBusy(false)
    }
  }, [busy, clearTimer, notify, onClose, onFinished, save])

  /** Leave midway: persist what was answered so the next open can resume. */
  const dismiss = useCallback(() => {
    clearTimer()
    const anyAnswered = Object.values(answers).some((value) => value !== null && value !== undefined)
    const changed = !sameAnswers(answers, initial)
    if ((anyAnswered || initial !== null) && changed) {
      void api
        .saveCheckin({ date, answers: toFullAnswers(answers), context: context.trim() || null })
        .then((status) => onChanged(status))
        .catch(() => {
          /* the answers stay on screen next time; a failed save is not fatal */
        })
    }
    onClose()
  }, [answers, clearTimer, context, date, initial, onChanged, onClose])

  // Escape closes (persisting partial progress through the dismiss handler) and
  // the page behind the wizard is locked from scrolling while it is open.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') dismiss()
    }
    window.addEventListener('keydown', onKey)
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = previous
    }
  }, [dismiss])

  const skipAll = useCallback(async () => {
    if (busy) return
    clearTimer()
    setBusy(true)
    try {
      const status = await api.skipCheckin(date)
      onChanged(status)
      notify('Check-in skipped for today.', 'info')
      onClose()
    } catch (error) {
      notify(errorMessage(error), 'error')
    } finally {
      setBusy(false)
    }
  }, [busy, clearTimer, date, notify, onChanged, onClose])

  const question = step < total ? CHECKIN_QUESTIONS[step] : null
  const isFinal = question === null
  const answered = answeredCount(answers)
  const greeting = greetingForHour(new Date().getHours())
  const firstQuestion = step === 0

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center p-0 sm:items-center sm:p-6">
      <div className="animate-fade absolute inset-0 bg-slate-950/50 backdrop-blur-sm" onClick={dismiss} />

      <div
        role="dialog"
        aria-modal="true"
        aria-label={mode === 'prompt' ? 'Daily check-in' : 'Update your check-in'}
        className="animate-in relative flex max-h-[92dvh] w-full max-w-lg flex-col overflow-hidden rounded-t-3xl border border-slate-200 bg-white shadow-2xl sm:rounded-3xl"
      >
        {/* Header: greeting, progress and the always-available skip controls */}
        <div className="flex items-center justify-between gap-2 px-4 pt-3.5 pb-2 sm:px-5">
          <div className="min-w-0">
            <p className="truncate text-[11px] font-semibold tracking-wide text-slate-400 uppercase">
              {greeting}
              {name ? `, ${name}` : ''}
            </p>
            <p className="text-[11px] text-slate-400" aria-hidden="true">
              {isFinal ? 'All done' : `Question ${step + 1} of ${total}`}
            </p>
          </div>
          <button
            type="button"
            onClick={dismiss}
            className="icon-btn -mr-1"
            aria-label="Close check-in (your answers are saved)"
          >
            <XIcon className="h-5 w-5" />
          </button>
        </div>

        {/* Progress dots */}
        <div className="flex items-center gap-1 px-4 sm:px-5" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={Math.min(step, total)} aria-label="Check-in progress">
          {CHECKIN_QUESTIONS.map((item, index) => {
            const done = answers[item.key] !== null && answers[item.key] !== undefined
            const current = index === step
            return (
              <span
                key={item.key}
                className={`h-1.5 flex-1 rounded-full transition-colors ${
                  current
                    ? 'bg-slate-800'
                    : done
                      ? 'bg-indigo-400'
                      : 'bg-slate-200'
                }`}
              />
            )
          })}
        </div>

        <p className="sr-only" aria-live="polite">
          {isFinal ? 'All questions answered.' : `Question ${step + 1} of ${total}. ${question?.prompt ?? ''}`}
        </p>

        {question ? (
          <div
            key={question.key}
            className="checkin-surface animate-in flex min-h-0 flex-1 flex-col overflow-y-auto px-4 pt-4 pb-2 sm:px-6"
            style={{ '--accent': question.accent } as CSSProperties}
          >
            {firstQuestion && mode === 'prompt' && (
              <p className="mb-3 text-center text-xs text-slate-500">
                Nine quick taps to set the scene for today. Skip anything you would rather not answer.
              </p>
            )}

            <div className="text-center">
              <div className="checkin-choice-emoji text-5xl leading-none sm:text-6xl" aria-hidden="true">
                {question.emoji}
              </div>
              <h2 className="mx-auto mt-3 max-w-sm text-balance text-lg font-bold tracking-tight text-slate-800">
                {question.prompt}
              </h2>
            </div>

            <div
              role="radiogroup"
              aria-label={question.prompt}
              className="mt-5 grid grid-cols-1 gap-2 sm:grid-cols-5"
            >
              {question.options.map((label, index) => {
                const value = index + 1
                const selected = answers[question.key] === value
                const flash = justPicked === value
                return (
                  <button
                    key={label}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    data-selected={selected}
                    onClick={() => pick(question.key, value)}
                    className={`checkin-choice flex min-h-[3.25rem] items-center gap-3 rounded-2xl border px-3.5 py-2.5 text-left transition sm:flex-col sm:justify-center sm:gap-1.5 sm:px-2 sm:py-3 sm:text-center ${
                      selected
                        ? 'border-indigo-400 text-slate-900'
                        : 'border-slate-200 bg-white/70 text-slate-600 hover:border-slate-300 hover:bg-white'
                    } ${flash ? 'scale-[1.02]' : ''}`}
                  >
                    <span className="checkin-choice-emoji text-2xl leading-none sm:text-3xl" aria-hidden="true">
                      {question.optionEmojis[index]}
                    </span>
                    <span className="text-sm font-medium">{label}</span>
                    {selected && (
                      <span className="ml-auto inline-flex h-4 w-4 items-center justify-center rounded-full bg-indigo-600 text-white sm:ml-0" aria-hidden="true">
                        <CheckIcon className="h-3 w-3" strokeWidth={3} />
                      </span>
                    )}
                  </button>
                )
              })}
            </div>
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-6 py-10 text-center">
            <div className="text-5xl" aria-hidden="true">
              🌤️
            </div>
            <h2 className="mt-4 text-lg font-bold tracking-tight text-slate-800">
              That&apos;s everything for today
            </h2>
            <p className="mt-1.5 max-w-xs text-sm text-slate-500">
              Thanks for checking in. You can change any answer later from the smiley in the header.
            </p>
            <label className="mt-5 block w-full max-w-xs text-left">
              <span className="label">Anything else about today? (optional)</span>
              <textarea
                value={context}
                onChange={(event) => setContext(event.target.value)}
                rows={2}
                maxLength={500}
                placeholder="A short note, if you want to remember the context."
                className="field resize-none"
              />
            </label>
          </div>
        )}

        {/* Footer: Back on the left, skip controls on the right */}
        <div className="flex items-center justify-between gap-2 border-t border-slate-100 px-4 py-3 sm:px-5">
          <button
            type="button"
            onClick={goBack}
            disabled={step === 0 || busy}
            className="btn-ghost px-2.5! py-1.5! text-xs disabled:invisible"
          >
            <ChevronRightIcon className="h-3.5 w-3.5 rotate-180" />
            Back
          </button>

          <div className="flex items-center gap-1">
            {!isFinal && (
              <button
                type="button"
                onClick={skipQuestion}
                disabled={busy}
                className="rounded-lg px-2.5 py-1.5 text-[11px] font-medium text-slate-500 transition hover:bg-slate-100 hover:text-slate-700"
              >
                Skip question
              </button>
            )}
            <button
              type="button"
              onClick={skipAll}
              disabled={busy}
              className="rounded-lg px-2.5 py-1.5 text-[11px] font-medium text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
            >
              Skip check-in
            </button>
            {isFinal && (
              <button type="button" onClick={finish} disabled={busy} className="btn-primary ml-1 px-3! py-2! text-xs">
                {busy ? <Spinner className="h-3.5 w-3.5" /> : <ArrowRightIcon className="h-3.5 w-3.5" />}
                Continue
              </button>
            )}
          </div>
        </div>

        {answered > 0 && !isFinal && (
          <p className="pb-2 text-center text-[10px] text-slate-300">
            {answered}/{total} answered
          </p>
        )}
      </div>
    </div>
  )
}
