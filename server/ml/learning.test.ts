import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { createCheckinSchema, saveCheckin, skipCheckin, CHECKIN_ANSWER_KEYS, type CheckinAnswerKey } from '../checkins-store'
import { createFoundationSchema, createMlSchema, createPredictionSchema } from './schema'
import { recordTaskConfig } from './task-config'
import { createSession } from './sessions'
import { setDailyStatus } from './daily-activity'
import { addDays } from './off-days'
import { DEFAULT_PREDICTION_MINUTE } from './features'
import { epochAtMinute } from './predictors'
import { championFor, promoteCandidate, registerModel, type RegistryMetrics } from './registry'
import {
  evaluateModelHealth,
  isFallbackActive,
  labelHealthPredictions,
  logHealthPrediction,
  modelHealthView,
  HEALTH_MIN_LABELLED,
} from './health'
import {
  lastRetrainAt,
  listOutcomeLinks,
  maybeRetrain,
  recordActivityOutcome,
  retrainStatus,
  tagLevelStatistics,
} from './learning'
import { configChangesForTask, rateDriftForTask } from './drift'
import { deleteCheckinHistory, privacySummary } from './privacy'
import { runScenarioSuite } from './scenarios'

/**
 * Continuous learning tests.
 *
 * These run the real continuous-learning, health, drift and privacy code on
 * small in-memory databases. They test the *machinery*: that recording stores
 * the linkage, that the retrain gate is rate-limited, that a deliberately
 * degraded model falls back to the baseline and that small noisy data does not
 * trigger a fallback, that a retrain clears the fallback, that drift is reported
 * as an association, and that deleting check-ins is real. No number here is an
 * accuracy claim.
 */

const USER = 1
const CONFIG_FROM = Date.parse('2025-01-01T00:00:00')

/** The cutoff used by training and serving for a local date. */
function preCutoff(date: string): number {
  return epochAtMinute(date, DEFAULT_PREDICTION_MINUTE) - 1
}

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

function taskLike(id: string, text: string, priority: string, duration: number | null) {
  return {
    id,
    user_id: USER,
    text,
    priority,
    tags: '[]',
    recurrence: 'none',
    recurrence_config: null,
    duration,
    preferred_time: null,
  }
}

function insertTask(db: DatabaseSync, options: { text?: string; duration?: number | null; priority?: string } = {}): string {
  const id = randomUUID()
  const text = options.text ?? 'Read'
  const duration = options.duration === undefined ? 60 : options.duration
  const priority = options.priority ?? 'none'
  db.prepare(
    `INSERT INTO tasks (id, user_id, text, created_at, priority, tags, recurrence, duration)
     VALUES (?, ?, ?, 1, ?, '[]', 'none', ?)`,
  ).run(id, USER, text, priority, duration)
  recordTaskConfig(db, taskLike(id, text, priority, duration), [], CONFIG_FROM)
  return id
}

function addSession(db: DatabaseSync, taskId: string, date: string, minutes: number, startHour = 7): void {
  const [year, month, day] = date.split('-').map(Number)
  const startedAt = new Date(year, month - 1, day, startHour, 0, 0, 0).getTime()
  createSession(db, USER, {
    taskId,
    localDate: date,
    startedAt,
    endedAt: startedAt + minutes * 60_000,
    durationMinutes: minutes,
    note: null,
  }, 'user', startedAt)
}

function reg(db: DatabaseSync, kind: 'completion' | 'target' | 'duration', version: string, metrics: RegistryMetrics) {
  return registerModel(db, USER, {
    kind,
    version,
    trainFrom: '2026-01-01',
    trainTo: '2026-06-01',
    dataCount: 100,
    labelledCount: 100,
    featureNames: ['f'],
    metrics,
    payload: { test: true },
  })
}

// ---------------------------------------------------------------------------
// Scenario suite
// ---------------------------------------------------------------------------

test('learning scenarios: every required situation behaves as specified', () => {
  const outcomes = runScenarioSuite()
  const failed = outcomes.filter((outcome) => !outcome.ok)
  assert.equal(outcomes.length, 16, 'the suite should cover all sixteen situations')
  assert.deepEqual(
    failed.map((outcome) => `${outcome.name}: ${outcome.detail}`),
    [],
  )
})

