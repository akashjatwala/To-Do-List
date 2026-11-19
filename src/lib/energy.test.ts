import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MIN_USUAL_SAMPLE,
  answerText,
  compareToUsual,
  displaySubScores,
  fieldEmoji,
  fieldLabel,
  goodness,
  goodnessToScore,
  scoreBand,
  subScoreBarClass,
  subScoreTextClass,
  usualForField,
  usualPhrase,
} from './energy'

test('goodness flips the stored 1–5 ordinal so 5 is best', () => {
  assert.equal(goodness(1), 5)
  assert.equal(goodness(3), 3)
  assert.equal(goodness(5), 1)
})

test('goodnessToScore maps the flipped scale onto 0–100', () => {
  assert.equal(goodnessToScore(1), 0)
  assert.equal(goodnessToScore(3), 50)
  assert.equal(goodnessToScore(5), 100)
  // Out-of-range values are clamped rather than producing impossible scores.
  assert.equal(goodnessToScore(0), 0)
  assert.equal(goodnessToScore(9), 100)
})

test('scoreBand follows the four documented boundaries', () => {
  assert.equal(scoreBand(0).key, 'drained')
  assert.equal(scoreBand(20).key, 'drained')
  assert.equal(scoreBand(21).key, 'low')
  assert.equal(scoreBand(50).key, 'low')
  assert.equal(scoreBand(51).key, 'good')
  assert.equal(scoreBand(80).key, 'good')
  assert.equal(scoreBand(81).key, 'strong')
  assert.equal(scoreBand(100).key, 'strong')
})

test('scoreBand maps each range to its requested background colour', () => {
  assert.equal(scoreBand(10).tone, 'peach')
  assert.equal(scoreBand(30).tone, 'butter')
  assert.equal(scoreBand(60).tone, 'cyan')
  assert.equal(scoreBand(90).tone, 'lime')
})

test('scoreBand never uses red and always has a text label', () => {
  for (const score of [0, 25, 50, 75, 100]) {
    const band = scoreBand(score)
    assert.notEqual(band.tone, 'red')
    assert.ok(band.label.length > 0)
    assert.ok(band.emoji.length > 0)
  }
})

test('scoreBand treats a withheld score as steady with a plain white band', () => {
  const band = scoreBand(null)
  assert.equal(band.key, 'steady')
  assert.equal(band.tone, 'plain')
})

test('displaySubScores only counts answered fields and never invents values', () => {
  const subs = displaySubScores({ energy: 1, sleep: 1, body: 1 })
  const physical = subs.find((sub) => sub.key === 'physical')!
  const mood = subs.find((sub) => sub.key === 'mood')!

  assert.equal(physical.score, 100)
  assert.equal(physical.answered, 3)
  assert.equal(physical.total, 3)

  // Nothing answered in Mood → no score, not a neutral 50.
  assert.equal(mood.score, null)
  assert.equal(mood.answered, 0)
})

test('displaySubScores averages the answered fields in a group', () => {
  // energy 3 → goodness 3 (score 50); sleep 1 → goodness 5 (score 100); average 4 → 75.
  const subs = displaySubScores({ energy: 3, sleep: 1 })
  const physical = subs.find((sub) => sub.key === 'physical')!
  assert.equal(physical.score, 75)
  assert.equal(physical.answered, 2)
})

test('displaySubScores keeps the four display groups in order', () => {
  const subs = displaySubScores({})
  assert.deepEqual(
    subs.map((sub) => sub.key),
    ['physical', 'mood', 'focus', 'capacity'],
  )
})

test('field labels and emoji come from the shared question definitions', () => {
  assert.equal(fieldLabel('energy'), 'Energy')
  assert.equal(fieldEmoji('energy'), '⚡')
  assert.equal(fieldLabel('feeling'), 'Mood')
})

test('answerText returns the exact option the person chose, or null', () => {
  assert.equal(answerText('energy', 1), 'Very high')
  assert.equal(answerText('energy', 5), 'Very low')
  assert.equal(answerText('energy', null), null)
  assert.equal(answerText('energy', undefined), null)
})

test('usualForField stays silent until there is enough history', () => {
  const rows = Array.from({ length: MIN_USUAL_SAMPLE - 1 }, () => ({ answers: { energy: 2 } }))
  assert.equal(usualForField(rows, 'energy'), null)

  rows.push({ answers: { energy: 2 } })
  const usual = usualForField(rows, 'energy')!
  assert.equal(usual.sample, MIN_USUAL_SAMPLE)
  assert.equal(usual.goodness, goodness(2))
})

test('usualForField skips missing answers instead of counting them', () => {
  const rows = [
    { answers: { energy: 1 } },
    { answers: { energy: null } },
    { answers: {} },
    { answers: { energy: 1 } },
    { answers: { energy: 1 } },
    { answers: { energy: 1 } },
    { answers: { energy: 1 } },
  ]
  const usual = usualForField(rows, 'energy')!
  // Five real answers; the null and the empty row are ignored, not treated as neutral.
  assert.equal(usual.sample, MIN_USUAL_SAMPLE)
})

test('compareToUsual describes position next to the usual in neutral bands', () => {
  const usual = { goodness: 3, sample: 10 }
  assert.equal(compareToUsual(1, usual), 'above') // goodness 5
  assert.equal(compareToUsual(3, usual), 'about') // goodness 3
  assert.equal(compareToUsual(5, usual), 'below') // goodness 1
  assert.equal(compareToUsual(1, null), null)
})

test('usualPhrase never says good or bad and never states a cause', () => {
  assert.equal(usualPhrase('above'), 'A little above your usual')
  assert.equal(usualPhrase('below'), 'A little below your usual')
  assert.equal(usualPhrase('about'), 'About your usual')
  assert.equal(usualPhrase(null), null)
  for (const phrase of [usualPhrase('above'), usualPhrase('below'), usualPhrase('about')]) {
    assert.doesNotMatch(phrase!, /because|due to|good|bad/i)
  }
})

test('sub-score colour helpers pick a sensible tone and never red', () => {
  assert.equal(subScoreTextClass(null), 'text-slate-400')
  assert.match(subScoreTextClass(30), /amber/)
  assert.match(subScoreTextClass(50), /sky/)
  assert.match(subScoreTextClass(90), /emerald/)
  assert.doesNotMatch(subScoreBarClass(90), /rose|red/)
})
