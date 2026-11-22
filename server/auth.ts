import { createHash, randomBytes } from 'node:crypto'
import { db, type AuthTokenRow, type UserRow } from './db'

// ---- Token handling ----
// Only SHA-256 hashes of tokens are stored; the raw token exists solely on
// the client, so a leaked database cannot be replayed as valid sessions.
// Sessions are stored as hashes so a leaked database cannot be replayed.

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

export const REMEMBER_TTL_MS = 1000 * 60 * 60 * 24 * 30 // "Remember me": 30 days
export const SHORT_TTL_MS = 1000 * 60 * 60 * 24 // Otherwise: 1 day

// ---- Housekeeping ----

/** Delete expired sessions. Called on auth operations. */
export function sweepExpired(): void {
  db.prepare('DELETE FROM auth_tokens WHERE expires_at < ?').run(Date.now())
}

// ---- Sessions (persisted in SQLite — they survive server restarts) ----

export function createSession(userId: number, remember: boolean): string {
  const token = randomBytes(32).toString('hex')
  const ttl = remember ? REMEMBER_TTL_MS : SHORT_TTL_MS
  db.prepare(
    "INSERT INTO auth_tokens (token_hash, user_id, kind, created_at, expires_at) VALUES (?, ?, 'session', ?, ?)",
  ).run(sha256(token), userId, Date.now(), Date.now() + ttl)
  return token
}

export function destroySession(token: string): void {
  db.prepare("DELETE FROM auth_tokens WHERE token_hash = ? AND kind = 'session'").run(sha256(token))
}

/** Invalidate every session for a user, e.g. after a password change. */
export function destroyAllSessions(userId: number): void {
  db.prepare("DELETE FROM auth_tokens WHERE user_id = ? AND kind = 'session'").run(userId)
}

/** Invalidate every session for a user except the one making the request. */
export function destroyOtherSessions(userId: number, keepToken: string): void {
  db.prepare(
    "DELETE FROM auth_tokens WHERE user_id = ? AND kind = 'session' AND token_hash != ?",
  ).run(userId, sha256(keepToken))
}

export function userIdForToken(token: string | undefined): number | null {
  if (!token) return null
  const row = db
    .prepare("SELECT * FROM auth_tokens WHERE token_hash = ? AND kind = 'session'")
    .get(sha256(token)) as unknown as AuthTokenRow | undefined
  if (!row) return null
  if (row.expires_at < Date.now()) {
    db.prepare("DELETE FROM auth_tokens WHERE token_hash = ? AND kind = 'session'").run(row.token_hash)
    return null
  }
  return row.user_id
}

// ---- Users ----

export function getUserById(id: number): UserRow | undefined {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id) as unknown as UserRow | undefined
}

export function getUserByEmail(email: string): UserRow | undefined {
  return db.prepare('SELECT * FROM users WHERE email = ?').get(email) as unknown as UserRow | undefined
}

// ---- Validation ----

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function validEmail(email: unknown): email is string {
  return typeof email === 'string' && EMAIL_RE.test(email) && email.length <= 254
}

export function validatePassword(password: unknown): string | null {
  if (typeof password !== 'string' || password.length < 8) {
    return 'Password must be at least 8 characters.'
  }
  if (password.length > 200) {
    return 'Password must be at most 200 characters.'
  }
  return null
}