// ---------------------------------------------------------------------------
// Immediate learning: the linkage and per-tag statistics
// ---------------------------------------------------------------------------

test('learning learning: recording activity stores one linkage row and it is idempotent', () => {
  const db = freshDb()
  const task = insertTask(db)
  const date = '2026-06-01'
  addSession(db, task, date, 30)
  recordActivityOutcome(db, USER, task, date, '2026-06-02')
  recordActivityOutcome(db, USER, task, date, '2026-06-02')

  const links = listOutcomeLinks(db, USER, { taskId: task })
  assert.equal(links.length, 1)
  assert.equal(links[0].performed, 1)
  assert.equal(links[0].checkin_state, 'not_asked')
  db.close()
})

test('learning learning: a skipped day is linked as a real miss, an unrecorded day is not', () => {
  const db = freshDb()
  const task = insertTask(db)
  const skipped = '2026-06-01'
  const unrecorded = '2026-06-02'
  setDailyStatus(db, USER, task, skipped, 'skipped', null)
  recordActivityOutcome(db, USER, task, skipped, '2026-06-03')
  recordActivityOutcome(db, USER, task, unrecorded, '2026-06-03')

  const links = listOutcomeLinks(db, USER, { taskId: task })
  const miss = links.find((link) => link.local_date === skipped)
  const unknown = links.find((link) => link.local_date === unrecorded)
  assert.equal(miss?.performed, 0)
  assert.equal(unknown?.performed, null)
  db.close()
})

test('learning learning: per-tag statistics follow immediately from the stored links', () => {
  const db = freshDb()
  const task = insertTask(db, { text: 'Gym' })
  const tagIds = [1, 2]
  // Link two days by hand, using the same table the recording path writes.
  const insert = db.prepare(
    `INSERT INTO activity_outcome_links
       (user_id, task_id, local_date, checkin_state, performed, target_achieved, total_minutes, tag_ids, priority, config_version_id, recorded_at, updated_at)
     VALUES (?, ?, ?, 'completed', ?, NULL, 30, ?, NULL, NULL, 1, 1)`,
  )
  insert.run(USER, task, '2026-06-01', 1, JSON.stringify(tagIds))
  insert.run(USER, task, '2026-06-02', 0, JSON.stringify(tagIds))

  const stats = tagLevelStatistics(db, USER)
  assert.equal(stats.length, 2)
  const one = stats.find((stat) => stat.tagId === '1')
  assert.equal(one?.labelled, 2)
  assert.equal(one?.performed, 1)
  assert.equal(one?.completionRate, 0.5)
  db.close()
})

// ---------------------------------------------------------------------------
// Retraining gate and rate limit
// ---------------------------------------------------------------------------

test('learning retrain: a first model is due, and a second attempt is rate-limited', () => {
  const db = freshDb()
  const task = insertTask(db)
  const from = '2026-01-01'
  for (let i = 0; i < 30; i += 1) {
    const date = addDays(from, i)
    setDailyStatus(db, USER, task, date, i % 3 === 0 ? 'skipped' : 'completed', null)
    if (i % 3 !== 0) addSession(db, task, date, 45)
  }

  const status = retrainStatus(db, USER)
  const completion = status.find((row) => row.kind === 'completion')
  assert.equal(completion?.should, true)
  assert.ok(status.every((row) => row.kind !== 'timing'), 'timing has no model and is never gated here')

  const first = maybeRetrain(db, USER, { force: true })
  assert.equal(first.ran, true)
  assert.ok(lastRetrainAt(db, USER) !== null)

  // Make it due again but keep it inside the rate-limit window.
  const current = retrainStatus(db, USER).find((row) => row.kind === 'completion')?.currentLabelled ?? 0
  db.prepare('UPDATE ml_retrain_state SET last_trained_at = ?, last_labelled_count = ? WHERE user_id = ? AND kind = ?').run(
    Date.now(),
    current - 25,
    USER,
    'completion',
  )
  const second = maybeRetrain(db, USER)
  assert.equal(second.ran, false)
  assert.match(second.reason, /rate limit/i)
  db.close()
})

// ---------------------------------------------------------------------------
// Live model health and fallback
// ---------------------------------------------------------------------------

