import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { createReminder, reminderRecipients, remindersFor } from './reminders'

function fixture(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
      password_hash TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE teams (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, created_by INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE team_members (
      team_id TEXT NOT NULL, user_id INTEGER NOT NULL,
      role TEXT NOT NULL, joined_at INTEGER NOT NULL,
      PRIMARY KEY (team_id, user_id)
    );
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, team_id TEXT,
      text TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
    );
    CREATE TABLE task_assignees (
      task_id TEXT NOT NULL, user_id INTEGER NOT NULL,
      PRIMARY KEY (task_id, user_id)
    );
    CREATE TABLE task_reminders (
      id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL,
      sender_id INTEGER NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE task_reminder_recipients (
      reminder_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
      PRIMARY KEY (reminder_id, user_id)
    );
  `)
  db.exec(`
    INSERT INTO users (id, email, name, password_hash, created_at)
      VALUES (1, 'me@example.com', '', 'x', 0),
             (2, 'asha@example.com', 'Asha', 'x', 0),
             (3, 'marco@example.com', 'Marco', 'x', 0),
             (4, 'outsider@example.com', 'Outsider', 'x', 0);
    INSERT INTO teams (id, name, created_by, created_at) VALUES ('crew', 'Launch crew', 1, 0);
    INSERT INTO team_members (team_id, user_id, role, joined_at)
      VALUES ('crew', 1, 'host', 0), ('crew', 2, 'member', 0), ('crew', 3, 'member', 0);
    INSERT INTO tasks (id, user_id, team_id, text, created_at)
      VALUES ('personal', 1, NULL, 'Personal task', 0),
             ('assigned', 1, 'crew', 'Assigned team task', 0),
             ('unassigned', 1, 'crew', 'Unassigned team task', 0);
    INSERT INTO task_assignees (task_id, user_id)
      VALUES ('assigned', 2), ('assigned', 3);
  `)
  return db
}

test('personal reminders stay local with no recipient', () => {
  const db = fixture()
  assert.deepEqual(reminderRecipients('personal', db), [])

  const reminder = createReminder('personal', 1, db)
  assert.ok(reminder)
  assert.equal(reminder.taskText, 'Personal task')
  assert.equal(reminder.recipients.length, 0)
  assert.equal(remindersFor(1, db).length, 1)
  db.close()
})

test('team reminders go to every assignee', () => {
  const db = fixture()
  assert.deepEqual(reminderRecipients('assigned', db), [2, 3])

  const reminder = createReminder('assigned', 1, db)
  assert.ok(reminder)
  assert.deepEqual(
    reminder.recipients.map((person) => person.email).sort(),
    ['asha@example.com', 'marco@example.com'],
  )
  assert.equal(remindersFor(4, db).length, 0)
  db.close()
})

test('an unassigned team task broadcasts to all members', () => {
  const db = fixture()
  assert.deepEqual(reminderRecipients('unassigned', db), [1, 2, 3])

  const reminder = createReminder('unassigned', 1, db)
  assert.ok(reminder)
  assert.equal(reminder.recipients.length, 3)
  assert.deepEqual(
    reminder.recipients.map((person) => person.name),
    ['me', 'Asha', 'Marco'],
  )
  db.close()
})

test('completed tasks cannot be reminded', () => {
  const db = fixture()
  db.prepare('UPDATE tasks SET done = 1 WHERE id = ?').run('personal')
  assert.equal(createReminder('personal', 1, db), null)
  db.close()
})
