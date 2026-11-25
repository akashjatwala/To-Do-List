import { randomUUID } from 'node:crypto'
import { mkdirSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { DatabaseSync } from 'node:sqlite'
import bcrypt from 'bcryptjs'
import {
  CHECKIN_ANSWER_KEYS,
  answeredValues,
  checkinState,
  getCheckinAsOf,
  saveCheckin,
  skipCheckin,
  type CheckinAnswerKey,
} from '../checkins-store'
import { applyOffDayTaskMoves } from '../off-day-task-moves'
import { skipTaskDate, type SkippableTaskRow } from '../task-skip-events'
import { addDays, createOffDay, getPredictionSettings, type OffDayKind } from './off-days'
import { configForDate, configTagIds, recordTaskConfig, type TaskLike } from './task-config'
import { syncTaskTags } from './tags'
import { createSession } from './sessions'
import { setDailyStatus } from './daily-activity'
import { recordActivityOutcome } from './learning'
import { epochAtMinute, predictTask, type PredictContext } from './predictors'
import { groupStatistics, userCompletionPrior, userTaskIds } from './statistics'
import { buildTrainingSet } from './dataset'
import { predictClassifier, predictDuration, type ClassifierArtifact } from './training'
import { trainUserModels } from './pipeline'
import { brier, calibrationError, confusion, mae, rocAuc, type Labelled } from './metrics'
import { promoteCandidate } from './registry'

/**
 * Repeatable local demo data and a chronological backtest.
 *
 * This is deliberately *not* a fake accuracy claim. It writes history through
 * the same stores the app uses (tasks, versioned config, check-ins with edit
 * history, timed sessions with late logging, explicit day statuses and off
 * days), then trains on earlier dates and scores untouched later dates. The
 * numbers printed by the CLI describe this synthetic history, never the user's
 * own habits.
 */

export const DEMO_EMAIL = 'ml-demo@example.com'
export const DEMO_PASSWORD = 'demo12345'
export const DEMO_NAME = 'ML Demo'

export interface DemoDataOptions {
  /** Number of complete days to generate, ending yesterday. */
  days?: number
  /** Final days kept completely out of training for the backtest. */
  holdoutDays?: number
  seed?: number
  /** Local date string; defaults to today. Generated data ends the day before. */
  today?: string
  email?: string
  name?: string
}

export interface DemoDataResult {
  userId: number
  email: string
  from: string
  to: string
  today: string
  holdoutFrom: string
  taskIds: string[]
  counts: {
    tasks: number
    sessions: number
    lateSessions: number
    statuses: number
    offDays: number
    skipEvents: number
    checkins: number
    checkinEdits: number
    configVersions: number
    outcomeLinks: number
  }
}

interface TaskSpec {
  text: string
  tags: string[]
  priority: string
  targetMinutes: number
  preferredMinute: number
  baseRate: number
  weekend: number
  drift: number
  achieved: number
}

const TASK_SPECS: TaskSpec[] = [
  { text: 'Morning reading', tags: ['mind', 'habit'], priority: 'medium', targetMinutes: 25, preferredMinute: 8 * 60, baseRate: 0.74, weekend: 0.03, drift: 0.02, achieved: 0.58 },
  { text: 'Deep work block', tags: ['work', 'focus'], priority: 'high', targetMinutes: 90, preferredMinute: 10 * 60, baseRate: 0.6, weekend: -0.16, drift: 0.08, achieved: 0.5 },
  { text: 'Workout', tags: ['health', 'body'], priority: 'high', targetMinutes: 45, preferredMinute: 7 * 60, baseRate: 0.52, weekend: 0.1, drift: 0, achieved: 0.46 },
  { text: 'Inbox zero', tags: ['work', 'admin'], priority: 'low', targetMinutes: 30, preferredMinute: 16 * 60, baseRate: 0.47, weekend: -0.2, drift: -0.03, achieved: 0.62 },
  { text: 'Language practice', tags: ['learning', 'habit'], priority: 'medium', targetMinutes: 20, preferredMinute: 21 * 60, baseRate: 0.59, weekend: 0.02, drift: 0.04, achieved: 0.54 },
  { text: 'Evening journal', tags: ['mind', 'habit'], priority: 'low', targetMinutes: 15, preferredMinute: 20 * 60, baseRate: 0.69, weekend: 0.04, drift: 0, achieved: 0.66 },
]

function localDateString(date = new Date()): string {
  const year = date.getFullYear()
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  return `${year}-${month}-${day}`
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value))
}

