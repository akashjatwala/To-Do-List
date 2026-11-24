import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { createFoundationSchema } from './ml/schema'
import { listTags } from './ml/tags'
import { deduplicateTags, lowercaseTagNames } from './migrations'

function legacyTagDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT)')
  db.exec("INSERT INTO users (id, email) VALUES (1, 'me@example.com')")
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
  db.exec("INSERT INTO tasks (id, user_id, text, created_at, tags) VALUES ('t1', 1, 'Draft', 10, '[\"design\",\"design\"]')")
  createFoundationSchema(db)
  db.exec(`
    INSERT INTO tags (id, user_id, name, normalized, merged_into_id, created_at) VALUES
      (1, 1, 'Design', 'design', NULL, 10),
      (2, 1, 'design', 'design', NULL, 20),
      (3, 1, 'Work', 'work', NULL, 30),
      (4, 1, 'work', 'work', NULL, 40);
    INSERT INTO task_tags (task_id, tag_id, user_id, created_at) VALUES
      ('t1', 1, 1, 10), ('t1', 2, 1, 20), ('t1', 4, 1, 40);
  `)
  return db
}

test('deduplicateTags folds legacy duplicate names into the oldest active id', () => {
  const db = legacyTagDb()
  deduplicateTags(db)

  assert.deepEqual(
    listTags(db, 1).map((tag) => ({ id: tag.id, name: tag.name })),
    [
      { id: 1, name: 'Design' },
      { id: 3, name: 'Work' },
    ],
  )
  const source = db.prepare('SELECT merged_into_id FROM tags WHERE id = 2').get() as {
    merged_into_id: number | null
  }
  assert.equal(source.merged_into_id, 1)
  assert.deepEqual(
    (db.prepare('SELECT tag_id FROM task_tags WHERE task_id = ? ORDER BY tag_id').all('t1') as Array<{
      tag_id: number
    }>).map((row) => ({ tag_id: row.tag_id })),
    [{ tag_id: 1 }, { tag_id: 3 }],
  )
  assert.equal(
    (db.prepare('SELECT tags FROM tasks WHERE id = ?').get('t1') as { tags: string }).tags,
    '["design"]',
  )
  db.close()
})

test('lowercaseTagNames canonicalises tag rows and task labels without changing ids', () => {
  const db = legacyTagDb()
  db.prepare('UPDATE tasks SET tags = ? WHERE id = ?').run('["Design","WORK"]', 't1')
  lowercaseTagNames(db)

  assert.deepEqual(
    (db.prepare('SELECT id, name, normalized FROM tags ORDER BY id').all() as Array<{
      id: number
      name: string
      normalized: string
    }>).map((row) => ({ id: row.id, name: row.name, normalized: row.normalized })),
    [
      { id: 1, name: 'design', normalized: 'design' },
      { id: 2, name: 'design', normalized: 'design' },
      { id: 3, name: 'work', normalized: 'work' },
      { id: 4, name: 'work', normalized: 'work' },
    ],
  )
  assert.equal(
    (db.prepare('SELECT tags FROM tasks WHERE id = ?').get('t1') as { tags: string }).tags,
    '["design","work"]',
  )
  db.close()
})
