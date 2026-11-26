import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { createFoundationSchema } from './ml/schema'
import { listTags } from './ml/tags'
import { deduplicateTags, lowercaseTagNames, runMigrations } from './migrations'
import { TASK_SKIP_EVENTS_SCHEMA } from './task-move-events'

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

test('legacy skip events gain move columns after the base schema is applied', () => {
  const db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE task_skip_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      actor_id INTEGER NOT NULL,
      from_date TEXT NOT NULL,
      to_date TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    INSERT INTO task_skip_events (task_id, actor_id, from_date, to_date, created_at)
      VALUES ('t1', 1, '2026-11-25', '2026-11-26', 10);
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );
  `)
  const baseline = db.prepare(
    'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
  )
  for (let version = 1; version <= 19; version += 1) baseline.run(version, 'baseline', 10)

  // db.ts applies this base schema before running migrations. It must not touch
  // the `undone` index until the migration has added that column.
  db.exec(TASK_SKIP_EVENTS_SCHEMA)
  runMigrations(db)

  const columns = (
    db.prepare('PRAGMA table_info(task_skip_events)').all() as Array<{ name: string }>
  ).map((row) => row.name)
  for (const column of ['due', 'reason', 'undone']) {
    assert.ok(columns.includes(column), `missing ${column} column`)
  }

  const indexes = (
    db.prepare('PRAGMA index_list(task_skip_events)').all() as Array<{ name: string }>
  ).map((row) => row.name)
  assert.ok(indexes.includes('idx_task_skip_events_actor'))

  const migrated = db
    .prepare('SELECT task_id, due, reason, undone FROM task_skip_events WHERE id = 1')
    .get() as unknown as { task_id: string; due: number; reason: string; undone: number }
  assert.deepEqual({ ...migrated }, { task_id: 't1', due: 0, reason: 'skip', undone: 0 })
  db.close()
})

test('legacy target and duration ML rows are removed; completion rows are kept', () => {
  const db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE task_skip_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      actor_id INTEGER NOT NULL,
      from_date TEXT NOT NULL,
      to_date TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE ml_models (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, kind TEXT NOT NULL);
    CREATE TABLE ml_shadow (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, kind TEXT NOT NULL, candidate_id INTEGER NOT NULL);
    CREATE TABLE ml_retrain_state (user_id INTEGER NOT NULL, kind TEXT NOT NULL, last_trained_at INTEGER NOT NULL, last_labelled_count INTEGER NOT NULL);
    CREATE TABLE ml_retrain_log (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, kind TEXT NOT NULL, trigger TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE ml_health (user_id INTEGER NOT NULL, kind TEXT NOT NULL, fallback INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE ml_health_predictions (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, kind TEXT NOT NULL);
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );
  `)
  for (const kind of ['completion', 'target', 'duration']) {
    db.prepare('INSERT INTO ml_models (user_id, kind) VALUES (1, ?)').run(kind)
    db.prepare('INSERT INTO ml_shadow (user_id, kind, candidate_id) VALUES (1, ?, 1)').run(kind)
    db.prepare('INSERT INTO ml_retrain_state (user_id, kind, last_trained_at, last_labelled_count) VALUES (1, ?, 10, 10)').run(kind)
    db.prepare("INSERT INTO ml_retrain_log (user_id, kind, trigger, created_at) VALUES (1, ?, 'threshold', 10)").run(kind)
    db.prepare('INSERT INTO ml_health (user_id, kind) VALUES (1, ?)').run(kind)
    db.prepare('INSERT INTO ml_health_predictions (user_id, kind) VALUES (1, ?)').run(kind)
  }
  const baseline = db.prepare(
    'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
  )
  for (let version = 1; version <= 20; version += 1) baseline.run(version, 'baseline', 10)

  runMigrations(db)

  for (const table of [
    'ml_models',
    'ml_shadow',
    'ml_retrain_state',
    'ml_retrain_log',
    'ml_health',
    'ml_health_predictions',
  ]) {
    assert.deepEqual(
      (db.prepare(`SELECT DISTINCT kind FROM ${table} ORDER BY kind`).all() as Array<{ kind: string }>).map((row) => row.kind),
      ['completion'],
      `${table} should only contain completion rows`,
    )
  }
  db.close()
})
