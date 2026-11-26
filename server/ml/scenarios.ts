import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import {
  CHECKIN_ANSWER_KEYS,
  createCheckinSchema,
  getCheckin,
  listCheckinHistory,
  saveCheckin,
  skipCheckin,
  type CheckinAnswerKey,
} from '../checkins-store'
import { createFoundationSchema, createMlSchema, createPredictionSchema } from './schema'
import { recordTaskConfig } from './task-config'
import { createSession } from './sessions'
import { dailyActivity, setDailyStatus, type ExplicitStatus } from './daily-activity'
import { createOffDay, addDays } from './off-days'
import { syncTaskTags } from './tags'
import { activityStatistics, groupStatistics, userCompletionPrior, userTaskIds } from './statistics'
import { checkinAdjustment } from './predictors'
import { buildTrainingSet } from './dataset'
import { trainUserModels } from './pipeline'
import { recordActivityOutcome } from './learning'
import { driftForTask, configChangesForTask } from './drift'
import { modelHealthView } from './health'

/**
 * Scenario suite.
 *
 * Sixteen small, self-contained situations, each built on a fresh in-memory
 * database and run through the real code — no mocks. Each scenario asserts the
 * behaviour the brief requires and returns a plain-language result. Nothing here
 * fabricates a row or claims an accuracy figure: the checks are about
 * *behaviour* (missing stays missing, off days are excluded, a shift is reported
 * as an association, a model is only trained on enough real data), not about how
 * good a model is.
 *
 * `runScenarioSuite` is used by the tests. It never touches the app's real
 * database.
 */

const USER = 1
const CONFIG_FROM = Date.parse('2025-01-01T00:00:00')

export interface ScenarioOutcome {
  name: string
  description: string
  ok: boolean
  detail: string
}

export interface Scenario {
  name: string
  description: string
  run: (db: DatabaseSync) => ScenarioOutcome
}

function result(scenario: { name: string; description: string }, ok: boolean, detail: string): ScenarioOutcome {
  return { name: scenario.name, description: scenario.description, ok, detail }
}

/** A fresh in-memory database with exactly the app's schemas. */
export function scenarioDatabase(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT)')
  db.exec("INSERT INTO users (email) VALUES ('scenario@example.com')")
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
  createPredictionSchema(db)
  createMlSchema(db)
  return db
}

interface TaskOptions {
  text?: string
  priority?: string
  duration?: number | null
  tags?: string[]
  from?: number
}

function addTask(db: DatabaseSync, options: TaskOptions = {}): string {
  const id = randomUUID()
  const text = options.text ?? 'Read'
  const priority = options.priority ?? 'none'
  const duration = options.duration === undefined ? 60 : options.duration
  db.prepare(
    `INSERT INTO tasks (id, user_id, text, created_at, priority, tags, recurrence, duration)
     VALUES (?, ?, ?, 1, ?, '[]', 'none', ?)`,
  ).run(id, USER, text, priority, duration)
  const tagIds = options.tags && options.tags.length > 0 ? syncTaskTags(db, USER, id, options.tags) : []
  recordTaskConfig(
    db,
    { id, user_id: USER, text, priority, tags: '[]', recurrence: 'none', recurrence_config: null, duration },
    tagIds,
    options.from ?? CONFIG_FROM,
  )
  return id
}

/** Re-record the task's config with a new version effective from a date. */
function reconfigureTask(
  db: DatabaseSync,
  taskId: string,
  changes: { text?: string; priority?: string; duration?: number | null },
  effectiveFrom: number,
): void {
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as unknown as {
    text: string
    priority: string
    duration: number | null
  }
  const text = changes.text ?? row.text
  const priority = changes.priority ?? row.priority
  const duration = changes.duration === undefined ? row.duration : changes.duration
  db.prepare('UPDATE tasks SET text = ?, priority = ?, duration = ? WHERE id = ?').run(
    text,
    priority,
    duration,
    taskId,
  )
  const tagIds = (
    db.prepare('SELECT tag_id FROM task_tags WHERE task_id = ?').all(taskId) as unknown as Array<{ tag_id: number }>
  ).map((r) => r.tag_id)
  recordTaskConfig(
    db,
    { id: taskId, user_id: USER, text, priority, tags: '[]', recurrence: 'none', recurrence_config: null, duration },
    tagIds,
    effectiveFrom,
  )
}

