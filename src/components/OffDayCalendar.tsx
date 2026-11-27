import { useState } from 'react'
import type { OffDayKind } from '@/types'
import { CalendarIcon } from './Icons'
import { Modal } from './ui'
import { offDayEmoji, offKindLabel } from './off-day-display'

export interface OffDayCalendarEntry {
  id: number | string
  startDate: string
  endDate: string
  kind?: OffDayKind | null
  /** Person or kind shown beside the dates. */
  label: string
  note?: string | null
  /** Used for "You are off" / "Demo Mate was off" in the detail row. */
  person?: string | null
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]
const WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']
const pad = (value: number) => `${value}`.padStart(2, '0')

function shortDate(value: string): string {
  const [, month, day] = value.split('-').map(Number)
  return `${MONTH_NAMES[month - 1]?.slice(0, 3) ?? ''} ${day}`
}

function monthIndex(value: string): number {
  const [year, month] = value.split('-').map(Number)
  return year * 12 + (month - 1)
}

function windowLabel(entry: OffDayCalendarEntry): string {
  return entry.startDate === entry.endDate
    ? shortDate(entry.startDate)
    : `${shortDate(entry.startDate)} – ${shortDate(entry.endDate)}`
}

/**
 * Calendar body shared by the My tasks and Teams off-day cards. Off dates are
 * highlighted; selecting one shows the matching period below the grid as
 * "You are off" or "Demo Mate was off". No separate Upcoming/History lists are
 * rendered — the calendar itself carries both past and future periods.
 */