function intInRange(value: number, low: number, high: number): number {
  return Math.round(clamp(value, low, high))
}

/** Small deterministic PRNG so a run can be reproduced from its seed. */
function randomFrom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

function answerFor(quality: number, rng: () => number): number {
  return intInRange(3 - quality * 1.4 + (rng() - 0.5) * 2.2, 1, 5)
}

function dailyAnswers(quality: number, rng: () => number): Record<CheckinAnswerKey, number | null> {
  const out = {} as Record<CheckinAnswerKey, number | null>
  for (const key of CHECKIN_ANSWER_KEYS) {
    const variation = key === 'free_time' || key === 'motivation' ? -0.18 : 0
    out[key] = answerFor(quality + variation + (rng() - 0.5) * 0.3, rng)
  }
  return out
}

function readinessOf(answers: Partial<Record<CheckinAnswerKey, number | null>> | null): number {
  if (!answers) return 0
  let total = 0
  let count = 0
  for (const key of CHECKIN_ANSWER_KEYS) {
    const value = answers[key]
    if (value === null || value === undefined) continue
    total += ((6 - value) - 3) / 2
    count += 1
  }
  return count > 0 ? total / count : 0
}

/** Create (or recreate) the isolated demo user without touching other accounts. */
export function createDemoUser(db: DatabaseSync, options: DemoDataOptions = {}): number {
  const email = options.email ?? DEMO_EMAIL
  const name = options.name ?? DEMO_NAME
  db.prepare('DELETE FROM users WHERE email = ?').run(email)
  const result = db
    .prepare('INSERT INTO users (email, name, password_hash, created_at) VALUES (?, ?, ?, ?)')
    .run(email, name, bcrypt.hashSync(DEMO_PASSWORD, 10), Date.now())
  return Number(result.lastInsertRowid)
}

function addTask(db: DatabaseSync, userId: number, spec: TaskSpec, from: string): string {
  const id = randomUUID()
  db.prepare(
    `INSERT INTO tasks
       (id, user_id, text, done, created_at, due, position, priority, tags,
        recurrence, duration, preferred_time)
     VALUES (?, ?, ?, 0, ?, ?, 0, ?, '[]', 'daily', ?, ?)`,
  ).run(
    id,
    userId,
    spec.text,
    epochAtMinute(from, 0) - 2 * 86_400_000,
    epochAtMinute(from, 0),
    spec.priority,
    spec.targetMinutes,
    null,
  )
  const tagIds = syncTaskTags(db, userId, id, spec.tags)
  const task: TaskLike = {
    id,
    user_id: userId,
    text: spec.text,
    priority: spec.priority,
    tags: '[]',
    recurrence: 'daily',
    recurrence_config: null,
    duration: spec.targetMinutes,
    preferred_time: null,
  }
  recordTaskConfig(db, task, tagIds, epochAtMinute(from, 0))
  return id
}

function reconfigure(db: DatabaseSync, userId: number, taskId: string, date: string): void {
  const row = db
    .prepare('SELECT text FROM tasks WHERE id = ? AND user_id = ?')
    .get(taskId, userId) as unknown as { text: string }
  const latest = configForDate(db, taskId, date)
  const tagIds = latest ? configTagIds(db, latest.id) : []
  const task: TaskLike = {
    id: taskId,
    user_id: userId,
    text: row.text,
    priority: 'high',
    tags: '[]',
    recurrence: 'daily',
    recurrence_config: null,
    duration: 75,
    preferred_time: null,
  }
  db.prepare('UPDATE tasks SET priority = ?, duration = ? WHERE id = ? AND user_id = ?')
    .run('high', 75, taskId, userId)
  recordTaskConfig(db, task, tagIds, epochAtMinute(date, 0))
}

