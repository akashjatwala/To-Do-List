import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { createOffDay, deleteOffDay, updateOffDay } from './ml/off-days'
import { applyOffDayTaskMoves, restoreOffDayTaskMoves } from './off-day-task-moves'
import { recordTaskMove, TASK_SKIP_EVENTS_SCHEMA } from './task-move-events'
import { localDateValue } from './recurrence'

const USER = 1
const MATE = 2

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT)')
  db.exec("INSERT INTO users (email) VALUES ('me@example.com'), ('mate@example.com')")
  db.exec('CREATE TABLE team_members (team_id TEXT NOT NULL, user_id INTEGER NOT NULL, role TEXT)')
  db.exec("INSERT INTO team_members (team_id, user_id, role) VALUES ('crew', 1, 'host'), ('crew', 2, 'member')")
  db.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      team_id TEXT,
      text TEXT NOT NULL,
      done INTEGER NOT NULL DEFAULT 0,
      due INTEGER
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
  db.exec(TASK_SKIP_EVENTS_SCHEMA)
  return db
}

function insertTask(
  db: DatabaseSync,
  id: string,
  dueDate: string,
  options: { userId?: number; teamId?: string | null; done?: boolean; recurrence?: string } = {},
) {
  const [year, month, day] = dueDate.split('-').map(Number)
  const due = new Date(year, month - 1, day, 9, 0, 0).getTime()
  db.prepare(
    `INSERT INTO tasks (id, user_id, team_id, text, done, due)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, options.userId ?? USER, options.teamId ?? null, id, options.done ? 1 : 0, due)
}

function dueValue(db: DatabaseSync, id: string): string {
  const row = db.prepare('SELECT due FROM tasks WHERE id = ?').get(id) as { due: number }
  return localDateValue(row.due)
}

test('off days move open personal tasks, but leave team, completed and working-day tasks alone', () => {
  const db = freshDb()
  insertTask(db, 'personal', '2026-11-25', { recurrence: 'none' })
  insertTask(db, 'team', '2026-11-25', { userId: MATE, teamId: 'crew', recurrence: 'none' })
  insertTask(db, 'completed', '2026-11-25', { done: true })
  insertTask(db, 'working', '2026-11-24')

  createOffDay(db, USER, { kind: null, startDate: '2026-11-25', endDate: '2026-11-25', note: null })
  const result = applyOffDayTaskMoves(db, USER)

  assert.equal(result.moved, 1)
  assert.equal(dueValue(db, 'personal'), '2026-11-26')
  assert.equal(dueValue(db, 'team'), '2026-11-25')
  assert.equal(dueValue(db, 'completed'), '2026-11-25')
  assert.equal(dueValue(db, 'working'), '2026-11-24')
})

test('several off days move tasks once, to the first date that is not marked off', () => {
  const db = freshDb()
  insertTask(db, 'daily', '2026-11-25', { recurrence: 'daily' })
  insertTask(db, 'from-second-day', '2026-11-26', { recurrence: 'daily' })
  insertTask(db, 'on-working-day', '2026-11-27')
  insertTask(db, 'in-my-team', '2026-11-25', { userId: MATE, teamId: 'crew' })
  insertTask(db, 'outside-team', '2026-11-25', { userId: MATE, teamId: 'other' })

  createOffDay(db, USER, { kind: 'travel', startDate: '2026-11-25', endDate: '2026-11-26', note: null })
  createOffDay(db, USER, { kind: null, startDate: '2026-11-28', endDate: '2026-11-28', note: null })
  const result = applyOffDayTaskMoves(db, USER)

  assert.equal(result.moved, 2)
  assert.equal(dueValue(db, 'daily'), '2026-11-27')
  assert.equal(dueValue(db, 'from-second-day'), '2026-11-27')
  assert.equal(dueValue(db, 'on-working-day'), '2026-11-27')
  assert.equal(dueValue(db, 'in-my-team'), '2026-11-25')
  assert.equal(dueValue(db, 'outside-team'), '2026-11-25')
})

test('no off days leaves every due date unchanged', () => {
  const db = freshDb()
  insertTask(db, 'personal', '2026-11-25')
  assert.deepEqual(applyOffDayTaskMoves(db, USER), { moved: 0, moves: [] })
  assert.equal(dueValue(db, 'personal'), '2026-11-25')
})

test('clearing an off day restores personal moves and historic team moves', () => {
  const db = freshDb()
  insertTask(db, 'personal', '2026-11-25')
  insertTask(db, 'team', '2026-11-25', { userId: MATE, teamId: 'crew' })
  insertTask(db, 'completed', '2026-11-25', { done: true })
  const offDay = createOffDay(db, USER, { kind: null, startDate: '2026-11-25', endDate: '2026-11-25', note: null })
  assert.equal(applyOffDayTaskMoves(db, USER).moved, 1)
  assert.equal(dueValue(db, 'personal'), '2026-11-26')
  assert.equal(dueValue(db, 'team'), '2026-11-25')

  // Older data may still hold a team move made by the previous behaviour.
  const legacyDue = new Date(2026, 10, 26, 9, 0).getTime()
  recordTaskMove(db, {
    taskId: 'team',
    actorId: USER,
    fromDate: '2026-11-25',
    toDate: '2026-11-26',
    due: legacyDue,
    reason: 'off-day',
  })
  db.prepare('UPDATE tasks SET due = ? WHERE id = ?').run(legacyDue, 'team')

  assert.equal(deleteOffDay(db, USER, offDay.id), true)
  assert.equal(restoreOffDayTaskMoves(db, USER).moved, 2)
  assert.equal(dueValue(db, 'personal'), '2026-11-25')
  assert.equal(dueValue(db, 'team'), '2026-11-25')
  assert.equal(dueValue(db, 'completed'), '2026-11-25')

  const undone = db.prepare('SELECT COUNT(*) AS n FROM task_skip_events WHERE reason = ? AND undone = 1').get('off-day') as { n: number }
  assert.equal(undone.n, 2)
})

test('editing an off day away from the original date restores the moved tasks', () => {
  const db = freshDb()
  insertTask(db, 'personal', '2026-11-25')
  const offDay = createOffDay(db, USER, { kind: null, startDate: '2026-11-25', endDate: '2026-11-25', note: null })
  applyOffDayTaskMoves(db, USER)
  updateOffDay(db, USER, offDay.id, { kind: null, startDate: '2026-11-26', endDate: '2026-11-26', note: null })

  assert.equal(restoreOffDayTaskMoves(db, USER).moved, 1)
  assert.equal(dueValue(db, 'personal'), '2026-11-25')
  assert.equal(applyOffDayTaskMoves(db, USER).moved, 0)
  assert.equal(dueValue(db, 'personal'), '2026-11-25')
})

test('a move is not restored while its original date is still off, or after a manual edit', () => {
  const db = freshDb()
  insertTask(db, 'still-off', '2026-11-25')
  insertTask(db, 'manually-moved', '2026-11-25')
  const offDay = createOffDay(db, USER, { kind: null, startDate: '2026-11-25', endDate: '2026-11-26', note: null })
  applyOffDayTaskMoves(db, USER)
  assert.equal(dueValue(db, 'still-off'), '2026-11-27')
  assert.equal(dueValue(db, 'manually-moved'), '2026-11-27')

  assert.equal(restoreOffDayTaskMoves(db, USER).moved, 0)
  assert.equal(dueValue(db, 'still-off'), '2026-11-27')

  deleteOffDay(db, USER, offDay.id)
  db.prepare('UPDATE tasks SET due = ? WHERE id = ?').run(new Date(2026, 10, 30, 9, 0).getTime(), 'manually-moved')
  assert.equal(restoreOffDayTaskMoves(db, USER).moved, 1)
  assert.equal(dueValue(db, 'still-off'), '2026-11-25')
  assert.equal(dueValue(db, 'manually-moved'), '2026-11-30')
})

test('skip moves are never reversed by clearing an off day', () => {
  const db = freshDb()
  insertTask(db, 'skipped', '2026-11-25')
  const due = new Date(2026, 10, 26, 9, 0).getTime()
  recordTaskMove(db, {
    taskId: 'skipped',
    actorId: USER,
    fromDate: '2026-11-25',
    toDate: '2026-11-26',
    due,
    reason: 'skip',
  })
  db.prepare('UPDATE tasks SET due = ? WHERE id = ?').run(due, 'skipped')

  assert.equal(restoreOffDayTaskMoves(db, USER).moved, 0)
  assert.equal(dueValue(db, 'skipped'), '2026-11-26')
})
