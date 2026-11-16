import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import {
  CHECKIN_ANSWER_KEYS,
  checkinState,
  createCheckinSchema,
  deleteCheckins,
  getCheckin,
  listCheckinHistory,
  listCheckins,
  parseAnswer,
  parseContext,
  parseLocalDate,
  saveCheckin,
  skipCheckin,
  type CheckinAnswerKey,
} from './checkins-store'
import { localDateString } from '../src/lib/checkin'

const USER = 1

/** A throwaway in-memory database — never the real app database. */
function freshDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT)')
  db.exec("INSERT INTO users (email) VALUES ('me@example.com')")
  createCheckinSchema(db)
  return db
}

/** Build a full nine-key answer set, defaulting every untouched answer to null. */
function answers(
  overrides: Partial<Record<CheckinAnswerKey, number | null>> = {},
): Record<CheckinAnswerKey, number | null> {
  const full = {} as Record<CheckinAnswerKey, number | null>
  for (const key of CHECKIN_ANSWER_KEYS) full[key] = overrides[key] ?? null
  return full
}

test('a day with no record is "not asked"', () => {
  const db = freshDb()
  assert.equal(getCheckin(db, USER, '2026-05-01'), undefined)
})

test('answering all nine questions completes the day', () => {
  const db = freshDb()
  const row = saveCheckin(db, USER, {
    date: '2026-05-01',
    answers: answers({
      feeling: 2,
      energy: 3,
      motivation: 4,
      sleep: 2,
      stress: 3,
      free_time: 4,
      focus: 3,
      body: 2,
      workload: 4,
    }),
    context: null,
  })
  assert.equal(checkinState(row), 'completed')
})

test('partial answers are kept and missing stays missing', () => {
  const db = freshDb()
  const row = saveCheckin(db, USER, {
    date: '2026-05-02',
    answers: answers({ feeling: 5, energy: 1 }),
    context: null,
  })
  assert.equal(checkinState(row), 'partial')
  assert.equal(row.feeling, 5)
  assert.equal(row.energy, 1)
  assert.equal(row.sleep, null)
  assert.equal(row.workload, null)
})

test('skipping records a skip and never fills in neutral answers', () => {
  const db = freshDb()
  const row = skipCheckin(db, USER, '2026-05-03')
  assert.equal(checkinState(row), 'skipped')
  assert.equal(row.skipped, 1)
  for (const key of CHECKIN_ANSWER_KEYS) assert.equal(row[key], null)
})

test('skipping after answering clears the answers', () => {
  const db = freshDb()
  saveCheckin(db, USER, {
    date: '2026-05-04',
    answers: answers({ feeling: 1 }),
    context: 'a note',
  })
  const row = skipCheckin(db, USER, '2026-05-04')
  assert.equal(row.skipped, 1)
  assert.equal(row.feeling, null)
  assert.equal(row.context, null)
})

test('once per day: a saved day is read back unchanged', () => {
  const db = freshDb()
  saveCheckin(db, USER, {
    date: '2026-05-05',
    answers: answers({ feeling: 3 }),
    context: null,
  })
  const again = getCheckin(db, USER, '2026-05-05')
  assert.ok(again)
  assert.equal(again.feeling, 3)
})

test('a same-day edit updates values and keeps an append-only history', () => {
  const db = freshDb()
  const first = saveCheckin(db, USER, {
    date: '2026-05-06',
    answers: answers({ feeling: 4 }),
    context: null,
  })
  const before = Date.now()
  const second = saveCheckin(db, USER, {
    date: '2026-05-06',
    answers: answers({ feeling: 2, energy: 5 }),
    context: 'changed my mind',
  })

  assert.equal(second.feeling, 2)
  assert.equal(second.energy, 5)
  assert.equal(second.context, 'changed my mind')
  // Same record, same creation time, newer update time.
  assert.equal(second.id, first.id)
  assert.equal(second.created_at, first.created_at)
  assert.ok(second.updated_at >= before)
  assert.ok(second.updated_at >= first.updated_at)

  const history = listCheckinHistory(db, USER, 10)
  assert.equal(history.length, 2)
  assert.equal(history[0].feeling, 2) // newest first
  assert.equal(history[1].feeling, 4)
})

test('a new local day starts fresh', () => {
  const db = freshDb()
  saveCheckin(db, USER, {
    date: '2026-05-07',
    answers: answers({
      feeling: 1,
      energy: 1,
      motivation: 1,
      sleep: 1,
      stress: 1,
      free_time: 1,
      focus: 1,
      body: 1,
      workload: 1,
    }),
    context: null,
  })
  const completed = getCheckin(db, USER, '2026-05-07')
  assert.ok(completed)
  assert.equal(checkinState(completed), 'completed')
  assert.equal(getCheckin(db, USER, '2026-05-08'), undefined)
})

test('the local date comes from the local calendar, not UTC', () => {
  // Late evening local time is still that local day, even if UTC has rolled over.
  assert.equal(localDateString(new Date(2026, 0, 1, 23, 30, 0)), '2026-01-01')
  assert.equal(localDateString(new Date(2026, 0, 2, 0, 30, 0)), '2026-01-02')
})

test('deleting history removes every check-in and its edit trail', () => {
  const db = freshDb()
  saveCheckin(db, USER, { date: '2026-05-09', answers: answers({ feeling: 3 }), context: null })
  saveCheckin(db, USER, { date: '2026-05-09', answers: answers({ feeling: 4 }), context: null })
  saveCheckin(db, USER, { date: '2026-05-10', answers: answers({ feeling: 2 }), context: null })

  assert.equal(listCheckins(db, USER, 10).length, 2)
  deleteCheckins(db, USER)
  assert.equal(listCheckins(db, USER, 10).length, 0)
  assert.equal(listCheckinHistory(db, USER, 10).length, 0)
})

test('validation helpers reject malformed input', () => {
  assert.equal(parseAnswer(3), 3)
  assert.equal(parseAnswer(undefined), null)
  assert.equal(parseAnswer(null), null)
  assert.equal(parseAnswer(0), undefined)
  assert.equal(parseAnswer(6), undefined)
  assert.equal(parseAnswer(2.5), undefined)
  assert.equal(parseAnswer('3'), undefined)

  assert.equal(parseLocalDate('2026-05-01'), '2026-05-01')
  assert.equal(parseLocalDate('2026-13-01'), null)
  assert.equal(parseLocalDate('2026-02-30'), null)
  assert.equal(parseLocalDate('01-05-2026'), null)
  assert.equal(parseLocalDate(undefined), null)

  assert.equal(parseContext('  hi  '), 'hi')
  assert.equal(parseContext(''), null)
  assert.equal(parseContext(undefined), null)
  assert.equal(parseContext(42), undefined)
  assert.equal(parseContext('x'.repeat(501)), undefined)
})
