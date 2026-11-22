import type { DatabaseSync } from 'node:sqlite'

/**
 * Versioned, idempotent schema migrations.
 *
 * Fresh databases already contain every column in the CREATE TABLE statements.
 * Older databases get the missing pieces here, once each, and the applied
 * versions are recorded in `schema_migrations`. Each migration still checks for
 * its own column so an existing database can be baselined safely.
 */
interface Migration {
  version: number
  name: string
  up: (db: DatabaseSync) => void
}

const hasColumn = (db: DatabaseSync, table: string, column: string): boolean =>
  (
    db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{ name: string }>
  ).some((row) => row.name === column)

const addColumn = (db: DatabaseSync, table: string, definition: string) =>
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`)

const migrations: Migration[] = [
  {
    version: 1,
    name: 'users.name',
    up: (db) => {
      if (!hasColumn(db, 'users', 'name')) addColumn(db, 'users', "name TEXT NOT NULL DEFAULT ''")
    },
  },
  {
    version: 2,
    name: 'tasks.progress',
    up: (db) => {
      if (!hasColumn(db, 'tasks', 'progress')) {
        addColumn(db, 'tasks', 'progress INTEGER NOT NULL DEFAULT 0')
        db.prepare('UPDATE tasks SET progress = 100 WHERE done = 1').run()
      }
    },
  },
  {
    version: 3,
    name: 'tasks.priority',
    up: (db) => {
      if (!hasColumn(db, 'tasks', 'priority')) {
        addColumn(db, 'tasks', "priority TEXT NOT NULL DEFAULT 'none'")
      }
    },
  },
  {
    version: 4,
    name: 'tasks.tags',
    up: (db) => {
      if (!hasColumn(db, 'tasks', 'tags')) addColumn(db, 'tasks', "tags TEXT NOT NULL DEFAULT '[]'")
    },
  },
  {
    version: 5,
    name: 'tasks.recurrence',
    up: (db) => {
      if (!hasColumn(db, 'tasks', 'recurrence')) {
        addColumn(db, 'tasks', "recurrence TEXT NOT NULL DEFAULT 'none'")
      }
    },
  },
  {
    version: 6,
    name: 'tasks.duration',
    up: (db) => {
      if (!hasColumn(db, 'tasks', 'duration')) addColumn(db, 'tasks', 'duration INTEGER')
    },
  },
  {
    version: 7,
    name: 'tasks.recurrence_config',
    up: (db) => {
      if (!hasColumn(db, 'tasks', 'recurrence_config')) {
        addColumn(db, 'tasks', 'recurrence_config TEXT')
      }
    },
  },
  {
    version: 8,
    name: 'tasks.preferred_time',
    up: (db) => {
      if (!hasColumn(db, 'tasks', 'preferred_time')) addColumn(db, 'tasks', 'preferred_time TEXT')
    },
  },
  {
    version: 9,
    name: 'subtasks.assignee_id',
    up: (db) => {
      if (!hasColumn(db, 'subtasks', 'assignee_id')) {
        addColumn(
          db,
          'subtasks',
          'assignee_id INTEGER REFERENCES users(id) ON DELETE SET NULL',
        )
      }
    },
  },
  {
    version: 10,
    name: 'checkins.source',
    up: (db) => {
      if (!hasColumn(db, 'checkins', 'source')) {
        addColumn(db, 'checkins', "source TEXT NOT NULL DEFAULT 'user'")
      }
    },
  },
  {
    version: 11,
    name: 'checkin_history.source',
    up: (db) => {
      if (!hasColumn(db, 'checkin_history', 'source')) {
        addColumn(db, 'checkin_history', "source TEXT NOT NULL DEFAULT 'user'")
      }
    },
  },
  {
    version: 12,
    name: 'auth_tokens.sessions-only',
    up: (db) => {
      // Password-reset codes were removed; keep only live session rows and
      // narrow the CHECK constraint so a stray reset token cannot be created.
      db.exec(`
        CREATE TABLE auth_tokens_next (
          token_hash TEXT PRIMARY KEY,
          user_id INTEGER NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('session')),
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
        INSERT INTO auth_tokens_next (token_hash, user_id, kind, created_at, expires_at)
          SELECT token_hash, user_id, 'session', created_at, expires_at
          FROM auth_tokens WHERE kind = 'session';
        DROP TABLE auth_tokens;
        ALTER TABLE auth_tokens_next RENAME TO auth_tokens;
        CREATE INDEX IF NOT EXISTS idx_auth_tokens_user ON auth_tokens(user_id);
      `)
    },
  },
]

export function runMigrations(db: DatabaseSync): void {
  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)',
  )
  const applied = new Set(
    (db.prepare('SELECT version FROM schema_migrations').all() as unknown as Array<{
      version: number
    }>).map((row) => row.version),
  )

  for (const migration of migrations) {
    if (applied.has(migration.version)) continue
    db.exec('BEGIN')
    try {
      migration.up(db)
      db.prepare(
        'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
      ).run(migration.version, migration.name, Date.now())
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
}
