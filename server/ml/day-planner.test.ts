import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { buildDaySchedule } from './day-planner'
import { epochAtMinute, type PlanResult, type TaskPrediction } from './predictors'

const USER = 1
const DATE = '2026-06-30'
const NOW = 9 * 60

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      text TEXT NOT NULL,
      done INTEGER NOT NULL DEFAULT 0,
      preferred_time TEXT
    )
  `)
  return db
}

function insertTask(db: DatabaseSync, text: string, preferred: string | null = null): string {
  const id = randomUUID()
  db.prepare('INSERT INTO tasks (id, user_id, text, preferred_time) VALUES (?, ?, ?, ?)').run(id, USER, text, preferred)
  return id
}

function prediction(taskId: string, startMinute: number | null, duration: number): TaskPrediction {
  return {
    taskId,
    date: DATE,
    source: 'baseline',
    modelVersion: 'baseline-1.0.0',
    stage: 1,
    confidence: 'medium',
    dataSufficiencyDays: 10,
    completionProbability: 0.7,
    targetProbability: null,
    expectedDuration: duration,
    durationLow: null,
    durationHigh: null,
    recommendedStart: startMinute === null ? null : epochAtMinute(DATE, startMinute),
    recommendedEnd: startMinute === null ? null : epochAtMinute(DATE, startMinute + duration),
    exploratory: false,
    explanation: '',
    inputs: {
      baseRate: 0.7,
      priorRate: 0.7,
      stage: 1,
      checkinAdjustment: 0,
      tagAdjustment: 0,
      priorityAdjustment: 0,
      labelledDays: 10,
      peakBin: null,
      offDaysExcluded: 0,
    },
  }
}

function plan(entries: Array<{ taskId: string; text: string; start: number | null; duration: number }>): PlanResult {
  return {
    date: DATE,
    offDay: false,
    offDayKind: null,
    reducedConfidence: false,
    checkinState: 'completed',
    readiness: { score: 50, line: '', state: 'ready' },
    entries: entries.map((entry) => ({
      taskId: entry.taskId,
      text: entry.text,
      priority: 'none',
      remainingTargetMinutes: null,
      doneMinutes: 0,
      prediction: prediction(entry.taskId, entry.start, entry.duration),
      rankScore: 0.7,
    })),
    suggestions: [],
    note: '',
  }
}

function schedule(db: DatabaseSync, current: PlanResult, freeTime?: number) {
  return buildDaySchedule(db, USER, current, {
    date: DATE,
    today: DATE,
    nowMinutes: NOW,
    answers: freeTime === undefined ? null : { free_time: freeTime },
  })
}

test('an empty or off-day plan cannot be arranged', () => {
  const db = freshDb()
  const empty = schedule(db, { ...plan([]), offDay: true })
  assert.equal(empty.available, false)
  assert.equal(empty.warning, null)
  assert.equal(schedule(db, plan([])).available, false)
})

test('slots never overlap; a colliding task is nudged and marked as shifted', () => {
  const db = freshDb()
  const first = insertTask(db, 'Write')
  const second = insertTask(db, 'Review')
  const result = schedule(db, plan([
    { taskId: first, text: 'Write', start: 9 * 60, duration: 60 },
    { taskId: second, text: 'Review', start: 9 * 60, duration: 30 },
  ]))

  assert.equal(result.available, true)
  assert.equal(result.slots.length, 2)
  const [a, b] = result.slots
  assert.ok(a.end <= b.start, 'slots must not overlap')
  assert.equal(a.shifted, false)
  assert.equal(b.shifted, true)
  assert.equal(result.overloaded, false)
})

test('an overloaded plan warns against the free-time answer but changes nothing', () => {
  const db = freshDb()
  const first = insertTask(db, 'Write')
  const second = insertTask(db, 'Review')
  const before = db.prepare('SELECT done, preferred_time FROM tasks ORDER BY id').all()
  const result = schedule(db, plan([
    { taskId: first, text: 'Write', start: 9 * 60, duration: 45 },
    { taskId: second, text: 'Review', start: 10 * 60, duration: 45 },
  ]), 5) // very limited => 60 min budget

  assert.equal(result.capacityMinutes, 60)
  assert.equal(result.plannedMinutes, 90)
  assert.equal(result.overloaded, true)
  assert.match(result.warning ?? '', /looks overloaded/)
  assert.deepEqual(db.prepare('SELECT done, preferred_time FROM tasks ORDER BY id').all(), before)
})

test('a task without a recommended time uses its preferred time as a weak hint', () => {
  const db = freshDb()
  const task = insertTask(db, 'Walk', '14:30')
  const result = schedule(db, plan([{ taskId: task, text: 'Walk', start: null, duration: 30 }]))
  assert.equal(result.slots.length, 1)
  assert.equal(result.slots[0].start, epochAtMinute(DATE, 14 * 60 + 30))
})

test('no free-time answer means no overload claim', () => {
  const db = freshDb()
  const first = insertTask(db, 'A')
  const second = insertTask(db, 'B')
  const third = insertTask(db, 'C')
  const result = schedule(db, plan([
    { taskId: first, text: 'A', start: 9 * 60, duration: 120 },
    { taskId: second, text: 'B', start: 11 * 60 + 30, duration: 120 },
    { taskId: third, text: 'C', start: 14 * 60, duration: 120 },
  ]))
  assert.equal(result.capacityMinutes, null)
  assert.equal(result.overloaded, false)
  assert.equal(result.warning, null)
  assert.equal(result.plannedMinutes, 360)
})

test('a plan that cannot fit the day reports the leftovers instead of inventing slots', () => {
  const db = freshDb()
  const tasks = ['A', 'B', 'C'].map((name) => insertTask(db, name))
  const result = schedule(db, plan(tasks.map((taskId, index) => ({
    taskId,
    text: ['A', 'B', 'C'][index],
    start: 9 * 60,
    duration: 320,
  }))))
  assert.equal(result.slots.length, 2)
  assert.equal(result.unplaced.length, 1)
  assert.equal(result.overloaded, true)
  assert.match(result.warning ?? '', /without a slot/)
})
