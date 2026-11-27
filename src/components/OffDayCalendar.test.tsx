import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import OffDayCalendarButton, {
  OffDayCalendar,
  type OffDayCalendarEntry,
} from './OffDayCalendar'

const entries: OffDayCalendarEntry[] = [
  {
    id: 1,
    startDate: '2026-11-20',
    endDate: '2026-11-21',
    kind: 'sick',
    label: 'Demo Mate · Sick',
    person: 'Demo Mate',
    note: 'Old period',
  },
  {
    id: 2,
    startDate: '2026-11-28',
    endDate: '2026-11-29',
    kind: 'travel',
    label: 'Travelling',
    person: 'You',
    note: 'Train journey',
  },
  {
    id: 3,
    startDate: '2025-01-19',
    endDate: '2025-01-21',
    kind: 'holiday',
    label: 'Holiday',
    person: 'You',
    note: 'Old trip',
  },
]

function renderCalendar(
  overrides: Partial<Parameters<typeof OffDayCalendar>[0]> = {},
): string {
  return renderToStaticMarkup(
    <OffDayCalendar entries={entries} today="2026-11-27" {...overrides} />,
  )
}

test('off day calendar highlights both past and future off dates without lists', () => {
  const html = renderCalendar()

  assert.match(html, /November 2026/)
  assert.match(html, /aria-label="2026-11-28: Travelling"/)
  assert.match(html, /aria-label="2026-11-20: Demo Mate · Sick"/)
  assert.match(html, /bg-\[#DCEBDF\] text-\[#2F4A37\]/)
  assert.match(html, /bg-\[#E7EDE8\] text-\[#526255\] ring-1 ring-\[#CFDDD2\]/)
  assert.match(html, /bg-white\/70 p-2 shadow-sm ring-1 ring-\[#DCE9EE\]/)
  assert.match(html, /text-\[#35506B\]\/80/)
  assert.doesNotMatch(html, />Upcoming</)
  assert.doesNotMatch(html, />History</)
})

test('the calendar can page back to historical months', () => {
  const html = renderCalendar()

  assert.match(html, /aria-label="Previous month"(?![^>]*disabled="")/)
  assert.match(html, /aria-label="Next month"(?![^>]*disabled="")/)
})

test('selecting a future date shows that the person is off', () => {
  const html = renderCalendar({ initialSelectedDate: '2026-11-28' })

  assert.match(html, /You are off/)
  assert.match(html, /Travelling · Nov 28 – Nov 29/)
  assert.match(html, /Train journey/)
})

test('selecting a past date shows that the teammate was off', () => {
  const html = renderCalendar({ initialSelectedDate: '2026-11-20' })

  assert.match(html, /Demo Mate was off/)
  assert.match(html, /Sick · Nov 20 – Nov 21/)
  assert.match(html, /Old period/)
})

test('a date with no off day says so', () => {
  const html = renderCalendar({ initialSelectedDate: '2026-11-27' })

  assert.match(html, /No off day on this date\./)
})

test('teammate calendar uses its own tone', () => {
  const html = renderCalendar({ tone: 'teammate' })

  assert.match(html, /bg-\[#D5E3F0\] text-\[#35506B\]/)
})

test('the header button opens a dialog without adding a sidebar section', () => {
  const html = renderToStaticMarkup(
    <OffDayCalendarButton
      entries={entries}
      today="2026-11-27"
      title="Off day calendar"
      buttonLabel="View off day calendar"
    />,
  )

  assert.match(html, /aria-label="View off day calendar"/)
  assert.match(html, /aria-haspopup="dialog"/)
  assert.match(html, /aria-expanded="false"/)
  assert.doesNotMatch(html, /aria-label="Upcoming off days"/)
})
