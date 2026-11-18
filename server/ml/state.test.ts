import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import {
  CHECKIN_ANSWER_KEYS,
  createCheckinSchema,
  getCheckin,
  listCheckinHistory,
  saveCheckin,
  skipCheckin,
  type CheckinAnswerKey,
} from '../checkins-store'
import { createFoundationSchema, createPredictionSchema, createStateSchema } from './schema'
import { syncTaskFoundation } from './task-sync'
import { createSession } from './sessions'
import {
  SUB_SCORE_GROUPS,
  goodness,
  readinessFromCheckin,
} from './readiness'
import { estimatesFor } from './estimates'
import { similarDays } from './similar-days'
import { recentContext } from './recent-context'
import { getDayReview, listDayReviews, reviewAlignment, saveDayReview } from './day-review'
import {
  MIN_SUGGESTION_DAYS,
  completionRateForDate,
  dailyState,
  getStatePrefs,
  saveStatePrefs,
} from './state'

const USER = 1
const MINUTE = 60_000

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT)')
  db.exec("INSERT INTO users (email) VALUES ('me@example.com')")
  db.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      team_id TEXT,
      text TEXT NOT NULL,
      done INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      due INTEGER,
      position INTEGER NOT NULL DEFAULT 0,
      progress INTEGER NOT NULL DEFAULT 0,
      priority TEXT NOT NULL DEFAULT 'none',
      tags TEXT NOT NULL DEFAULT '[]',
      recurrence TEXT NOT NULL DEFAULT 'none',
      duration INTEGER,
      recurrence_config TEXT,
      preferred_time TEXT
    )
  `)
  createCheckinSchema(db)
  createFoundationSchema(db)
  createStateSchema(db)
  createPredictionSchema(db)
  return db
}

function addDays(date: string, offset: number): string {
  const [year, month, day] = date.split('-').map(Number)
  const next = new Date(year, month - 1, day + offset)
  const m = `${next.getMonth() + 1}`.padStart(2, '0')
  const d = `${next.getDate()}`.padStart(2, '0')
  return `${next.getFullYear()}-${m}-${d}`
}

function at(date: string, hour: number, minute = 0): number {
  const [year, month, day] = date.split('-').map(Number)
  return new Date(year, month - 1, day, hour, minute, 0, 0).getTime()
}

/** A full nine-key answer set, every untouched answer defaulting to null. */
function answers(
  overrides: Partial<Record<CheckinAnswerKey, number | null>> = {},
): Record<CheckinAnswerKey, number | null> {
  const out = {} as Record<CheckinAnswerKey, number | null>
  for (const key of CHECKIN_ANSWER_KEYS) out[key] = null
  for (const [key, value] of Object.entries(overrides)) out[key as CheckinAnswerKey] = value as number | null
  return out
}

function save(db: DatabaseSync, date: string, overrides: Partial<Record<CheckinAnswerKey, number | null>> = {}) {
  return saveCheckin(db, USER, { date, answers: answers(overrides), context: null })
}

function addTask(db: DatabaseSync, overrides: { id?: string; text?: string; tags?: string[]; duration?: number | null } = {}) {
  const id = overrides.id ?? randomUUID()
  db.prepare(
    `INSERT INTO tasks (id, user_id, text, created_at, priority, tags, recurrence, duration, preferred_time)
     VALUES (?, ?, ?, ?, 'none', ?, 'daily', ?, NULL)`,
  ).run(id, USER, overrides.text ?? 'Read a book', Date.now(), JSON.stringify(overrides.tags ?? []), overrides.duration ?? 30)
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as unknown as Parameters<typeof syncTaskFoundation>[1]
  // The config must take effect before the historical days we log sessions on.
  syncTaskFoundation(db, row, at('2026-01-01', 0))
  return id
}

function logSession(db: DatabaseSync, taskId: string, date: string, minutes = 30) {
  createSession(db, USER, {
    taskId,
    localDate: date,
    startedAt: at(date, 9),
    endedAt: at(date, 9) + minutes * MINUTE,
    durationMinutes: minutes,
    note: null,
  })
}

// ---------------------------------------------------------------------------
// Readiness scoring
// ---------------------------------------------------------------------------

test('every answer is flipped so higher is always better', () => {
  assert.equal(goodness(1), 5)
  assert.equal(goodness(3), 3)
  assert.equal(goodness(5), 1)
})

test('all fields answered gives a full score and no estimates', () => {
  const db = freshDb()
  save(db, '2026-05-10', {
    feeling: 1,
    energy: 1,
    motivation: 1,
    sleep: 1,
    stress: 1,
    free_time: 1,
    focus: 1,
    body: 1,
    workload: 1,
  })
  const state = dailyState(db, USER, '2026-05-10', '2026-05-11')
  assert.equal(state.summary.readiness.answered, 9)
  assert.equal(state.summary.readiness.state, 'ready')
  assert.equal(state.summary.readiness.score, 100)
  assert.equal(state.estimates.available, false)
  assert.equal(state.estimates.shown, false)
})

test('the summary uses only answered fields and never counts skipped ones', () => {
  const db = freshDb()
  // Only the three capacity fields answered, all at the best end.
  save(db, '2026-05-10', { free_time: 1, workload: 1, stress: 1 })
  const readiness = readinessFromCheckin(getCheckin(db, USER, '2026-05-10'))
  assert.equal(readiness.answered, 3)
  assert.equal(readiness.score, 100)
  assert.equal(readiness.state, 'partial')
  const capacity = readiness.subScores.find((sub) => sub.name === 'capacity')!
  assert.equal(capacity.answered, 3)
  assert.equal(capacity.score, 100)
  // A sub-score with too few of its fields is withheld, not defaulted.
  const mental = readiness.subScores.find((sub) => sub.name === 'mental')!
  assert.equal(mental.answered, 0)
  assert.equal(mental.score, null)
})

test('a sub-score ignores fields that were skipped', () => {
  const db = freshDb()
  // physical = energy + sleep + body. Only energy answered.
  save(db, '2026-05-10', { energy: 1 })
  const readiness = readinessFromCheckin(getCheckin(db, USER, '2026-05-10'))
  const physical = readiness.subScores.find((sub) => sub.name === 'physical')!
  assert.equal(physical.answered, 1)
  assert.equal(physical.score, null)
  // Two of the three fields is enough.
  save(db, '2026-05-10', { energy: 1, sleep: 1 })
  const two = readinessFromCheckin(getCheckin(db, USER, '2026-05-10'))
  assert.equal(two.subScores.find((sub) => sub.name === 'physical')!.score, 100)
})

test('a skipped check-in yields no score at all', () => {
  const db = freshDb()
  skipCheckin(db, USER, '2026-05-10')
  const state = dailyState(db, USER, '2026-05-10', '2026-05-11')
  assert.equal(state.summary.readiness.score, null)
  assert.equal(state.summary.readiness.state, 'none')
  assert.equal(state.summary.readiness.answered, 0)
  assert.match(state.summary.readiness.line, /nothing/i)
})

test('the three sub-score groups cover every field exactly once', () => {
  const grouped = [...SUB_SCORE_GROUPS.physical, ...SUB_SCORE_GROUPS.mental, ...SUB_SCORE_GROUPS.capacity]
  assert.equal(new Set(grouped).size, CHECKIN_ANSWER_KEYS.length)
  for (const key of CHECKIN_ANSWER_KEYS) assert.ok(grouped.includes(key))
})

// ---------------------------------------------------------------------------
// Estimates
// ---------------------------------------------------------------------------

test('too little history means no estimate is offered', () => {
  const db = freshDb()
  save(db, '2026-05-09', { energy: 3 })
  save(db, '2026-05-10', { feeling: 2 })
  const estimates = estimatesFor(db, USER, '2026-05-10', getCheckin(db, USER, '2026-05-10'))
  assert.equal(estimates.available, false)
  assert.match(estimates.reason ?? '', /not enough|past check-ins/i)
})

test('with enough history a skipped field gets a labelled estimate with a range', () => {
  const db = freshDb()
  const values = [3, 2, 2, 3, 2, 2, 3, 2]
  values.forEach((value, index) => {
    save(db, addDays('2026-05-01', index), { energy: value })
  })
  save(db, '2026-05-10', { feeling: 2 }) // energy deliberately left out
  const estimates = estimatesFor(db, USER, '2026-05-10', getCheckin(db, USER, '2026-05-10'))
  assert.equal(estimates.available, true)
  const energy = estimates.estimates.find((item) => item.key === 'energy')
  assert.ok(energy)
  assert.ok(energy!.value >= 1 && energy!.value <= 5)
  assert.ok(energy!.range[0] <= energy!.value && energy!.value <= energy!.range[1])
  assert.match(energy!.basis, /typical for you on|recent average/)
})

test('estimates are only shown once they beat the best simple baseline', () => {
  const db = freshDb()
  // Enough per-field history to compute an estimate, but below the validation
  // minimum, so nothing is shown yet and the note says the data is too small.
  for (let i = 0; i < 8; i += 1) save(db, addDays('2026-05-01', i), { energy: 2 })
  save(db, '2026-05-10', { feeling: 2 })
  const estimates = estimatesFor(db, USER, '2026-05-10', getCheckin(db, USER, '2026-05-10'))
  assert.equal(estimates.available, true, 'an estimate can be computed')
  assert.equal(estimates.shown, false, 'but it must not be shown before it is validated')
  assert.equal(estimates.beatsBaseline, null)
  assert.match(estimates.evaluationNote, /Not enough history/i)
  assert.ok(estimates.reason)
})

test('estimates are never written back into the check-in record', () => {
  const db = freshDb()
  for (let i = 0; i < 8; i += 1) save(db, addDays('2026-05-01', i), { energy: 2 })
  save(db, '2026-05-10', { feeling: 2 })
  const before = getCheckin(db, USER, '2026-05-10')!
  const state = dailyState(db, USER, '2026-05-10', '2026-05-11')
  assert.equal(state.estimates.available, true)
  const after = getCheckin(db, USER, '2026-05-10')!
  for (const key of CHECKIN_ANSWER_KEYS) {
    assert.equal(after[key], before[key], `${key} must be untouched by estimates`)
  }
  assert.equal(after.energy, null)
})

test('estimates never change the readiness score (display-only)', () => {
  const db = freshDb()
  for (let i = 0; i < 8; i += 1) save(db, addDays('2026-05-01', i), { energy: 2 })
  save(db, '2026-05-10', { feeling: 2 })
  const withEstimates = dailyState(db, USER, '2026-05-10', '2026-05-11')
  // Turning estimates off changes nothing about the score or the summary.
  saveStatePrefs(db, USER, { showEstimates: false })
  const withoutEstimates = dailyState(db, USER, '2026-05-10', '2026-05-11')
  assert.equal(withEstimates.summary.readiness.score, withoutEstimates.summary.readiness.score)
  assert.deepEqual(withEstimates.summary.readiness.subScores, withoutEstimates.summary.readiness.subScores)
  assert.equal(withoutEstimates.estimates.shown, false)
})

// ---------------------------------------------------------------------------
// Mid-day edit
// ---------------------------------------------------------------------------

test('editing the check-in recomputes the summary and keeps the history', () => {
  const db = freshDb()
  save(db, '2026-05-10', { feeling: 3, energy: 3, sleep: 3 })
  const first = dailyState(db, USER, '2026-05-10', '2026-05-11')
  const historyBefore = listCheckinHistory(db, USER, 50).length

  // Mid-day edit: more answers, at the better end.
  save(db, '2026-05-10', { feeling: 1, energy: 1, sleep: 1, motivation: 1, focus: 1, body: 1 })
  const second = dailyState(db, USER, '2026-05-10', '2026-05-11')

  assert.notEqual(first.summary.readiness.score, second.summary.readiness.score)
  assert.ok(second.summary.readiness.score! > first.summary.readiness.score!)
  assert.equal(second.summary.readiness.answered, 6)
  assert.ok(listCheckinHistory(db, USER, 50).length > historyBefore)
})

// ---------------------------------------------------------------------------
// Days like today
// ---------------------------------------------------------------------------

test('days-like-today shows nothing with too few similar days', () => {
  const db = freshDb()
  addTask(db, { text: 'Read a book' })
  save(db, '2026-05-08', { feeling: 2, energy: 2, sleep: 2, focus: 2, motivation: 2 })
  save(db, '2026-05-09', { feeling: 2, energy: 2, sleep: 2, focus: 2, motivation: 2 })
  save(db, '2026-05-10', { feeling: 2, energy: 2, sleep: 2, focus: 2, motivation: 2 })
  const result = similarDays(db, USER, '2026-05-10', '2026-05-10', getCheckin(db, USER, '2026-05-10'))
  assert.equal(result.available, false)
  assert.equal(result.line, null)
})

test('days-like-today uses only labelled past days, never pending ones', () => {
  const db = freshDb()
  const taskId = addTask(db, { text: 'Read a book', duration: 30 })
  const full = { feeling: 2, energy: 2, sleep: 2, focus: 2, motivation: 2, body: 2 }
  for (let i = 1; i <= 8; i += 1) {
    const date = addDays('2026-05-10', -i)
    save(db, date, full)
    logSession(db, taskId, date)
  }
  save(db, '2026-05-10', full)
  const result = similarDays(db, USER, '2026-05-10', '2026-05-10', getCheckin(db, USER, '2026-05-10'))
  assert.equal(result.available, true)
  assert.ok(result.dayCount >= 5)
  for (const day of result.days) assert.ok(day.date < '2026-05-10', 'pending/today must never be a similar day')
  const read = result.tasks.find((task) => task.id === taskId)!
  assert.equal(read.performedDays, read.consideredDays)
  assert.match(result.line ?? '', /Read a book/)
})

test('days-like-today needs enough overlapping answers to compare a day', () => {
  const db = freshDb()
  addTask(db, { text: 'Read a book' })
  // Only one overlapping field, below the minimum.
  for (let i = 1; i <= 8; i += 1) save(db, addDays('2026-05-10', -i), { feeling: 2 })
  save(db, '2026-05-10', { feeling: 2, energy: 2, sleep: 2, focus: 2, motivation: 2 })
  const result = similarDays(db, USER, '2026-05-10', '2026-05-10', getCheckin(db, USER, '2026-05-10'))
  assert.equal(result.available, false)
})

// ---------------------------------------------------------------------------
// Recent-days context
// ---------------------------------------------------------------------------

test('a trend is shown only when the change is clear', () => {
  const db = freshDb()
  // The three most recent days are low-capacity; the week before is high.
  for (let i = 1; i <= 3; i += 1) save(db, addDays('2026-05-10', -i), { free_time: 5, workload: 5, stress: 5 })
  for (let i = 4; i <= 10; i += 1) save(db, addDays('2026-05-10', -i), { free_time: 1, workload: 1, stress: 1 })
  const context = recentContext(db, USER, '2026-05-10')
  const capacity = context.trends.find((trend) => trend.name === 'capacity')!
  assert.equal(capacity.direction, 'falling')
  assert.ok(capacity.line)
  assert.ok(context.lines.some((line) => /Capacity has been lower/i.test(line)))
})

test('a steady stretch produces no pattern lines', () => {
  const db = freshDb()
  for (let i = 1; i <= 10; i += 1) save(db, addDays('2026-05-10', -i), { feeling: 3, energy: 3, sleep: 3 })
  const context = recentContext(db, USER, '2026-05-10')
  assert.equal(context.available, false)
  assert.equal(context.lines.length, 0)
})

test('a run of the same low field is reported as a streak', () => {
  const db = freshDb()
  for (let i = 1; i <= 5; i += 1) save(db, addDays('2026-05-10', -i), { sleep: 5, energy: 3 })
  const context = recentContext(db, USER, '2026-05-10')
  assert.ok(context.streaks.some((streak) => streak.key === 'sleep' && streak.days >= 3))
  assert.ok(context.lines.some((line) => /poor sleep/i.test(line)))
})

// ---------------------------------------------------------------------------
// End-of-day review
// ---------------------------------------------------------------------------

test('the evening review is stored separately and never overwrites the morning', () => {
  const db = freshDb()
  save(db, '2026-05-10', { feeling: 2, energy: 2, sleep: 2 })
  const morning = getCheckin(db, USER, '2026-05-10')!

  saveDayReview(db, USER, '2026-05-10', 'worse')
  const review = getDayReview(db, USER, '2026-05-10')
  assert.equal(review?.answer, 'worse')

  const after = getCheckin(db, USER, '2026-05-10')!
  assert.equal(after.feeling, morning.feeling)
  assert.equal(after.energy, morning.energy)
  assert.equal(after.sleep, morning.sleep)
  assert.equal(after.updated_at, morning.updated_at)
})

test('a second review the same day updates the one row and stays one row', () => {
  const db = freshDb()
  saveDayReview(db, USER, '2026-05-10', 'better')
  saveDayReview(db, USER, '2026-05-10', 'much_better')
  const reviews = listDayReviews(db, USER)
  assert.equal(reviews.length, 1)
  assert.equal(reviews[0].answer, 'much_better')
})

test('a missing review stays missing', () => {
  const db = freshDb()
  assert.equal(getDayReview(db, USER, '2026-05-10'), undefined)
})

test('review alignment is honest about small samples', () => {
  const db = freshDb()
  save(db, '2026-05-09', { feeling: 2, energy: 2, sleep: 2, focus: 2, motivation: 2, body: 2 })
  saveDayReview(db, USER, '2026-05-09', 'better')
  const alignment = reviewAlignment(db, USER, '2026-05-10')
  assert.equal(alignment.correlation, null)
  assert.match(alignment.note, /Not enough/i)
})

// ---------------------------------------------------------------------------
// Turn on only when data allows
// ---------------------------------------------------------------------------

test('per-tag weights and smarter estimates stay off below the minimum', () => {
  const db = freshDb()
  save(db, '2026-05-10', { feeling: 3, energy: 3, sleep: 3 })
  const state = dailyState(db, USER, '2026-05-10', '2026-05-11')
  assert.equal(state.advanced.perTagWeights.enabled, false)
  assert.match(state.advanced.perTagWeights.reason, /stay off/i)
  assert.equal(state.advanced.smarterEstimates.enabled, false)
})

test('low-capacity suggestions stay off below the minimum labelled days', () => {
  const db = freshDb()
  addTask(db, { text: 'Read a book' })
  // A genuinely low-capacity day, but nowhere near enough labelled days.
  save(db, '2026-05-10', { free_time: 5, workload: 5, stress: 5 })
  const state = dailyState(db, USER, '2026-05-10', '2026-05-11')
  const capacity = state.summary.readiness.subScores.find((sub) => sub.name === 'capacity')!
  assert.ok(capacity.score !== null && capacity.score <= 40)
  assert.equal(state.advanced.lowCapacity.enabled, false)
  assert.match(state.advanced.lowCapacity.reason, new RegExp(String(MIN_SUGGESTION_DAYS)))
})

test('low-capacity suggestions are offered, never forced, on a low day with enough history', () => {
  const db = freshDb()
  const taskId = addTask(db, { text: 'Read a book', duration: 30 })
  const full = { feeling: 2, energy: 2, sleep: 2, focus: 2, motivation: 2, body: 2 }
  for (let i = 1; i <= 16; i += 1) {
    const date = addDays('2026-05-10', -i)
    save(db, date, { ...full, free_time: 5, workload: 5, stress: 5 })
    logSession(db, taskId, date)
  }
  save(db, '2026-05-10', { ...full, free_time: 5, workload: 5, stress: 5 })
  const state = dailyState(db, USER, '2026-05-10', '2026-05-10')
  assert.equal(state.advanced.lowCapacity.enabled, true)
  assert.ok(state.advanced.lowCapacity.suggestions.length > 0)
  assert.match(state.advanced.lowCapacity.reason, /never|offered/i)
})

// ---------------------------------------------------------------------------
// Preferences and plumbing
// ---------------------------------------------------------------------------

test('preferences default to shown and can be turned off', () => {
  const db = freshDb()
  assert.deepEqual(getStatePrefs(db, USER), { showSummary: true, showEstimates: true })
  saveStatePrefs(db, USER, { showSummary: false })
  assert.deepEqual(getStatePrefs(db, USER), { showSummary: false, showEstimates: true })
})

test('the completion rate counts only labelled tasks and ignores pending days', () => {
  const db = freshDb()
  const taskId = addTask(db, { text: 'Read a book', duration: 30 })
  save(db, '2026-05-10', { feeling: 2 })
  assert.equal(completionRateForDate(db, USER, '2026-05-10', '2026-05-11'), null)
  logSession(db, taskId, '2026-05-10')
  assert.equal(completionRateForDate(db, USER, '2026-05-10', '2026-05-11'), 1)
  // The same day, before it is over, is pending and has no rate.
  assert.equal(completionRateForDate(db, USER, '2026-05-10', '2026-05-10'), null)
})
