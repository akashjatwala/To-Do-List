import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import {
  CHECKIN_ANSWER_KEYS,
  createCheckinSchema,
  saveCheckin,
  type CheckinAnswerKey,
} from '../checkins-store'
import { createFoundationSchema, createPredictionSchema } from './schema'
import { endOfLocalDay, recordTaskConfig } from './task-config'
import { syncTaskTags } from './tags'
import { createSession } from './sessions'
import { setDailyStatus } from './daily-activity'
import { createOffDay } from './off-days'
import {
  addDays,
  activityStatistics,
  binCentreMinute,
  binForMinute,
  clamp01,
  combineGroups,
  consistency,
  daysSinceLastCompletion,
  decayedCompletionRate,
  durationStats,
  gatherTaskDays,
  groupStatistics,
  minuteOfDay,
  moodAssociations,
  preferredTimePrior,
  priorityAssociation,
  quantile,
  recentMisses,
  smoothedRate,
  timingProfile,
  userCompletionPrior,
  userTaskIds,
  weekdayOf,
  weekdayRates,
  type ActivityStatistics,
  type GroupStatistics,
  type LabelledDay,
} from './statistics'
import { assessStage, confidenceFor, isSkipped, stageNote } from './cold-start'
import {
  buildPlan,
  checkinAdjustment,
  epochAtMinute,
  freeTimeBudget,
  isPersonalTask,
  predictTask,
  rankScore,
  recommendWindow,
  suggest,
  targetAchievementProbability,
  taskContext,
  thompsonBin,
  type PredictContext,
  type TaskPrediction,
} from './predictors'
import {
  listFeedback,
  listPredictions,
  logPlanPredictions,
  logPrediction,
  parseFeedback,
  recordFeedback,
} from './predictions'

/**
 * Baseline prediction tests: personal statistics, cold-start stages, predictors, the
 * prediction log and the feedback trail.
 *
 * These assert the safety properties the phase is built around: probabilities
 * stay in [0, 1], intervals stay ordered, off days are excluded but kept,
 * unknown/pending days are never a miss, low data reads as low confidence,
 * exploration respects its gates, and a prediction is never written as an
 * outcome.
 */

const USER = 1
const TODAY = '2026-06-30'
const CONFIG_FROM = Date.parse('2025-01-01T00:00:00')
const SETTINGS = { reducedConfidenceDays: 3, explorationShare: 0.1, stage2MinDays: 3 }

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

function insertTask(
  db: DatabaseSync,
  options: {
    text?: string
    duration?: number | null
    priority?: string
    tagNames?: string[]
    due?: number | null
  } = {},
): string {
  const id = randomUUID()
  const text = options.text ?? 'Read'
  const duration = options.duration === undefined ? 60 : options.duration
  const priority = options.priority ?? 'none'
  const due = options.due === undefined ? endOfLocalDay(TODAY) : options.due
  db.prepare(
    `INSERT INTO tasks (id, user_id, text, created_at, due, priority, tags, recurrence, duration)
     VALUES (?, ?, ?, 1, ?, ?, '[]', 'none', ?)`,
  ).run(id, USER, text, due, priority, duration)
  const tagIds = options.tagNames ? syncTaskTags(db, USER, id, options.tagNames) : []
  recordTaskConfig(db, taskLike(id, text, priority, duration), tagIds, CONFIG_FROM)
  return id
}

/** The task fields `recordTaskConfig` reads. */
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

/** A session on `date` starting at `startHour`, lasting `minutes`. */
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

function label(db: DatabaseSync, taskId: string, date: string, status: 'completed' | 'partial' | 'skipped' | 'postponed'): void {
  setDailyStatus(db, USER, taskId, date, status, null)
}

function answers(value: number): Partial<Record<CheckinAnswerKey, number>> {
  const out: Partial<Record<CheckinAnswerKey, number>> = {}
  for (const key of CHECKIN_ANSWER_KEYS) out[key] = value
  return out
}

/** A complete check-in answer set, for the store. */
function fullAnswers(value: number): Record<CheckinAnswerKey, number | null> {
  const out = {} as Record<CheckinAnswerKey, number | null>
  for (const key of CHECKIN_ANSWER_KEYS) out[key] = value
  return out
}

function context(db: DatabaseSync, overrides: Partial<PredictContext> = {}): PredictContext {
  const taskIds = userTaskIds(db, USER)
  return {
    date: TODAY,
    today: TODAY,
    nowMinutes: 480,
    checkinState: 'completed',
    answers: null,
    settings: SETTINGS,
    priorRate: userCompletionPrior(db, USER, taskIds, TODAY),
    ...overrides,
  }
}

function day(date: string, overrides: Partial<LabelledDay> = {}): LabelledDay {
  return {
    date,
    performed: overrides.performed ?? null,
    targetAchieved: overrides.targetAchieved ?? null,
    totalMinutes: overrides.totalMinutes ?? 0,
    sessionStarts: overrides.sessionStarts ?? [],
    offDay: overrides.offDay ?? false,
    offDayKind: overrides.offDayKind ?? null,
    targetMinutes: overrides.targetMinutes ?? null,
    priority: overrides.priority ?? null,
    tagIds: overrides.tagIds ?? [],
    answers: overrides.answers ?? null,
  }
}

