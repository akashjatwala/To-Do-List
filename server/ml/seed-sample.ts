import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { DatabaseSync } from 'node:sqlite'
import { CHECKIN_ANSWER_KEYS, getCheckin, saveCheckin, skipCheckin, type CheckinAnswerKey } from '../checkins-store'
import { createSession, type ValidSession } from './sessions'
import { setDailyStatus } from './daily-activity'
import { syncTaskFoundation } from './task-sync'

/**
 * Sample data for checking the system end to end.
 *
 * This is **synthetic** data, not real history. It exists only so the tables
 * can be inspected with a month of activity in them. Everything it creates is
 * marked `source = 'sample'` (or registered in `sample_seed_registry`) and can
 * be removed again with `--purge`, so it never has to be mixed with real data
 * or used to claim real accuracy.
 */
const DAY = 24 * 60 * 60 * 1000

export interface SeedOptions {
  days?: number
  now?: number
  seed?: number
}

export interface SeedResult {
  userId: number
  tasks: number
  sessions: number
  statuses: number
  checkins: number
  questions: number
}

interface VersionSpec {
  /** Days before today (negative). */
  fromOffset: number
  target: number | null
  priority: string
  tags: string[]
  preferredTime: string | null
}

interface SampleTaskSpec {
  text: string
  recurrence: 'none' | 'daily' | 'weekly' | 'custom'
  recurrenceConfig?: string | null
  reliability: number
  /** For custom weekly repeats. */
  weekdays?: number[]
  /** For a plain weekly repeat. */
  weeklyDow?: number
  versions: VersionSpec[]
}

const SAMPLE_TASKS: SampleTaskSpec[] = [
  {
    text: 'Read a book',
    recurrence: 'daily',
    reliability: 0.82,
    versions: [
      { fromOffset: -30, target: 45, priority: 'low', tags: ['Personal'], preferredTime: '21:00' },
      { fromOffset: -15, target: 60, priority: 'medium', tags: ['Personal', 'Health'], preferredTime: '21:30' },
    ],
  },
  {
    text: 'Morning run',
    recurrence: 'custom',
    recurrenceConfig: JSON.stringify({ mode: 'weekly', days: [1, 3, 5] }),
    weekdays: [1, 3, 5],
    reliability: 0.66,
    versions: [
      { fromOffset: -30, target: 30, priority: 'medium', tags: ['Health', 'Exercise'], preferredTime: '07:00' },
    ],
  },
  {
    text: 'Study Spanish',
    recurrence: 'daily',
    reliability: 0.6,
    versions: [
      { fromOffset: -30, target: 25, priority: 'medium', tags: ['Personal', 'Study'], preferredTime: '18:30' },
    ],
  },
  {
    text: 'Tidy the kitchen',
    recurrence: 'daily',
    reliability: 0.55,
    versions: [
      { fromOffset: -30, target: 15, priority: 'low', tags: ['Household'], preferredTime: null },
    ],
  },
  {
    text: 'Write journal',
    recurrence: 'daily',
    reliability: 0.72,
    versions: [
      { fromOffset: -30, target: 10, priority: 'none', tags: ['Personal'], preferredTime: '22:30' },
    ],
  },
  {
    text: 'Call family',
    recurrence: 'weekly',
    weeklyDow: 0,
    reliability: 0.8,
    versions: [
      { fromOffset: -30, target: 20, priority: 'high', tags: ['Relationship'], preferredTime: '19:00' },
    ],
  },
]

const SKIP_REASONS = ['Away from home', 'Too tired', 'Ran out of time', 'Not feeling well', 'Unexpected guests']

/** Small deterministic PRNG so re-running produces the same sample month. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function localDate(date: Date): string {
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

function startOfLocalDay(date: string): number {
  const [year, month, day] = date.split('-').map(Number)
  return new Date(year, month - 1, day, 0, 0, 0, 0).getTime()
}

function hhmmToMinutes(value: string): number {
  const [hours, minutes] = value.split(':').map(Number)
  return hours * 60 + minutes
}

function ensureRegistry(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sample_seed_registry (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      entity TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE (entity, entity_id)
    );
  `)
}

function register(db: DatabaseSync, userId: number, entity: string, entityId: string, now: number): void {
  db.prepare(
    'INSERT OR IGNORE INTO sample_seed_registry (user_id, entity, entity_id, created_at) VALUES (?, ?, ?, ?)',
  ).run(userId, entity, entityId, now)
}

function allTagIds(db: DatabaseSync, userId: number): number[] {
  return (
    db.prepare('SELECT id FROM tags WHERE user_id = ?').all(userId) as unknown as Array<{ id: number }>
  ).map((row) => row.id)
}

/** The version in force on a given local date, or the first version. */
function versionFor(spec: SampleTaskSpec, date: string): VersionSpec {
  const ordered = [...spec.versions].sort((a, b) => a.fromOffset - b.fromOffset)
  let chosen = ordered[0]
  for (const version of ordered) {
    if (version.fromOffset <= dateOffset(date)) chosen = version
  }
  return chosen
}