/**
 * Current off-day and skip examples for the demo board.
 *
 * These tasks are deliberately outside `result.taskIds`, so the chronological
 * backtest and champion training still use only the generated habit history.
 */
function seedScheduleExamples(db: DatabaseSync, userId: number, today: string): void {
  const offStart = addDays(today, 1)
  const offEnd = addDays(today, 2)
  const examples = [
    { id: 'demo-off-day-note', text: 'Off-day moved note', due: epochAtMinute(offStart, 14 * 60), recurrence: 'none' },
    { id: 'demo-off-day-repeat', text: 'Off-day daily check', due: epochAtMinute(offStart, 7 * 60 + 30), recurrence: 'daily' },
    { id: 'demo-skipped-note', text: 'Skipped personal note', due: epochAtMinute(today, 9 * 60), recurrence: 'none' },
    { id: 'demo-skipped-repeat', text: 'Skipped daily habit', due: epochAtMinute(today, 8 * 60), recurrence: 'daily' },
  ] as const

  for (const example of examples) {
    db.prepare(
      `INSERT INTO tasks
         (id, user_id, text, done, created_at, due, position, priority, tags,
          recurrence, duration, preferred_time)
       VALUES (?, ?, ?, 0, ?, ?, 0, 'medium', '[]', ?, 30, NULL)`,
    ).run(
      example.id,
      userId,
      example.text,
      epochAtMinute(addDays(today, -1), 0),
      example.due,
      example.recurrence,
    )
  }

  createOffDay(
    db,
    userId,
    {
      kind: 'travel' as OffDayKind,
      startDate: offStart,
      endDate: offEnd,
      note: null,
    },
    'generated',
  )
  applyOffDayTaskMoves(db, userId)

  const load = (id: string) =>
    db
      .prepare('SELECT id, done, due, recurrence, recurrence_config FROM tasks WHERE id = ?')
      .get(id) as SkippableTaskRow | undefined
  for (const id of ['demo-skipped-note', 'demo-skipped-repeat']) {
    const task = load(id)
    if (task) skipTaskDate(db, task, userId, today)
  }
}

