import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { CHECKIN_ANSWER_KEYS, createCheckinSchema } from '../checkins-store'
import { createFoundationSchema, createMlSchema, createPredictionSchema } from './schema'
import { recordTaskConfig } from './task-config'
import { createSession } from './sessions'
import { setDailyStatus } from './daily-activity'
import { addDays } from './off-days'
import { buildTrainingSet } from './dataset'
import {
  EMPTY_VOCABULARY,
  computeFeatures,
  featureNamesFor,
  gatherFeatureSnapshot,
  type FeatureSnapshot,
  type FeatureStats,
} from './features'
import { trainClassifier, trainDuration } from './training'
import { fitCalibrator } from './calibration'
import {
  championFor,
  getStoredModel,
  isSyntheticDatabase,
  promoteCandidate,
  registerModel,
  rollbackChampion,
  type RegistryMetrics,
} from './registry'
import { labelShadow, logShadow, promoteAfterShadow, shadowSummary } from './shadow'
import { serveTask } from './serving'
import { epochAtMinute, type PredictContext } from './predictors'
import { gatherTaskDays, userCompletionPrior } from './statistics'

/**
 * Phase 5 tests.
 *
 * These run the real training, evaluation, registry, shadow and serving code on
 * small databases built in memory. They test the *machinery*: that features only
 * ever use earlier data, that training and serving share one feature module,
 * that promotion, rollback, calibration and shadow mode are gated as specified,
 * that a broken champion falls back to the baseline, and that below the data
 * thresholds nothing is trained. No number here is an accuracy claim.
 */

const USER = 1
const CONFIG_FROM = Date.parse('2025-01-01T00:00:00')