let TODAY_REF = ''
function dateOffset(date: string): number {
  return Math.round((startOfLocalDay(date) - startOfLocalDay(TODAY_REF)) / DAY)
}

function isScheduled(spec: SampleTaskSpec, date: string): boolean {
  if (spec.recurrence === 'daily') return true
  if (spec.recurrence === 'custom') {
    const dow = new Date(startOfLocalDay(date)).getDay()
    return (spec.weekdays ?? []).includes(dow)
  }
  if (spec.recurrence === 'weekly') {
    const dow = new Date(startOfLocalDay(date)).getDay()
    return dow === (spec.weeklyDow ?? 0)
  }
  return false
}

interface Occupied {
  start: number
  end: number
}

function overlaps(occupied: Occupied[], start: number, end: number): boolean {
  return occupied.some((range) => start < range.end && range.start < end)
}

function makeSession(taskId: string, date: string, startMinutes: number, durationMinutes: number): ValidSession {
  const dayStart = startOfLocalDay(date)
  const startedAt = dayStart + startMinutes * 60_000
  return {
    taskId,
    localDate: date,
    startedAt,
    endedAt: startedAt + durationMinutes * 60_000,
    durationMinutes,
    note: null,
  }
}

export function seedSample(db: DatabaseSync, userId: number, options: SeedOptions = {}): SeedResult {
  ensureRegistry(db)
  const now = options.now ?? Date.now()
  const days = Math.min(Math.max(options.days ?? 30, 7), 180)
  const rng = mulberry32(options.seed ?? 20260501)

  const today = localDate(new Date(now))
  TODAY_REF = today
  // The board only shows tasks due on the selected day, so the sample tasks are
  // due today — that is where the user will look to inspect them.
  const dueToday = startOfLocalDay(today) + DAY - 1
  const tagsBefore = new Set(allTagIds(db, userId))

  const result: SeedResult = { userId, tasks: 0, sessions: 0, statuses: 0, checkins: 0, questions: 0 }
  const preferredTimeRe = /^([01]\d|2[0-3]):[0-5]\d$/

  for (const spec of SAMPLE_TASKS) {
    const ordered = [...spec.versions].sort((a, b) => a.fromOffset - b.fromOffset)
    const first = ordered[0]
    const id = randomUUID()

    // Create the task at its earliest version, then append later versions by
    // updating the row and re-syncing — exactly what a real edit would do.
    db.prepare(
      `INSERT INTO tasks (id, user_id, text, created_at, due, priority, tags, recurrence, duration, recurrence_config, preferred_time)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      userId,
      spec.text,
      now + first.fromOffset * DAY,
      dueToday,
      first.priority,
      JSON.stringify(first.tags),
      spec.recurrence,
      first.target,
      spec.recurrenceConfig ?? null,
      first.preferredTime && preferredTimeRe.test(first.preferredTime) ? first.preferredTime : null,
    )
    syncTaskFoundation(db, taskRow(db, id), now + first.fromOffset * DAY)
    register(db, userId, 'task', id, now)
    result.tasks += 1

    for (const version of ordered.slice(1)) {
      db.prepare('UPDATE tasks SET priority = ?, tags = ?, duration = ?, preferred_time = ? WHERE id = ?').run(
        version.priority,
        JSON.stringify(version.tags),
        version.target,
        version.preferredTime,
        id,
      )
      syncTaskFoundation(db, taskRow(db, id), now + version.fromOffset * DAY)
    }

    // A month of sessions, one day at a time.
    for (let offset = -days; offset <= -1; offset += 1) {
      const date = localDate(new Date(now + offset * DAY))
      if (!isScheduled(spec, date)) continue
      const version = versionFor(spec, date)
      const target = version.target ?? 30

      // Overlap is only meaningful within a single day, so this resets daily.
      const occupied: Occupied[] = []

      if (rng() < spec.reliability * 0.9) {
        const total = Math.max(5, Math.round(target * (0.5 + rng())))
        const parts = target >= 30 && rng() < 0.25 ? [Math.round(total * 0.6), total - Math.round(total * 0.6)] : [total]
        const base = version.preferredTime ? hhmmToMinutes(version.preferredTime) : 10 * 60 + Math.floor(rng() * 8 * 60)
        let cursor = base + Math.round(rng() * 90 - 45)
        for (const part of parts) {
          if (part < 5) continue
          const start = Math.max(0, Math.min(cursor, 24 * 60 - 90))
          const end = start + part
          if (end > 24 * 60 || overlaps(occupied, start, end)) {
            cursor = end + 20
            continue
          }
          occupied.push({ start, end })
          createSession(db, userId, makeSession(id, date, start, part), 'sample', now + offset * DAY + 12 * 60 * 60 * 1000)
          result.sessions += 1
          cursor = end + 10 + Math.floor(rng() * 30)
        }
      } else if (rng() < 0.3) {
        const status = rng() < 0.5 ? 'skipped' : 'postponed'
        const reason = SKIP_REASONS[Math.floor(rng() * SKIP_REASONS.length)]
        setDailyStatus(db, userId, id, date, status, reason, 'sample', now + offset * DAY + 20 * 60 * 60 * 1000)
        result.statuses += 1
      }
    }
  }

  // Tag-suggested default question and one task-specific question.
  const exerciseTag = db
    .prepare("SELECT id FROM tags WHERE user_id = ? AND normalized = 'exercise' AND merged_into_id IS NULL")
    .get(userId) as unknown as { id: number } | undefined
  if (exerciseTag) {
    const questionId = randomUUID()
    db.prepare(
      `INSERT INTO context_questions (id, user_id, task_id, tag_id, key, prompt, kind, options_json, position, active, created_at)
       VALUES (?, ?, NULL, ?, 'recovery', 'How did your body feel afterwards?', 'scale', NULL, 0, 1, ?)`,
    ).run(questionId, userId, exerciseTag.id, now)
    register(db, userId, 'question', questionId, now)
    result.questions += 1
  }
  const bookTask = db
    .prepare("SELECT id FROM tasks WHERE user_id = ? AND text = 'Read a book' LIMIT 1")
    .get(userId) as unknown as { id: string } | undefined
  if (bookTask) {
    const questionId = randomUUID()
    db.prepare(
      `INSERT INTO context_questions (id, user_id, task_id, tag_id, key, prompt, kind, options_json, position, active, created_at)
       VALUES (?, ?, ?, NULL, 'where', 'Where did you read?', 'text', NULL, 0, 1, ?)`,
    ).run(questionId, userId, bookTask.id, now)
    register(db, userId, 'question', questionId, now)
    result.questions += 1
  }

  // A check-in for each past day that does not already have one.
  for (let offset = -days; offset <= -1; offset += 1) {
    const date = localDate(new Date(now + offset * DAY))
    if (getCheckin(db, userId, date)) continue
    if (rng() < 0.12) {
      skipCheckin(db, userId, date)
    } else {
      const answers = {} as Record<CheckinAnswerKey, number | null>
      for (const key of CHECKIN_ANSWER_KEYS) answers[key] = 1 + Math.floor(rng() * 5)
      saveCheckin(db, userId, { date, answers, context: null })
    }
    db.prepare("UPDATE checkins SET source = 'sample' WHERE user_id = ? AND date = ?").run(userId, date)
    db.prepare("UPDATE checkin_history SET source = 'sample' WHERE user_id = ? AND date = ?").run(userId, date)
    result.checkins += 1
  }

  // Remember tags created by the seed so a purge can tidy them up.
  for (const tagId of allTagIds(db, userId)) {
    if (!tagsBefore.has(tagId)) register(db, userId, 'tag', String(tagId), now)
  }

  return result
}

/** Remove everything the seed created. Real data is left untouched. */
export function purgeSample(db: DatabaseSync, userId: number): void {
  ensureRegistry(db)
  const rows = db
    .prepare('SELECT entity, entity_id FROM sample_seed_registry WHERE user_id = ?')
    .all(userId) as unknown as Array<{ entity: string; entity_id: string }>

  for (const row of rows) {
    if (row.entity === 'task') db.prepare('DELETE FROM tasks WHERE id = ?').run(row.entity_id)
    if (row.entity === 'question') db.prepare('DELETE FROM context_questions WHERE id = ?').run(row.entity_id)
  }

  for (const row of rows) {
    if (row.entity !== 'tag') continue
    const tagId = Number(row.entity_id)
    const used =
      db.prepare('SELECT 1 FROM task_tags WHERE tag_id = ? LIMIT 1').get(tagId) ??
      db.prepare('SELECT 1 FROM task_config_tags WHERE tag_id = ? LIMIT 1').get(tagId)
    if (used) continue
    db.prepare('DELETE FROM tag_history WHERE tag_id = ?').run(tagId)
    db.prepare('DELETE FROM tags WHERE id = ?').run(tagId)
  }

  db.prepare("DELETE FROM checkins WHERE user_id = ? AND source = 'sample'").run(userId)
  db.prepare("DELETE FROM checkin_history WHERE user_id = ? AND source = 'sample'").run(userId)
  db.prepare('DELETE FROM sample_seed_registry WHERE user_id = ?').run(userId)
}

function taskRow(db: DatabaseSync, id: string) {
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as unknown as Parameters<typeof syncTaskFoundation>[1]
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const purge = args.includes('--purge')
  const userIndex = args.indexOf('--user')
  const daysIndex = args.indexOf('--days')
  const { db } = await import('../db')

  const userId =
    userIndex >= 0
      ? Number.parseInt(args[userIndex + 1] ?? '', 10)
      : (db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get() as unknown as { id: number } | undefined)?.id
  if (!userId) {
    console.error('No user found. Sign up first, or pass --user <id>.')
    process.exit(1)
  }
  const days = daysIndex >= 0 ? Number.parseInt(args[daysIndex + 1] ?? '30', 10) : 30

  if (purge) {
    purgeSample(db, userId)
    console.log(`Removed sample data for user ${userId}.`)
    return
  }

  const result = seedSample(db, userId, { days })
  console.log(
    `Seeded user ${result.userId}: ${result.tasks} tasks, ${result.sessions} sessions, ` +
      `${result.statuses} day statuses, ${result.checkins} check-ins, ${result.questions} questions.`,
  )
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  main().catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
