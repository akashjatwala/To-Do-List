import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { createCheckinSchema } from '../checkins-store'
import { createFoundationSchema, createPredictionSchema } from './schema'
import {
  DEFAULT_PREDICTION_SETTINGS,
  addDays,
  createOffDay,
  deleteOffDay,
  diffDays,
  getOffDay,
  getPredictionSettings,
  isOffDay,
  listOffDays,
  offDayContext,
  offDayDates,
  parseOffDayInput,
  savePredictionSettings,
  updateOffDay,
} from './off-days'
import { dailyActivity, setDailyStatus } from './daily-activity'
import { createSession } from './sessions'
import { recordTaskConfig } from './task-config'

const USER = 1

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
  createPredictionSchema(db)
  return db
}

function insertTask(db: DatabaseSync, duration: number | null = 60): string {
  const id = randomUUID()
  db.prepare(
    `INSERT INTO tasks (id, user_id, text, created_at, priority, tags, recurrence, duration)
     VALUES (?, ?, 'Read', 1, 'none', '[]', 'none', ?)`,
  ).run(id, USER, duration)
  recordTaskConfig(
    db,
    {
      id,
      user_id: USER,
      text: 'Read',
      priority: 'none',
      tags: '[]',
      recurrence: 'none',
      recurrence_config: null,
      duration,
      preferred_time: null,
    },
    [],
    Date.parse('2026-01-01T00:00:00'),
  )
  return id
}

test('off-day records: single day, no reason, edit and remove', () => {
  const db = freshDb()

  // "Off" with no reason must work: kind stays null.
  const created = createOffDay(db, USER, { kind: null, startDate: '2026-03-02', endDate: '2026-03-02', note: null })
  assert.equal(created.kind, null)
  assert.equal(created.start_date, '2026-03-02')
  assert.equal(created.end_date, '2026-03-02')
  assert.equal(isOffDay(db, USER, '2026-03-02'), true)
  assert.equal(isOffDay(db, USER, '2026-03-03'), false)

  // Edit in place.
  const edited = updateOffDay(db, USER, created.id, {
    kind: 'sick',
    startDate: '2026-03-02',
    endDate: '2026-03-04',
    note: 'flu',
  })!
  assert.equal(edited.kind, 'sick')
  assert.equal(edited.end_date, '2026-03-04')
  assert.equal(edited.note, 'flu')
  assert.equal(isOffDay(db, USER, '2026-03-03'), true)
  assert.equal(listOffDays(db, USER).length, 1)

  // Removing restores the day.
  assert.equal(deleteOffDay(db, USER, created.id), true)
  assert.equal(isOffDay(db, USER, '2026-03-03'), false)
  assert.equal(listOffDays(db, USER).length, 0)
  assert.equal(getOffDay(db, USER, created.id), undefined)
})

test('off-day records are user-scoped', () => {
  const db = freshDb()
  db.exec("INSERT INTO users (id, email) VALUES (2, 'other@example.com')")
  const mine = createOffDay(db, USER, { kind: 'holiday', startDate: '2026-04-01', endDate: '2026-04-01', note: null })
  assert.equal(listOffDays(db, 2).length, 0)
  assert.equal(updateOffDay(db, 2, mine.id, { kind: null, startDate: '2026-04-01', endDate: '2026-04-01', note: null }), undefined)
  assert.equal(deleteOffDay(db, 2, mine.id), false)
  assert.equal(listOffDays(db, USER).length, 1)
})

test('offDayDates expands a range and clips to the window', () => {
  const db = freshDb()
  createOffDay(db, USER, { kind: null, startDate: '2026-05-01', endDate: '2026-05-03', note: null })
  createOffDay(db, USER, { kind: 'travel', startDate: '2026-05-10', endDate: '2026-05-10', note: null })
  const dates = offDayDates(db, USER, '2026-05-02', '2026-05-10')
  assert.deepEqual([...dates].sort(), ['2026-05-02', '2026-05-03', '2026-05-10'])
})