export function OffDayCalendar({
  entries,
  today,
  tone = 'own',
  initialSelectedDate,
}: {
  entries: OffDayCalendarEntry[]
  today: string
  tone?: 'own' | 'teammate'
  initialSelectedDate?: string
}) {
  const [monthOffset, setMonthOffset] = useState(0)
  const [selectedDate, setSelectedDate] = useState(initialSelectedDate ?? today)

  const allEntries = [...entries].sort(
    (a, b) => a.startDate.localeCompare(b.startDate) || a.label.localeCompare(b.label),
  )

  const todayMonth = monthIndex(today)
  const minOffset = allEntries.reduce(
    (min, entry) => Math.min(min, monthIndex(entry.startDate) - todayMonth),
    0,
  )
  const maxOffset = allEntries.reduce(
    (max, entry) => Math.max(max, monthIndex(entry.endDate) - todayMonth),
    0,
  )
  const visibleOffset = Math.max(minOffset, Math.min(monthOffset, maxOffset))
  const cursorMonth = todayMonth + visibleOffset
  const year = Math.floor(cursorMonth / 12)
  const monthNumber = ((cursorMonth % 12) + 12) % 12
  const firstWeekday = new Date(year, monthNumber, 1).getDay()
  const daysInMonth = new Date(year, monthNumber + 1, 0).getDate()

  const activeClass =
    tone === 'teammate'
      ? 'bg-[#D5E3F0] text-[#35506B]'
      : 'bg-[#DCEBDF] text-[#2F4A37]'
  const pastActiveClass =
    tone === 'teammate'
      ? 'bg-[#E5EDF4] text-[#52677A] ring-1 ring-[#C8D9E6]'
      : 'bg-[#E7EDE8] text-[#526255] ring-1 ring-[#CFDDD2]'

  const selectedEntries = allEntries.filter(
    (entry) => selectedDate >= entry.startDate && selectedDate <= entry.endDate,
  )

  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => setMonthOffset((offset) => Math.max(minOffset, offset - 1))}
          disabled={visibleOffset <= minOffset}
          aria-label="Previous month"
          className="rounded-lg px-2 py-0.5 text-sm font-bold text-[#35506B] transition hover:bg-white disabled:opacity-30"
        >
          ‹
        </button>
        <p className="text-xs font-bold tracking-wide text-[#35506B]">
          {MONTH_NAMES[monthNumber]} {year}
        </p>
        <button
          type="button"
          onClick={() => setMonthOffset((offset) => Math.min(maxOffset, offset + 1))}
          disabled={visibleOffset >= maxOffset}
          aria-label="Next month"
          className="rounded-lg px-2 py-0.5 text-sm font-bold text-[#35506B] transition hover:bg-white disabled:opacity-30"
        >
          ›
        </button>
      </div>

      <div className="rounded-2xl bg-white/70 p-2 shadow-sm ring-1 ring-[#DCE9EE]">
        <div className="grid grid-cols-7 gap-0.5 text-center text-[10px] font-bold text-[#35506B]/80">
          {WEEKDAYS.map((weekday) => (
            <span key={weekday}>{weekday}</span>
          ))}
        </div>
        <div className="mt-1 grid grid-cols-7 gap-0.5">
          {Array.from({ length: firstWeekday }, (_, index) => (
            <span key={`blank-${index}`} />
          ))}
          {Array.from({ length: daysInMonth }, (_, index) => {
            const day = index + 1
            const value = `${year}-${pad(monthNumber + 1)}-${pad(day)}`
            const matches = allEntries.filter(
              (entry) => value >= entry.startDate && value <= entry.endDate,
            )
            const isToday = value === today
            const isPast = value < today
            const isSelected = value === selectedDate
            return (
              <button
                key={value}
                type="button"
                onClick={() => setSelectedDate(value)}
                aria-label={matches.length ? `${value}: ${matches.map((entry) => entry.label).join(', ')}` : value}
                aria-pressed={isSelected}
                title={matches.length ? `${value}: ${matches.map((entry) => entry.label).join(', ')}` : value}
                className={[
                  'flex h-7 items-center justify-center rounded-lg text-[11px] font-semibold transition hover:brightness-95',
                  matches.length > 0
                    ? isPast
                      ? pastActiveClass
                      : activeClass
                    : 'text-[#35506B]',
                  isSelected ? 'ring-2 ring-[#35506B]' : isToday ? 'ring-2 ring-[#D9480F]' : '',
                  isPast && matches.length === 0 ? 'opacity-40' : '',
                ].join(' ')}
              >
                {day}
              </button>
            )
          })}
        </div>
      </div>

      <div className="mt-3 rounded-2xl bg-white/70 px-3 py-2.5 shadow-sm ring-1 ring-[#DCE9EE]">
        <p className="text-[10px] font-bold uppercase tracking-wide text-[#35506B]/70">
          {shortDate(selectedDate)}
        </p>
        {selectedEntries.length === 0 ? (
          <p className="mt-1 text-xs text-[#52677A]">No off day on this date.</p>
        ) : (
          <ul className="mt-1 space-y-2">
            {selectedEntries.map((entry) => {
              const isPast = selectedDate < today
              const isYou = entry.person === 'You'
              const verb = isYou ? (isPast ? 'were' : 'are') : isPast ? 'was' : 'is'
              return (
              <li key={entry.id} className="flex items-start gap-2">
                <span className="text-base leading-none" aria-hidden="true">
                  {offDayEmoji(entry.kind ?? null)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold text-[#15181E]">
                    {entry.person ?? entry.label} {verb} off
                  </span>
                  <span className="block text-xs text-slate-500">
                    {offKindLabel(entry.kind)} · {windowLabel(entry)}
                    {entry.note ? ` · ${entry.note}` : ''}
                  </span>
                </span>
              </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}

/** Small header button that opens the off-day calendar in a modal. */
export default function OffDayCalendarButton({
  entries,
  today,
  title,
  description,
  buttonLabel = 'View off day calendar',
  tone = 'own',
}: {
  entries: OffDayCalendarEntry[]
  today: string
  title: string
  description?: string
  buttonLabel?: string
  tone?: 'own' | 'teammate'
}) {
  const [open, setOpen] = useState(false)

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={buttonLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={buttonLabel}
        className="icon-btn -mr-1 -mt-1 shrink-0 text-[#35506B]"
      >
        <CalendarIcon className="h-4 w-4" />
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={title}
        description={description}
        width="max-w-md"
        surfaceClassName="border-[#DCE9EE] bg-[#EEF5F8]"
      >
        <OffDayCalendar entries={entries} today={today} tone={tone} />
      </Modal>
    </>
  )
}