// ---------------------------------------------------------------------------
// Cold-start stages
// ---------------------------------------------------------------------------

test('cold start: stage thresholds and labels', () => {
  const none = assessStage(0, 10)
  assert.equal(none.stage, 1)
  assert.equal(none.noHistory, true)
  assert.match(none.reason, /No personal history/)

  const early = assessStage(5, 10)
  assert.equal(early.stage, 1)
  assert.equal(early.noHistory, false)

  const ready = assessStage(10, 10)
  assert.equal(ready.stage, 2)
  assert.equal(stageNote(ready.stage), 'Personalised from your own history.')
  assert.equal(stageNote(1), 'Insufficient personal history — starting estimate.')
})

test('cold start: confidence from data and today’s context', () => {
  const base = { stage: 2 as const, stage2MinDays: 10, checkinSkipped: false, reducedConfidence: false }
  assert.equal(confidenceFor({ ...base, labelledDays: 10 }), 'medium')
  assert.equal(confidenceFor({ ...base, labelledDays: 30 }), 'high')
  assert.equal(confidenceFor({ ...base, stage: 1, labelledDays: 30 }), 'low')
  assert.equal(confidenceFor({ ...base, labelledDays: 30, checkinSkipped: true }), 'medium')
  assert.equal(confidenceFor({ ...base, labelledDays: 30, reducedConfidence: true, checkinSkipped: true }), 'low')
  assert.equal(isSkipped('skipped'), true)
  assert.equal(isSkipped('completed'), false)
})

// ---------------------------------------------------------------------------
// Statistics — pure maths
// ---------------------------------------------------------------------------

test('smoothedRate blends toward the prior and always lands in [0,1]', () => {
  const noData = smoothedRate(0, 0, 0.5)
  assert.equal(noData.rate, 0.5)
  assert.equal(noData.raw, null)

  const mixed = smoothedRate(5, 10, 0.5)
  assert.equal(mixed.rate, 0.5)
  assert.equal(mixed.raw, 0.5)

  const lowPrior = smoothedRate(10, 10, 0.2)
  assert.ok(lowPrior.rate > 0.8 && lowPrior.rate < 1)
  assert.ok(clamp01(5) === 1 && clamp01(-2) === 0 && clamp01(Number.NaN) === 0)
})

test('durationStats gives a median, a mean and an ordered interval', () => {
  const stats = durationStats([45, 60, 75])
  assert.equal(stats.count, 3)
  assert.equal(stats.median, 60)
  assert.equal(stats.mean, 60)
  assert.equal(stats.low, 52.5)
  assert.equal(stats.high, 67.5)
  assert.ok(stats.low! <= stats.median! && stats.median! <= stats.high!)

  // A zero-minute day is missing, not a zero-length session.
  assert.equal(durationStats([0, 30]).count, 1)
  assert.deepEqual(durationStats([]), { count: 0, median: null, mean: null, low: null, high: null })
  assert.equal(quantile([10, 20], 0.5), 15)
})

test('timingProfile learns when the activity actually happened', () => {
  // 09:00 and 09:10 both fall in the 08:00–10:00 bin (bin 4 of 12).
  const profile = timingProfile([540, 550])
  assert.equal(profile.sessions, 2)
  assert.equal(profile.peakBin, 4)
  assert.equal(profile.weights.length, 12)
  assert.ok(Math.abs(profile.weights.reduce((sum, weight) => sum + weight, 0) - 1) < 1e-9)

  const empty = timingProfile([])
  assert.equal(empty.peakBin, null)
  assert.ok(Math.abs(empty.weights[0] - 1 / 12) < 1e-9)

  assert.equal(binForMinute(540), 4)
  assert.equal(binCentreMinute(4), 540)
  assert.equal(minuteOfDay(epochAtMinute(TODAY, 540)), 540)

  const prior = preferredTimePrior('09:00')
  assert.ok(prior && prior[4] > prior[0])
  assert.equal(preferredTimePrior('nonsense'), null)
  assert.equal(preferredTimePrior(null), null)
})

test('decayedCompletionRate favours recent days and ignores off days', () => {
  const days = [
    day('2026-06-29', { performed: true }),
    day('2026-05-01', { performed: false }),
    day('2026-06-28', { performed: false, offDay: true }),
  ]
  const rate = decayedCompletionRate(days, TODAY)!
  assert.ok(rate > 0.5 && rate <= 1)
  assert.equal(decayedCompletionRate([day('2026-06-01', { performed: true, offDay: true })], TODAY), null)
  assert.equal(decayedCompletionRate([day('2026-06-01', { performed: null })], TODAY), null)
})