/** Fill an existing demo user's history. Existing rows for that user are removed first. */
export function generateDemoHistory(db: DatabaseSync, userId: number, options: DemoDataOptions = {}): DemoDataResult {
  const days = options.days ?? 150
  const holdoutDays = options.holdoutDays ?? 30
  if (days < 20) throw new Error('At least 20 days are needed to generate demo data.')
  if (holdoutDays < 1 || holdoutDays >= days - 10) {
    throw new Error('The holdout must leave at least 10 training days.')
  }
  const rng = randomFrom(options.seed ?? 20261124)
  const today = options.today ?? localDateString()
  const from = addDays(today, -days)
  const to = addDays(today, -1)
  const holdoutFrom = addDays(to, -(holdoutDays - 1))

  // The demo user is recreated, so clearing its own generated tables is safe.
  for (const table of [
    'activity_outcome_links',
    'activity_sessions',
    'daily_activity_status',
    'checkin_history',
    'checkins',
    'off_days',
    'task_config_tags',
    'task_configs',
    'task_tags',
    'tags',
    'ml_health_predictions',
    'ml_health',
    'ml_shadow',
    'ml_models',
    'ml_retrain_state',
    'ml_retrain_log',
    'predictions',
  ]) {
    try {
      db.prepare(`DELETE FROM ${table} WHERE user_id = ?`).run(userId)
    } catch {
      // A table may not exist in an older database; newer stores are authoritative.
    }
  }
  try {
    db.prepare('DELETE FROM task_skip_events WHERE actor_id = ?').run(userId)
  } catch {
    // An older database may not have the skip-event table yet.
  }
  db.prepare('DELETE FROM tasks WHERE user_id = ?').run(userId)

  const taskIds = TASK_SPECS.map((spec) => addTask(db, userId, spec, from))
  const changeDate = addDays(from, Math.floor(days * 0.65))
  reconfigure(db, userId, taskIds[1], changeDate)
  seedScheduleExamples(db, userId, today)

  const offPeriods: Array<{ startDate: string; endDate: string; kind: OffDayKind; note: string }> = [
    { startDate: addDays(from, 18), endDate: addDays(from, 20), kind: 'sick' as OffDayKind, note: 'Down with a cold.' },
    { startDate: addDays(from, 57), endDate: addDays(from, 58), kind: 'travel' as OffDayKind, note: 'Train journey.' },
    { startDate: addDays(from, 96), endDate: addDays(from, 98), kind: 'holiday' as OffDayKind, note: 'A few days away.' },
  ].filter((period) => period.endDate <= to)
  for (const period of offPeriods) {
    createOffDay(db, userId, period, 'generated')
  }

  let sessions = 0
  let lateSessions = 0
  let statuses = 0
  let checkins = 0
  let checkinEdits = 0

  for (let index = 0; index < days; index += 1) {
    const date = addDays(from, index)
    const off = offPeriods.some((period) => date >= period.startDate && date <= period.endDate)
    if (off) continue

    const weekday = new Date(epochAtMinute(date, 0)).getDay()
    const dayQuality = clamp((rng() + rng() - 1) * 0.9 + Math.sin(index / 7) * 0.18, -1, 1)
    const answers = dailyAnswers(dayQuality, rng)
    const firstRecorded = epochAtMinute(date, 7 * 60 + 30)
    const roll = rng()
    if (roll < 0.07) {
      skipCheckin(db, userId, date, firstRecorded)
    } else if (roll >= 0.12) {
      saveCheckin(db, userId, { date, answers, context: null }, firstRecorded)
      checkins += 1
      if (rng() < 0.22) {
        const edited = { ...answers, motivation: answerFor(dayQuality - 0.3, rng), free_time: answerFor(dayQuality + 0.2, rng) }
        saveCheckin(db, userId, { date, answers: edited, context: null }, epochAtMinute(date, 10 * 60 + 15))
        checkinEdits += 1
      }
    }
    const morningCheckin = getCheckinAsOf(db, userId, date, epochAtMinute(date, 8 * 60) - 1)
    const readiness =
      morningCheckin && morningCheckin.skipped === 0 ? readinessOf(answeredValues(morningCheckin)) : 0

    TASK_SPECS.forEach((spec, taskIndex) => {
      const taskId = taskIds[taskIndex]
      const config = configForDate(db, taskId, date)
      const target = config?.target_duration ?? spec.targetMinutes
      const priority = config?.priority ?? spec.priority
      const priorityBonus = priority === 'high' ? 0.1 : priority === 'medium' ? 0.04 : -0.03
      const weekendBonus = weekday === 0 || weekday === 6 ? spec.weekend : 0
      const probability = clamp(
        spec.baseRate + priorityBonus + weekendBonus + spec.drift * (index / days) + readiness * 0.22 + (rng() - 0.5) * 0.24,
        0.03,
        0.96,
      )
      const performed = rng() < probability

      if (performed) {
        const achievedChance = clamp(spec.achieved + readiness * 0.25 + (priority === 'high' ? 0.08 : 0), 0.12, 0.9)
        const achieved = rng() < achievedChance
        const duration = achieved
          ? Math.round(target * (1 + rng() * 0.12))
          : Math.max(5, Math.round(target * (0.25 + rng() * 0.6)))
        const startMinute = clamp(spec.preferredMinute + Math.round((rng() - 0.5) * 90), 6 * 60, 22 * 60)
        const startedAt = epochAtMinute(date, startMinute)
        const late = rng() < 0.16
        const createdAt = late
          ? epochAtMinute(addDays(date, 1), 8 * 60)
          : Math.min(epochAtMinute(date, 23 * 60 + 50), startedAt + (duration + 6) * 60_000)
        createSession(
          db,
          userId,
          {
            taskId,
            localDate: date,
            startedAt,
            endedAt: startedAt + duration * 60_000,
            durationMinutes: duration,
            note: null,
          },
          late ? 'generated-late' : 'generated',
          createdAt,
        )
        sessions += 1
        if (late) lateSessions += 1
      } else {
        setDailyStatus(
          db,
          userId,
          taskId,
          date,
          rng() < 0.72 ? 'skipped' : 'postponed',
          null,
          'generated',
          epochAtMinute(addDays(date, 1), 7 * 60),
        )
        statuses += 1
      }
      recordActivityOutcome(db, userId, taskId, date, addDays(date, 1))
    })
  }

  // Give today's Nudge a completed check-in without creating any outcome.
  saveCheckin(
    db,
    userId,
    { date: today, answers: dailyAnswers(0.25, rng), context: 'Demo check-in' },
    Math.min(Date.now(), epochAtMinute(today, 23 * 60 + 50)),
  )

  const counts = {
    tasks: taskIds.length,
    sessions,
    lateSessions,
    statuses,
    offDays: (db.prepare('SELECT COUNT(*) AS n FROM off_days WHERE user_id = ?').get(userId) as unknown as { n: number }).n,
    skipEvents: (db.prepare('SELECT COUNT(*) AS n FROM task_skip_events WHERE actor_id = ?').get(userId) as unknown as { n: number }).n,
    checkins,
    checkinEdits,
    configVersions: (db.prepare('SELECT COUNT(*) AS n FROM task_configs WHERE user_id = ?').get(userId) as unknown as { n: number }).n,
    outcomeLinks: (db.prepare('SELECT COUNT(*) AS n FROM activity_outcome_links WHERE user_id = ?').get(userId) as unknown as { n: number }).n,
  }
  return { userId, email: options.email ?? DEMO_EMAIL, from, to, today, holdoutFrom, taskIds, counts }
}

