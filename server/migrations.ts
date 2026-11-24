import type { DatabaseSync } from 'node:sqlite'
import { mergeTags } from './ml/tags'

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

/**
 * Older seeded databases can contain several active ids for the same tag name.
 * Fold them into the oldest id with the existing merge logic so task links,
 * context questions, JSON labels and tag history all stay consistent.
 */
export function deduplicateTags(db: DatabaseSync): void {
  const groups = db
    .prepare(
      `SELECT user_id, normalized, MIN(id) AS survivor_id
       FROM tags
       WHERE merged_into_id IS NULL
       GROUP BY user_id, normalized
       HAVING COUNT(*) > 1`,
    )
    .all() as unknown as Array<{ user_id: number; normalized: string; survivor_id: number }>

  const now = Date.now()
  for (const group of groups) {
    const sources = db
      .prepare(
        `SELECT id FROM tags
         WHERE user_id = ? AND normalized = ? AND merged_into_id IS NULL AND id <> ?
         ORDER BY id`,
      )
      .all(group.user_id, group.normalized, group.survivor_id) as unknown as Array<{ id: number }>
    for (const source of sources) {
      mergeTags(db, group.user_id, source.id, group.survivor_id, now)
    }
  }
}

/**
 * Legacy rows can hold mixed-case tag names even though `normalized` has
 * always been lower case. Canonicalise both the tag rows and the JSON labels
 * stored on tasks, keeping every id (and therefore every history link) intact.
 */
export function lowercaseTagNames(db: DatabaseSync): void {
  const canonical = (value: string) => value.trim().replace(/\s+/g, ' ').toLowerCase()

  const tags = db.prepare('SELECT id, name, normalized FROM tags').all() as unknown as Array<{
    id: number
    name: string
    normalized: string
  }>
  const updateTag = db.prepare('UPDATE tags SET name = ?, normalized = ? WHERE id = ?')
  for (const tag of tags) {
    const name = canonical(tag.name)
    const normalized = canonical(tag.normalized)
    if (name !== tag.name || normalized !== tag.normalized) updateTag.run(name, normalized, tag.id)
  }

  const tasks = db.prepare('SELECT id, tags FROM tasks WHERE tags IS NOT NULL').all() as unknown as Array<{
    id: string
    tags: string
  }>
  const updateTask = db.prepare('UPDATE tasks SET tags = ? WHERE id = ?')
  for (const task of tasks) {
    let parsed: unknown
    try {
      parsed = JSON.parse(task.tags)
    } catch {
      continue
    }
    if (!Array.isArray(parsed)) continue
    const seen = new Set<string>()
    const next: string[] = []
    let changed = false
    for (const item of parsed) {
      if (typeof item !== 'string') {
        changed = true
        continue
      }
      const name = canonical(item)
      if (!name || seen.has(name)) {
        changed = true
        continue
      }
      if (name !== item) changed = true
      seen.add(name)
      next.push(name)
    }
    if (changed) updateTask.run(JSON.stringify(next), task.id)
  }
}

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
  {
    version: 13,
    name: 'task_reminders',
    up: (db) => {
      // The tables are also declared in db.ts; this records the version so an
      // older database is explicitly brought up to the reminder-enabled shape.
      db.exec(`
        CREATE TABLE IF NOT EXISTS task_reminders (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id TEXT NOT NULL,
          sender_id INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
          FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS task_reminder_recipients (
          reminder_id INTEGER NOT NULL,
          user_id INTEGER NOT NULL,
          PRIMARY KEY (reminder_id, user_id),
          FOREIGN KEY (reminder_id) REFERENCES task_reminders(id) ON DELETE CASCADE,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_task_reminders_task ON task_reminders(task_id);
        CREATE INDEX IF NOT EXISTS idx_task_reminder_recipients_reminder ON task_reminder_recipients(reminder_id);
      `)
    },
  },
  {
    version: 14,
    name: 'task_assignees.assignment-metadata',
    up: (db) => {
      if (!hasColumn(db, 'task_assignees', 'assigned_at')) {
        addColumn(db, 'task_assignees', 'assigned_at INTEGER')
      }
      if (!hasColumn(db, 'task_assignees', 'assigned_by')) {
        addColumn(
          db,
          'task_assignees',
          'assigned_by INTEGER REFERENCES users(id) ON DELETE SET NULL',
        )
      }
      // Old assignments were made when the task was created by its owner.
      db.exec(`
        UPDATE task_assignees
        SET assigned_at = COALESCE(assigned_at, (SELECT created_at FROM tasks WHERE tasks.id = task_assignees.task_id)),
            assigned_by = COALESCE(assigned_by, (SELECT user_id FROM tasks WHERE tasks.id = task_assignees.task_id))
      `)
    },
  },
  {
    version: 15,
    name: 'tasks.completion-metadata',
    up: (db) => {
      if (!hasColumn(db, 'tasks', 'completed_at')) {
        addColumn(db, 'tasks', 'completed_at INTEGER')
      }
      if (!hasColumn(db, 'tasks', 'completed_by')) {
        addColumn(db, 'tasks', 'completed_by INTEGER REFERENCES users(id) ON DELETE SET NULL')
      }
      // Existing done rows have no reliable completion time, so they stay blank
      // rather than pretending they were completed when they were created.
    },
  },
  {
    version: 16,
    name: 'tags.duplicate-names',
    up: (db) => {
      deduplicateTags(db)
    },
  },
  {
    version: 17,
    name: 'tags.lowercase-and-deletable',
    up: (db) => {
      if (!hasColumn(db, 'tags', 'deleted_at')) {
        addColumn(db, 'tags', 'deleted_at INTEGER')
      }
      lowercaseTagNames(db)
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
