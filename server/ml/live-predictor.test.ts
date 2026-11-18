import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { createCheckinSchema } from '../checkins-store'
import { createFoundationSchema, createMlSchema, createPredictionSchema } from './schema'
import { recordTaskConfig } from './task-config'
import { createSession } from './sessions'
import { setDailyStatus } from './daily-activity'
import { addDays } from './off-days'
import { buildTrainingSet } from './dataset'
import { trainClassifier } from './training'
import { promoteCandidate, registerModel } from './registry'
import { userCompletionPrior } from './statistics'
import {
  buildPlan,
  predictTask,
  type PredictContext,
  type TaskPredictor,
} from './predictors'
import { makeLivePredictor } from './live-predictor'

/**
 * Tests for the live prediction entry point and its injection into plans.
 *
 * These use the same in-memory setup as the model tests so a real champion can
 * be trained and served. Nothing here is an accuracy claim — it only checks the
 * wiring: model served when present, baseline otherwise, and the kill switch.
 */

const USER = 1
const CONFIG_FROM = Date.parse('2025-01-01T00:00:00')

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
  createMlSchema(db)
  return db
}

function insertTask(db: DatabaseSync, text = 'Read', duration = 60): string {
  const id = randomUUID()
  db.prepare(
    `INSERT INTO tasks (id, user_id, text, created_at, priority, tags, recurrence, duration)
     VALUES (?, ?, ?, 1, 'none', '[]', 'none', ?)`,
  ).run(id, USER, text, duration)
  recordTaskConfig(
    db,
    {
      id,
      user_id: USER,
      text,
      priority: 'none',
      tags: '[]',
      recurrence: 'none',
      recurrence_config: null,
      duration,
      preferred_time: null,
    },
    [],
    CONFIG_FROM,
  )
  return id
}

function addSession(db: DatabaseSync, taskId: string, date: string, minutes: number, startHour: number): void {
  const [year, month, day] = date.split('-').map(Number)
  const startedAt = new Date(year, month - 1, day, startHour, 0, 0, 0).getTime()
  createSession(db, USER, {
    taskId,
    localDate: date,
    startedAt,
    endedAt: startedAt + minutes * 60_000,
    durationMinutes: minutes,
    note: null,
  })
}

function setStatus(db: DatabaseSync, taskId: string, date: string, status: 'completed' | 'skipped'): void {
  setDailyStatus(db, USER, taskId, date, status, null)
}

function contextFor(db: DatabaseSync, taskId: string, today: string): PredictContext {
  return {
    date: today,
    today,
    nowMinutes: 480,
    checkinState: 'not_asked',
    answers: null,
    settings: { reducedConfidenceDays: 3, explorationShare: 0, stage2MinDays: 3 },
    priorRate: userCompletionPrior(db, USER, [taskId], today),
  }
}

/** Train and promote a real completion champion, reusing the model-test fixture. */
function champion(db: DatabaseSync, taskId: string, from: string, to: string, today: string): void {
  const dates = Array.from({ length: 12 }, (_, i) => addDays(from, i))
  dates.forEach((date, i) => setStatus(db, taskId, date, i % 3 === 0 ? 'skipped' : 'completed'))
  addSession(db, taskId, dates[1], 45, 9)
  const set = buildTrainingSet(db, USER, [taskId], from, to, today)
  const artifact = trainClassifier(set, 'completion')
  const model = registerModel(db, USER, {
    kind: 'completion',
    version: 'v1',
    trainFrom: from,
    trainTo: to,
    dataCount: set.rows.length,
    labelledCount: set.labelledCount,
    featureNames: set.featureNames,
    metrics: { type: 'logistic', brier: 0.15, ece: 0.05, baselineBrier: 0.2 },
    payload: artifact,
  })
  assert.equal(promoteCandidate(db, USER, model.id).ok, true)
}

test('live predictor: serves the champion when one is registered', () => {
  const db = freshDb()
  const task = insertTask(db)
  const from = '2026-01-01'
  const to = '2026-01-12'
  const today = '2026-01-13'
  champion(db, task, from, to, today)

  const result = makeLivePredictor(false)(db, USER, task, contextFor(db, task, today))
  assert.ok(result)
  // `source` alone is not decisive: the phase-4 baseline also says 'model' at
  // stage 2. The champion version and the appended explanation prove it served.
  assert.equal(result.modelVersion, 'v1')
  assert.match(result.explanation, /Served by model v1/)
  db.close()
})

test('live predictor: falls back to the baseline with no champion', () => {
  const db = freshDb()
  const task = insertTask(db)
  const today = '2026-02-01'

  const result = makeLivePredictor(false)(db, USER, task, contextFor(db, task, today))
  assert.ok(result)
  assert.equal(result.source, 'baseline')
  db.close()
})

test('live predictor: the kill switch keeps baseline-only behaviour', () => {
  const db = freshDb()
  const task = insertTask(db)
  const from = '2026-01-01'
  const to = '2026-01-12'
  const today = '2026-01-13'
  champion(db, task, from, to, today)
  const ctx = contextFor(db, task, today)
  const expected = predictTask(db, USER, task, ctx)

  const result = makeLivePredictor(true)(db, USER, task, ctx)
  assert.ok(result)
  // With the switch on, the output must be exactly the baseline — no champion
  // version, no "Served by model" note, no health logging.
  assert.deepEqual(result, expected)
  db.close()
})

test('buildPlan: routes every open task through the injected predictor', () => {
  const db = freshDb()
  insertTask(db)
  const today = '2026-01-13'
  let calls = 0
  const spy: TaskPredictor = (db, userId, taskId, ctx, options) => {
    calls += 1
    const prediction = predictTask(db, userId, taskId, ctx, options)
    return prediction ? { ...prediction, explanation: 'injected' } : null
  }

  const plan = buildPlan(db, USER, today, today, 480, 'completed', { predict: spy })
  assert.equal(calls, 1)
  assert.equal(plan.entries.length, 1)
  assert.equal(plan.entries[0].prediction.explanation, 'injected')
  db.close()
})
