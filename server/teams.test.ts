import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { hostedTeamsFor, transferHost } from './teams'

function fixture(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
      password_hash TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE teams (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, created_by INTEGER NOT NULL
        REFERENCES users(id) ON DELETE CASCADE, created_at INTEGER NOT NULL
    );
    CREATE TABLE team_members (
      team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('host', 'member')),
      joined_at INTEGER NOT NULL,
      PRIMARY KEY (team_id, user_id)
    );
  `)
  db.exec(`
    INSERT INTO users (id, email, name, password_hash, created_at)
      VALUES (1, 'host@example.com', 'Host', 'x', 0), (2, 'member@example.com', 'Member', 'x', 0),
             (3, 'other@example.com', 'Other', 'x', 0);
    INSERT INTO teams (id, name, created_by, created_at)
      VALUES ('book', 'Book club', 1, 0), ('design', 'Design guild', 2, 0);
    INSERT INTO team_members (team_id, user_id, role, joined_at)
      VALUES ('book', 1, 'host', 0), ('book', 2, 'member', 0),
             ('design', 2, 'host', 0), ('design', 1, 'member', 0);
  `)
  return db
}

test('hostedTeamsFor lists only teams the user would take down with their account', () => {
  const db = fixture()
  assert.deepEqual(hostedTeamsFor(1, db).map((row) => ({ ...row })), [
    { id: 'book', name: 'Book club' },
  ])
  assert.deepEqual(hostedTeamsFor(2, db).map((row) => ({ ...row })), [
    { id: 'design', name: 'Design guild' },
  ])
  assert.deepEqual(hostedTeamsFor(3, db), [])
  db.close()
})

test('transferHost moves roles and ownership together', () => {
  const db = fixture()
  transferHost(db, 'book', 1, 2)

  const roles = db
    .prepare('SELECT user_id, role FROM team_members WHERE team_id = ? ORDER BY user_id')
    .all('book') as unknown as Array<{ user_id: number; role: string }>
  assert.deepEqual(roles.map((row) => ({ ...row })), [
    { user_id: 1, role: 'member' },
    { user_id: 2, role: 'host' },
  ])
  const host = db.prepare('SELECT created_by FROM teams WHERE id = ?').get('book') as {
    created_by: number
  }
  assert.equal(host.created_by, 2)
  assert.deepEqual(hostedTeamsFor(1, db), [])
  assert.deepEqual(hostedTeamsFor(2, db).map((team) => team.id).sort(), ['book', 'design'])
  db.close()
})
