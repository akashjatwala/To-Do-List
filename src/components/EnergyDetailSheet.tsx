import { useEffect, useRef } from 'react'
import type { CheckinAnswerValues } from '@/lib/checkin'
import type { EnergySubScore } from '@/lib/energy'
import {
  answerText,
  compareToUsual,
  fieldEmoji,
  fieldLabel,
  usualForField,
  usualPhrase,
} from '@/lib/energy'
import { XIcon } from './Icons'

interface EnergyDetailSheetProps {
  subScore: EnergySubScore
  answers: CheckinAnswerValues
  /** Past check-ins (today excluded) used only for the "your usual" note. */
  history: ReadonlyArray<{ answers: CheckinAnswerValues }>
  onClose: () => void
}

/**
 * What is behind one sub-score (Phase 1b).
 *
 * It lists only the fields the person actually answered, each with its emoji
 * and the answer they gave. Where there is enough history it adds a neutral
 * note about how that answer sits next to their own usual. It describes
 * associations, never causes, and reads only data that is already stored — no
 * new data is created or saved.
 *
 * Presentation only: a bottom sheet on mobile and a centred dialog on wider
 * screens, closing on a tap outside or Escape, with the close control focused
 * for keyboard and screen-reader users.
 */
export default function EnergyDetailSheet({
  subScore,
  answers,
  history,
  onClose,
}: EnergyDetailSheetProps) {
  const closeRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    closeRef.current?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const answered = subScore.fields.filter((key) => {
    const value = answers[key]
    return value !== null && value !== undefined
  })

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center p-0 sm:items-center sm:p-6">
      <div
        className="animate-fade absolute inset-0 bg-slate-950/40 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />

      <div
        role="dialog"
        aria-modal="true"
        aria-label={`${subScore.label} — what is behind it`}
        className="animate-in relative w-full max-w-md rounded-t-3xl border border-slate-200 bg-white p-5 shadow-2xl sm:rounded-3xl dark:border-slate-800 dark:bg-slate-900"
      >
        <div className="flex items-start gap-3">
          <span className="text-2xl leading-none" aria-hidden="true">
            {subScore.emoji}
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-bold tracking-tight text-slate-900 dark:text-white">
              {subScore.label}
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {subScore.score === null ? 'Nothing answered here yet.' : `${subScore.score}/100 today`}
            </p>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            className="icon-btn -mt-1 -mr-1"
            aria-label="Close"
          >
            <XIcon className="h-5 w-5" />
          </button>
        </div>

        <ul className="mt-4 space-y-2.5">
          {answered.map((key) => {
            const value = answers[key] as number
            const usual = usualForField(history, key)
            const comparison = usualPhrase(compareToUsual(value, usual))
            return (
              <li
                key={key}
                className="flex items-start gap-3 rounded-2xl bg-slate-50 px-3.5 py-2.5 dark:bg-slate-800/50"
              >
                <span className="text-lg leading-none" aria-hidden="true">
                  {fieldEmoji(key)}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-[11px] font-semibold tracking-wide text-slate-500 uppercase dark:text-slate-400">
                    {fieldLabel(key)}
                  </p>
                  <p className="text-sm font-medium text-slate-800 dark:text-slate-100">
                    {answerText(key, value) ?? 'Answered'}
                  </p>
                  {comparison && (
                    <p className="mt-0.5 text-[11px] text-slate-400 dark:text-slate-500">
                      {comparison}
                    </p>
                  )}
                </div>
              </li>
            )
          })}
        </ul>

        <p className="mt-4 text-[10px] leading-snug text-slate-400 dark:text-slate-500">
          Only what you answered is listed. Where there is enough history, the note compares it with
          your own usual — an association in what you reported, not a cause.
        </p>
      </div>
    </div>
  )
}
