import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { CHECKIN_ANSWER_KEYS, createCheckinSchema, getCheckinAsOf } from '../checkins-store'
import { createFoundationSchema, createMlSchema, createPredictionSchema, createStateSchema } from './schema'
import { configForDate } from './task-config'
import { addDays } from './off-days'
import { buildTrainingSet } from './dataset'
import { epochAtMinute } from './predictors'
import {
  backtestDemoData,
  createDemoUser,
  generateDemoHistory,
  type DemoDataResult,
} from './demo-data'

/**
 * Demo-data generator tests.
 *
 * The generated history is synthetic, so these tests check the *plumbing*: the
 * rows go through the real stores, are reconstructable at old cutoffs, and can
 * be scored on a genuine later window. No number here is an accuracy claim.
 */

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL DEFAULT '',
      password_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `)
  db.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      team_id TEXT,
      text TEXT NOT NULL,
      done INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      completed_at INTEGER,
      completed_by INTEGER,
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
  createMlSchema(db)
  return db
}

function demoUser(db: DatabaseSync): number {
  const result = db
    .prepare('INSERT INTO users (email, name, password_hash, created_at) VALUES (?, ?, ?, ?)')
    .run('demo@test.example', 'Demo', 'not-a-login-test', Date.now())
  return Number(result.lastInsertRowid)
}

function count(db: DatabaseSync, sql: string, ...args: Array<string | number>): number {
  return (db.prepare(sql).get(...args) as unknown as { n: number }).n
}

test('demo data: generated history uses the real stores and can be reconstructed at old cutoffs', () => {
  const db = freshDb()
  const userId = demoUser(db)
  const result = generateDemoHistory(db, userId, { days: 30, holdoutDays: 7, seed: 41, today: '2026-11-24' })

  assert.equal(result.from, '2026-10-25')
  assert.equal(result.to, '2026-11-23')
  assert.equal(result.holdoutFrom, '2026-11-17')
  assert.equal(result.counts.tasks, 6)
  assert.ok(result.counts.sessions > 0)
  assert.ok(result.counts.lateSessions > 0)
  assert.ok(result.counts.statuses > 0)
  assert.ok(result.counts.offDays >= 1)
  assert.ok(result.counts.checkins > 0)
  assert.ok(result.counts.checkinEdits > 0)
  assert.ok(result.counts.configVersions > result.counts.tasks)
  assert.ok(result.counts.outcomeLinks > 0)

  assert.ok(count(db, 'SELECT COUNT(*) AS n FROM checkin_history WHERE user_id = ?', userId) > result.counts.checkins)
  const late = count(
    db,
    "SELECT COUNT(*) AS n FROM activity_sessions WHERE user_id = ? AND source = 'generated-late'",
    userId,
  )
  assert.equal(late, result.counts.lateSessions)

  // A check-in edited at 10:15 must look different at 08:00 and 12:00.
  const editedDate = db
    .prepare(
      `SELECT date, MIN(recorded_at) AS first FROM checkin_history
       WHERE user_id = ? AND recorded_at >= ?
       GROUP BY date
       HAVING COUNT(*) > 1
       ORDER BY date
       LIMIT 1`,
    )
    .get(userId, epochAtMinute('2026-10-25', 8 * 60)) as unknown as { date: string } | undefined
  assert.ok(editedDate)
  const morning = getCheckinAsOf(db, userId, editedDate.date, epochAtMinute(editedDate.date, 8 * 60) - 1)
  const noon = getCheckinAsOf(db, userId, editedDate.date, epochAtMinute(editedDate.date, 12 * 60) - 1)
  assert.ok(morning && noon)
  assert.ok(
    CHECKIN_ANSWER_KEYS.some((key) => morning[key] !== noon[key]),
    'an edited check-in should look different before and after the edit',
  )

  // A dated config change is visible to training, not just the current task row.
  const changeDate = addDays(result.from, Math.floor(30 * 0.65))
  const before = configForDate(db, result.taskIds[1], addDays(changeDate, -1))
  const after = configForDate(db, result.taskIds[1], changeDate)
  assert.notEqual(before?.target_duration, after?.target_duration)

  const set = buildTrainingSet(db, userId, result.taskIds, result.from, result.to, result.today)
  assert.ok(set.rows.length > 0)
  assert.ok(set.rows.every((row) => row.date <= result.to))
  db.close()
})

test('demo data: backtest trains before the holdout and reports honest held-out metrics', () => {
  const db = freshDb()
  const userId = createDemoUser(db)
  const result: DemoDataResult = generateDemoHistory(db, userId, { days: 60, holdoutDays: 12, seed: 7, today: '2026-11-24' })
  const report = backtestDemoData(db, userId, result)

  assert.equal(report.trainTo, addDays(result.holdoutFrom, -1))
  assert.equal(report.holdoutTo, result.to)
  assert.ok(report.featureCount > 0)
  assert.deepEqual(report.predictionMinutes, [480, 720, 960, 1200])
  assert.ok(report.completion.n > 0)
  assert.ok(report.completion.modelBrier !== null && Number.isFinite(report.completion.modelBrier))
  assert.ok(report.completion.baselineBrier !== null && Number.isFinite(report.completion.baselineBrier))
  assert.ok(report.target.n > 0)
  assert.ok(report.duration.n > 0)
  assert.ok(report.duration.modelMae !== null && Number.isFinite(report.duration.modelMae))
  assert.ok(report.duration.baselineMae !== null && Number.isFinite(report.duration.baselineMae))
  db.close()
})
