import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { createFoundationSchema, createPredictionSchema } from './schema'
import { syncTaskFoundation } from './task-sync'
import { createTag, deleteTag, listTags, mergeTags, renameTag, resolveTagChain, syncTaskTags } from './tags'
import {
  configForDate,
  configTagIds,
  latestConfig,
  listTaskConfigs,
  priorityForConfig,
  recordTaskConfig,
} from './task-config'
import {
  SESSION_MAX_MINUTES,
  createSession,
  existingRanges,
  listSessions,
  listTaskSessions,
  validateSession,
  type SessionRange,
} from './sessions'
import {
  clearDailyStatus,
  dailyActivity,
  deriveDailyActivity,
  setDailyStatus,
} from './daily-activity'

const USER = 1
const MINUTE = 60_000

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
  db.exec('CREATE TABLE checkins (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, date TEXT, skipped INTEGER)')
  createFoundationSchema(db)
  createPredictionSchema(db)
  return db
}

interface TaskOverrides {
  id?: string
  text?: string
  priority?: string
  tags?: string[]
  recurrence?: string
  duration?: number | null
  preferred_time?: string | null
}

function insertTask(db: DatabaseSync, overrides: TaskOverrides = {}): string {
  const id = overrides.id ?? randomUUID()
  db.prepare(
    `INSERT INTO tasks (id, user_id, text, created_at, priority, tags, recurrence, duration, preferred_time)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    USER,
    overrides.text ?? 'Read a book',
    Date.now(),
    overrides.priority ?? 'none',
    JSON.stringify(overrides.tags ?? []),
    overrides.recurrence ?? 'none',
    overrides.duration ?? null,
    overrides.preferred_time ?? null,
  )
  return id
}

function taskRow(db: DatabaseSync, id: string) {
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as unknown as Parameters<
    typeof syncTaskFoundation
  >[1]
}

function storedTags(db: DatabaseSync, id: string): string[] {
  const row = db.prepare('SELECT tags FROM tasks WHERE id = ?').get(id) as { tags: string }
  return JSON.parse(row.tags) as string[]
}

/** A local timestamp inside a given local date. */
function at(date: string, hour: number, minute = 0): number {
  const [year, month, day] = date.split('-').map(Number)
  return new Date(year, month - 1, day, hour, minute, 0, 0).getTime()
}

function sessionInput(taskId: string, date: string, startHour: number, durationMinutes: number) {
  return {
    taskId,
    localDate: date,
    startedAt: at(date, startHour),
    endedAt: at(date, startHour) + durationMinutes * MINUTE,
    note: null,
  }
}

// ---------------------------------------------------------------------------
// Session validation
// ---------------------------------------------------------------------------

test('a well-formed session is accepted and its duration derived from the times', () => {
  const result = validateSession(
    { taskId: 't1', localDate: '2026-05-10', startedAt: at('2026-05-10', 9), endedAt: at('2026-05-10', 10) },
    { now: at('2026-05-10', 12), existing: [] },
  )
  assert.equal(result.ok, true)
  assert.equal(result.ok && result.value.durationMinutes, 60)
})

test('a session with no end time keeps its stated duration', () => {
  const result = validateSession(
    { taskId: 't1', localDate: '2026-05-10', startedAt: at('2026-05-10', 9), durationMinutes: 20 },
    { now: at('2026-05-10', 12), existing: [] },
  )
  assert.equal(result.ok, true)
  assert.equal(result.ok && result.value.durationMinutes, 20)
  assert.equal(result.ok && result.value.endedAt, null)
})

test('end-before-start is rejected', () => {
  const result = validateSession(
    { taskId: 't1', localDate: '2026-05-10', startedAt: at('2026-05-10', 10), endedAt: at('2026-05-10', 9) },
    { now: at('2026-05-10', 12), existing: [] },
  )
  assert.equal(result.ok, false)
})

test('negative, zero and impossible durations are rejected', () => {
  const now = at('2026-05-10', 12)
  for (const durationMinutes of [-5, 0]) {
    const result = validateSession(
      { taskId: 't1', localDate: '2026-05-10', startedAt: at('2026-05-10', 9), durationMinutes },
      { now, existing: [] },
    )
    assert.equal(result.ok, false, `duration ${durationMinutes} should be rejected`)
  }
  const tooLong = validateSession(
    { taskId: 't1', localDate: '2026-05-10', startedAt: at('2026-05-10', 9), durationMinutes: SESSION_MAX_MINUTES + 1 },
    { now, existing: [] },
  )
  assert.equal(tooLong.ok, false)
})

test('future-dated sessions are rejected', () => {
  const result = validateSession(
    { taskId: 't1', localDate: '2026-05-10', startedAt: at('2026-05-10', 15), durationMinutes: 30 },
    { now: at('2026-05-10', 12), existing: [] },
  )
  assert.equal(result.ok, false)
})

test('duplicate sessions are rejected', () => {
  const existing: SessionRange[] = [{ startedAt: at('2026-05-10', 9), endedAt: at('2026-05-10', 10), durationMinutes: 60 }]
  const result = validateSession(
    { taskId: 't1', localDate: '2026-05-10', startedAt: at('2026-05-10', 9), endedAt: at('2026-05-10', 10) },
    { now: at('2026-05-10', 12), existing },
  )
  assert.equal(result.ok, false)
  assert.match(result.ok ? '' : result.error, /already been logged/i)
})

test('overlapping sessions are rejected but adjacent ones are fine', () => {
  const existing: SessionRange[] = [{ startedAt: at('2026-05-10', 9), endedAt: at('2026-05-10', 10), durationMinutes: 60 }]
  const overlap = validateSession(
    { taskId: 't1', localDate: '2026-05-10', startedAt: at('2026-05-10', 9, 30), endedAt: at('2026-05-10', 10, 30) },
    { now: at('2026-05-10', 12), existing },
  )
  assert.equal(overlap.ok, false)

  const adjacent = validateSession(
    { taskId: 't1', localDate: '2026-05-10', startedAt: at('2026-05-10', 10), endedAt: at('2026-05-10', 11) },
    { now: at('2026-05-10', 12), existing },
  )
  assert.equal(adjacent.ok, true)
})

test('an open-ended session overlaps a later one that starts inside its span', () => {
  const existing: SessionRange[] = [{ startedAt: at('2026-05-10', 9), endedAt: null, durationMinutes: 90 }]
  const result = validateSession(
    { taskId: 't1', localDate: '2026-05-10', startedAt: at('2026-05-10', 10), durationMinutes: 30 },
    { now: at('2026-05-10', 12), existing },
  )
  assert.equal(result.ok, false)
})

// ---------------------------------------------------------------------------
// Multi-session aggregation and label derivation
// ---------------------------------------------------------------------------

test('multiple sessions add up towards the target while keeping target and actual separate', () => {
  const day = deriveDailyActivity({
    date: '2026-05-10',
    today: '2026-05-11',
    targetMinutes: 60,
    sessions: [{ durationMinutes: 45 }, { durationMinutes: 30 }],
    explicitStatus: null,
    explicitReason: null,
    configVersionId: 7,
    checkinId: 3,
  })
  assert.equal(day.totalMinutes, 75)
  assert.equal(day.sessionCount, 2)
  assert.equal(day.targetMinutes, 60)
  assert.equal(day.status, 'completed')
  assert.equal(day.targetAchieved, true)
  assert.equal(day.performed, true)
  assert.equal(day.configVersionId, 7)
  assert.equal(day.checkinId, 3)
})

test('a partial day is distinct from a completed day', () => {
  const day = deriveDailyActivity({
    date: '2026-05-10',
    today: '2026-05-11',
    targetMinutes: 60,
    sessions: [{ durationMinutes: 20 }],
    explicitStatus: null,
    explicitReason: null,
    configVersionId: null,
    checkinId: null,
  })
  assert.equal(day.status, 'partial')
  assert.equal(day.targetAchieved, false)
  assert.equal(day.performed, true)
})

test('a past day with no data is unknown, not zero and not skipped', () => {
  const day = deriveDailyActivity({
    date: '2026-05-10',
    today: '2026-05-11',
    targetMinutes: 60,
    sessions: [],
    explicitStatus: null,
    explicitReason: null,
    configVersionId: null,
    checkinId: null,
  })
  assert.equal(day.status, 'unknown')
  assert.equal(day.totalMinutes, 0)
  assert.equal(day.performed, null)
  assert.equal(day.targetAchieved, null)
})

test('today is pending and never given a negative label', () => {
  const day = deriveDailyActivity({
    date: '2026-05-11',
    today: '2026-05-11',
    targetMinutes: 60,
    sessions: [{ durationMinutes: 10 }],
    explicitStatus: null,
    explicitReason: null,
    configVersionId: null,
    checkinId: null,
  })
  assert.equal(day.status, 'pending')
  assert.equal(day.performed, true)
})

test('skipped and postponed are explicit and never inferred from missing data', () => {
  const skipped = deriveDailyActivity({
    date: '2026-05-10',
    today: '2026-05-11',
    targetMinutes: 60,
    sessions: [],
    explicitStatus: 'skipped',
    explicitReason: 'Away all day',
    configVersionId: null,
    checkinId: null,
  })
  assert.equal(skipped.status, 'skipped')
  assert.equal(skipped.performed, false)
  assert.equal(skipped.reason, 'Away all day')

  const postponed = deriveDailyActivity({
    date: '2026-05-10',
    today: '2026-05-11',
    targetMinutes: 60,
    sessions: [],
    explicitStatus: 'postponed',
    explicitReason: null,
    configVersionId: null,
    checkinId: null,
  })
  assert.equal(postponed.status, 'postponed')
})

test('a task with no target still records what happened without inventing a target', () => {
  const day = deriveDailyActivity({
    date: '2026-05-10',
    today: '2026-05-11',
    targetMinutes: null,
    sessions: [{ durationMinutes: 15 }],
    explicitStatus: null,
    explicitReason: null,
    configVersionId: null,
    checkinId: null,
  })
  assert.equal(day.targetMinutes, null)
  assert.equal(day.targetAchieved, null)
  assert.equal(day.status, 'completed')
})

// ---------------------------------------------------------------------------
// Config versioning
// ---------------------------------------------------------------------------

test('a missing priority is stored as null, never a default low priority', () => {
  const db = freshDb()
  const id = insertTask(db, { priority: 'none' })
  syncTaskFoundation(db, taskRow(db, id))
  const config = latestConfig(db, id)!
  assert.equal(config.version, 1)
  assert.equal(config.priority, null)
  assert.equal(priorityForConfig('none'), null)
  assert.equal(priorityForConfig('high'), 'high')
})

test('changing priority appends a version and past days keep the old one', () => {
  const db = freshDb()
  const id = insertTask(db, { priority: 'low', duration: 30 })
  syncTaskFoundation(db, taskRow(db, id), at('2026-05-01', 8))
  assert.equal(latestConfig(db, id)!.version, 1)

  db.prepare("UPDATE tasks SET priority = 'high' WHERE id = ?").run(id)
  syncTaskFoundation(db, taskRow(db, id), at('2026-05-10', 8))
  assert.equal(latestConfig(db, id)!.version, 2)
  assert.equal(latestConfig(db, id)!.priority, 'high')

  // The day before the change still resolves to version 1.
  const before = configForDate(db, id, '2026-05-05')
  assert.equal(before?.version, 1)
  assert.equal(before?.priority, 'low')
  const after = configForDate(db, id, '2026-05-12')
  assert.equal(after?.version, 2)
  assert.equal(after?.priority, 'high')
})

test('changing tags appends a version and the old version keeps its tags', () => {
  const db = freshDb()
  const id = insertTask(db, { tags: ['Health'], duration: 30 })
  syncTaskFoundation(db, taskRow(db, id), at('2026-05-01', 8))
  const v1 = latestConfig(db, id)!
  assert.equal(configTagIds(db, v1.id).length, 1)

  db.prepare("UPDATE tasks SET tags = ? WHERE id = ?").run(JSON.stringify(['Health', 'Exercise']), id)
  syncTaskFoundation(db, taskRow(db, id), at('2026-05-10', 8))
  const v2 = latestConfig(db, id)!
  assert.equal(v2.version, 2)
  assert.equal(configTagIds(db, v2.id).length, 2)
  // The first version still has exactly the tags it had back then.
  assert.equal(configTagIds(db, v1.id).length, 1)
  assert.equal(listTaskConfigs(db, id).length, 2)
})

test('recording the same configuration twice does not create a version', () => {
  const db = freshDb()
  const id = insertTask(db, { tags: ['Health'], priority: 'medium', duration: 20 })
  syncTaskFoundation(db, taskRow(db, id), at('2026-05-01', 8))
  syncTaskFoundation(db, taskRow(db, id), at('2026-05-02', 8))
  syncTaskFoundation(db, taskRow(db, id), at('2026-05-03', 8))
  assert.equal(listTaskConfigs(db, id).length, 1)
})

test('the effective-from timestamp decides which version applied', () => {
  const db = freshDb()
  const id = insertTask(db, { duration: 30 })
  recordTaskConfig(db, taskRow(db, id), [], at('2026-05-01', 12))
  db.prepare('UPDATE tasks SET duration = 45 WHERE id = ?').run(id)
  recordTaskConfig(db, taskRow(db, id), [], at('2026-05-05', 12))

  assert.equal(configForDate(db, id, '2026-05-03')?.target_duration, 30)
  assert.equal(configForDate(db, id, '2026-05-06')?.target_duration, 45)
})

// ---------------------------------------------------------------------------
// Tags: create, rename and delete keep past records linked
// ---------------------------------------------------------------------------

test('creating a tag lowercases the name and is idempotent', () => {
  const db = freshDb()
  const first = createTag(db, USER, ' Wellness ', at('2026-05-01', 8))
  const again = createTag(db, USER, 'wellness', at('2026-05-02', 8))
  assert.equal(first?.name, 'wellness')
  assert.equal(again?.id, first?.id)
  assert.deepEqual(
    listTags(db, USER).map((tag) => ({ id: tag.id, name: tag.name })),
    [{ id: first!.id, name: 'wellness' }],
  )
  db.close()
})

test('renaming a tag keeps past config versions linked to the same tag id', () => {
  const db = freshDb()
  const id = insertTask(db, { tags: ['Health'] })
  syncTaskFoundation(db, taskRow(db, id), at('2026-05-01', 8))
  const v1 = latestConfig(db, id)!
  const [tagId] = configTagIds(db, v1.id)

  const renamed = renameTag(db, USER, tagId, 'Wellness', at('2026-05-10', 8))
  assert.equal(renamed?.name, 'wellness')
  // The snapshot still points at the same id, which now resolves to the new name.
  assert.deepEqual(configTagIds(db, v1.id), [tagId])
  assert.equal(resolveTagChain(db, tagId)?.name, 'wellness')
  assert.deepEqual(storedTags(db, id), ['wellness'])
  db.close()
})

test('renaming onto an existing tag is rejected instead of merging', () => {
  const db = freshDb()
  const one = createTag(db, USER, 'work', at('2026-05-01', 8))!
  const two = createTag(db, USER, 'personal', at('2026-05-01', 8))!
  assert.throws(() => renameTag(db, USER, one.id, 'Personal', at('2026-05-10', 8)), /already exists/)
  assert.equal(resolveTagChain(db, one.id)?.name, 'work')
  assert.equal(resolveTagChain(db, two.id)?.name, 'personal')
  db.close()
})

test('deleting a tag clears current labels but keeps historic ids resolvable', () => {
  const db = freshDb()
  const id = insertTask(db, { tags: ['Health', 'Fitness'] })
  syncTaskFoundation(db, taskRow(db, id), at('2026-05-01', 8))
  const v1 = latestConfig(db, id)!
  const [healthId, fitnessId] = configTagIds(db, v1.id)

  assert.ok(deleteTag(db, USER, healthId, at('2026-05-10', 8)))
  assert.deepEqual(configTagIds(db, v1.id), [healthId, fitnessId])
  assert.equal(resolveTagChain(db, healthId)?.name, 'health')
  assert.deepEqual(listTags(db, USER).map((tag) => tag.name), ['fitness'])
  assert.deepEqual(storedTags(db, id), ['fitness'])
  assert.deepEqual(syncTaskTags(db, USER, id, ['fitness']), [fitnessId])
  db.close()
})

test('merging tags keeps old links resolvable through the surviving tag', () => {
  const db = freshDb()
  const id = insertTask(db, { tags: ['Health', 'Fitness'] })
  const other = insertTask(db, { id: 'other', tags: ['health'] })
  syncTaskFoundation(db, taskRow(db, id), at('2026-05-01', 8))
  syncTaskFoundation(db, taskRow(db, other), at('2026-05-01', 8))
  const v1 = latestConfig(db, id)!
  const before = configTagIds(db, v1.id)
  assert.equal(before.length, 2)
  const [sourceId, targetId] = before

  const survivor = mergeTags(db, USER, sourceId, targetId, at('2026-05-10', 8))
  assert.equal(survivor?.id, targetId)
  // Both old ids still resolve, and the past snapshot is unchanged.
  assert.equal(resolveTagChain(db, sourceId)?.id, targetId)
  assert.deepEqual(configTagIds(db, v1.id), before)
  // The merged tag no longer appears in the active list.
  assert.equal(listTags(db, USER).length, 1)
  assert.deepEqual(syncTaskTags(db, USER, id, ['Health', 'Fitness']), [targetId])
  assert.deepEqual(storedTags(db, id), ['fitness'])
  assert.deepEqual(storedTags(db, other), ['fitness'])
})

// ---------------------------------------------------------------------------
// Sessions stored, aggregated, and day status through the database
// ---------------------------------------------------------------------------

test('stored sessions aggregate into a day and never overlap', () => {
  const db = freshDb()
  const id = insertTask(db, { duration: 60, tags: ['Personal'] })
  syncTaskFoundation(db, taskRow(db, id), at('2026-05-09', 8))

  const first = validateSession(sessionInput(id, '2026-05-10', 9, 45), {
    now: at('2026-05-11', 8),
    existing: existingRanges(db, id),
  })
  assert.equal(first.ok, true)
  createSession(db, USER, first.ok ? first.value : ({} as never), 'user', at('2026-05-10', 10))

  const second = validateSession(sessionInput(id, '2026-05-10', 14, 30), {
    now: at('2026-05-11', 8),
    existing: existingRanges(db, id),
  })
  assert.equal(second.ok, true)
  createSession(db, USER, second.ok ? second.value : ({} as never), 'user', at('2026-05-10', 15))

  const day = dailyActivity(db, USER, id, '2026-05-10', '2026-05-11')
  assert.equal(day.sessionCount, 2)
  assert.equal(day.totalMinutes, 75)
  assert.equal(day.status, 'completed')
  assert.equal(day.configVersionId, latestConfig(db, id)!.id)
  assert.equal(listSessions(db, USER, { taskId: id }).length, 2)
})

test('a team task lists every author\'s time entries while overlap stays per user', () => {
  const db = freshDb()
  db.exec("ALTER TABLE users ADD COLUMN name TEXT NOT NULL DEFAULT ''")
  db.exec("INSERT INTO users (email, name) VALUES ('teammate@example.com', 'Teammate')")
  const teammate = Number(
    (db.prepare("SELECT id FROM users WHERE email = 'teammate@example.com'").get() as { id: number }).id,
  )
  const id = insertTask(db)

  const mine = validateSession(sessionInput(id, '2026-05-10', 9, 45), {
    now: at('2026-05-11', 8),
    existing: existingRanges(db, id, USER),
  })
  assert.equal(mine.ok, true)
  createSession(db, USER, mine.ok ? mine.value : ({} as never))

  // The teammate logs the exact same stretch: allowed because ranges are per author.
  const theirs = validateSession(sessionInput(id, '2026-05-10', 9, 45), {
    now: at('2026-05-11', 8),
    existing: existingRanges(db, id, teammate),
  })
  assert.equal(theirs.ok, true)
  createSession(db, teammate, theirs.ok ? theirs.value : ({} as never))

  assert.equal(listSessions(db, USER, { taskId: id }).length, 1)
  assert.equal(listSessions(db, teammate, { taskId: id }).length, 1)

  const shared = listTaskSessions(db, id)
  assert.equal(shared.length, 2)
  assert.deepEqual(
    shared.map((row) => row.author_email).sort(),
    ['me@example.com', 'teammate@example.com'],
  )
  assert.equal(shared.find((row) => row.user_id === teammate)?.author_name, 'Teammate')
})

test('an explicit day status survives and can be cleared', () => {
  const db = freshDb()
  const id = insertTask(db, { duration: 60 })
  syncTaskFoundation(db, taskRow(db, id), at('2026-05-09', 8))

  setDailyStatus(db, USER, id, '2026-05-10', 'skipped', 'Sick', 'user', at('2026-05-10', 20))
  let day = dailyActivity(db, USER, id, '2026-05-10', '2026-05-11')
  assert.equal(day.status, 'skipped')
  assert.equal(day.reason, 'Sick')

  clearDailyStatus(db, USER, id, '2026-05-10')
  day = dailyActivity(db, USER, id, '2026-05-10', '2026-05-11')
  assert.equal(day.status, 'unknown')
})

test('the asOf cutoff hides sessions that had not started yet', () => {
  const db = freshDb()
  const id = insertTask(db, { duration: 60 })
  syncTaskFoundation(db, taskRow(db, id), at('2026-05-09', 8))

  const early = validateSession(sessionInput(id, '2026-05-10', 9, 30), {
    now: at('2026-05-11', 8),
    existing: existingRanges(db, id),
  })
  createSession(db, USER, early.ok ? early.value : ({} as never), 'user', at('2026-05-10', 10))
  const late = validateSession(sessionInput(id, '2026-05-10', 20, 30), {
    now: at('2026-05-11', 8),
    existing: existingRanges(db, id),
  })
  createSession(db, USER, late.ok ? late.value : ({} as never), 'user', at('2026-05-10', 21))

  const asOfNoon = dailyActivity(db, USER, id, '2026-05-10', '2026-05-11', { asOf: at('2026-05-10', 12) })
  assert.equal(asOfNoon.sessionCount, 1)
  assert.equal(asOfNoon.totalMinutes, 30)

  const full = dailyActivity(db, USER, id, '2026-05-10', '2026-05-11')
  assert.equal(full.sessionCount, 2)
  assert.equal(full.totalMinutes, 60)
})

test('a day links back to the check-in when one exists', () => {
  const db = freshDb()
  const id = insertTask(db, { duration: 30 })
  syncTaskFoundation(db, taskRow(db, id), at('2026-05-09', 8))
  db.prepare('INSERT INTO checkins (user_id, date, skipped) VALUES (?, ?, 0)').run(USER, '2026-05-10')

  const day = dailyActivity(db, USER, id, '2026-05-10', '2026-05-11')
  assert.equal(typeof day.checkinId, 'number')

  const without = dailyActivity(db, USER, id, '2026-05-08', '2026-05-11')
  assert.equal(without.checkinId, null)
})

test('deleting a task removes its sessions and configuration', () => {
  const db = freshDb()
  const id = insertTask(db, { duration: 30, tags: ['Personal'] })
  syncTaskFoundation(db, taskRow(db, id), at('2026-05-09', 8))
  const ok = validateSession(sessionInput(id, '2026-05-10', 9, 30), {
    now: at('2026-05-11', 8),
    existing: [],
  })
  createSession(db, USER, ok.ok ? ok.value : ({} as never), 'user', at('2026-05-10', 10))

  db.prepare('DELETE FROM tasks WHERE id = ?').run(id)
  assert.equal(listSessions(db, USER, { taskId: id }).length, 0)
  assert.equal(listTaskConfigs(db, id).length, 0)
})