test('weekday, recency and consistency summaries', () => {
  const days = [
    day('2026-06-29', { performed: true }),
    day('2026-06-28', { performed: false }),
    day('2026-06-27', { performed: false }),
    day('2026-06-26', { performed: false }),
    day('2026-06-20', { performed: false }),
  ]
  const rates = weekdayRates(days, 0.5)
  assert.equal(rates.length, 7)
  assert.ok(rates.every((entry) => entry.rate >= 0 && entry.rate <= 1))
  assert.equal(weekdayOf('2026-06-30'), new Date(Date.UTC(2026, 5, 30)).getUTCDay())
  assert.equal(daysSinceLastCompletion(days, TODAY), 1)
  assert.equal(recentMisses(days, 10), 4)
  assert.equal(consistency(days, TODAY, 2), 0.5)
  assert.equal(consistency([day('2026-06-29', { performed: null })], TODAY, 2), null)
})

test('mood associations need enough observations per group', () => {
  const days = [
    day('2026-06-29', { performed: true, answers: { energy: 1 } }),
    day('2026-06-28', { performed: true, answers: { energy: 1 } }),
    day('2026-06-27', { performed: true, answers: { energy: 1 } }),
    day('2026-06-26', { performed: false, answers: { energy: 5 } }),
    day('2026-06-25', { performed: false, answers: { energy: 5 } }),
    day('2026-06-24', { performed: false, answers: { energy: 5 } }),
    day('2026-06-23', { performed: true, answers: { focus: 1 } }),
  ]
  const energy = moodAssociations(days).find((entry) => entry.field === 'energy')!
  assert.equal(energy.enough, true)
  assert.equal(energy.best, 1)
  assert.equal(energy.worst, 5)
  const focus = moodAssociations(days).find((entry) => entry.field === 'focus')!
  assert.equal(focus.enough, false)
})

test('combineGroups weights tag groups by their sample size', () => {
  const groups: GroupStatistics[] = [
    {
      key: '1',
      labelled: 10,
      completion: smoothedRate(8, 10, 0.5),
      duration: durationStats([60, 60, 60]),
      timing: timingProfile([540, 540, 540]),
    },
    {
      key: '2',
      labelled: 2,
      completion: smoothedRate(0, 2, 0.5),
      duration: durationStats([]),
      timing: timingProfile([]),
    },
  ]
  const combined = combineGroups(groups, 0.5)
  assert.equal(combined.completion.labelled, 12)
  assert.ok(combined.completion.rate > 0.4 && combined.completion.rate < 0.8)
  assert.equal(combined.duration.count, 3)
  assert.equal(combined.timing.peakBin, 4)
})

test('priorityAssociation only reports a difference when the data shows one', () => {
  const spread = [
    day('2026-06-29', { performed: true, priority: 'high' }),
    day('2026-06-28', { performed: true, priority: 'high' }),
    day('2026-06-27', { performed: true, priority: 'high' }),
    day('2026-06-26', { performed: false, priority: 'low' }),
    day('2026-06-25', { performed: false, priority: 'low' }),
    day('2026-06-24', { performed: false, priority: 'low' }),
  ]
  assert.equal(priorityAssociation(spread)?.associated, true)
  assert.equal(priorityAssociation([day('2026-06-29', { performed: true, priority: 'high' })]), null)
})

// ---------------------------------------------------------------------------
// Statistics — from the database
// ---------------------------------------------------------------------------

test('activity statistics exclude off days but keep unknown days out of rates', () => {
  const db = freshDb()
  const taskId = insertTask(db, { duration: 60 })
  addSession(db, taskId, addDays(TODAY, -1), 60, 9)
  addSession(db, taskId, addDays(TODAY, -2), 30, 9)
  label(db, taskId, addDays(TODAY, -3), 'skipped')
  createOffDay(db, USER, { kind: 'sick', startDate: addDays(TODAY, -4), endDate: addDays(TODAY, -4), note: null })

  const prior = userCompletionPrior(db, USER, userTaskIds(db, USER), TODAY)
  const stats = activityStatistics(db, USER, taskId, TODAY, prior, { stage2MinDays: 3 })

  // Labelled = 3 (two performed days, one explicit skip); the off day is kept
  // separately and never counted as a labelled day.
  assert.equal(stats.labelledDays, 3)
  assert.equal(stats.offDays, 1)
  assert.ok(stats.completion.rate >= 0 && stats.completion.rate <= 1)
  assert.ok(stats.duration.count === 2 && stats.duration.median !== null)
  assert.ok(stats.target !== null && stats.target.rate >= 0 && stats.target.rate <= 1)
  assert.equal(stats.timing.sessions, 2)

  // Every day is present, with the off day flagged.
  const days = gatherTaskDays(db, USER, taskId, addDays(TODAY, -4), TODAY, TODAY)
  const off = days.find((entry) => entry.date === addDays(TODAY, -4))!
  assert.equal(off.offDay, true)
  assert.equal(off.performed, null)
})

