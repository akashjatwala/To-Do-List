import type { DatabaseSync } from 'node:sqlite'

/**
 * Phase 2 data foundation: the tables the rest of the learning system depends
 * on. Everything here is additive — no existing table is modified — and every
 * statement is idempotent, so it is safe to run on every boot.
 *
 * Design notes
 * ------------
 * - Tags get stable ids. Task/tag links and versioned config snapshots point at
 *   those ids, so renaming or merging a tag never breaks a past record.
 * - Task configuration is versioned: a new row is appended whenever a versioned
 *   field changes, and old rows are never overwritten. `effective_from` marks
 *   when a version started to apply.
 * - Priority is stored exactly as the user set it. "No priority" is NULL, never
 *   a default such as "low".
 * - Sessions record real activity. The table is called `activity_sessions`
 *   because `sessions` is already taken by login sessions.
 * - Missing data is not zero. An explicit per-day status row is what
 *   distinguishes "I skipped it" from "I did not record anything".
 */
export function createFoundationSchema(db: DatabaseSync): void {
  db.exec(`
    -- Tags live per user and have stable ids.
    CREATE TABLE IF NOT EXISTS tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      normalized TEXT NOT NULL,
      merged_into_id INTEGER,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (merged_into_id) REFERENCES tags(id)
    );

    -- Append-only trail of tag renames and merges.
    CREATE TABLE IF NOT EXISTS tag_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tag_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      normalized TEXT NOT NULL,
      action TEXT NOT NULL CHECK (action IN ('create', 'rename', 'merge')),
      merged_into_id INTEGER,
      recorded_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    -- Current task <-> tag membership (many-to-many).
    CREATE TABLE IF NOT EXISTS task_tags (
      task_id TEXT NOT NULL,
      tag_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (task_id, tag_id),
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
      FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    -- Versioned task configuration. Never overwritten; a change appends a row.
    CREATE TABLE IF NOT EXISTS task_configs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      version INTEGER NOT NULL,
      effective_from INTEGER NOT NULL,
      name TEXT NOT NULL,
      category TEXT,
      priority TEXT,
      frequency TEXT,
      frequency_config TEXT,
      target_duration INTEGER,
      preferred_time TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      UNIQUE (task_id, version),
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    -- Tag membership as it stood for a specific config version.
    CREATE TABLE IF NOT EXISTS task_config_tags (
      config_id INTEGER NOT NULL,
      tag_id INTEGER NOT NULL,
      PRIMARY KEY (config_id, tag_id),
      FOREIGN KEY (config_id) REFERENCES task_configs(id) ON DELETE CASCADE,
      FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
    );

    -- Real activity sessions. Several per day are allowed.
    CREATE TABLE IF NOT EXISTS activity_sessions (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      task_id TEXT NOT NULL,
      local_date TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      duration_minutes INTEGER NOT NULL,
      note TEXT,
      source TEXT NOT NULL DEFAULT 'user',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
    );

    -- What the user explicitly said about a day, when there is no timed session.
    CREATE TABLE IF NOT EXISTS daily_activity_status (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      task_id TEXT NOT NULL,
      local_date TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('completed', 'partial', 'skipped', 'postponed')),
      reason TEXT,
      source TEXT NOT NULL DEFAULT 'user',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (user_id, task_id, local_date),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
    );

    -- Optional extra questions. task_id set => asked for that task;
    -- tag_id set => a default suggested by a tag. Nothing is asked by default.
    CREATE TABLE IF NOT EXISTS context_questions (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      task_id TEXT,
      tag_id INTEGER,
      key TEXT NOT NULL,
      prompt TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('text', 'number', 'scale', 'boolean')),
      options_json TEXT,
      position INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
      FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
    );

    -- Answers to extra questions, recorded against a session.
    CREATE TABLE IF NOT EXISTS session_context (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      question_id TEXT NOT NULL,
      value TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE (session_id, question_id),
      FOREIGN KEY (session_id) REFERENCES activity_sessions(id) ON DELETE CASCADE,
      FOREIGN KEY (question_id) REFERENCES context_questions(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_tags_user ON tags(user_id, normalized);
    CREATE INDEX IF NOT EXISTS idx_tag_history_tag ON tag_history(tag_id, recorded_at);
    CREATE INDEX IF NOT EXISTS idx_task_tags_tag ON task_tags(tag_id);
    CREATE INDEX IF NOT EXISTS idx_task_configs_task ON task_configs(task_id, effective_from);
    CREATE INDEX IF NOT EXISTS idx_activity_sessions_task ON activity_sessions(user_id, task_id, local_date);
    CREATE INDEX IF NOT EXISTS idx_activity_sessions_date ON activity_sessions(user_id, local_date);
    CREATE INDEX IF NOT EXISTS idx_daily_activity_status_task ON daily_activity_status(user_id, task_id, local_date);
    CREATE INDEX IF NOT EXISTS idx_context_questions_task ON context_questions(user_id, task_id);
  `)
}

/**
 * Phase 2a: the read-only daily-state layer's own tables.
 *
 * These are deliberately separate from the check-in tables. The morning
 * check-in is the user's report and is never touched by this layer; the
 * evening review and the display preferences live here instead.
 *
 * - `day_reviews` stores the single optional evening tap. It is keyed by user
 *   and date, so there is at most one review per day, and it never overwrites
 *   or back-fills the morning check-in. Missing stays missing (no row).
 * - `state_prefs` lets the user hide the summary and the estimates. Absent row
 *   means the defaults (both shown).
 */
export function createStateSchema(db: DatabaseSync): void {
  db.exec(`
    -- One optional evening review per local day. Never writes to checkins.
    CREATE TABLE IF NOT EXISTS day_reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      local_date TEXT NOT NULL,
      answer TEXT NOT NULL CHECK (answer IN ('much_better', 'better', 'about_same', 'worse', 'much_worse')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (user_id, local_date),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    -- Display preferences for the state summary and estimates.
    CREATE TABLE IF NOT EXISTS state_prefs (
      user_id INTEGER PRIMARY KEY,
      show_summary INTEGER NOT NULL DEFAULT 1,
      show_estimates INTEGER NOT NULL DEFAULT 1,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    -- The user's choice about a low-capacity suggestion, stored separately from
    -- the suggestion itself (as with the reschedule/drop suggestions). Nothing
    -- is changed automatically; this only remembers what the user decided.
    CREATE TABLE IF NOT EXISTS state_suggestion_choices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      local_date TEXT NOT NULL,
      suggestion_key TEXT NOT NULL,
      choice TEXT NOT NULL CHECK (choice IN ('accepted', 'dismissed')),
      created_at INTEGER NOT NULL,
      UNIQUE (user_id, local_date, suggestion_key),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_day_reviews_user ON day_reviews(user_id, local_date);
    CREATE INDEX IF NOT EXISTS idx_suggestion_choices_user ON state_suggestion_choices(user_id, local_date);
  `)
}
