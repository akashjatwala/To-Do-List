import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Checkin, CheckinAnswers, CheckinState, DailyState } from '@/types'
import DailyStateCard from './DailyStateCard'

/** A full nine-key answer map with every field skipped unless overridden. */
function answers(values: Partial<CheckinAnswers> = {}): CheckinAnswers {
  return {
    feeling: null,
    energy: null,
    motivation: null,
    sleep: null,
    stress: null,
    free_time: null,
    focus: null,
    body: null,
    workload: null,
    ...values,
  }
}

function makeState(overrides: Partial<DailyState> = {}): DailyState {
  return {
    date: '2026-11-17',
    today: '2026-11-17',
    prefs: { showSummary: true, showEstimates: true },
    summary: {
      shown: true,
      readiness: {
        score: 72,
        answered: 9,
        total: 9,
        state: 'ready',
        phrases: [],
        line: 'A steady day so far.',
        subScores: [],
      },
      baseline: {
        weekdayAverage: 70,
        weekdaySample: 8,
        delta: 2,
        line: 'About your usual Tuesday.',
      },
    },
    estimates: {
      available: false,
      reason: null,
      estimates: [],
      evaluation: [],
      beatsBaseline: null,
      evaluationNote: '',
      shown: false,
    },
    similarDays: { available: false, reason: null, dayCount: 0, days: [], tasks: [], tags: [], line: null },
    recentContext: { available: false, trends: [], streaks: [], lines: [] },
    association: { correlation: null, sample: 0, useful: false, note: '' },
    review: null,
    reviewAlignment: { sample: 0, correlation: null, changeRate: null, note: '' },
    advanced: {
      perTagWeights: { enabled: false, weights: {}, reason: '' },
      smarterEstimates: { enabled: false, reason: '' },
      lowCapacity: { enabled: false, reason: '', capacityScore: null, suggestions: [], choices: [] },
    },
    ...overrides,
  }
}

function completedCheckin(fields: Partial<CheckinAnswers>): Checkin {
  return {
    id: 1,
    date: '2026-11-17',
    answers: answers(fields),
    skipped: false,
    context: null,
    createdAt: 0,
    updatedAt: 0,
  }
}

function render(props: {
  state?: DailyState
  checkin?: Checkin | null
  checkinState?: CheckinState
}) {
  return renderToStaticMarkup(
    <DailyStateCard
      state={props.state ?? makeState()}
      checkin={props.checkin ?? null}
      checkinState={props.checkinState ?? 'not_asked'}
      onEditCheckin={() => {}}
      onRefreshState={async () => {}}
      notify={() => {}}
    />,
  )
}

test('the card is always visible and titled Energy Level', () => {
  const html = render({ checkinState: 'not_asked' })
  assert.match(html, /Energy Level/)
  // There is no show/hide control and no stored preference toggle.
  assert.doesNotMatch(html, /Hide (summary|estimates)|Show (summary|estimates)/i)
})

test('energy inner boxes use a light butter tint instead of plain white', () => {
  const empty = render({ checkinState: 'not_asked' })
  assert.match(empty, /rounded-2xl bg-white\/50 px-4 py-6/)
  assert.doesNotMatch(empty, /rounded-2xl bg-slate-50/)

  const scored = render({
    checkinState: 'completed',
    checkin: completedCheckin({
      feeling: 2,
      energy: 2,
      motivation: 2,
      sleep: 2,
      stress: 2,
      free_time: 2,
      focus: 2,
      body: 2,
      workload: 2,
    }),
  })
  assert.match(scored, /rounded-2xl bg-white\/45 p-4/)
  assert.doesNotMatch(scored, /rounded-2xl bg-white\/60 p-4/)
})

test('with no check-in the card invites one and shows no score', () => {
  const html = render({ checkinState: 'not_asked' })
  assert.match(html, /No check-in yet today/)
  assert.match(html, /Take your check-in/)
  assert.doesNotMatch(html, /\/100/)
  // No Update button before there is anything to update.
  assert.doesNotMatch(html, />Update</)
})

test('a skipped day shows a quiet card with no score', () => {
  const html = render({ checkinState: 'skipped' })
  assert.match(html, /No check-in today/)
  assert.doesNotMatch(html, /\/100/)
})

test('too few answers withholds the score and asks for a little more', () => {
  const state = makeState({
    summary: {
      ...makeState().summary,
      readiness: {
        score: null,
        answered: 1,
        total: 9,
        state: 'none',
        phrases: [],
        line: 'Not enough answers yet.',
        subScores: [],
      },
    },
  })
  const html = render({ state, checkinState: 'partial', checkin: completedCheckin({ energy: 2 }) })
  assert.doesNotMatch(html, /\/100/)
  assert.match(html, /A few more answers are needed before a score is shown\./)
})

test('a completed check-in shows the score, band, Update and the four sub-scores', () => {
  const checkin = completedCheckin({
    energy: 1,
    sleep: 1,
    body: 1,
    feeling: 2,
    stress: 2,
    focus: 2,
    motivation: 2,
    free_time: 3,
    workload: 3,
  })
  const html = render({ checkinState: 'completed', checkin })

  assert.match(html, /72/)
  assert.match(html, /\/100/)
  assert.match(html, /About your usual Tuesday\./)
  assert.match(html, />Update</)

  for (const label of ['Physical', 'Mood', 'Focus', 'Capacity']) {
    assert.match(html, new RegExp(label))
  }
})

test('the four display sub-scores use only answered fields', () => {
  // Only physical fields answered → Physical has a score, the others show a dash.
  const checkin = completedCheckin({ energy: 1, sleep: 1, body: 1 })
  const html = render({ checkinState: 'completed', checkin })
  assert.match(html, /100/)
  assert.match(html, /—/)
})

test('sub-score buttons are labelled for screen readers', () => {
  const checkin = completedCheckin({ energy: 1, sleep: 1, body: 1 })
  const html = render({ checkinState: 'completed', checkin })
  assert.match(html, /Physical: 100 out of 100\. Show what is behind it\./)
})

test('estimates, recent-pattern and days-like-today lines are not shown on the card', () => {
  const state = makeState({
    recentContext: { available: true, trends: [], streaks: [], lines: ['A visible recent-pattern line.'] },
    similarDays: {
      available: true,
      reason: null,
      dayCount: 4,
      days: [],
      tasks: [],
      tags: [],
      line: 'A visible days-like-today line.',
    },
  })
  const checkin = completedCheckin({ energy: 1, sleep: 1, body: 1 })
  const html = render({ state, checkinState: 'completed', checkin })
  assert.doesNotMatch(html, /A visible recent-pattern line\./)
  assert.doesNotMatch(html, /A visible days-like-today line\./)
  assert.doesNotMatch(html, /Estimates for what you skipped/)
})