function addSession(db: DatabaseSync, taskId: string, date: string, minutes: number, startHour = 9): void {
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

function setStatus(db: DatabaseSync, taskId: string, date: string, status: ExplicitStatus): void {
  setDailyStatus(db, USER, taskId, date, status, null)
}

function answers(values: Partial<Record<CheckinAnswerKey, number>>): Record<CheckinAnswerKey, number | null> {
  const out = {} as Record<CheckinAnswerKey, number | null>
  for (const key of CHECKIN_ANSWER_KEYS) out[key] = values[key] ?? null
  return out
}

function checkin(db: DatabaseSync, date: string, values: Partial<Record<CheckinAnswerKey, number>>, context: string | null = null): void {
  saveCheckin(db, USER, { date, answers: answers(values), context })
}

// ---------------------------------------------------------------------------
// The scenarios
// ---------------------------------------------------------------------------

export const SCENARIOS: Scenario[] = [
  {
    name: 'new-user',
    description: 'A brand-new user with no tasks and no history.',
    run(db) {
      const tasks = userTaskIds(db, USER)
      const stats = activityStatistics(db, USER, 'missing-task', '2026-06-01', 0.5)
      const drift = driftForTask(db, USER, 'missing-task', '2026-06-01', 0.5)
      const health = modelHealthView(db, USER)
      const ok = tasks.length === 0 && stats.labelledDays === 0 && drift.configChanges.length === 0 && !health.anyFallback
      return result(this, ok, `tasks=${tasks.length}, labelledDays=${stats.labelledDays}, driftChanges=${drift.configChanges.length}, fallback=${health.anyFallback}`)
    },
  },
  {
    name: 'no-outcomes',
    description: 'Activity recorded, but no day was ever explicitly marked.',
    run(db) {
      const task = addTask(db)
      const date = '2026-06-01'
      addSession(db, task, date, 30)
      recordActivityOutcome(db, USER, task, date, '2026-06-02')
      const day = dailyActivity(db, USER, task, date, '2026-06-02')
      const link = db
        .prepare('SELECT performed, target_achieved FROM activity_outcome_links WHERE user_id = ? AND task_id = ?')
        .get(USER, task) as unknown as { performed: number | null; target_achieved: number | null }
      // No explicit day status was ever set, but the recorded session is a real
      // observed outcome: performed is true and the target is judged (not null).
      const ok = day.performed === true && link.performed === 1 && link.target_achieved !== null
      return result(this, ok, `performed=${day.performed}, link.performed=${link.performed}, link.target=${link.target_achieved}`)
    },
  },
  {
    name: 'small-history',
    description: 'Only a handful of labelled days — below the training thresholds.',
    run(db) {
      const task = addTask(db)
      for (let i = 0; i < 5; i += 1) setStatus(db, task, addDays('2026-06-01', i), 'completed')
      const set = buildTrainingSet(db, USER, [task], '2026-06-01', '2026-06-05', '2026-06-06')
      const trained = trainUserModels(db, USER, { register: false, today: '2026-06-06', from: '2026-06-01', to: '2026-06-05' })
      const allBaseline = trained.candidates.every((candidate) => candidate.chosenType === 'baseline' || candidate.smallData)
      const ok = set.labelledCount < 40 && allBaseline
      return result(this, ok, `labelled=${set.labelledCount}, types=${trained.candidates.map((c) => c.chosenType).join(',')}`)
    },
  },
  {
    name: 'sufficient-history',
    description: 'Enough labelled days for a model to be trained.',
    run(db) {
      const task = addTask(db)
      const from = '2026-01-01'
      for (let i = 0; i < 70; i += 1) {
        const date = addDays(from, i)
        if (i % 4 === 3) {
          setStatus(db, task, date, 'skipped')
        } else {
          setStatus(db, task, date, 'completed')
          addSession(db, task, date, 45 + (i % 3) * 15, 8 + (i % 6))
        }
      }
      const trained = trainUserModels(db, USER, { register: true, today: addDays(from, 70), from, to: addDays(from, 69), version: 'scenario-1' })
      const ok = trained.labelledCount >= 40 && trained.candidates.some((candidate) => candidate.chosenType !== 'baseline')
      return result(this, ok, `labelled=${trained.labelledCount}, types=${trained.candidates.map((c) => c.chosenType).join(',')}`)
    },
  },
  {
    name: 'good-mood-high-energy',
    description: 'A good mood / high energy check-in shifts the read upward, as an association.',
    run(_db) {
      const good = checkinAdjustment({ feeling: 1, energy: 1, motivation: 1 })
      const ok = good.value > 0
      return result(this, ok, `adjustment=${good.value.toFixed(3)}, note=${good.note ?? 'none'}`)
    },
  },
  {
    name: 'low-mood-low-energy',
    description: 'A low mood / low energy check-in shifts the read downward, as an association.',
    run(_db) {
      const low = checkinAdjustment({ feeling: 5, energy: 5, motivation: 5 })
      const ok = low.value < 0
      return result(this, ok, `adjustment=${low.value.toFixed(3)}, note=${low.note ?? 'none'}`)
    },
  },
  {
    name: 'skipped-checkin',
    description: 'A skipped check-in applies no shift and is not treated as neutral answers.',
    run(db) {
      const date = '2026-06-01'
      skipCheckin(db, USER, date)
      const row = getCheckin(db, USER, date)
      const adjustment = checkinAdjustment(null)
      const ok = row?.skipped === 1 && row.feeling === null && adjustment.value === 0
      return result(this, ok, `skipped=${row?.skipped}, feeling=${row?.feeling}, adjustment=${adjustment.value}`)
    },
  },
  {
    name: 'mood-change-during-day',
    description: 'The check-in is edited later; history is kept and the latest answer is used.',
    run(db) {
      const date = '2026-06-01'
      checkin(db, date, { feeling: 4, energy: 4 })
      checkin(db, date, { feeling: 2, energy: 2 })
      const row = getCheckin(db, USER, date)
      const history = listCheckinHistory(db, USER).filter((item) => item.date === date)
      const ok = row?.feeling === 2 && history.length >= 2
      return result(this, ok, `latest feeling=${row?.feeling}, history rows=${history.length}`)
    },
  },
  {
    name: 'multi-session',
    description: 'Multiple sessions in a day are summed and the target is checked against the total.',
    run(db) {
      const task = addTask(db, { duration: 60 })
      const date = '2026-06-01'
      addSession(db, task, date, 30, 8)
      addSession(db, task, date, 45, 18)
      const day = dailyActivity(db, USER, task, date, '2026-06-02')
      const ok = day.totalMinutes === 75 && day.performed === true && day.targetAchieved === true
      return result(this, ok, `total=${day.totalMinutes}, performed=${day.performed}, targetMet=${day.targetAchieved}`)
    },
  },
  {
    name: 'frequent-misses',
    description: 'Many skipped days show up as recent misses and a lower completion read.',
    run(db) {
      const task = addTask(db)
      const from = '2026-05-01'
      for (let i = 0; i < 20; i += 1) setStatus(db, task, addDays(from, i), i < 2 ? 'completed' : 'skipped')
      const stats = activityStatistics(db, USER, task, addDays(from, 19), 0.5)
      const ok = stats.recentMisses >= 10 && (stats.completion.raw ?? 1) < 0.3
      return result(this, ok, `recentMisses=${stats.recentMisses}, rawCompletion=${stats.completion.raw?.toFixed(2)}`)
    },
  },
  {
    name: 'seasonal-change',
    description: 'More than a year of data turns on the seasonal features.',
    run(db) {
      const task = addTask(db)
      const from = '2025-06-01'
      for (let i = 0; i < 370; i += 1) {
        const date = addDays(from, i)
        if (i < 200 || i % 5 !== 0) {
          setStatus(db, task, date, 'completed')
          addSession(db, task, date, 30, 9)
        } else {
          setStatus(db, task, date, 'skipped')
        }
      }
      const set = buildTrainingSet(db, USER, [task], from, addDays(from, 369), addDays(from, 370))
      const ok = set.monthsOfData >= 12 && set.vocabulary.seasonal
      return result(this, ok, `months=${set.monthsOfData.toFixed(1)}, seasonal=${set.vocabulary.seasonal}`)
    },
  },
  {
    name: 'changed-daily-target',
    description: 'A changed daily target is read as a dated configuration change, not a change in the person.',
    run(db) {
      const task = addTask(db, { duration: 30 })
      for (let i = 0; i < 10; i += 1) {
        setStatus(db, task, addDays('2026-06-01', i), 'completed')
        addSession(db, task, addDays('2026-06-01', i), 30)
      }
      reconfigureTask(db, task, { duration: 60 }, Date.parse('2026-06-11T00:00:00'))
      const changes = configChangesForTask(db, task)
      const targetChange = changes.find((change) => change.fields.includes('target'))
      const ok = Boolean(targetChange && targetChange.date === '2026-06-11' && targetChange.summary.includes('30') && targetChange.summary.includes('60'))
      return result(this, ok, targetChange ? targetChange.summary : 'no target change found')
    },
  },
  {
    name: 'changed-tags-or-priority',
    description: 'A changed priority is read as a dated configuration change.',
    run(db) {
      const task = addTask(db, { priority: 'low' })
      setStatus(db, task, '2026-06-01', 'completed')
      reconfigureTask(db, task, { priority: 'high' }, Date.parse('2026-06-05T00:00:00'))
      const changes = configChangesForTask(db, task)
      const priorityChange = changes.find((change) => change.fields.includes('priority'))
      const ok = Boolean(priorityChange && priorityChange.date === '2026-06-05')
      return result(this, ok, priorityChange ? priorityChange.summary : 'no priority change found')
    },
  },
  {
    name: 'new-task-with-tag-history',
    description: 'A new activity whose tag already has history can use that tag statistic.',
    run(db) {
      const first = addTask(db, { text: 'Gym', tags: ['exercise'] })
      const from = '2026-05-01'
      for (let i = 0; i < 30; i += 1) {
        setStatus(db, first, addDays(from, i), 'completed')
        addSession(db, first, addDays(from, i), 40)
      }
      const second = addTask(db, { text: 'Run', tags: ['exercise'] })
      setStatus(db, second, addDays(from, 30), 'completed')
      recordActivityOutcome(db, USER, first, addDays(from, 0), addDays(from, 31))
      recordActivityOutcome(db, USER, second, addDays(from, 30), addDays(from, 31))
      const prior = userCompletionPrior(db, USER, userTaskIds(db, USER), addDays(from, 31))
      const tags = groupStatistics(db, USER, userTaskIds(db, USER), addDays(from, 31), prior, 'tag')
      const tagStat = [...tags.values()].find((group) => group.labelled > 0)
      const ok = Boolean(tagStat && tagStat.labelled >= 30)
      return result(this, ok, `tag labelled=${tagStat?.labelled ?? 0}, rate=${tagStat?.completion.rate.toFixed(2) ?? 'n/a'}`)
    },
  },
  {
    name: 'incomplete-inconsistent-data',
    description: 'Unknown days, an off day and a missing target are handled without inventing data.',
    run(db) {
      const task = addTask(db, { duration: null })
      const dates = ['2026-06-01', '2026-06-02', '2026-06-03', '2026-06-04']
      setStatus(db, task, dates[0], 'completed')
      addSession(db, task, dates[0], 25)
      // dates[1]: nothing recorded at all -> unknown, not a miss.
      createOffDay(db, USER, { kind: 'sick', startDate: dates[2], endDate: dates[2], note: null })
      // dates[3]: a session with no explicit status.
      addSession(db, task, dates[3], 20)
      const day0 = dailyActivity(db, USER, task, dates[0], '2026-06-05')
      const day1 = dailyActivity(db, USER, task, dates[1], '2026-06-05')
      const day2 = dailyActivity(db, USER, task, dates[2], '2026-06-05')
      const day3 = dailyActivity(db, USER, task, dates[3], '2026-06-05')
      const stats = activityStatistics(db, USER, task, '2026-06-05', 0.5)
      const ok =
        day0.targetAchieved === null &&
        day1.performed === null &&
        day2.offDay === true &&
        day3.performed === true &&
        stats.offDays === 1
      return result(
        this,
        ok,
        `d0.target=${day0.targetAchieved}, d1.performed=${day1.performed}, d2.off=${day2.offDay}, d3.performed=${day3.performed}, offDays=${stats.offDays}`,
      )
    },
  },
]

/** Run every scenario on its own fresh database. */
export function runScenarioSuite(factory: () => DatabaseSync = scenarioDatabase): ScenarioOutcome[] {
  return SCENARIOS.map((scenario) => {
    const db = factory()
    try {
      return scenario.run(db)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return result(scenario, false, `threw: ${message}`)
    } finally {
      db.close()
    }
  })
}
