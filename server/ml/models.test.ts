import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { CHECKIN_ANSWER_KEYS, createCheckinSchema, saveCheckin, type CheckinAnswerKey } from '../checkins-store'
import { createFoundationSchema, createMlSchema, createPredictionSchema } from './schema'
import { recordTaskConfig } from './task-config'
import { createSession } from './sessions'
import { dailyActivity, setDailyStatus } from './daily-activity'
import { addDays } from './off-days'
import { buildTrainingSet, type TrainingRow } from './dataset'
import {
  EMPTY_VOCABULARY,
  PREDICTION_MINUTES,
  computeFeatures,
  featureNamesFor,
  gatherFeatureSnapshot,
  predictionMinuteFor,
  type FeatureSnapshot,
  type FeatureStats,
  type FeatureVocabulary,
} from './features'
import { MIN_ROWS_PER_FEATURE, chronologicalFolds, trainClassifier, trainDuration } from './training'
import { fitCalibrator } from './calibration'
import {
  championFor,
  getStoredModel,
  loadChampionArtifact,
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
 * Model training and serving tests.
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

test('model features: a day is built only from strictly earlier days', () => {
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

// ---------------------------------------------------------------------------
// P0 regressions: an answer or activity recorded later must not rewrite what a
// prediction made earlier could have known.
// ---------------------------------------------------------------------------

const P0_DATE = '2026-03-10'
const P0_CUTOFF = epochAtMinute(P0_DATE, 480) - 1

function p0SnapshotOptions(taskId: string) {
  return {
    userId: USER,
    taskId,
    date: P0_DATE,
    today: addDays(P0_DATE, 1),
    asOfEpoch: P0_CUTOFF,
    nowMinutes: 480,
    priorRate: 0.5,
    monthsOfData: 3,
  }
}

function p0Answers(feeling: number): Record<CheckinAnswerKey, number | null> {
  return Object.fromEntries(
    CHECKIN_ANSWER_KEYS.map((key) => [key, key === 'feeling' ? feeling : null]),
  ) as Record<CheckinAnswerKey, number | null>
}

test('P0 regression: a check-in saved after the cutoff is invisible to an earlier snapshot', () => {
  const db = freshDb()
  const task = insertTask(db)
  saveCheckin(db, USER, { date: P0_DATE, answers: p0Answers(1), context: null }, P0_CUTOFF + 60_000)

  const snapshot = gatherFeatureSnapshot(db, p0SnapshotOptions(task))
  assert.equal(snapshot.answers, null)
  assert.equal(snapshot.checkinState, 'not_asked')
  db.close()
})

test('P0 regression: editing a check-in after the cutoff cannot change an earlier snapshot', () => {
  const db = freshDb()
  const task = insertTask(db)
  saveCheckin(db, USER, { date: P0_DATE, answers: p0Answers(1), context: null }, P0_CUTOFF - 60_000)
  const before = gatherFeatureSnapshot(db, p0SnapshotOptions(task))
  assert.equal(before.answers?.feeling, 1)

  saveCheckin(db, USER, { date: P0_DATE, answers: p0Answers(5), context: null }, P0_CUTOFF + 60_000)
  const after = gatherFeatureSnapshot(db, p0SnapshotOptions(task))
  assert.deepEqual(after, before)
  assert.equal(after.answers?.feeling, 1)
  db.close()
})

test('P0 regression: a session logged after the cutoff cannot change an earlier snapshot', () => {
  const db = freshDb()
  const task = insertTask(db, { duration: 60 })
  const startedAt = epochAtMinute(P0_DATE, 7 * 60)
  createSession(db, USER, {
    taskId: task,
    localDate: P0_DATE,
    startedAt,
    endedAt: startedAt + 30 * 60_000,
    durationMinutes: 30,
    note: null,
  }, 'user', P0_CUTOFF - 1000)

  const before = gatherFeatureSnapshot(db, p0SnapshotOptions(task))
  assert.equal(before.progressMinutes, 30)

  // A second session that started before the cutoff but was only logged after
  // it was not knowable to the earlier prediction.
  const laterStart = epochAtMinute(P0_DATE, 7 * 60 + 30)
  createSession(db, USER, {
    taskId: task,
    localDate: P0_DATE,
    startedAt: laterStart,
    endedAt: laterStart + 20 * 60_000,
    durationMinutes: 20,
    note: null,
  }, 'user', P0_CUTOFF + 1000)

  const after = gatherFeatureSnapshot(db, p0SnapshotOptions(task))
  assert.deepEqual(after, before)
  assert.equal(after.progressMinutes, 30)
  db.close()
})

test('P0 regression: a running session is clipped at the cutoff, not counted in full', () => {
  const db = freshDb()
  const task = insertTask(db, { duration: 60 })
  const startedAt = epochAtMinute(P0_DATE, 7 * 60)
  createSession(db, USER, {
    taskId: task,
    localDate: P0_DATE,
    startedAt,
    endedAt: epochAtMinute(P0_DATE, 12 * 60),
    durationMinutes: 300,
    note: null,
  }, 'user', startedAt)

  const day = dailyActivity(db, USER, task, P0_DATE, addDays(P0_DATE, 1), { asOf: P0_CUTOFF })
  // The cutoff is one millisecond before 08:00, so 59 whole minutes have elapsed.
  assert.equal(day.totalMinutes, 59)
  db.close()
})

test('P0 regression: a same-day outcome cannot change an earlier snapshot', () => {
  const db = freshDb()
  const task = insertTask(db, { duration: 60 })
  const before = gatherFeatureSnapshot(db, p0SnapshotOptions(task))

  // Labelling the day after the prediction time must not touch its features.
  setStatus(db, task, P0_DATE, 'completed')
  const after = gatherFeatureSnapshot(db, p0SnapshotOptions(task))
  assert.deepEqual(after, before)
  db.close()
})

test('model features: a missing check-in is explicit and neutral, never a normal answer', () => {
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

test('model features: priority is an ordinal for that day, with an explicit missing flag', () => {
  const names = featureNamesFor(EMPTY_VOCABULARY)
  assert.equal(computeFeatures(snapshot({ priority: 'high' }), EMPTY_VOCABULARY)[featureIndex(names, 'priority_level')], 0.75)
  assert.equal(computeFeatures(snapshot({ priority: 'urgent' }), EMPTY_VOCABULARY)[featureIndex(names, 'priority_level')], 1)
  const none = computeFeatures(snapshot(), EMPTY_VOCABULARY)
  assert.equal(none[featureIndex(names, 'priority_level')], 0)
  assert.equal(none[featureIndex(names, 'priority_missing')], 1)
})

test('model features: tags are multi-hot with other and missing buckets', () => {
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

test('model features: seasonal columns appear only with at least a year of data', () => {
  const plain = featureNamesFor({ tags: [], seasonal: false })
  const seasonal = featureNamesFor({ tags: [], seasonal: true })
  assert.ok(!plain.includes('season_sin'))
  assert.ok(seasonal.includes('season_sin') && seasonal.includes('season_cos'))
  assert.equal(computeFeatures(snapshot(), { tags: [], seasonal: true }).length, seasonal.length)
  assert.equal(computeFeatures(snapshot(), EMPTY_VOCABULARY).length, plain.length)
})

test('model features: serving snaps to the most recent trained prediction time', () => {
  assert.deepEqual([...PREDICTION_MINUTES], [480, 720, 960, 1200])
  assert.equal(predictionMinuteFor(480), 480)
  assert.equal(predictionMinuteFor(540), 480)
  assert.equal(predictionMinuteFor(720), 720)
  assert.equal(predictionMinuteFor(900), 720)
  assert.equal(predictionMinuteFor(960), 960)
  assert.equal(predictionMinuteFor(1100), 960)
  assert.equal(predictionMinuteFor(1200), 1200)
  assert.equal(predictionMinuteFor(1439), 1200)
})

test('model features: a labelled day trains at every cutoff with time-correct progress', () => {
  const db = freshDb()
  const task = insertTask(db, { text: 'Read', duration: 60 })
  const date = '2026-02-10'
  setStatus(db, task, date, 'completed')
  // Recorded just before noon: invisible at 08:00, known from 12:00 onward.
  const startedAt = epochAtMinute(date, 9 * 60)
  createSession(
    db,
    USER,
    {
      taskId: task,
      localDate: date,
      startedAt,
      endedAt: startedAt + 30 * 60_000,
      durationMinutes: 30,
      note: null,
    },
    'user',
    epochAtMinute(date, 12 * 60) - 60_000,
  )

  const from = addDays(date, -1)
  const to = date
  const today = addDays(date, 1)
  const set = buildTrainingSet(db, USER, [task], from, to, today)
  const rows = set.rows.filter((row) => row.date === date).sort((a, b) => a.predictionMinute - b.predictionMinute)
  assert.deepEqual(rows.map((row) => row.predictionMinute), [...PREDICTION_MINUTES])

  const progress = featureIndex(set.featureNames, 'today_progress')
  const left = featureIndex(set.featureNames, 'minutes_left_in_day')
  // The 09:00 session is invisible at 08:00 and fully counted from 12:00 on.
  assert.equal(rows[0].features[progress], 0)
  assert.equal(rows[1].features[progress], 0.5)
  assert.equal(rows[2].features[progress], 0.5)
  assert.equal(rows[3].features[progress], 0.5)
  assert.ok(rows[0].features[left] > rows[3].features[left])
  db.close()
})

test('model features: the compact set is used until there are rows for the wide set', () => {
  const db = freshDb()
  const task = insertTask(db, { text: 'Read', duration: 60 })
  const from = '2026-01-01'
  const dates = Array.from({ length: 5 }, (_, i) => addDays(from, i))
  dates.forEach((date) => setStatus(db, task, date, 'completed'))
  const small = buildTrainingSet(db, USER, [task], from, dates[4], addDays(dates[4], 1))
  assert.equal(small.vocabulary.compact, true)
  assert.equal(small.featureNames.length, 18)
  assert.ok(!small.featureNames.some((name) => name.startsWith('tag_')))
  assert.ok(!small.featureNames.includes('season_sin'))
  assert.equal(computeFeatures(snapshot(), small.vocabulary).length, small.featureNames.length)

  const longFrom = '2025-01-01'
  const longDates = Array.from({ length: 75 }, (_, i) => addDays(longFrom, i))
  longDates.forEach((date, i) => setStatus(db, task, date, i % 2 === 0 ? 'completed' : 'skipped'))
  const large = buildTrainingSet(db, USER, [task], longFrom, longDates[74], addDays(longDates[74], 1))
  assert.equal(large.vocabulary.compact, false)
  assert.ok(large.rows.length >= 300)
  assert.ok(large.featureNames.length > small.featureNames.length)
  db.close()
})

test('model features: an explicit vocabulary keeps holdout columns identical to training', () => {
  const db = freshDb()
  const task = insertTask(db, { text: 'Read', duration: 60 })
  const from = '2026-01-01'
  const dates = Array.from({ length: 13 }, (_, i) => addDays(from, i))
  dates.forEach((date, i) => setStatus(db, task, date, i % 3 === 0 ? 'skipped' : 'completed'))

  // A champion's recorded vocabulary is authoritative even if this short holdout
  // window would otherwise choose a different (or seasonal-free) feature set.
  const recorded: FeatureVocabulary = { tags: ['1'], seasonal: true, compact: false }
  const expected = featureNamesFor(recorded)
  const holdout = buildTrainingSet(db, USER, [task], dates[10], dates[12], addDays(dates[12], 1), {
    vocabulary: recorded,
  })

  assert.deepEqual(holdout.featureNames, expected)
  assert.ok(expected.includes('season_sin'))
  assert.ok(expected.some((name) => name === 'tag_1'))
  assert.ok(holdout.rows.length > 0)
  assert.ok(holdout.rows.every((row) => row.features.length === expected.length))
  db.close()
})

test('model features: training and serving build the identical vector through one module', () => {
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
  // The training prior is recomputed for every date from days strictly before it.
  const priorRate = userCompletionPrior(db, USER, [task], addDays(row.date, -1))
  const allDays = gatherTaskDays(db, USER, task, addDays(from, -365), to, today)
  const index = allDays.findIndex((day) => day.date === row.date)
  const snap = gatherFeatureSnapshot(db, {
    userId: USER,
    taskId: task,
    date: row.date,
    today,
    asOfEpoch: epochAtMinute(row.date, row.predictionMinute) - 1,
    nowMinutes: row.predictionMinute,
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

test('model training: below the minimum rows the trainers return a baseline and claim nothing', () => {
  const db = freshDb()
  const task = insertTask(db, { text: 'Read', duration: 60 })
  const from = '2026-01-01'
  const dates = Array.from({ length: 5 }, (_, i) => addDays(from, i))
  for (const date of dates) setStatus(db, task, date, 'completed')

  const set = buildTrainingSet(db, USER, [task], from, dates[4], addDays(dates[4], 1))
  const completion = trainClassifier(set, 'completion')
  assert.equal(completion.type, 'baseline')
  assert.equal(completion.smallData, true)
  const needed = Math.max(40, set.featureNames.length * MIN_ROWS_PER_FEATURE)
  assert.match(completion.reason, new RegExp(`at least ${needed}`))

  const duration = trainDuration(set)
  assert.equal(duration.type, 'median')
  assert.equal(duration.smallData, true)
  const durationNeeded = Math.max(20, set.featureNames.length * MIN_ROWS_PER_FEATURE)
  assert.match(duration.reason, new RegExp(`at least ${durationNeeded}`))
  db.close()
})

test('model training: a date is never split between train and validation', () => {
  const rows: TrainingRow[] = []
  for (let day = 0; day < 8; day += 1) {
    const date = addDays('2026-01-01', day)
    for (let task = 0; task < 5; task += 1) {
      rows.push({
        taskId: `t${task}`,
        date,
        predictionMinute: 480 + task * 60,
        features: [day, task],
        completionLabel: task % 2,
        targetLabel: null,
        duration: null,
        weight: 1,
      })
    }
  }

  const folds = chronologicalFolds(rows, 2, 0.4)
  assert.equal(folds.length, 2)
  for (const fold of folds) {
    const trainDates = new Set(fold.train.map((i) => rows[i].date))
    for (const i of fold.valid) {
      assert.equal(trainDates.has(rows[i].date), false, `${rows[i].date} must not be on both sides of a fold`)
    }
  }
})

test('model calibration: skipped below the data threshold, never fabricated', () => {
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
// Registry: promotion, reliability gate, rollback
// ---------------------------------------------------------------------------

test('model registry: promotion needs to beat the baseline and the champion, and pass calibration', () => {
  const db = freshDb()
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

test('model registry: rollback restores the previous version and keeps the newer one', () => {
  const db = freshDb()
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

  const lonely = freshDb()
  const only = reg(lonely, 'completion', 'only', { type: 'logistic', brier: 0.1, ece: 0.05, baselineBrier: 0.2 })
  promoteCandidate(lonely, USER, only.id)
  assert.equal(rollbackChampion(lonely, USER, 'completion').ok, false)

  db.close()
  lonely.close()
})

test('model registry: champion artifacts are reused until the champion changes', () => {
  const db = freshDb()
  const v1 = reg(db, 'completion', 'v1', { type: 'logistic', brier: 0.1, ece: 0.05, baselineBrier: 0.2 }, { marker: 1 })
  promoteCandidate(db, USER, v1.id)

  const first = loadChampionArtifact(db, USER, 'completion')
  const second = loadChampionArtifact(db, USER, 'completion')
  assert.ok(first && second)
  assert.strictEqual(first.artifact, second.artifact)

  const v2 = reg(db, 'completion', 'v2', { type: 'logistic', brier: 0.05, ece: 0.05, baselineBrier: 0.2 }, { marker: 2 })
  promoteCandidate(db, USER, v2.id)

  const promoted = loadChampionArtifact(db, USER, 'completion')
  assert.ok(promoted)
  assert.equal(promoted.row.id, v2.id)
  assert.notStrictEqual(promoted.artifact, first.artifact)
  db.close()
})

// ---------------------------------------------------------------------------
// Shadow mode
// ---------------------------------------------------------------------------

test('model shadow: a candidate that loses in shadow is not promoted, and labels are never overwritten', () => {
  const db = freshDb()
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

test('model shadow: a candidate that beats the champion and baseline in shadow is eligible', () => {
  const db = freshDb()
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

test('model serving: the champion is served, and the baseline is used when it is missing or malformed', () => {
  const db = freshDb()
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

test('model serving: a champion is used only at its trained grid with its exact feature list', () => {
  const db = freshDb()
  const task = insertTask(db, { text: 'Read', duration: 60 })
  const from = '2026-04-01'
  const dates = Array.from({ length: 12 }, (_, i) => addDays(from, i))
  dates.forEach((date, i) => setStatus(db, task, date, i % 3 === 0 ? 'skipped' : 'completed'))
  const to = dates[11]
  const today = addDays(to, 1)
  const set = buildTrainingSet(db, USER, [task], from, to, today, { predictionMinutes: [480, 720] })
  const artifact = trainClassifier(set, 'completion')

  const register = (version: string, payload: unknown, featureNames: string[], brier: number) =>
    registerModel(db, USER, {
      kind: 'completion',
      version,
      trainFrom: from,
      trainTo: to,
      dataCount: set.rows.length,
      labelledCount: set.labelledCount,
      featureNames,
      metrics: { type: 'logistic', brier, ece: 0.05, baselineBrier: 0.2 },
      payload,
    })
  const contextAt = (nowMinutes: number): PredictContext => ({
    date: today,
    today,
    nowMinutes,
    checkinState: 'not_asked',
    answers: null,
    settings: { reducedConfidenceDays: 3, explorationShare: 0, stage2MinDays: 3 },
    priorRate: userCompletionPrior(db, USER, [task], today),
  })

  const grid = register('grid', artifact, set.featureNames, 0.15)
  assert.equal(promoteCandidate(db, USER, grid.id).ok, true)
  // 09:00 is not a trained time; it must snap back to the 08:00 row.
  const morning = serveTask(db, USER, task, contextAt(540))
  assert.ok(morning)
  assert.equal(morning.usedModel, true)
  const noon = serveTask(db, USER, task, contextAt(780))
  assert.ok(noon)
  assert.equal(noon.usedModel, true)

  const morningOnly = register('morning-only', { ...artifact, predictionMinutes: [480] }, set.featureNames, 0.14)
  assert.equal(promoteCandidate(db, USER, morningOnly.id).ok, true)
  const offGrid = serveTask(db, USER, task, contextAt(780))
  assert.ok(offGrid)
  assert.equal(offGrid.usedModel, false)
  assert.match(offGrid.reason, /prediction time|feature list|baseline/i)

  const reorderedNames = [...set.featureNames].reverse()
  const reordered = register('reordered', { ...artifact, featureNames: reorderedNames }, reorderedNames, 0.13)
  assert.equal(promoteCandidate(db, USER, reordered.id).ok, true)
  const mismatched = serveTask(db, USER, task, contextAt(720))
  assert.ok(mismatched)
  assert.equal(mismatched.usedModel, false)
  assert.match(mismatched.reason, /feature list|baseline/i)
  db.close()
})
