import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { notificationsFor, type AppNotification, type NotificationKind } from './notifications'

function fixture(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
      password_hash TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE teams (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, created_by INTEGER NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE team_members (
      team_id TEXT NOT NULL, user_id INTEGER NOT NULL, role TEXT NOT NULL, joined_at INTEGER NOT NULL,
      PRIMARY KEY (team_id, user_id)
    );
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, team_id TEXT,
      text TEXT NOT NULL, created_at INTEGER NOT NULL,
      completed_at INTEGER, completed_by INTEGER
    );
    CREATE TABLE task_assignees (
      task_id TEXT NOT NULL, user_id INTEGER NOT NULL,
      assigned_at INTEGER, assigned_by INTEGER,
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
    CREATE TABLE comments (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL, user_id INTEGER NOT NULL,
      text TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE team_invites (
      team_id TEXT NOT NULL, email TEXT NOT NULL, invited_by INTEGER NOT NULL,
      created_at INTEGER NOT NULL, PRIMARY KEY (team_id, email)
    );
  `)
  db.exec(`
    INSERT INTO users (id, email, name, password_hash, created_at) VALUES
      (1, 'me@example.com', '', 'x', 0),
      (2, 'asha@example.com', 'Asha', 'x', 0),
      (3, 'marco@example.com', 'Marco', 'x', 0),
      (4, 'outsider@example.com', 'Outsider', 'x', 0);
    INSERT INTO teams (id, name, created_by, created_at) VALUES
      ('crew', 'Launch crew', 1, 0), ('secret', 'Other crew', 4, 0);
    INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES
      ('crew', 1, 'host', 0), ('crew', 2, 'member', 0), ('crew', 3, 'member', 0);
    INSERT INTO tasks (id, user_id, team_id, text, created_at) VALUES
      ('personal', 1, NULL, 'Personal task', 0),
      ('team', 1, 'crew', 'Shared task', 1000),
      ('assigned', 2, 'crew', 'Work for me', 2000),
      ('hidden', 4, 'secret', 'Hidden task', 3000);
  `)
  return db
}

function ofKind(items: AppNotification[], kind: NotificationKind): AppNotification[] {
  return items.filter((item) => item.kind === kind)
}

test('collects team adds, completions, comments, assignments and reminders including own actions', () => {
  const db = fixture()
  db.exec(`
    INSERT INTO team_invites (team_id, email, invited_by, created_at)
      VALUES ('crew', 'me@example.com', 2, 4000);
    INSERT INTO task_reminders (id, task_id, sender_id, created_at) VALUES
      (1, 'team', 2, 3000), (2, 'team', 1, 5200);
    INSERT INTO task_reminder_recipients (reminder_id, user_id) VALUES (1, 1), (2, 2);
    INSERT INTO comments (id, task_id, user_id, text, created_at) VALUES
      ('c1', 'team', 2, 'Can you review this?', 2600),
      ('c2', 'team', 1, 'My own note', 2400),
      ('c3', 'hidden', 4, 'Not for me', 9000);
    INSERT INTO task_assignees (task_id, user_id, assigned_at, assigned_by) VALUES
      ('assigned', 1, 5000, 2), ('team', 2, 4800, 1);
    UPDATE tasks SET completed_at = 5500, completed_by = 2 WHERE id = 'assigned';
  `)

  const items = notificationsFor(1, db)
  const times = items.map((item) => item.createdAt)
  assert.deepEqual(times, [...times].sort((a, b) => b - a))

  assert.deepEqual(
    ofKind(items, 'task-completed').map((item) => item.title),
    ['Asha completed a task'],
  )
  assert.deepEqual(
    ofKind(items, 'team-reminder').map((item) => item.title),
    ['You sent a reminder'],
  )
  const added = ofKind(items, 'task-added').map((item) => item.title)
  assert.deepEqual(added.sort(), ['Asha added a task', 'You added a task'])
  const comments = ofKind(items, 'comment').map((item) => item.title)
  assert.deepEqual(comments.sort(), ['Asha commented', 'You commented'])
  const assignments = ofKind(items, 'assignment').map((item) => item.title)
  assert.deepEqual(assignments.sort(), ['Asha assigned you', 'You assigned Asha'])
  assert.deepEqual(
    ofKind(items, 'reminder').map((item) => item.title),
    ['Asha reminded you'],
  )
  assert.equal(ofKind(items, 'invite').length, 1)
  assert.equal(ofKind(items, 'invite')[0].teamName, 'Launch crew')
  const teamActivity = items.filter((item) =>
    ['comment', 'assignment', 'task-added', 'task-completed', 'team-reminder'].includes(item.kind),
  )
  assert.ok(teamActivity.length > 0)
  assert.ok(teamActivity.every((item) => item.teamName === 'Launch crew'))
  assert.ok(!items.some((item) => item.body.includes('Hidden task')))
  db.close()
})

test('personal reminders stay in Reminders while untargeted team reminders join the feed', () => {
  const db = fixture()
  db.exec(`
    INSERT INTO task_reminders (id, task_id, sender_id, created_at) VALUES
      (1, 'personal', 1, 6000), (2, 'team', 2, 6500);
    INSERT INTO task_reminder_recipients (reminder_id, user_id) VALUES (2, 3);
    INSERT INTO comments (id, task_id, user_id, text, created_at)
      VALUES ('own', 'team', 1, 'My note', 7000);
  `)

  const items = notificationsFor(1, db)
  assert.deepEqual(
    ofKind(items, 'reminder').map((item) => item.title),
    ['Reminder set'],
  )
  assert.deepEqual(
    ofKind(items, 'team-reminder').map((item) => item.title),
    ['Asha sent a reminder'],
  )
  assert.deepEqual(
    ofKind(items, 'comment').map((item) => item.title),
    ['You commented'],
  )
  assert.equal(ofKind(items, 'reminder')[0].teamName, null)
  assert.equal(ofKind(items, 'team-reminder')[0].teamName, 'Launch crew')
  db.close()
})