test('reduced confidence follows an off period and expires', () => {
  const db = freshDb()
  createOffDay(db, USER, { kind: 'travel', startDate: '2026-06-01', endDate: '2026-06-03', note: null })
  const settings = { reducedConfidenceDays: 3, explorationShare: 0.1, stage2MinDays: 10 }

  const onDay = offDayContext(db, USER, '2026-06-02', settings)
  assert.equal(onDay.onOffDay, true)
  assert.equal(onDay.reducedConfidence, false)

  for (const [date, expected] of [
    ['2026-06-04', true],
    ['2026-06-06', true],
    ['2026-06-07', false],
  ] as const) {
    const context = offDayContext(db, USER, date, settings)
    assert.equal(context.onOffDay, false, date)
    assert.equal(context.reducedConfidence, expected, date)
  }
  assert.equal(offDayContext(db, USER, '2026-06-04', settings).daysSinceOff, 1)
})

test('prediction settings default and persist', () => {
  const db = freshDb()
  assert.deepEqual(getPredictionSettings(db, USER), DEFAULT_PREDICTION_SETTINGS)
  const saved = savePredictionSettings(db, USER, { reducedConfidenceDays: 5 })
  assert.equal(saved.reducedConfidenceDays, 5)
  assert.equal(saved.explorationShare, DEFAULT_PREDICTION_SETTINGS.explorationShare)
  assert.deepEqual(getPredictionSettings(db, USER), saved)
})

test('an off day never writes a negative label and keeps recorded work', () => {
  const db = freshDb()
  const taskId = insertTask(db, 60)
  createOffDay(db, USER, { kind: 'sick', startDate: '2026-07-01', endDate: '2026-07-01', note: null })

  // Past off day with no data: still unknown, never skipped.
  const empty = dailyActivity(db, USER, taskId, '2026-07-01', '2026-07-05')
  assert.equal(empty.offDay, true)
  assert.equal(empty.offDayKind, 'sick')
  assert.equal(empty.status, 'unknown')

  // Work done on an off day is kept and flagged, not erased.
  createSession(db, USER, {
    taskId,
    localDate: '2026-07-01',
    startedAt: Date.parse('2026-07-01T09:00:00'),
    endedAt: null,
    durationMinutes: 45,
    note: null,
  })
  const done = dailyActivity(db, USER, taskId, '2026-07-01', '2026-07-05')
  assert.equal(done.offDay, true)
  assert.equal(done.totalMinutes, 45)
  assert.equal(done.performed, true)
  assert.equal(done.status, 'partial')

  // Marking off never touches an explicit status already recorded.
  setDailyStatus(db, USER, taskId, '2026-07-01', 'completed', null)
  const stated = dailyActivity(db, USER, taskId, '2026-07-01', '2026-07-05')
  assert.equal(stated.status, 'completed')
  assert.equal(stated.offDay, true)
})

test('parseOffDayInput validates dates, order, kind and note', () => {
  assert.deepEqual(parseOffDayInput({ startDate: '2026-08-01' }), {
    kind: null,
    startDate: '2026-08-01',
    endDate: '2026-08-01',
    note: null,
  })
  assert.deepEqual(parseOffDayInput({ kind: 'holiday', startDate: '2026-08-01', endDate: '2026-08-03', note: '  ' }), {
    kind: 'holiday',
    startDate: '2026-08-01',
    endDate: '2026-08-03',
    note: null,
  })
  assert.equal(parseOffDayInput({ startDate: '2026-08-03', endDate: '2026-08-01' }), null)
  assert.equal(parseOffDayInput({ startDate: 'not-a-date' }), null)
  assert.equal(parseOffDayInput({ kind: 'vacation', startDate: '2026-08-01' }), null)
  assert.equal(parseOffDayInput({ startDate: '2026-08-01', note: 'x'.repeat(501) }), null)
})

test('date helpers are pure and DST-safe', () => {
  assert.equal(diffDays('2026-03-01', '2026-03-08'), 7)
  assert.equal(addDays('2026-02-28', 1), '2026-03-01')
  assert.equal(addDays('2026-12-31', 1), '2027-01-01')
  assert.equal(addDays('2026-03-29', -1), '2026-03-28')
})
