import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { createCheckinSchema } from '../../checkins-store'
import { createFoundationSchema, createMlSchema, createPredictionSchema, createStateSchema } from '../schema'

/**
 * Isolation for the synthetic dataset (Phase 3).
 *
 * Hard rules this module exists to enforce:
 * - Synthetic data lives in its **own database file**, never the app's real
 *   `server/data/todo.db`. Nothing here imports the app's `db` singleton.
 * - Every synthetic person is its own user row with a reserved email domain, and
 *   every record they produce carries the `synthetic` source flag.
 * - Models trained on synthetic data are registered with `synthetic = 1` and can
 *   never be promoted into the real registry (there is no code path that
 *   promotes a synthetic model).
 *
 * The app's own schema builders are reused so the synthetic tables are byte-for-
 * byte the same shape as the real ones; only `users` and `tasks` (the two base
 * tables the app defines inline) are re-created here.
 */

export const SYNTHETIC_FLAG = 'synthetic'
export const SYNTHETIC_EMAIL_DOMAIN = 'synthetic.local'

/** Create the synthetic-only bookkeeping tables. */
function createSyntheticSchema(db: DatabaseSync): void {
  db.exec(`
    -- One row per simulated person, linking the generator's id to a user row.
    CREATE TABLE IF NOT EXISTS synthetic_persons (
      person_id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      label TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('named', 'random')),
      archetype INTEGER,
      held_out INTEGER NOT NULL DEFAULT 0,
      seed INTEGER NOT NULL,
      synthetic INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      UNIQUE (user_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    -- Every model produced from synthetic data is flagged and never promotable.
    CREATE TABLE IF NOT EXISTS synthetic_models (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      payload TEXT,
      synthetic INTEGER NOT NULL DEFAULT 1,
      promoted INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );

    -- The Phase 3 recommendation/suggestion layer, kept in a synthetic-only
    -- table because the app itself has no table for it. Loading it lets the
    -- Phase 4 pipeline checks exercise recommendations end to end.
    CREATE TABLE IF NOT EXISTS synthetic_recommendations (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL,
      local_date TEXT NOT NULL,
      task_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('plan', 'reschedule', 'drop')),
      exploratory INTEGER NOT NULL DEFAULT 0,
      response TEXT NOT NULL,
      synthetic INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `)
}

/**
 * Open (or create) the isolated synthetic database. The base `users` and `tasks`
 * tables mirror the app's own definitions; the rest of the schema comes from the
 * app's schema builders.
 */
export function openSyntheticDb(path: string): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec('PRAGMA foreign_keys = ON')
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

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
      preferred_time TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `)
  createCheckinSchema(db)
  createFoundationSchema(db)
  createStateSchema(db)
  createPredictionSchema(db)
  createMlSchema(db)
  createSyntheticSchema(db)
  return db
}

/** Throw unless this database is a synthetic one (has the marker table). */
export function assertSynthetic(db: DatabaseSync): void {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'synthetic_persons'")
    .get()
  if (!row) {
    throw new Error('Refusing to write synthetic data into a database without the synthetic marker table.')
  }
}

export interface SyntheticPersonRef {
  personId: string
  label: string
  kind: 'named' | 'random'
  archetype: number | null
  heldOut: boolean
  seed: number
}

export interface SyntheticUser {
  personId: string
  userId: number
  email: string
}

/** Create (or reuse) the isolated user row for one simulated person. */
export function createSyntheticUser(db: DatabaseSync, person: SyntheticPersonRef, now = Date.now()): SyntheticUser {
  assertSynthetic(db)
  const email = `${person.personId}@${SYNTHETIC_EMAIL_DOMAIN}`
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email) as unknown as
    | { id: number }
    | undefined
  if (existing) return { personId: person.personId, userId: existing.id, email }

  const result = db
    .prepare('INSERT INTO users (email, password_hash, created_at) VALUES (?, ?, ?)')
    .run(email, 'synthetic-not-a-real-login', now)
  const userId = Number(result.lastInsertRowid)
  db.prepare(
    `INSERT INTO synthetic_persons (person_id, user_id, label, kind, archetype, held_out, seed, synthetic, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`,
  ).run(person.personId, userId, person.label, person.kind, person.archetype, person.heldOut ? 1 : 0, person.seed, now)
  return { personId: person.personId, userId, email }
}

export interface SyntheticPersonRow {
  person_id: string
  user_id: number
  label: string
  kind: 'named' | 'random'
  archetype: number | null
  held_out: number
  seed: number
}

export function listSyntheticPersons(db: DatabaseSync): SyntheticPersonRow[] {
  return db
    .prepare('SELECT person_id, user_id, label, kind, archetype, held_out, seed FROM synthetic_persons ORDER BY person_id')
    .all() as unknown as SyntheticPersonRow[]
}

// ---------------------------------------------------------------------------
// Model registry guard
// ---------------------------------------------------------------------------

export interface SyntheticModel {
  id: number
  name: string
  payload: string | null
  synthetic: boolean
  promoted: boolean
  createdAt: number
}

/**
 * Register a model produced from synthetic data. It is always flagged synthetic;
 * there is deliberately no way to register a non-synthetic model here.
 */
export function registerSyntheticModel(db: DatabaseSync, name: string, payload: unknown, now = Date.now()): SyntheticModel {
  assertSynthetic(db)
  const result = db
    .prepare('INSERT INTO synthetic_models (name, payload, synthetic, promoted, created_at) VALUES (?, ?, 1, 0, ?)')
    .run(name, payload === undefined ? null : JSON.stringify(payload), now)
  return getSyntheticModel(db, Number(result.lastInsertRowid))!
}

export function getSyntheticModel(db: DatabaseSync, id: number): SyntheticModel | undefined {
  const row = db
    .prepare('SELECT id, name, payload, synthetic, promoted, created_at FROM synthetic_models WHERE id = ?')
    .get(id) as unknown as
    | { id: number; name: string; payload: string | null; synthetic: number; promoted: number; created_at: number }
    | undefined
  if (!row) return undefined
  return {
    id: row.id,
    name: row.name,
    payload: row.payload,
    synthetic: row.synthetic === 1,
    promoted: row.promoted === 1,
    createdAt: row.created_at,
  }
}

/**
 * The single gate for promotion. A synthetic model can never pass: the result
 * always says no, with the reason. Real model promotion is Phase 6's job; this
 * exists so a synthetic model cannot slip through when it arrives.
 */
export function canPromoteModel(db: DatabaseSync, id: number): { ok: boolean; reason: string } {
  const model = getSyntheticModel(db, id)
  if (!model) return { ok: false, reason: 'No such model.' }
  if (model.synthetic) {
    return { ok: false, reason: 'This model was trained on synthetic data and can never be promoted to the real registry.' }
  }
  return { ok: true, reason: 'Eligible for promotion.' }
}

/** Attempt a promotion. Always throws for a synthetic model. */
export function promoteModel(db: DatabaseSync, id: number): never {
  const check = canPromoteModel(db, id)
  throw new Error(check.reason)
}