test('tag and priority statistics pool across tasks', () => {
  const db = freshDb()
  const withTag = insertTask(db, { tagNames: ['exercise'] })
  addSession(db, withTag, addDays(TODAY, -1), 60, 9)
  addSession(db, withTag, addDays(TODAY, -2), 60, 9)
  addSession(db, withTag, addDays(TODAY, -3), 60, 9)
  // A neglected task drags the user's overall rate below the tag's rate.
  const neglected = insertTask(db, { tagNames: ['admin'] })
  for (let i = 1; i <= 6; i += 1) label(db, neglected, addDays(TODAY, -i), 'skipped')

  const ids = userTaskIds(db, USER)
  const prior = userCompletionPrior(db, USER, ids, TODAY)
  const tagStats = groupStatistics(db, USER, ids, TODAY, prior, 'tag')
  assert.equal(tagStats.size, 2)
  const group = tagStats.get(String(syncTaskTags(db, USER, withTag, ['exercise'])[0]))!
  assert.equal(group.labelled, 3)
  assert.ok(group.completion.rate > prior)

  const priorityStats = groupStatistics(db, USER, ids, TODAY, prior, 'priority')
  assert.equal(priorityStats.size, 0)
})

test('a new task with no history leans on its tags, not a made-up value', () => {
  const db = freshDb()
  const established = insertTask(db, { tagNames: ['exercise'] })
  for (let i = 1; i <= 12; i += 1) addSession(db, established, addDays(TODAY, -i), 60, 9)
  // A second task with a different tag drags the user's overall rate down.
  const other = insertTask(db, { tagNames: ['admin'] })
  for (let i = 1; i <= 12; i += 1) label(db, other, addDays(TODAY, -i), 'skipped')

  const fresh = insertTask(db, { tagNames: ['exercise'] })
  const ids = userTaskIds(db, USER)
  const prior = userCompletionPrior(db, USER, ids, TODAY)
  const tagStats = groupStatistics(db, USER, ids, TODAY, prior, 'tag')

  const prediction = predictTask(db, USER, fresh, context(db, { priorRate: prior, tagStats }))!
  assert.equal(prediction.stage, 1)
  assert.equal(prediction.source, 'baseline')
  assert.equal(prediction.confidence, 'low')
  assert.ok(prediction.inputs.baseRate > prior)
  assert.match(prediction.explanation, /Insufficient personal history/)
})

// ---------------------------------------------------------------------------
// Predictors
// ---------------------------------------------------------------------------

test('check-in adjustment is modest, capped and silent when skipped', () => {
  assert.equal(checkinAdjustment(null).value, 0)
  assert.equal(checkinAdjustment(answers(3)).value, 0)
  const good = checkinAdjustment(answers(1)).value
  const bad = checkinAdjustment(answers(5)).value
  assert.ok(good > 0 && good <= 0.15)
  assert.ok(bad < 0 && bad >= -0.15)
})

test('thompson sampling returns a valid bin', () => {
  const weights = timingProfile([540, 540, 550]).weights
  const bin = thompsonBin(weights, 3, () => 0.5)
  assert.ok(Number.isInteger(bin) && bin >= 0 && bin < weights.length)
})

test('free time and the recommended window never point at the past', () => {
  assert.equal(freeTimeBudget(null), null)
  assert.equal(freeTimeBudget({ free_time: 1 }), 480)
  assert.equal(freeTimeBudget({ free_time: 5 }), 60)

  const empty = timingProfile([])
  const window = recommendWindow(empty, TODAY, 600, 30, null)
  assert.equal(window.start === null ? null : new Date(window.start).getHours(), 10)
  assert.equal(
    window.start !== null && window.end !== null ? window.end - window.start : null,
    30 * 60_000,
  )
  assert.equal(window.exploratory, false)
})

test('learned ideal time is hidden once its window has passed', () => {
  const timing = timingProfile([9 * 60]) // learned morning habit
  const window = recommendWindow(timing, TODAY, 21 * 60, 30, null)
  assert.equal(window.start, null)
  assert.equal(window.end, null)
  assert.equal(window.peakBin, timing.peakBin)
})

test('target probability is separate from completion and bounded', () => {
  const stub = {
    target: smoothedRate(3, 5, 0.5),
    completion: smoothedRate(3, 5, 0.5),
    duration: durationStats([30, 30, 30]),
  } as unknown as ActivityStatistics

  assert.equal(targetAchievementProbability(stub, 0, 600, null), 1)
  const oneSession = targetAchievementProbability(stub, 30, 600, null)
  const fourSessions = targetAchievementProbability(stub, 120, 600, null)
  assert.ok(oneSession > fourSessions)
  assert.ok(fourSessions >= 0 && fourSessions <= 1)
  const noRoom = targetAchievementProbability(stub, 900, 600, 120)
  assert.ok(noRoom >= 0 && noRoom <= 1 && noRoom < oneSession)
})

test('predictTask: stage 1 baseline, off day suppressed, probabilities bounded', () => {
  const db = freshDb()
  const taskId = insertTask(db, { duration: 60 })

  const prediction = predictTask(db, USER, taskId, context(db))!
  assert.equal(prediction.stage, 1)
  assert.equal(prediction.source, 'baseline')
  assert.equal(prediction.confidence, 'low')
  assert.ok(prediction.completionProbability >= 0 && prediction.completionProbability <= 1)
  assert.ok(prediction.targetProbability !== null && prediction.targetProbability >= 0 && prediction.targetProbability <= 1)
  assert.equal(prediction.expectedDuration, null)
  assert.ok(prediction.recommendedStart !== null && prediction.recommendedEnd !== null)
  assert.ok(prediction.recommendedEnd! > prediction.recommendedStart!)
  assert.match(prediction.explanation, /No personal history/)

  createOffDay(db, USER, { kind: 'travel', startDate: TODAY, endDate: TODAY, note: null })
  assert.equal(predictTask(db, USER, taskId, context(db)), null)
})

