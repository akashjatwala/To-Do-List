import { test } from 'node:test'
import assert from 'node:assert/strict'
import bcrypt from 'bcryptjs'
import { resetPasswordForEmail } from './auth'
import { db } from './db'

test('a direct reset changes the password and signs out every session', async () => {
  const email = `reset-check-${Date.now()}@example.com`
  const oldHash = await bcrypt.hash('old-password-123', 10)
  const result = db
    .prepare('INSERT INTO users (email, name, password_hash, created_at) VALUES (?, ?, ?, ?)')
    .run(email, 'Reset Check', oldHash, Date.now())
  const userId = Number(result.lastInsertRowid)

  try {
    db.prepare(
      "INSERT INTO auth_tokens (token_hash, user_id, kind, created_at, expires_at) VALUES (?, ?, 'session', ?, ?)",
    ).run('reset-check-session', userId, Date.now(), Date.now() + 60_000)
    const countSessions = () =>
      (
        db
          .prepare("SELECT COUNT(*) AS n FROM auth_tokens WHERE user_id = ? AND kind = 'session'")
          .get(userId) as { n: number }
      ).n
    assert.equal(countSessions(), 1)

    assert.equal(await resetPasswordForEmail(email, 'new-password-456'), true)

    const user = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(userId) as {
      password_hash: string
    }
    assert.equal(await bcrypt.compare('new-password-456', user.password_hash), true)
    assert.equal(await bcrypt.compare('old-password-123', user.password_hash), false)
    assert.equal(countSessions(), 0)

    assert.equal(await resetPasswordForEmail(`missing-${Date.now()}@example.com`, 'another-pass'), false)
  } finally {
    db.prepare('DELETE FROM users WHERE id = ?').run(userId)
  }
})