function seedBadHealth(db: DatabaseSync, task: string, version: string, days: number, from = '2026-06-01'): string {
  let today = from
  for (let i = 0; i < days; i += 1) {
    today = addDays(from, i)
    logHealthPrediction(db, USER, {
      kind: 'completion',
      date: today,
      taskId: task,
      modelVersion: version,
      modelProbability: 0.95,
      baselineProbability: 0.05,
    }, preCutoff(today))
    labelHealthPredictions(db, USER, 'completion', today, task, 0)
  }
  return today
}

test('learning health: the first prediction for a day is frozen, even after labelling', () => {
  const db = freshDb()
  const task = insertTask(db)
  const date = '2026-06-01'
  const base = { kind: 'completion' as const, date, taskId: task, modelVersion: 'v1', baselineProbability: 0.5 }
  const storedProbability = () => (db
    .prepare(
      `SELECT model_probability FROM ml_health_predictions
       WHERE user_id = ? AND kind = 'completion' AND local_date = ? AND task_id = ?`,
    )
    .get(USER, date, task) as { model_probability: number }).model_probability

  logHealthPrediction(db, USER, { ...base, modelProbability: 0.1 }, 1000)
  logHealthPrediction(db, USER, { ...base, modelProbability: 0.9 }, 2000)
  assert.equal(storedProbability(), 0.1)

  labelHealthPredictions(db, USER, 'completion', date, task, 1)
  logHealthPrediction(db, USER, { ...base, modelProbability: 0.99 }, 3000)
  assert.equal(storedProbability(), 0.1)
  db.close()
})

test('learning health: small noisy data does not trigger a fallback', () => {
  const db = freshDb()
  const task = insertTask(db)
  const candidate = reg(db, 'completion', 'v1', { type: 'logistic', brier: 0.1, ece: 0.05, baselineBrier: 0.2 })
  assert.equal(promoteCandidate(db, USER, candidate.id).ok, true)

  const today = seedBadHealth(db, task, 'v1', HEALTH_MIN_LABELLED - 7)
  const health = evaluateModelHealth(db, USER, 'completion', { today })
  assert.equal(health.labelled_count, HEALTH_MIN_LABELLED - 7)
  assert.equal(health.fallback, 0)
  assert.match(health.reason ?? '', /too few/i)
  assert.equal(isFallbackActive(db, USER, 'completion'), false)
  db.close()
})

test('learning health: a deliberately degraded model falls back to the baseline', () => {
  const db = freshDb()
  const task = insertTask(db)
  const candidate = reg(db, 'completion', 'v1', { type: 'logistic', brier: 0.1, ece: 0.05, baselineBrier: 0.2 })
  assert.equal(promoteCandidate(db, USER, candidate.id).ok, true)

  const today = seedBadHealth(db, task, 'v1', HEALTH_MIN_LABELLED + 2)
  const health = evaluateModelHealth(db, USER, 'completion', { today })
  assert.ok(health.labelled_count >= HEALTH_MIN_LABELLED)
  assert.equal(health.fallback, 1)
  assert.equal(isFallbackActive(db, USER, 'completion'), true)
  assert.ok(health.model_brier !== null && health.baseline_brier !== null && health.model_brier > health.baseline_brier)
  assert.equal(modelHealthView(db, USER).anyFallback, true)
  db.close()
})

test('learning health: a retrain clears the fallback and a fresh model is judged on its own predictions', () => {
  const db = freshDb()
  const task = insertTask(db)
  // A champion registered directly, so the retrain gate sees no prior training.
  const candidate = reg(db, 'completion', 'v1', { type: 'logistic', brier: 0.1, ece: 0.05, baselineBrier: 0.2 })
  assert.equal(promoteCandidate(db, USER, candidate.id).ok, true)

  // A few real sessions so the retrain has a date to work from.
  const from = '2026-06-01'
  for (let i = 0; i < 6; i += 1) {
    const date = addDays(from, i)
    setDailyStatus(db, USER, task, date, 'completed', null)
    addSession(db, task, date, 30)
  }

  const today = seedBadHealth(db, task, 'v1', HEALTH_MIN_LABELLED + 2)
  evaluateModelHealth(db, USER, 'completion', { today })
  assert.equal(isFallbackActive(db, USER, 'completion'), true)

  const outcome = maybeRetrain(db, USER, { force: true })
  assert.equal(outcome.ran, true)
  assert.equal(isFallbackActive(db, USER, 'completion'), false, 'a retrain gives the model a fresh chance')

  // The fresh model is judged only on its own (new) predictions.
  const fresh = reg(db, 'completion', 'v2', { type: 'logistic', brier: 0.05, ece: 0.03, baselineBrier: 0.2 })
  assert.equal(promoteCandidate(db, USER, fresh.id).ok, true)
  let good = from
  for (let i = 0; i < HEALTH_MIN_LABELLED + 2; i += 1) {
    good = addDays(from, i)
    logHealthPrediction(db, USER, { kind: 'completion', date: good, taskId: task, modelVersion: 'v2', modelProbability: 0.05, baselineProbability: 0.5 })
    labelHealthPredictions(db, USER, 'completion', good, task, 0)
  }
  const recovered = evaluateModelHealth(db, USER, 'completion', { today: good })
  assert.equal(recovered.fallback, 0)
  assert.equal(championFor(db, USER, 'completion')?.version, 'v2')
  db.close()
})