test('predictTask: stage 2 uses personal history and skipped check-ins widen confidence', () => {
  const db = freshDb()
  const taskId = insertTask(db, { duration: 60 })
  for (let i = 1; i <= 9; i += 1) addSession(db, taskId, addDays(TODAY, -i * 2), 60, 9)
  for (let i = 1; i <= 3; i += 1) label(db, taskId, addDays(TODAY, -20 - i), 'skipped')

  const completed = predictTask(db, USER, taskId, context(db, { answers: answers(1) }))!
  assert.equal(completed.stage, 2)
  assert.equal(completed.source, 'model')
  assert.equal(completed.confidence, 'high')
  assert.equal(completed.expectedDuration, 60)
  assert.ok(completed.durationLow! <= completed.expectedDuration! && completed.expectedDuration! <= completed.durationHigh!)

  const skipped = predictTask(db, USER, taskId, context(db, { checkinState: 'skipped', answers: null }))!
  assert.equal(skipped.confidence, 'medium')
  assert.match(skipped.explanation, /check-in was skipped/)
})

test('exploration only happens for a light-priority stage-2 task', () => {
  const db = freshDb()
  const taskId = insertTask(db, { duration: 60, priority: 'low' })
  for (let i = 1; i <= 9; i += 1) addSession(db, taskId, addDays(TODAY, -i * 2), 60, 9)

  // Force a non-peak bin: give bin 0 the largest Gumbel draw.
  let call = 0
  const random = () => {
    const value = call === 0 ? 0.99 : 0.01
    call += 1
    return value
  }
  const exploratory = predictTask(db, USER, taskId, context(db, { random }), { explore: true })!
  assert.equal(exploratory.exploratory, true)
  assert.match(exploratory.explanation, /Trying a new time/)

  // A high-priority task is never pushed to a new time, even when asked.
  const high = insertTask(db, { duration: 60, priority: 'high' })
  for (let i = 1; i <= 9; i += 1) addSession(db, high, addDays(TODAY, -i * 2), 60, 9)
  const forced = predictTask(db, USER, high, context(db), { explore: true })!
  assert.equal(forced.exploratory, false)

  // A stage-1 task has too little history to explore.
  const fresh = insertTask(db, { duration: 60, priority: 'low' })
  assert.equal(predictTask(db, USER, fresh, context(db), { explore: true })!.exploratory, false)
})

test('plan ranking excludes completed and inactive tasks and never forces a choice', () => {
  const db = freshDb()
  const open = insertTask(db, { text: 'Open', duration: 60 })
  addSession(db, open, addDays(TODAY, -1), 60, 9)
  const completed = insertTask(db, { text: 'Done', duration: 60 })
  label(db, completed, TODAY, 'completed')
  const inactive = insertTask(db, { text: 'Inactive', duration: 60 })
  db.prepare('UPDATE task_configs SET active = 0 WHERE task_id = ?').run(inactive)

  const plan = buildPlan(db, USER, TODAY, TODAY, 480, 'completed')
  const ids = plan.entries.map((entry) => entry.taskId)
  assert.ok(ids.includes(open))
  assert.ok(!ids.includes(completed))
  assert.ok(!ids.includes(inactive))

  for (let i = 1; i < plan.entries.length; i += 1) {
    assert.ok(plan.entries[i - 1].rankScore >= plan.entries[i].rankScore)
  }
  assert.match(plan.note, /suggestion only/i)
})

test('plan only includes tasks due on the selected date', () => {
  const db = freshDb()
  const dueToday = insertTask(db, { text: 'Today', duration: 60 })
  const tomorrow = insertTask(db, {
    text: 'Tomorrow',
    duration: 60,
    due: endOfLocalDay(addDays(TODAY, 1)),
  })
  const noDue = insertTask(db, { text: 'No due', duration: 60, due: null })

  const plan = buildPlan(db, USER, TODAY, TODAY, 480, 'completed')
  assert.deepEqual(
    plan.entries.map((entry) => entry.taskId),
    [dueToday],
  )
  assert.equal(plan.suggestions.some((entry) => entry.taskId === tomorrow || entry.taskId === noDue), false)
  db.close()
})

test('plan never includes team tasks', () => {
  const db = freshDb()
  const personal = insertTask(db, { text: 'Personal' })
  const team = insertTask(db, { text: 'Team' })
  db.prepare('UPDATE tasks SET team_id = ? WHERE id = ?').run('team-1', team)

  const plan = buildPlan(db, USER, TODAY, TODAY, 480, 'completed')
  assert.deepEqual(
    plan.entries.map((entry) => entry.taskId),
    [personal],
  )
  assert.equal(plan.suggestions.some((entry) => entry.taskId === team), false)
  db.close()
})