function freshDb(withSyntheticMarker = false): DatabaseSync {
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
  if (withSyntheticMarker) {
    db.exec('CREATE TABLE IF NOT EXISTS synthetic_persons (id INTEGER PRIMARY KEY AUTOINCREMENT, person_id TEXT)')
  }
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

function insertTask(
  db: DatabaseSync,
  options: { text?: string; duration?: number | null; priority?: string } = {},
): string {
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

function setStatus(db: DatabaseSync, taskId: string, date: string, status: 'completed' | 'partial' | 'skipped' | 'postponed'): void {
  setDailyStatus(db, USER, taskId, date, status, null)
}

function baseStats(): FeatureStats {
  return {
    labelledDays: 0,
    completionRate: 0,
    recentRate: 0,
    decayedRate: null,
    consistency: null,
    durationMean: null,
    durationMedian: null,
    durationTrend: null,
    targetRate: null,
    daysSinceLastCompletion: null,
    recentMisses: 0,
    weekdayRate: 0,
    peakBin: null,
    timingConcentration: null,
    tagCompletionRate: null,
    tagDurationMedian: null,
  }
}

function snapshot(overrides: Partial<FeatureSnapshot> = {}): FeatureSnapshot {
  return {
    taskId: 't1',
    date: '2026-01-05',
    weekday: 1,
    stats: baseStats(),
    targetMinutes: null,
    progressMinutes: 0,
    remainingTarget: null,
    nowMinutes: 480,
    freeTimeMinutes: null,
    answers: null,
    checkinState: 'not_asked',
    priority: null,
    tagIds: [],
    exposure: { shownRecent: 0, exploratoryRecent: 0, followedRate: null },
    monthsOfData: 0,
    ...overrides,
  }
}

function featureIndex(names: string[], name: string): number {
  const index = names.indexOf(name)
  assert.ok(index >= 0, `feature ${name} should exist`)
  return index
}

function reg(db: DatabaseSync, kind: 'completion' | 'target' | 'duration', version: string, metrics: RegistryMetrics, payload: unknown = { test: true }) {
  return registerModel(db, USER, {
    kind,
    version,
    trainFrom: '2026-01-01',
    trainTo: '2026-06-01',
    dataCount: 100,
    labelledCount: 100,
    featureNames: ['f'],
    metrics,
    payload,
  })
}

// ---------------------------------------------------------------------------
// Feature engineering: no leakage, missing is explicit, tags/priority/season
// ---------------------------------------------------------------------------

test('phase5 features: a day is built only from strictly earlier days', () => {
  const db = freshDb()
  const task = insertTask(db, { text: 'Read', duration: 60 })
  const from = '2026-01-01'
  const dates = Array.from({ length: 10 }, (_, i) => addDays(from, i))
  for (const date of dates) setStatus(db, task, date, 'completed')

  const before = buildTrainingSet(db, USER, [task], from, dates[9], addDays(dates[9], 1))
  addSession(db, task, dates[4], 90, 20)
  const after = buildTrainingSet(db, USER, [task], from, dates[9], addDays(dates[9], 1))

  const sameDayBefore = before.rows.find((row) => row.date === dates[4])
  const sameDayAfter = after.rows.find((row) => row.date === dates[4])
  assert.ok(sameDayBefore && sameDayAfter)
  assert.deepEqual(sameDayAfter.features, sameDayBefore.features)

  const laterBefore = before.rows.find((row) => row.date === dates[5])
  const laterAfter = after.rows.find((row) => row.date === dates[5])
  assert.ok(laterBefore && laterAfter)
  assert.ok(laterAfter.features.some((value, index) => value !== laterBefore.features[index]))

  assert.ok(!before.featureNames.includes('followed'))
  assert.ok(!before.featureNames.some((name) => name.startsWith('same_day')))
  db.close()
})

test('phase5 features: a missing check-in is explicit and neutral, never a normal answer', () => {
  const names = featureNamesFor(EMPTY_VOCABULARY)
  const missing = computeFeatures(snapshot(), EMPTY_VOCABULARY)
  for (const key of CHECKIN_ANSWER_KEYS) {
    assert.equal(missing[featureIndex(names, `checkin_${key}`)], 0)
    assert.equal(missing[featureIndex(names, `checkin_${key}_missing`)], 1)
  }

  const best = computeFeatures(snapshot({ answers: { feeling: 1 } }), EMPTY_VOCABULARY)
  assert.equal(best[featureIndex(names, 'checkin_feeling')], 1)
  assert.equal(best[featureIndex(names, 'checkin_feeling_missing')], 0)

  const worst = computeFeatures(snapshot({ answers: { feeling: 5 } }), EMPTY_VOCABULARY)
  assert.equal(worst[featureIndex(names, 'checkin_feeling')], -1)
})

test('phase5 features: priority is an ordinal for that day, with an explicit missing flag', () => {
  const names = featureNamesFor(EMPTY_VOCABULARY)
  assert.equal(computeFeatures(snapshot({ priority: 'high' }), EMPTY_VOCABULARY)[featureIndex(names, 'priority_level')], 0.75)
  assert.equal(computeFeatures(snapshot({ priority: 'urgent' }), EMPTY_VOCABULARY)[featureIndex(names, 'priority_level')], 1)
  const none = computeFeatures(snapshot(), EMPTY_VOCABULARY)
  assert.equal(none[featureIndex(names, 'priority_level')], 0)
  assert.equal(none[featureIndex(names, 'priority_missing')], 1)
})

test('phase5 features: tags are multi-hot with other and missing buckets', () => {
  const vocabulary = { tags: ['1', '2'], seasonal: false }
  const names = featureNamesFor(vocabulary)
  const known = computeFeatures(snapshot({ tagIds: [1] }), vocabulary)
  assert.equal(known[featureIndex(names, 'tag_1')], 1)
  assert.equal(known[featureIndex(names, 'tag_2')], 0)
  assert.equal(known[featureIndex(names, 'tag_other')], 0)
  assert.equal(known[featureIndex(names, 'tag_missing')], 0)

  const other = computeFeatures(snapshot({ tagIds: [99] }), vocabulary)
  assert.equal(other[featureIndex(names, 'tag_other')], 1)

  const noTags = computeFeatures(snapshot({ tagIds: [] }), vocabulary)
  assert.equal(noTags[featureIndex(names, 'tag_missing')], 1)
})

test('phase5 features: seasonal columns appear only with at least a year of data', () => {
  const plain = featureNamesFor({ tags: [], seasonal: false })
  const seasonal = featureNamesFor({ tags: [], seasonal: true })
  assert.ok(!plain.includes('season_sin'))
  assert.ok(seasonal.includes('season_sin') && seasonal.includes('season_cos'))
  assert.equal(computeFeatures(snapshot(), { tags: [], seasonal: true }).length, seasonal.length)
  assert.equal(computeFeatures(snapshot(), EMPTY_VOCABULARY).length, plain.length)
})

test('phase5 features: training and serving build the identical vector through one module', () => {
  const db = freshDb()
  const task = insertTask(db, { text: 'Read', duration: 60 })
  const from = '2026-01-01'
  const dates = Array.from({ length: 12 }, (_, i) => addDays(from, i))
  dates.forEach((date, i) => setStatus(db, task, date, i % 3 === 0 ? 'skipped' : 'completed'))
  addSession(db, task, dates[1], 45, 9)
  addSession(db, task, dates[4], 60, 18)

  const to = dates[11]
  const today = addDays(to, 1)
  const set = buildTrainingSet(db, USER, [task], from, to, today)
  const row = set.rows[set.rows.length - 1]
  const priorRate = userCompletionPrior(db, USER, [task], addDays(from, -1))
  const allDays = gatherTaskDays(db, USER, task, addDays(from, -365), to, today)
  const index = allDays.findIndex((day) => day.date === row.date)
  const snap = gatherFeatureSnapshot(db, {
    userId: USER,
    taskId: task,
    date: row.date,
    today,
    asOfEpoch: epochAtMinute(row.date, 480) - 1,
    nowMinutes: 480,
    priorRate,
    tagStats: new Map(),
    monthsOfData: set.monthsOfData,
    priorDays: allDays.slice(0, index),
  })
  assert.deepEqual(computeFeatures(snap, set.vocabulary), row.features)
  assert.equal(row.features.length, featureNamesFor(set.vocabulary).length)
  db.close()
})

// ---------------------------------------------------------------------------
// Training thresholds and calibration gating
// ---------------------------------------------------------------------------

test('phase5 training: below the minimum rows the trainers return a baseline and claim nothing', () => {
  const db = freshDb()
  const task = insertTask(db, { text: 'Read', duration: 60 })
  const from = '2026-01-01'
  const dates = Array.from({ length: 5 }, (_, i) => addDays(from, i))
  for (const date of dates) setStatus(db, task, date, 'completed')

  const set = buildTrainingSet(db, USER, [task], from, dates[4], addDays(dates[4], 1))
  const completion = trainClassifier(set, 'completion')
  assert.equal(completion.type, 'baseline')
  assert.equal(completion.smallData, true)
  assert.match(completion.reason, /40/)

  const duration = trainDuration(set)
  assert.equal(duration.type, 'median')
  assert.equal(duration.smallData, true)
  assert.match(duration.reason, /20/)
  db.close()
})

test('phase5 calibration: skipped below the data threshold, never fabricated', () => {
  assert.equal(fitCalibrator([]).kind, 'none')
  const few = Array.from({ length: 10 }, (_, i) => ({ p: (i + 1) / 11, y: i % 2 }))
  assert.equal(fitCalibrator(few).kind, 'none')

  const plattRows = Array.from({ length: 80 }, (_, i) => ({ p: ((i % 8) + 1) / 9, y: i % 2 }))
  assert.equal(fitCalibrator(plattRows).kind, 'platt')

  const isotonicRows = Array.from({ length: 250 }, (_, i) => ({ p: ((i % 8) + 1) / 9, y: i % 2 }))
  assert.equal(fitCalibrator(isotonicRows).kind, 'isotonic')

  const oneClass = Array.from({ length: 80 }, () => ({ p: 0.5, y: 1 }))
  assert.equal(fitCalibrator(oneClass).kind, 'none')
})

// ---------------------------------------------------------------------------
// Registry: promotion, reliability gate, rollback, synthetic guard
// ---------------------------------------------------------------------------

test('phase5 registry: promotion needs to beat the baseline and the champion, and pass calibration', () => {
  const db = freshDb(true)
  const c1 = reg(db, 'completion', 'v1', { type: 'logistic', brier: 0.1, ece: 0.05, baselineBrier: 0.2 })
  assert.equal(promoteCandidate(db, USER, c1.id).ok, true)
  assert.equal(championFor(db, USER, 'completion')?.id, c1.id)

  const c2 = reg(db, 'completion', 'v2', { type: 'logistic', brier: 0.15, ece: 0.05, baselineBrier: 0.2 })
  assert.equal(promoteCandidate(db, USER, c2.id).ok, false)

  const c3 = reg(db, 'completion', 'v3', { type: 'logistic', brier: 0.05, ece: 0.05, baselineBrier: 0.2 })
  assert.equal(promoteCandidate(db, USER, c3.id).ok, true)
  assert.equal(championFor(db, USER, 'completion')?.id, c3.id)
  assert.equal(getStoredModel(db, c1.id)?.status, 'retired')

  const c4 = reg(db, 'completion', 'v4', { type: 'logistic', brier: 0.01, ece: 0.5, baselineBrier: 0.2 })
  assert.equal(promoteCandidate(db, USER, c4.id).ok, false)

  const c5 = reg(db, 'completion', 'v5', { type: 'baseline', brier: 0.01, ece: 0, baselineBrier: 0.2 })
  assert.equal(promoteCandidate(db, USER, c5.id).ok, false)

  const c6 = reg(db, 'duration', 'd1', { type: 'median', mae: 5, baselineMae: 6 })
  assert.equal(promoteCandidate(db, USER, c6.id).ok, false)
  db.close()
})

test('phase5 registry: rollback restores the previous version and keeps the newer one', () => {
  const db = freshDb(true)
  const c1 = reg(db, 'completion', 'v1', { type: 'logistic', brier: 0.1, ece: 0.05, baselineBrier: 0.2 })
  promoteCandidate(db, USER, c1.id)
  const c2 = reg(db, 'completion', 'v2', { type: 'logistic', brier: 0.05, ece: 0.05, baselineBrier: 0.2 })
  promoteCandidate(db, USER, c2.id)
  assert.equal(championFor(db, USER, 'completion')?.id, c2.id)

  const rolled = rollbackChampion(db, USER, 'completion')
  assert.equal(rolled.ok, true)
  assert.equal(championFor(db, USER, 'completion')?.id, c1.id)
  assert.equal(getStoredModel(db, c2.id)?.status, 'retired')

  assert.equal(promoteCandidate(db, USER, c2.id).ok, true)
  const explicit = rollbackChampion(db, USER, 'completion', { toVersion: 'v1' })
  assert.equal(explicit.ok, true)
  assert.equal(championFor(db, USER, 'completion')?.version, 'v1')

  const lonely = freshDb(true)
  const only = reg(lonely, 'completion', 'only', { type: 'logistic', brier: 0.1, ece: 0.05, baselineBrier: 0.2 })
  promoteCandidate(lonely, USER, only.id)
  assert.equal(rollbackChampion(lonely, USER, 'completion').ok, false)

  db.close()
  lonely.close()
})

test('phase5 registry: a synthetic model is refused in a real database but allowed in the sandbox', () => {
  const real = freshDb(false)
  assert.equal(isSyntheticDatabase(real), false)
  const syntheticRow = registerModel(real, USER, {
    kind: 'completion',
    version: 'syn',
    trainFrom: '2026-01-01',
    trainTo: '2026-02-01',
    dataCount: 100,
    labelledCount: 100,
    featureNames: ['f'],
    synthetic: true,
    metrics: { type: 'logistic', brier: 0.05, ece: 0.05, baselineBrier: 0.2 },
    payload: {},
  })
  const refused = promoteCandidate(real, USER, syntheticRow.id)
  assert.equal(refused.ok, false)
  assert.match(refused.reason, /synthetic/i)

  const sandbox = freshDb(true)
  assert.equal(isSyntheticDatabase(sandbox), true)
  const sandboxRow = registerModel(sandbox, USER, {
    kind: 'completion',
    version: 'syn',
    trainFrom: '2026-01-01',
    trainTo: '2026-02-01',
    dataCount: 100,
    labelledCount: 100,
    featureNames: ['f'],
    synthetic: true,
    metrics: { type: 'logistic', brier: 0.05, ece: 0.05, baselineBrier: 0.2 },
    payload: {},
  })
  assert.equal(promoteCandidate(sandbox, USER, sandboxRow.id).ok, true)

  real.close()
  sandbox.close()
})

// ---------------------------------------------------------------------------
// Shadow mode
// ---------------------------------------------------------------------------

test('phase5 shadow: a candidate that loses in shadow is not promoted, and labels are never overwritten', () => {
  const db = freshDb(true)
  const candidate = reg(db, 'completion', 'shadow-loser', { type: 'logistic', brier: 0.05, ece: 0.05, baselineBrier: 0.2 })
  for (let i = 0; i < 5; i += 1) {
    const date = addDays('2026-02-01', i)
    const y = (i % 2) as 0 | 1
    logShadow(db, USER, {
      kind: 'completion',
      candidateId: candidate.id,
      championId: null,
      date,
      taskId: 't1',
      candidateProbability: y === 1 ? 0.05 : 0.95,
      championProbability: 0.5,
      baselineProbability: 0.5,
    })
    assert.equal(labelShadow(db, USER, 'completion', candidate.id, date, 't1', y), true)
  }
  assert.equal(labelShadow(db, USER, 'completion', candidate.id, '2026-02-01', 't1', 1), false)

  const summary = shadowSummary(db, USER, 'completion', candidate.id)
  assert.equal(summary.labelled, 5)
  const decision = promoteAfterShadow(db, USER, 'completion', candidate.id, { minDays: 1, minLabelled: 3 })
  assert.equal(decision.ok, false)
  assert.equal(championFor(db, USER, 'completion'), undefined)
  db.close()
})

test('phase5 shadow: a candidate that beats the champion and baseline in shadow is eligible', () => {
  const db = freshDb(true)
  const candidate = reg(db, 'completion', 'shadow-winner', { type: 'logistic', brier: 0.05, ece: 0.05, baselineBrier: 0.2 })
  for (let i = 0; i < 4; i += 1) {
    const date = addDays('2026-03-01', i)
    const y = (i % 2) as 0 | 1
    logShadow(db, USER, {
      kind: 'completion',
      candidateId: candidate.id,
      championId: null,
      date,
      taskId: 't1',
      candidateProbability: y === 1 ? 0.9 : 0.1,
      championProbability: 0.5,
      baselineProbability: 0.5,
    })
    labelShadow(db, USER, 'completion', candidate.id, date, 't1', y)
  }
  const decision = promoteAfterShadow(db, USER, 'completion', candidate.id, { minDays: 1, minLabelled: 3 })
  assert.equal(decision.ok, true)
  assert.equal(championFor(db, USER, 'completion')?.id, candidate.id)
  db.close()
})

// ---------------------------------------------------------------------------
// Serving: champion used, baseline fallback
// ---------------------------------------------------------------------------

test('phase5 serving: the champion is served, and the baseline is used when it is missing or malformed', () => {
  const db = freshDb(true)
  const task = insertTask(db, { text: 'Read', duration: 60 })
  const from = '2026-01-01'
  const dates = Array.from({ length: 12 }, (_, i) => addDays(from, i))
  dates.forEach((date, i) => setStatus(db, task, date, i % 3 === 0 ? 'skipped' : 'completed'))
  addSession(db, task, dates[1], 45, 9)
  const to = dates[11]
  const today = addDays(to, 1)
  const context: PredictContext = {
    date: today,
    today,
    nowMinutes: 480,
    checkinState: 'not_asked',
    answers: null,
    settings: { reducedConfidenceDays: 3, explorationShare: 0, stage2MinDays: 3 },
    priorRate: userCompletionPrior(db, USER, [task], today),
  }

  const noChampion = serveTask(db, USER, task, context)
  assert.ok(noChampion)
  assert.equal(noChampion.usedModel, false)
  assert.match(noChampion.reason, /baseline/i)

  const set = buildTrainingSet(db, USER, [task], from, to, today)
  const artifact = trainClassifier(set, 'completion')
  const good = registerModel(db, USER, {
    kind: 'completion',
    version: 'good',
    trainFrom: from,
    trainTo: to,
    dataCount: set.rows.length,
    labelledCount: set.labelledCount,
    featureNames: set.featureNames,
    metrics: { type: 'logistic', brier: 0.15, ece: 0.05, baselineBrier: 0.2 },
    payload: artifact,
  })
  assert.equal(promoteCandidate(db, USER, good.id).ok, true)
  const served = serveTask(db, USER, task, context)
  assert.ok(served)
  assert.equal(served.usedModel, true)

  const bad = registerModel(db, USER, {
    kind: 'completion',
    version: 'bad',
    trainFrom: from,
    trainTo: to,
    dataCount: set.rows.length,
    labelledCount: set.labelledCount,
    featureNames: ['only_one'],
    metrics: { type: 'logistic', brier: 0.1, ece: 0.05, baselineBrier: 0.2 },
    payload: { ...artifact, featureNames: ['only_one'] },
  })
  assert.equal(promoteCandidate(db, USER, bad.id).ok, true)
  const fallback = serveTask(db, USER, task, context)
  assert.ok(fallback)
  assert.equal(fallback.usedModel, false)
  assert.match(fallback.reason, /feature|baseline/i)
  db.close()
})
