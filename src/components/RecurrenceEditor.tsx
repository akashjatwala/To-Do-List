import type { RecurrenceConfig } from '@/types'
import {
  NTH_LABELS,
  WEEKDAY_LABELS,
  WEEKDAY_LETTERS,
  WEEKDAY_SHORT,
  describeRecurrence,
} from '@/lib/taskmeta'

/**
 * Editor for custom repeats. Weekly lets you pick any set of weekdays, monthly
 * pins the repeat to the first/second/third/fourth/last weekday of each month.
 */
export default function RecurrenceEditor({
  config,
  onChange,
}: {
  config: RecurrenceConfig
  onChange: (config: RecurrenceConfig) => void
}) {
  const switchMode = (mode: 'weekly' | 'monthly') => {
    if (mode === config.mode) return
    if (mode === 'weekly') {
      const day = config.mode === 'monthly' ? config.weekday : new Date().getDay()
      onChange({ mode: 'weekly', days: [day] })
    } else {
      const day = config.mode === 'weekly' ? (config.days[0] ?? new Date().getDay()) : 0
      onChange({ mode: 'monthly', nth: 1, weekday: day })
    }
  }

  const toggleDay = (day: number) => {
    if (config.mode !== 'weekly') return
    const days = config.days.includes(day)
      ? config.days.filter((item) => item !== day)
      : [...config.days, day].sort((a, b) => a - b)
    // Keep at least one day selected so the rule always stays valid.
    if (days.length === 0) return
    onChange({ mode: 'weekly', days })
  }

  return (
    <div className="rounded-xl border border-dashed border-slate-300/80 bg-white/60 p-2.5 dark:border-slate-600/60 dark:bg-slate-900/40">
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded-lg bg-slate-200/70 p-0.5 dark:bg-slate-700/60">
          {(['weekly', 'monthly'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => switchMode(mode)}
              aria-pressed={config.mode === mode}
              className={`rounded-md px-2.5 py-1 text-[11px] font-semibold capitalize transition ${
                config.mode === mode
                  ? 'bg-white text-slate-900 shadow-sm dark:bg-slate-900 dark:text-white'
                  : 'text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200'
              }`}
            >
              {mode}
            </button>
          ))}
        </div>

        {config.mode === 'weekly' ? (
          <div className="flex items-center gap-1" role="group" aria-label="Repeat on weekdays">
            {WEEKDAY_LETTERS.map((letter, day) => {
              const active = config.days.includes(day)
              return (
                <button
                  key={`${letter}-${day}`}
                  type="button"
                  onClick={() => toggleDay(day)}
                  aria-pressed={active}
                  aria-label={WEEKDAY_LABELS[day]}
                  title={WEEKDAY_LABELS[day]}
                  className={`flex h-7 w-7 items-center justify-center rounded-full text-[11px] font-bold transition ${
                    active
                      ? 'bg-indigo-600 text-white shadow-sm shadow-indigo-600/30'
                      : 'bg-white text-slate-500 hover:bg-slate-100 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700'
                  }`}
                >
                  {letter}
                </button>
              )
            })}
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-1.5">
            <select
              value={config.nth}
              onChange={(event) =>
                onChange({ ...config, nth: Number(event.target.value) })
              }
              aria-label="Which weekday occurrence"
              className="cursor-pointer rounded-lg border border-slate-200 bg-white px-2 py-1 text-[11px] font-medium text-slate-600 outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300"
            >
              {NTH_LABELS.map((label, index) => (
                <option key={label} value={index + 1}>
                  {label}
                </option>
              ))}
            </select>
            <select
              value={config.weekday}
              onChange={(event) =>
                onChange({ ...config, weekday: Number(event.target.value) })
              }
              aria-label="Weekday"
              className="cursor-pointer rounded-lg border border-slate-200 bg-white px-2 py-1 text-[11px] font-medium text-slate-600 outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300"
            >
              {WEEKDAY_SHORT.map((label, index) => (
                <option key={label} value={index}>
                  {WEEKDAY_LABELS[index]}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      <p className="mt-2 text-[11px] font-medium text-slate-500 dark:text-slate-400">
        Repeats {describeRecurrence('custom', config).toLowerCase()}.
      </p>
    </div>
  )
}