test('predictions are personal-only and check-in answers shift the value', () => {
  const db = freshDb()
  const personal = insertTask(db, { text: 'Personal' })
  const team = insertTask(db, { text: 'Team' })
  db.prepare('UPDATE tasks SET team_id = ? WHERE id = ?').run('team-1', team)
  const otherUserTask = randomUUID()
  db.prepare(
    `INSERT INTO tasks (id, user_id, text, created_at, due, priority, tags, recurrence, duration)
     VALUES (?, ?, ?, 1, ?, 'none', '[]', 'none', 60)`,
  ).run(otherUserTask, USER + 1, 'Other person', endOfLocalDay(TODAY))

  assert.equal(isPersonalTask(db, USER, personal), true)
  assert.equal(isPersonalTask(db, USER, team), false)
  assert.equal(isPersonalTask(db, USER, otherUserTask), false)
  assert.equal(predictTask(db, USER, team, context(db)), null)
  assert.equal(predictTask(db, USER, otherUserTask, context(db)), null)
  assert.ok(predictTask(db, USER, personal, context(db)))
  assert.deepEqual(userTaskIds(db, USER), [personal])

  const noCheckin = predictTask(db, USER, personal, context(db, { checkinState: 'not_asked', answers: null }))!
  const goodCheckin = predictTask(db, USER, personal, context(db, { checkinState: 'completed', answers: answers(1) }))!
  const lowCheckin = predictTask(db, USER, personal, context(db, { checkinState: 'completed', answers: answers(5) }))!
  assert.ok(goodCheckin.completionProbability > noCheckin.completionProbability)
  assert.ok(lowCheckin.completionProbability < noCheckin.completionProbability)
  db.close()
})

test('off days suppress the whole plan', () => {
  const db = freshDb()
  insertTask(db, { duration: 60 })
  createOffDay(db, USER, { kind: 'holiday', startDate: TODAY, endDate: TODAY, note: null })
  const plan = buildPlan(db, USER, TODAY, TODAY, 480, 'completed')
  assert.equal(plan.offDay, true)
  assert.equal(plan.offDayKind, 'holiday')
  assert.equal(plan.entries.length, 0)
  assert.match(plan.note, /off day/i)
})

test('suggestions need low probability, low priority and adequate confidence', () => {
  const db = freshDb()
  const neglected = insertTask(db, { text: 'Neglected', duration: 60, priority: 'low' })
  for (let i = 1; i <= 12; i += 1) label(db, neglected, addDays(TODAY, -i), 'skipped')

  const plan = buildPlan(db, USER, TODAY, TODAY, 480, 'completed')
  const suggestion = plan.suggestions.find((entry) => entry.taskId === neglected)
  assert.ok(suggestion)
  assert.equal(suggestion!.kind, 'drop')
  assert.match(suggestion!.message, /your call/i)

  // A high-priority task is never suggested for dropping.
  const important = insertTask(db, { text: 'Important', duration: 60, priority: 'high' })
  for (let i = 1; i <= 12; i += 1) label(db, important, addDays(TODAY, -i), 'skipped')
  const highPlan = buildPlan(db, USER, TODAY, TODAY, 480, 'completed')
  assert.equal(highPlan.suggestions.some((entry) => entry.taskId === important), false)

  // Low confidence never produces a suggestion.
  const prediction = { confidence: 'low', completionProbability: 0.1 } as TaskPrediction
  assert.equal(suggest(prediction, 'low', 'x'), null)
  assert.ok(rankScore({ completionProbability: 0.8, confidence: 'high' } as TaskPrediction, 'high', 30) > 0)
})

// ---------------------------------------------------------------------------
// Acceptance scenarios
// ---------------------------------------------------------------------------

test('acceptance: a brand-new user with no activities gets an empty, honest plan', () => {
  const db = freshDb()
  const plan = buildPlan(db, USER, TODAY, TODAY, 480, 'not_asked')
  assert.equal(plan.entries.length, 0)
  assert.equal(plan.suggestions.length, 0)
  assert.equal(userCompletionPrior(db, USER, [], TODAY), 0.5)
  assert.equal(predictTask(db, USER, 'missing-task', context(db)), null)
})

test('acceptance: an activity with no outcomes is a bounded, low-confidence stage-1 estimate', () => {
  const db = freshDb()
  const taskId = insertTask(db, { duration: 60 })
  const prediction = predictTask(db, USER, taskId, context(db))!
  assert.equal(prediction.stage, 1)
  assert.equal(prediction.confidence, 'low')
  assert.equal(prediction.expectedDuration, null)
  assert.ok(prediction.completionProbability >= 0 && prediction.completionProbability <= 1)
  assert.match(prediction.explanation, /No personal history/)
})

test('acceptance: small history stays stage 1 until the labelled-day threshold', () => {
  const db = freshDb()
  const taskId = insertTask(db, { duration: 60 })
  addSession(db, taskId, addDays(TODAY, -1), 60, 9)
  addSession(db, taskId, addDays(TODAY, -2), 60, 9)
  assert.equal(predictTask(db, USER, taskId, context(db))!.stage, 1)
  addSession(db, taskId, addDays(TODAY, -3), 60, 9)
  assert.equal(predictTask(db, USER, taskId, context(db))!.stage, 2)
})

