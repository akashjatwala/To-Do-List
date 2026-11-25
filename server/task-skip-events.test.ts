import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { createOffDay } from './ml/off-days'
import { canSkipTaskOnDate, skipTaskDate, type SkippableTaskRow } from './task-skip-events'
import { localDateValue } from './recurrence'

const USER = 1

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
      due INTEGER,
      recurrence TEXT NOT NULL DEFAULT 'none',
      recurrence_config TEXT
    )
  `)
  db.exec(`
    CREATE TABLE off_days (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      kind TEXT,
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      note TEXT,
      source TEXT NOT NULL DEFAULT 'user',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `)
  db.exec(`
    CREATE TABLE task_skip_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      actor_id INTEGER NOT NULL,
      from_date TEXT NOT NULL,
      to_date TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `)
  return db
}

function insertTask(
  db: DatabaseSync,
  id: string,
  dueDate: string,
  options: { teamId?: string | null; done?: boolean; recurrence?: string } = {},
): void {
  const [year, month, day] = dueDate.split('-').map(Number)
  const due = new Date(year, month - 1, day, 9, 30, 0).getTime()
  db.prepare(
    `INSERT INTO tasks (id, user_id, team_id, text, done, due, recurrence, recurrence_config)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
  ).run(
    id,
    USER,
    options.teamId ?? null,
    id,
    options.done ? 1 : 0,
    due,
    options.recurrence ?? 'none',
  )
}

function load(db: DatabaseSync, id: string): SkippableTaskRow {
  return db
    .prepare(
      `SELECT id, done, due, recurrence, recurrence_config
       FROM tasks WHERE id = ?`,
    )
    .get(id) as unknown as SkippableTaskRow
}

function dueValue(db: DatabaseSync, id: string): string {
  const row = db.prepare('SELECT due FROM tasks WHERE id = ?').get(id) as { due: number }
  return localDateValue(row.due)
}

test('skip moves any scheduled open note to the next non-off date and records the actor', () => {
  const db = freshDb()
  insertTask(db, 'personal', '2026-11-25')
  insertTask(db, 'team', '2026-11-25', { teamId: 'crew', recurrence: 'daily' })
  insertTask(db, 'completed', '2026-11-25', { done: true })
  insertTask(db, 'other-day', '2026-11-24')
  createOffDay(db, USER, {
    kind: 'travel',
    startDate: '2026-11-25',
    endDate: '2026-11-26',
    note: null,
  })

  assert.equal(canSkipTaskOnDate(load(db, 'personal'), '2026-11-25'), true)
  assert.equal(canSkipTaskOnDate(load(db, 'personal'), '2026-11-24'), false)
  assert.equal(canSkipTaskOnDate(load(db, 'completed'), '2026-11-25'), false)

  const personal = skipTaskDate(db, load(db, 'personal'), USER, '2026-11-25')
  assert.deepEqual(
    { from: personal?.fromDate, to: personal?.toDate },
    { from: '2026-11-25', to: '2026-11-27' },
  )
  assert.equal(dueValue(db, 'personal'), '2026-11-27')
  const time = new Date((db.prepare('SELECT due FROM tasks WHERE id = ?').get('personal') as { due: number }).due)
  assert.equal(time.getHours(), 9)
  assert.equal(time.getMinutes(), 30)

  const team = skipTaskDate(db, load(db, 'team'), USER, '2026-11-25')
  assert.equal(team?.toDate, '2026-11-27')
  assert.equal(dueValue(db, 'team'), '2026-11-27')

  assert.equal(skipTaskDate(db, load(db, 'completed'), USER, '2026-11-25'), null)
  assert.equal(skipTaskDate(db, load(db, 'other-day'), USER, '2026-11-25'), null)
  assert.equal(dueValue(db, 'other-day'), '2026-11-24')

  const events = (
    db
      .prepare('SELECT task_id, actor_id, from_date, to_date FROM task_skip_events ORDER BY id')
      .all() as unknown as Array<{
      task_id: string
      actor_id: number
      from_date: string
      to_date: string
    }>
  ).map((row) => ({
    task_id: row.task_id,
    actor_id: row.actor_id,
    from_date: row.from_date,
    to_date: row.to_date,
  }))
  assert.deepEqual(events, [
    {
      task_id: 'personal',
      actor_id: USER,
      from_date: '2026-11-25',
      to_date: '2026-11-27',
    },
    {
      task_id: 'team',
      actor_id: USER,
      from_date: '2026-11-25',
      to_date: '2026-11-27',
    },
  ])
})

test('skip uses the next calendar day when no off day covers it', () => {
  const db = freshDb()
  insertTask(db, 'run', '2026-11-25', { recurrence: 'daily' })
  const result = skipTaskDate(db, load(db, 'run'), USER, '2026-11-25')

  assert.equal(result?.toDate, '2026-11-26')
  assert.equal(dueValue(db, 'run'), '2026-11-26')
  const count = db.prepare('SELECT COUNT(*) AS count FROM task_skip_events').get() as {
    count: number
  }
  assert.equal(count.count, 1)
})