// ---------------------------------------------------------------------------
// Drift
// ---------------------------------------------------------------------------

test('learning drift: a recent drop is reported as an association, not a cause', () => {
  const db = freshDb()
  const task = insertTask(db)
  const from = '2026-06-01'
  for (let i = 0; i < 40; i += 1) {
    const date = addDays(from, i)
    // First 26 days completed, the recent 14 skipped: a clear recent drop.
    setDailyStatus(db, USER, task, date, i < 26 ? 'completed' : 'skipped', null)
    if (i < 26) addSession(db, task, date, 30)
  }
  const drift = rateDriftForTask(db, USER, task, addDays(from, 39), 0.5)
  assert.equal(drift.judged, true)
  assert.equal(drift.direction, 'down')
  assert.match(drift.note, /association, not a cause/i)
  db.close()
})

test('learning drift: a changed daily target is dated and described, and is not a change in the person', () => {
  const db = freshDb()
  const task = insertTask(db, { duration: 30 })
  setDailyStatus(db, USER, task, '2026-06-01', 'completed', null)
  db.prepare('UPDATE tasks SET duration = 60 WHERE id = ?').run(task)
  recordTaskConfig(db, { ...taskLike(task, 'Read', 'none', 60) }, [], Date.parse('2026-06-10T00:00:00'))

  const changes = configChangesForTask(db, task)
  const target = changes.find((change) => change.fields.includes('target'))
  assert.ok(target)
  assert.equal(target?.date, '2026-06-10')
  assert.match(target?.summary ?? '', /30/)
  assert.match(target?.summary ?? '', /60/)
  db.close()
})

// ---------------------------------------------------------------------------
// Privacy: deletion is real, activity is kept
// ---------------------------------------------------------------------------

function answers(values: Partial<Record<CheckinAnswerKey, number>>): Record<CheckinAnswerKey, number | null> {
  const out = {} as Record<CheckinAnswerKey, number | null>
  for (const key of CHECKIN_ANSWER_KEYS) out[key] = values[key] ?? null
  return out
}

test('learning privacy: deleting check-in history clears the linkage state but keeps activity', () => {
  const db = freshDb()
  const task = insertTask(db)
  const date = '2026-06-01'
  saveCheckin(db, USER, { date, answers: answers({ feeling: 2, energy: 2 }), context: 'a private note' })
  skipCheckin(db, USER, '2026-06-02')
  addSession(db, task, date, 30)
  recordActivityOutcome(db, USER, task, date, '2026-06-03')

  const before = privacySummary(db, USER)
  assert.equal(before.localOnly, true)
  assert.equal(before.data.checkins, 2)
  assert.equal(before.data.contextNotes, 1)
  assert.equal(before.optionalFields.length, CHECKIN_ANSWER_KEYS.length)

  const deleted = deleteCheckinHistory(db, USER)
  assert.equal(deleted.checkinsDeleted, 2)
  assert.ok(deleted.linksCleared >= 1)

  const after = privacySummary(db, USER)
  assert.equal(after.data.checkins, 0)
  const link = listOutcomeLinks(db, USER, { taskId: task })[0]
  assert.equal(link.checkin_state, 'not_asked')
  // What the user actually did is untouched.
  const sessions = db.prepare('SELECT COUNT(*) AS n FROM activity_sessions WHERE user_id = ?').get(USER) as unknown as { n: number }
  assert.equal(sessions.n, 1)
  db.close()
})