test('acceptance: a mid-day check-in change moves the estimate', () => {
  const db = freshDb()
  const taskId = insertTask(db, { duration: 60 })
  for (let i = 1; i <= 9; i += 1) addSession(db, taskId, addDays(TODAY, -i * 2), 60, 9)

  const better = predictTask(db, USER, taskId, context(db, { answers: answers(1) }))!
  const worse = predictTask(db, USER, taskId, context(db, { answers: answers(5) }))!
  assert.ok(better.completionProbability > worse.completionProbability)

  // A real check-in saved, then edited the same day, is read back as the edit.
  saveCheckin(db, USER, { date: TODAY, answers: fullAnswers(2), context: null })
  const morning = getCheckinAnswers(db)
  saveCheckin(db, USER, { date: TODAY, answers: fullAnswers(5), context: null })
  const afternoon = getCheckinAnswers(db)
  assert.equal(morning, 2)
  assert.equal(afternoon, 5)
})

/** The stored `energy` answer for today, or Infinity when absent. */
function getCheckinAnswers(db: DatabaseSync): number {
  const row = db.prepare('SELECT energy FROM checkins WHERE user_id = ? AND date = ?').get(USER, TODAY) as
    | { energy: number | null }
    | undefined
  return row?.energy ?? Infinity
}

test('acceptance: a multi-session day counts towards the target', () => {
  const db = freshDb()
  const taskId = insertTask(db, { duration: 60 })
  addSession(db, taskId, TODAY, 30, 9)
  addSession(db, taskId, TODAY, 30, 11)
  const prediction = predictTask(db, USER, taskId, context(db))!
  // Two sessions meet the 60-minute target, so nothing is left to reach it.
  assert.equal(prediction.targetProbability, 1)
})

test('acceptance: a target change is picked up from the config history', () => {
  const db = freshDb()
  const taskId = insertTask(db, { duration: 60 })
  recordTaskConfig(db, taskLike(taskId, 'Read', 'none', 120), [], Date.parse('2026-06-01T00:00:00'))
  assert.equal(taskContext(db, taskId, '2026-05-15')!.targetMinutes, 60)
  assert.equal(taskContext(db, taskId, TODAY)!.targetMinutes, 120)
})

test('acceptance: frequent misses lower the estimate and are recorded as skips, not failures', () => {
  const db = freshDb()
  const reliable = insertTask(db, { text: 'Reliable', duration: 60 })
  for (let i = 1; i <= 12; i += 1) addSession(db, reliable, addDays(TODAY, -i), 60, 9)
  const missed = insertTask(db, { text: 'Missed', duration: 60 })
  for (let i = 1; i <= 12; i += 1) label(db, missed, addDays(TODAY, -i), 'skipped')

  const ids = userTaskIds(db, USER)
  const prior = userCompletionPrior(db, USER, ids, TODAY)
  const reliablePrediction = predictTask(db, USER, reliable, context(db, { priorRate: prior }))!
  const missedPrediction = predictTask(db, USER, missed, context(db, { priorRate: prior }))!
  assert.ok(reliablePrediction.completionProbability > missedPrediction.completionProbability)
  const status = db
    .prepare('SELECT status FROM daily_activity_status WHERE task_id = ? LIMIT 1')
    .get(missed) as { status: string }
  assert.equal(status.status, 'skipped')
})

test('acceptance: incomplete data leaves blank days missing, never a miss', () => {
  const db = freshDb()
  const taskId = insertTask(db, { duration: 60 })
  addSession(db, taskId, addDays(TODAY, -1), 60, 9)
  label(db, taskId, addDays(TODAY, -2), 'skipped')
  // Several days in between carry no record at all.
  const stats = activityStatistics(db, USER, taskId, TODAY, 0.5, { stage2MinDays: 3 })
  assert.equal(stats.labelledDays, 2)
  assert.equal(stats.completion.raw, 0.5)
  assert.equal(stats.recentMisses, 1)
})

test('acceptance: a task with several tags blends its tag statistics by sample size', () => {
  const db = freshDb()
  const exercise = insertTask(db, { tagNames: ['exercise'] })
  for (let i = 1; i <= 10; i += 1) addSession(db, exercise, addDays(TODAY, -i), 60, 9)
  const admin = insertTask(db, { tagNames: ['admin'] })
  for (let i = 1; i <= 2; i += 1) label(db, admin, addDays(TODAY, -i), 'skipped')

  const multi = insertTask(db, { tagNames: ['exercise', 'admin'] })
  const ids = userTaskIds(db, USER)
  const prior = userCompletionPrior(db, USER, ids, TODAY)
  const tagStats = groupStatistics(db, USER, ids, TODAY, prior, 'tag')
  const prediction = predictTask(db, USER, multi, context(db, { priorRate: prior, tagStats }))!
  const exerciseRate = tagStats.get(String(syncTaskTags(db, USER, exercise, ['exercise'])[0]))!.completion.rate
  const adminRate = tagStats.get(String(syncTaskTags(db, USER, admin, ['admin'])[0]))!.completion.rate
  assert.ok(prediction.inputs.baseRate > adminRate && prediction.inputs.baseRate < exerciseRate)
})