export interface ClassifierBacktest {
  kind: 'completion' | 'target'
  modelType: string
  n: number
  modelBrier: number | null
  baselineBrier: number | null
  modelEce: number | null
  modelAuc: number | null
  modelAccuracy: number | null
  baselineAccuracy: number | null
}

export interface DurationBacktest {
  modelType: string
  n: number
  modelMae: number | null
  baselineMae: number | null
}

export interface BacktestReport {
  trainFrom: string
  trainTo: string
  holdoutFrom: string
  holdoutTo: string
  featureCount: number
  compact: boolean
  predictionMinutes: number[]
  completion: ClassifierBacktest
  target: ClassifierBacktest
  duration: DurationBacktest
}

function contextFor(
  db: DatabaseSync,
  userId: number,
  taskIds: string[],
  date: string,
  minute: number,
  today: string,
): PredictContext | null {
  const historyEnd = addDays(date, -1)
  const priorRate = userCompletionPrior(db, userId, taskIds, historyEnd)
  const asOfEpoch = epochAtMinute(date, minute) - 1
  const checkin = getCheckinAsOf(db, userId, date, asOfEpoch)
  return {
    date,
    today,
    nowMinutes: minute,
    checkinState: checkin ? checkinState(checkin) : 'not_asked',
    answers: checkin && checkin.skipped === 0 ? answeredValues(checkin) : null,
    settings: getPredictionSettings(db, userId),
    priorRate,
    tagStats: groupStatistics(db, userId, taskIds, historyEnd, priorRate, 'tag', { to: historyEnd }),
    priorityStats: groupStatistics(db, userId, taskIds, historyEnd, priorRate, 'priority', { to: historyEnd }),
    random: () => 0.5,
    asOfEpoch,
  }
}

