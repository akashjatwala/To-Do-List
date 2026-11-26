import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { createCheckinSchema } from '../checkins-store'
import { createFoundationSchema, createPredictionSchema, createStateSchema } from './schema'
import { createSession } from './sessions'
import { setDailyStatus } from './daily-activity'
import { createOffDay } from './off-days'
import { rescheduleSuggestions } from './reschedule'

const USER = 1
const DATE = '2026-06-30'

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
      recurrence_config TEXT
    )
  `)
  createCheckinSchema(db)
  createFoundationSchema(db)
  createStateSchema(db)
  createPredictionSchema(db)
  return db
}

function insertTask(db: DatabaseSync, text = 'Write report'): string {
  const id = randomUUID()
  db.prepare('INSERT INTO tasks (id, user_id, text, created_at) VALUES (?, ?, ?, 1)').run(id, USER, text)
  return id
}

function session(db: DatabaseSync, taskId: string, date: string): void {
  const [year, month, day] = date.split('-').map(Number)
  const startedAt = new Date(year, month - 1, day, 10, 0, 0, 0).getTime()
  createSession(db, USER, {
    taskId,
    localDate: date,
    startedAt,
    endedAt: startedAt + 30 * 60_000,
    durationMinutes: 30,
    note: null,
  })
}

function suggest(db: DatabaseSync, date = DATE) {
  return rescheduleSuggestions(db, USER, { date, today: DATE })
}

test('nothing is suggested when no task was recently skipped or postponed', () => {
  const db = freshDb()
  insertTask(db)
  const result = suggest(db)
  assert.equal(result.available, false)
  assert.equal(result.suggestions.length, 0)
})

test('a postponed task gets a future day and time, and off days are ruled out', () => {
  const db = freshDb()
  const task = insertTask(db)
  setDailyStatus(db, USER, task, '2026-06-28', 'postponed', null)
  // Thursdays have gone well for this task before.
  for (const date of ['2026-06-25', '2026-06-18', '2026-06-11']) session(db, task, date)
  // The first candidate day is away.
  createOffDay(db, USER, { kind: 'travel', startDate: '2026-07-01', endDate: '2026-07-01', note: null })

  const result = suggest(db)
  assert.equal(result.available, true)
  assert.equal(result.suggestions.length, 1)
  const suggestion = result.suggestions[0]
  assert.equal(suggestion.taskId, task)
  assert.equal(suggestion.skippedKind, 'postponed')
  assert.equal(suggestion.suggestedDate, '2026-07-02')
  assert.ok(suggestion.suggestedStart !== null && suggestion.suggestedEnd !== null)
  assert.match(suggestion.reason, /postponed/)
  assert.match(suggestion.reason, /nothing was moved/)
  // The proposal never rewrites the task.
  const row = db.prepare('SELECT done, due FROM tasks WHERE id = ?').get(task) as { done: number; due: null }
  assert.equal(row.done, 0)
  assert.equal(row.due, null)
})

test('a previous answer hides the same suggestion for that day', () => {
  const db = freshDb()
  const task = insertTask(db)
  setDailyStatus(db, USER, task, '2026-06-29', 'skipped', null)
  db.prepare(
    `INSERT INTO state_suggestion_choices (user_id, local_date, suggestion_key, choice, created_at)
     VALUES (?, ?, ?, 'dismissed', 1)`,
  ).run(USER, DATE, `reschedule:${task}`)

  const result = suggest(db)
  assert.equal(result.available, false)
  assert.equal(result.suggestions.length, 0)
})

test('a past day has no reschedule ideas', () => {
  const db = freshDb()
  const task = insertTask(db)
  setDailyStatus(db, USER, task, '2026-06-20', 'skipped', null)
  const result = suggest(db, '2026-06-29')
  assert.equal(result.available, false)
  assert.equal(result.suggestions.length, 0)
})