test('acceptance: a priority change is versioned and shifts the estimate only when the data shows a difference', () => {
  const db = freshDb()
  const dependable = insertTask(db, { text: 'Dependable', duration: 60, priority: 'high' })
  for (let i = 1; i <= 8; i += 1) addSession(db, dependable, addDays(TODAY, -i), 60, 9)
  const neglected = insertTask(db, { text: 'Neglected', duration: 60, priority: 'low' })
  for (let i = 1; i <= 8; i += 1) label(db, neglected, addDays(TODAY, -i), 'skipped')

  const ids = userTaskIds(db, USER)
  const prior = userCompletionPrior(db, USER, ids, TODAY)
  const priorityStats = groupStatistics(db, USER, ids, TODAY, prior, 'priority')
  assert.ok(priorityStats.get('high')!.completion.rate > priorityStats.get('low')!.completion.rate)

  // A new high-priority task leans on the priority that has gone better.
  const fresh = insertTask(db, { text: 'Fresh', duration: 60, priority: 'high' })
  const asHigh = predictTask(db, USER, fresh, context(db, { priorRate: prior, priorityStats }))!
  assert.ok(asHigh.inputs.priorityAdjustment > 0)

  // Changing its priority to low produces a new config version and flips the sign.
  recordTaskConfig(db, taskLike(fresh, 'Fresh', 'low', 60), [], Date.parse('2026-06-01T00:00:00'))
  assert.equal(taskContext(db, fresh, TODAY)!.priority, 'low')
  const asLow = predictTask(db, USER, fresh, context(db, { priorRate: prior, priorityStats }))!
  assert.ok(asLow.inputs.priorityAdjustment < 0)
})

// ---------------------------------------------------------------------------
// Prediction log and feedback
// ---------------------------------------------------------------------------

test('predictions are logged separately and never written as outcomes', () => {
  const db = freshDb()
  const taskId = insertTask(db, { duration: 60 })
  addSession(db, taskId, addDays(TODAY, -1), 60, 9)
  label(db, taskId, addDays(TODAY, -2), 'skipped')

  const prediction = predictTask(db, USER, taskId, context(db))!
  const statusBefore = db.prepare('SELECT COUNT(*) AS n FROM daily_activity_status').get() as { n: number }
  const sessionsBefore = db.prepare('SELECT COUNT(*) AS n FROM activity_sessions').get() as { n: number }

  logPrediction(db, USER, prediction, 'completed')
  const rows = listPredictions(db, USER, TODAY)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].task_id, taskId)
  assert.ok(rows[0].completion_probability !== null && rows[0].completion_probability >= 0 && rows[0].completion_probability <= 1)

  // Re-logging the same day updates the row instead of piling up duplicates.
  logPrediction(db, USER, prediction, 'completed')
  assert.equal(listPredictions(db, USER, TODAY).length, 1)

  const statusAfter = db.prepare('SELECT COUNT(*) AS n FROM daily_activity_status').get() as { n: number }
  const sessionsAfter = db.prepare('SELECT COUNT(*) AS n FROM activity_sessions').get() as { n: number }
  assert.equal(statusAfter.n, statusBefore.n)
  assert.equal(sessionsAfter.n, sessionsBefore.n)
})

test('logPlanPredictions writes one row per plan entry', () => {
  const db = freshDb()
  insertTask(db, { text: 'One', duration: 60 })
  insertTask(db, { text: 'Two', duration: 30 })
  const plan = buildPlan(db, USER, TODAY, TODAY, 480, 'completed')
  const written = logPlanPredictions(db, USER, plan)
  assert.equal(written, plan.entries.length)
  assert.equal(listPredictions(db, USER, TODAY).length, plan.entries.length)
})

test('feedback keeps "not answered" apart from "not followed"', () => {
  const db = freshDb()
  const taskId = insertTask(db, { duration: 60 })

  recordFeedback(db, USER, { date: TODAY, taskId, kind: 'time', exploratory: false, shown: true })
  let rows = listFeedback(db, USER, TODAY)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].shown, 1)
  assert.equal(rows[0].followed, null)

  recordFeedback(db, USER, { date: TODAY, taskId, kind: 'time', exploratory: true, shown: true, followed: false })
  rows = listFeedback(db, USER, TODAY)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].exploratory, 1)
  assert.equal(rows[0].followed, 0)
})

test('parseFeedback rejects malformed payloads', () => {
  assert.deepEqual(parseFeedback({ taskId: 'a', kind: 'time' }), { taskId: 'a', kind: 'time' })
  assert.equal(parseFeedback({ taskId: 'a', kind: 'nudge' }), null)
  assert.equal(parseFeedback({ kind: 'time' }), null)
  assert.equal(parseFeedback({ taskId: 'a', kind: 'time', followed: 'yes' }), null)
  assert.equal(parseFeedback(null), null)
  assert.deepEqual(parseFeedback({ taskId: 'a', kind: 'drop', followed: null }), {
    taskId: 'a',
    kind: 'drop',
    followed: null,
  })
})
