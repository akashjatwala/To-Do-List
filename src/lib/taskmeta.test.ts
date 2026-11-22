import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dueFromDateInput } from './date'
import { repeatsOnDate } from './taskmeta'

const due = (value: string) => dueFromDateInput(value)

test('a repeating task always matches its due date and never a past date', () => {
  const start = due('2026-11-22')!
  assert.equal(repeatsOnDate(start, 'daily', null, '2026-11-22'), true)
  assert.equal(repeatsOnDate(start, 'daily', null, '2026-11-21'), false)
  assert.equal(repeatsOnDate(start, 'weekly', null, '2026-11-21'), false)
})

test('daily repeats match every later date', () => {
  const start = due('2026-11-22')!
  assert.equal(repeatsOnDate(start, 'daily', null, '2026-11-23'), true)
  assert.equal(repeatsOnDate(start, 'daily', null, '2026-12-05'), true)
})

test('weekly repeats match only the same weekday', () => {
  const start = due('2026-11-22')! // Sunday
  assert.equal(repeatsOnDate(start, 'weekly', null, '2026-11-29'), true)
  assert.equal(repeatsOnDate(start, 'weekly', null, '2026-12-06'), true)
  assert.equal(repeatsOnDate(start, 'weekly', null, '2026-11-24'), false)
})

test('monthly repeats match the same day, clamped to short months', () => {
  const start = due('2026-01-31')!
  assert.equal(repeatsOnDate(start, 'monthly', null, '2026-02-28'), true)
  assert.equal(repeatsOnDate(start, 'monthly', null, '2026-03-31'), true)
  assert.equal(repeatsOnDate(start, 'monthly', null, '2026-02-27'), false)
})

test('custom weekly repeats match only the chosen weekdays', () => {
  const start = due('2026-11-22')!
  const config = { mode: 'weekly' as const, days: [2, 4] } // Tue, Thu
  assert.equal(repeatsOnDate(start, 'custom', config, '2026-11-24'), true)
  assert.equal(repeatsOnDate(start, 'custom', config, '2026-11-26'), true)
  assert.equal(repeatsOnDate(start, 'custom', config, '2026-11-25'), false)
})

test('custom monthly repeats match the nth weekday of the month', () => {
  const start = due('2026-11-02')! // first Monday of November 2026
  const config = { mode: 'monthly' as const, nth: 1, weekday: 1 }
  assert.equal(repeatsOnDate(start, 'custom', config, '2026-12-07'), true)
  assert.equal(repeatsOnDate(start, 'custom', config, '2026-12-14'), false)
})

test('a non-repeating task never matches a future date', () => {
  const start = due('2026-11-22')!
  assert.equal(repeatsOnDate(start, 'none', null, '2026-11-23'), false)
  assert.equal(repeatsOnDate(null, 'daily', null, '2026-11-23'), false)
})