function classifierBacktest(
  artifact: ClassifierArtifact,
  rows: ReturnType<typeof buildTrainingSet>['rows'],
  label: (row: (typeof rows)[number]) => number | null,
  baselineProbability: (row: (typeof rows)[number]) => number | null,
  kind: 'completion' | 'target',
): ClassifierBacktest {
  const model: Labelled[] = []
  const baseline: Labelled[] = []
  for (const row of rows) {
    const y = label(row)
    const p = baselineProbability(row)
    if (y === null || p === null) continue
    const entry = { y, w: row.weight }
    model.push({ ...entry, p: predictClassifier(artifact, row.features) })
    baseline.push({ ...entry, p })
  }
  return {
    kind,
    modelType: artifact.type,
    n: model.length,
    modelBrier: brier(model),
    baselineBrier: brier(baseline),
    modelEce: calibrationError(model),
    modelAuc: rocAuc(model),
    modelAccuracy: confusion(model).accuracy,
    baselineAccuracy: confusion(baseline).accuracy,
  }
}

/** Train before the holdout and score the later days without ever training on them. */
export function backtestDemoData(db: DatabaseSync, userId: number, result: DemoDataResult): BacktestReport {
  const taskIds = userTaskIds(db, userId)
  const trainTo = addDays(result.holdoutFrom, -1)
  const today = result.today
  const training = trainUserModels(db, userId, {
    taskIds,
    from: result.from,
    to: trainTo,
    today: addDays(trainTo, 1),
    register: false,
    version: 'demo-backtest',
    seed: 20261124,
  })

  const predictionMinutes = training.completion.predictionMinutes
  const holdout = buildTrainingSet(db, userId, taskIds, result.holdoutFrom, result.to, today, {
    vocabulary: training.vocabulary,
    predictionMinutes,
  })
  const contexts = new Map<string, PredictContext | null>()
  const contextForRow = (row: (typeof holdout.rows)[number]): PredictContext | null => {
    const key = `${row.date}:${row.predictionMinute}`
    if (!contexts.has(key)) {
      contexts.set(key, contextFor(db, userId, taskIds, row.date, row.predictionMinute, today))
    }
    return contexts.get(key) ?? null
  }

  const completion = classifierBacktest(
    training.completion,
    holdout.rows,
    (row) => row.completionLabel,
    (row) => contextForRow(row) ? predictTask(db, userId, row.taskId, contextForRow(row)!)?.completionProbability ?? null : null,
    'completion',
  )
  const target = classifierBacktest(
    training.target,
    holdout.rows,
    (row) => row.targetLabel,
    (row) => contextForRow(row) ? predictTask(db, userId, row.taskId, contextForRow(row)!)?.targetProbability ?? null : null,
    'target',
  )

  const modelPoints: Array<{ predicted: number; actual: number; w: number }> = []
  const baselinePoints: Array<{ predicted: number; actual: number; w: number }> = []
  for (const row of holdout.rows) {
    if (row.duration === null) continue
    const context = contextForRow(row)
    const prediction = context ? predictTask(db, userId, row.taskId, context) : null
    if (!prediction?.expectedDuration) continue
    const estimate = predictDuration(training.duration, row.features)
    modelPoints.push({ predicted: estimate.point, actual: row.duration, w: row.weight })
    baselinePoints.push({ predicted: prediction.expectedDuration, actual: row.duration, w: row.weight })
  }

  return {
    trainFrom: result.from,
    trainTo,
    holdoutFrom: result.holdoutFrom,
    holdoutTo: result.to,
    featureCount: training.featureNames.length,
    compact: training.vocabulary.compact === true,
    predictionMinutes,
    completion,
    target,
    duration: {
      modelType: training.duration.type,
      n: modelPoints.length,
      modelMae: mae(modelPoints),
      baselineMae: mae(baselinePoints),
    },
  }
}

/** Train on every generated day and promote what clears the normal gates. */
export function trainDemoChampions(db: DatabaseSync, userId: number, result: DemoDataResult): string[] {
  const trained = trainUserModels(db, userId, {
    taskIds: result.taskIds,
    from: result.from,
    to: result.to,
    today: result.today,
    register: true,
    version: `demo-full-${result.to}`,
    seed: 20261124,
  })
  const notes: string[] = []
  for (const candidate of trained.candidates) {
    if (candidate.id === null) continue
    const decision = promoteCandidate(db, userId, candidate.id)
    notes.push(`${candidate.kind}: ${candidate.chosenType} — ${decision.reason}`)
  }
  return notes
}

