import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCheckinSchema } from './checkins-store'
import { runMigrations } from './migrations'
import { createFoundationSchema, createMlSchema, createPredictionSchema, createStateSchema } from './ml/schema'

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), 'data')
// Tests point this at an isolated file so they never open the live database.
const DB_PATH = process.env.DUIT_DB_PATH
  ? resolve(process.cwd(), process.env.DUIT_DB_PATH)
  : join(DATA_DIR, 'todo.db')
mkdirSync(dirname(DB_PATH), { recursive: true })

export const db = new DatabaseSync(DB_PATH)
db.exec('PRAGMA foreign_keys = ON')
db.exec('PRAGMA journal_mode = WAL')
db.exec('PRAGMA synchronous = NORMAL')
db.exec('PRAGMA busy_timeout = 5000')

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL DEFAULT '',
    password_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  -- Login sessions are stored as hashes; the raw token only exists in the
  -- browser cookie, so a leaked database cannot be replayed as a session.
  CREATE TABLE IF NOT EXISTS auth_tokens (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('session')),
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS teams (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_by INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS team_members (
    team_id TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('host', 'member')),
    joined_at INTEGER NOT NULL,
    PRIMARY KEY (team_id, user_id),
    FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS team_invites (
    team_id TEXT NOT NULL,
    email TEXT NOT NULL,
    invited_by INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (team_id, email),
    FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE
  );

  -- team_id NULL means a personal task; otherwise a shared team task.
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    team_id TEXT,
    text TEXT NOT NULL,
    done INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    completed_at INTEGER,
    completed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    due INTEGER,
    position INTEGER NOT NULL DEFAULT 0,
    progress INTEGER NOT NULL DEFAULT 0,
    priority TEXT NOT NULL DEFAULT 'none',
    tags TEXT NOT NULL DEFAULT '[]',
    recurrence TEXT NOT NULL DEFAULT 'none',
    duration INTEGER,
    recurrence_config TEXT,
    preferred_time TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS subtasks (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    text TEXT NOT NULL,
    done INTEGER NOT NULL DEFAULT 0,
    position INTEGER NOT NULL DEFAULT 0,
    assignee_id INTEGER,
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
    FOREIGN KEY (assignee_id) REFERENCES users(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS comments (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    text TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  -- A team task can be assigned to several teammates. The creator remains the
  -- task's owner (tasks.user_id); this table only records who is working on it.
  CREATE TABLE IF NOT EXISTS task_assignees (
    task_id TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    assigned_at INTEGER,
    assigned_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    PRIMARY KEY (task_id, user_id),
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  -- In-app reminders shown in the Overdue card. Personal reminders have no
  -- recipient; team broadcasts keep a snapshot of everyone notified at send time.
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

  CREATE INDEX IF NOT EXISTS idx_auth_tokens_user ON auth_tokens(user_id);
  CREATE INDEX IF NOT EXISTS idx_tasks_user ON tasks(user_id);
  CREATE INDEX IF NOT EXISTS idx_tasks_team ON tasks(team_id);
  CREATE INDEX IF NOT EXISTS idx_subtasks_task ON subtasks(task_id);
  CREATE INDEX IF NOT EXISTS idx_comments_task ON comments(task_id);
  CREATE INDEX IF NOT EXISTS idx_task_assignees_task ON task_assignees(task_id);
  CREATE INDEX IF NOT EXISTS idx_task_assignees_user ON task_assignees(user_id);
  CREATE INDEX IF NOT EXISTS idx_task_reminders_task ON task_reminders(task_id);
  CREATE INDEX IF NOT EXISTS idx_task_reminder_recipients_reminder ON task_reminder_recipients(reminder_id);
  CREATE INDEX IF NOT EXISTS idx_team_members_user ON team_members(user_id);
  CREATE INDEX IF NOT EXISTS idx_team_invites_email ON team_invites(email);
`)

// Daily mood/context check-ins and their append-only edit trail.
createCheckinSchema(db)

// Foundation: tags, versioned task configs, activity sessions and daily records.
createFoundationSchema(db)

// Daily state: the read-only layer's own tables (evening review, prefs).
createStateSchema(db)

// Predictions: off days, the prediction log and the feedback trail. These are the
// learning system's own tables and never hold observed outcomes.
createPredictionSchema(db)

// Machine learning: the model registry, the shadow-mode log and the retrain bookkeeping.
createMlSchema(db)

// Bring older databases up to the current shape exactly once.
runMigrations(db)

/** Clear a departing member's assignments on that team's tasks. */
export function clearTeamAssignees(teamId: string, userId: number) {
  db.prepare(
    `DELETE FROM task_assignees
     WHERE user_id = ? AND task_id IN (SELECT id FROM tasks WHERE team_id = ?)`,
  ).run(userId, teamId)
  db.prepare(
    `UPDATE subtasks SET assignee_id = NULL
     WHERE assignee_id = ? AND task_id IN (SELECT id FROM tasks WHERE team_id = ?)`,
  ).run(userId, teamId)
}

export interface UserRow {
  id: number
  email: string
  name: string
  password_hash: string
  created_at: number
}

export interface AuthTokenRow {
  token_hash: string
  user_id: number
  kind: 'session'
  created_at: number
  expires_at: number
}

export interface TeamRow {
  id: string
  name: string
  created_by: number
  created_at: number
}

export interface TeamInviteRow {
  team_id: string
  email: string
  invited_by: number
  created_at: number
}

export interface TaskRow {
  id: string
  user_id: number
  team_id: string | null
  text: string
  done: number
  created_at: number
  completed_at: number | null
  completed_by: number | null
  due: number | null
  position: number
  progress: number
  priority: string
  tags: string
  recurrence: string
  duration: number | null
  recurrence_config: string | null
  preferred_time: string | null
}

export interface SubtaskRow {
  id: string
  task_id: string
  text: string
  done: number
  position: number
  assignee_id: number | null
}

export interface CommentRow {
  id: string
  task_id: string
  user_id: number
  text: string
  created_at: number
}
