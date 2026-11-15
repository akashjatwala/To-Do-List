import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), 'data')
mkdirSync(DATA_DIR, { recursive: true })

export const db = new DatabaseSync(join(DATA_DIR, 'todo.db'))
db.exec('PRAGMA foreign_keys = ON')

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS password_resets (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
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
    due INTEGER,
    position INTEGER NOT NULL DEFAULT 0,
    progress INTEGER NOT NULL DEFAULT 0,
    priority TEXT NOT NULL DEFAULT 'none',
    tags TEXT NOT NULL DEFAULT '[]',
    recurrence TEXT NOT NULL DEFAULT 'none',
    duration INTEGER,
    recurrence_config TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS subtasks (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    text TEXT NOT NULL,
    done INTEGER NOT NULL DEFAULT 0,
    position INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
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

  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
  CREATE INDEX IF NOT EXISTS idx_tasks_user ON tasks(user_id);
  CREATE INDEX IF NOT EXISTS idx_tasks_team ON tasks(team_id);
  CREATE INDEX IF NOT EXISTS idx_subtasks_task ON subtasks(task_id);
  CREATE INDEX IF NOT EXISTS idx_comments_task ON comments(task_id);
  CREATE INDEX IF NOT EXISTS idx_team_members_user ON team_members(user_id);
  CREATE INDEX IF NOT EXISTS idx_team_invites_email ON team_invites(email);
`)

// Lightweight migrations for databases created by older versions of the app.
const taskColumns = db.prepare('PRAGMA table_info(tasks)').all() as unknown as Array<{
  name: string
}>
const hasTaskColumn = (name: string) => taskColumns.some((column) => column.name === name)

if (!hasTaskColumn('progress')) {
  db.exec('ALTER TABLE tasks ADD COLUMN progress INTEGER NOT NULL DEFAULT 0')
  db.prepare('UPDATE tasks SET progress = 100 WHERE done = 1').run()
}
if (!hasTaskColumn('priority')) {
  db.exec("ALTER TABLE tasks ADD COLUMN priority TEXT NOT NULL DEFAULT 'none'")
}
if (!hasTaskColumn('tags')) {
  db.exec("ALTER TABLE tasks ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'")
}
if (!hasTaskColumn('recurrence')) {
  db.exec("ALTER TABLE tasks ADD COLUMN recurrence TEXT NOT NULL DEFAULT 'none'")
}
if (!hasTaskColumn('duration')) {
  db.exec('ALTER TABLE tasks ADD COLUMN duration INTEGER')
}
if (!hasTaskColumn('recurrence_config')) {
  db.exec('ALTER TABLE tasks ADD COLUMN recurrence_config TEXT')
}

export interface UserRow {
  id: number
  email: string
  password_hash: string
  created_at: number
}

export interface SessionRow {
  token_hash: string
  user_id: number
  created_at: number
  expires_at: number
}

export interface PasswordResetRow {
  token_hash: string
  user_id: number
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
  due: number | null
  position: number
  progress: number
  priority: string
  tags: string
  recurrence: string
  duration: number | null
  recurrence_config: string | null
}

export interface SubtaskRow {
  id: string
  task_id: string
  text: string
  done: number
  position: number
}

export interface CommentRow {
  id: string
  task_id: string
  user_id: number
  text: string
  created_at: number
}
