import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CHECKIN_ANSWER_KEYS,
  CHECKIN_QUESTIONS,
  answeredCount,
  clampStep,
  firstUnansweredIndex,
  greetingForHour,
  type CheckinAnswerValues,
} from '../src/lib/checkin'

/**
 * The check-in UI is presentation only, but the flow decisions (where to resume, how
 * many are answered, how a step is clamped) live in pure helpers so they can be
 * tested without a DOM. These run under the repo's existing `node --test` setup.
 */

test('every question has five options, five option emoji and a header emoji', () => {
  assert.equal(CHECKIN_QUESTIONS.length, CHECKIN_ANSWER_KEYS.length)
  for (const question of CHECKIN_QUESTIONS) {
    assert.equal(question.options.length, 5)
    assert.equal(question.optionEmojis.length, 5)
    assert.ok(question.emoji.length > 0)
    assert.match(question.accent, /^#[0-9a-f]{6}$/i)
    for (const emoji of question.optionEmojis) assert.ok(emoji.length > 0)
  }
})

test('the question keys match the stored answer keys, in order', () => {
  assert.deepEqual(
    CHECKIN_QUESTIONS.map((question) => question.key),
    [...CHECKIN_ANSWER_KEYS],
  )
})

test('answeredCount counts only questions that actually have an answer', () => {
  assert.equal(answeredCount({}), 0)
  assert.equal(answeredCount({ feeling: 3, energy: null }), 1)
  assert.equal(answeredCount({ feeling: 1, energy: 5, sleep: 3 }), 3)
  // A stray zero is still "answered"; missing stays missing.
  assert.equal(answeredCount({ feeling: 0 }), 1)
})

test('firstUnansweredIndex points at the first gap, or past the end', () => {
  assert.equal(firstUnansweredIndex({}), 0)
  assert.equal(firstUnansweredIndex({ feeling: 2 }), 1)
  assert.equal(firstUnansweredIndex({ feeling: 2, energy: 2, motivation: 2 }), 3)
  const all = Object.fromEntries(CHECKIN_ANSWER_KEYS.map((key) => [key, 3])) as CheckinAnswerValues
  assert.equal(firstUnansweredIndex(all), CHECKIN_QUESTIONS.length)
})

test('a null in the middle is still the first unanswered question', () => {
  const answers: CheckinAnswerValues = { feeling: 1, energy: null, motivation: 2 }
  assert.equal(firstUnansweredIndex(answers), 1)
})

test('clampStep keeps the wizard inside its range', () => {
  assert.equal(clampStep(-3, 9), 0)
  assert.equal(clampStep(0, 9), 0)
  assert.equal(clampStep(4, 9), 4)
  assert.equal(clampStep(9, 9), 9)
  assert.equal(clampStep(42, 9), 9)
  assert.equal(clampStep(Number.NaN, 9), 0)
})

test('the greeting follows the time of day', () => {
  assert.equal(greetingForHour(2), 'Hello')
  assert.equal(greetingForHour(8), 'Good morning')
  assert.equal(greetingForHour(14), 'Good afternoon')
  assert.equal(greetingForHour(19), 'Good evening')
  assert.equal(greetingForHour(23), 'Good night')
})
