import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Team } from '@/types'
import { parseQuickAdd } from './quickAdd'

// Monday, 23 November 2026, local time.
const now = new Date(2026, 10, 23, 9, 0)

test('parses the sample phrase into title, date, time and tag', () => {
  assert.deepEqual(parseQuickAdd('Submit report tomorrow 3pm #work', now), {
    text: 'Submit report',
    due: '2026-11-24',
    preferredTime: '15:00',
    tags: ['work'],
    duration: null,
    teamId: null,
    priority: null,
  })
})

test('parses weekdays, twelve-hour times, tags and duration', () => {
  assert.deepEqual(parseQuickAdd('Call Alex next Monday 9:30am #work for 30m', now), {
    text: 'Call Alex',
    due: '2026-11-30',
    preferredTime: '09:30',
    tags: ['work'],
    duration: 30,
    teamId: null,
    priority: null,
  })
})

test('parses today and named times without inventing a priority', () => {
  assert.deepEqual(parseQuickAdd('Review notes today noon #Personal', now), {
    text: 'Review notes',
    due: '2026-11-23',
    preferredTime: '12:00',
    tags: ['personal'],
    duration: null,
    teamId: null,
    priority: null,
  })
})

test('parses relative dates and twenty-four-hour times', () => {
  assert.deepEqual(parseQuickAdd('Draft plan in 2 weeks 15:00 #planning for 1h', now), {
    text: 'Draft plan',
    due: '2026-12-07',
    preferredTime: '15:00',
    tags: ['planning'],
    duration: 60,
    teamId: null,
    priority: null,
  })
})

test('tonight gets a date and a default evening time', () => {
  assert.deepEqual(parseQuickAdd('Call Mom tonight', now), {
    text: 'Call Mom',
    due: '2026-11-23',
    preferredTime: '20:00',
    tags: [],
    duration: null,
    teamId: null,
    priority: null,
  })
})

test('leaves plain titles untouched', () => {
  assert.deepEqual(parseQuickAdd('Plain task title', now), {
    text: 'Plain task title',
    due: null,
    preferredTime: null,
    tags: [],
    duration: null,
    teamId: null,
    priority: null,
  })
})

test('keeps invalid times in the title but still collects tags', () => {
  assert.deepEqual(parseQuickAdd('Check 99pm #qa', now), {
    text: 'Check 99pm',
    due: null,
    preferredTime: null,
    tags: ['qa'],
    duration: null,
    teamId: null,
    priority: null,
  })
})

test('parses explicit dates', () => {
  assert.deepEqual(parseQuickAdd('Pay invoice 2026-12-01 #finance', now), {
    text: 'Pay invoice',
    due: '2026-12-01',
    preferredTime: null,
    tags: ['finance'],
    duration: null,
    teamId: null,
    priority: null,
  })
})

const crew: Team = {
  id: 'crew',
  name: 'Launch crew',
  createdAt: 0,
  role: 'host',
  members: [],
}

test('parses slash dates and a trailing team name', () => {
  assert.deepEqual(parseQuickAdd('submit report 25/11/26 launch crew', now, [crew]), {
    text: 'submit report',
    due: '2026-11-25',
    preferredTime: null,
    tags: [],
    duration: null,
    teamId: 'crew',
    priority: null,
  })
})

test('accepts four-digit years and month-first slash dates', () => {
  assert.equal(parseQuickAdd('Pay invoice 25/11/2026', now).due, '2026-11-25')
  assert.equal(parseQuickAdd('Pay invoice 11/25/26', now).due, '2026-11-25')
})

test('keeps an invalid slash date in the title', () => {
  assert.deepEqual(parseQuickAdd('Check 31/02/26 #qa', now), {
    text: 'Check 31/02/26',
    due: null,
    preferredTime: null,
    tags: ['qa'],
    duration: null,
    teamId: null,
    priority: null,
  })
})

test('parses shorthand and phrase priorities', () => {
  assert.deepEqual(parseQuickAdd('Ship release tomorrow !high #work', now), {
    text: 'Ship release',
    due: '2026-11-24',
    preferredTime: null,
    tags: ['work'],
    duration: null,
    teamId: null,
    priority: 'high',
  })
  assert.equal(parseQuickAdd('Sort inbox low priority', now).priority, 'low')
  assert.equal(parseQuickAdd('Tidy desk !none', now).priority, 'none')
})

test('keeps unsupported priority words in the title', () => {
  assert.deepEqual(parseQuickAdd('Fix alert !urgent', now), {
    text: 'Fix alert !urgent',
    due: null,
    preferredTime: null,
    tags: [],
    duration: null,
    teamId: null,
    priority: null,
  })
})

test('does not invent a title from markers alone', () => {
  assert.equal(parseQuickAdd('tomorrow !high #work', now).text, '')
})
