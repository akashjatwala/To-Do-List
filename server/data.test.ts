import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { teammateOffDaysFor } from './data'

function fixture(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL
    );
    CREATE TABLE teams (
      id TEXT PRIMARY KEY, name TEXT NOT NULL
    );
    CREATE TABLE team_members (
      team_id TEXT NOT NULL, user_id INTEGER NOT NULL, role TEXT NOT NULL,
      PRIMARY KEY (team_id, user_id)
    );
    CREATE TABLE off_days (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL,
      kind TEXT, start_date TEXT NOT NULL, end_date TEXT NOT NULL,
      note TEXT, source TEXT NOT NULL DEFAULT 'user',
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
  `)
  db.exec(`
    INSERT INTO users (id, email, name) VALUES
      (1, 'me@example.com', ''),
      (2, 'asha@example.com', 'Asha'),
      (3, 'marco@example.com', ''),
      (4, 'outsider@example.com', 'Outsider');
    INSERT INTO teams (id, name) VALUES ('crew', 'Launch crew'), ('secret', 'Other crew');
    INSERT INTO team_members (team_id, user_id, role) VALUES
      ('crew', 1, 'host'), ('crew', 2, 'member'), ('crew', 3, 'member'),
      ('secret', 4, 'host');
    INSERT INTO off_days (user_id, kind, start_date, end_date, note, created_at, updated_at) VALUES
      (1, NULL, '2026-11-25', '2026-11-25', NULL, 1, 1),
      (2, 'sick', '2026-11-24', '2026-11-26', 'Recovering', 2, 2),
      (3, 'travel', '2026-11-26', '2026-11-27', NULL, 3, 3),
      (4, 'holiday', '2026-11-25', '2026-11-25', 'Private', 4, 4);
  `)
  return db
}

test('teammate off days come only from people sharing a team', () => {
  const items = teammateOffDaysFor(1, fixture())

  assert.deepEqual(
    items.map((item) => item.userId),
    [2, 3],
  )
  assert.deepEqual(
    items.map((item) => item.name),
    ['Asha', 'marco'],
  )
  assert.equal(items[0].kind, 'sick')
  assert.equal(items[0].startDate, '2026-11-24')
  assert.equal(items[0].endDate, '2026-11-26')
  assert.equal(items[0].note, 'Recovering')
})