interface ParsedArgs {
  target: 'isolated' | 'app'
  dbPath?: string
  days: number
  holdout: number
  seed: number
}

function parseArgs(argv: string[]): ParsedArgs {
  const value = (name: string, fallback?: string): string | undefined => {
    const index = argv.indexOf(`--${name}`)
    return index >= 0 ? argv[index + 1] : fallback
  }
  const target = value('target', 'isolated')
  if (target !== 'isolated' && target !== 'app') throw new Error('--target must be isolated or app.')
  return {
    target,
    dbPath: value('db'),
    days: Number(value('days', '150')),
    holdout: Number(value('holdout', '30')),
    seed: Number(value('seed', '20261124')),
  }
}

function format(value: number | null | undefined, digits = 3): string {
  return value === null || value === undefined || !Number.isFinite(value) ? 'n/a' : value.toFixed(digits)
}

async function openCliDatabase(args: ParsedArgs): Promise<DatabaseSync> {
  const defaultPath = args.target === 'app' ? 'server/data/todo.db' : 'server/data/ml-backtest.db'
  const path = resolve(process.cwd(), args.dbPath ?? defaultPath)
  if (args.target === 'isolated') {
    for (const suffix of ['', '-wal', '-shm']) {
      rmSync(`${path}${suffix}`, { force: true })
    }
  }
  mkdirSync(dirname(path), { recursive: true })
  process.env.DUIT_DB_PATH = path
  const { db } = await import('../db')
  return db
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv)
  const db = await openCliDatabase(args)
  const userId = createDemoUser(db)
  const result = generateDemoHistory(db, userId, {
    days: args.days,
    holdoutDays: args.holdout,
    seed: args.seed,
  })
  const report = backtestDemoData(db, userId, result)
  const promotions = trainDemoChampions(db, userId, result)

  console.log(`Target: ${args.target}`)
  console.log(`Demo user: ${result.email} / ${DEMO_PASSWORD}`)
  console.log(`History: ${result.from} → ${result.to} (${args.days} days), holdout ${result.holdoutFrom} → ${result.to}`)
  console.log(`Written: ${result.counts.tasks} tasks, ${result.counts.sessions} sessions (${result.counts.lateSessions} late), ${result.counts.statuses} statuses, ${result.counts.checkins} check-ins, ${result.counts.offDays} off periods, ${result.counts.skipEvents} skips`)
  console.log(`Features: ${report.featureCount} columns, compact=${report.compact}, grid=${report.predictionMinutes.join('/')}`)
  console.log('')
  console.log('Synthetic chronological holdout (lower Brier/MAE is better):')
  console.log(`  completion: n=${report.completion.n}, model Brier ${format(report.completion.modelBrier)} vs baseline ${format(report.completion.baselineBrier)}, ECE ${format(report.completion.modelEce)}, AUC ${format(report.completion.modelAuc)}, accuracy ${format(report.completion.modelAccuracy)} vs ${format(report.completion.baselineAccuracy)}`)
  console.log(`  target:     n=${report.target.n}, model Brier ${format(report.target.modelBrier)} vs baseline ${format(report.target.baselineBrier)}, ECE ${format(report.target.modelEce)}, AUC ${format(report.target.modelAuc)}, accuracy ${format(report.target.modelAccuracy)} vs ${format(report.target.baselineAccuracy)}`)
  console.log(`  duration:   n=${report.duration.n}, model MAE ${format(report.duration.modelMae, 1)} vs baseline ${format(report.duration.baselineMae, 1)} minutes`)
  console.log('')
  console.log('Demo champions:')
  for (const note of promotions) console.log(`  ${note}`)
  console.log('')
  console.log('These numbers describe synthetic data only. They do not measure accuracy on your own habits.')
  db.close()
}

const invoked = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (invoked && import.meta.url === invoked) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
