import { Router } from 'express'
import bcrypt from 'bcryptjs'
import {
  createPasswordReset,
  createSession,
  consumePasswordReset,
  destroyAllSessions,
  destroySession,
  getUserByEmail,
  getUserById,
  sweepExpired,
  validEmail,
  validatePassword,
} from './auth'
import { db } from './db'
import {
  clearSessionCookie,
  fail,
  parseCookies,
  SESSION_COOKIE,
  setSessionCookie,
  unauthorized,
  type AuthedRequest,
} from './http'

const router = Router()

const normalizeEmail = (email: string) => email.trim().toLowerCase()
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10)

router.post('/signup', async (req, res) => {
  sweepExpired()
  const email = typeof req.body?.email === 'string' ? normalizeEmail(req.body.email) : ''
  const password = req.body?.password
  const remember = req.body?.remember === true

  if (!validEmail(email)) return fail(res, 400, 'Please enter a valid email address.')
  const passwordError = validatePassword(password)
  if (passwordError) return fail(res, 400, passwordError)
  if (getUserByEmail(email)) {
    return fail(res, 409, 'An account with that email already exists. Try signing in.')
  }

  const hash = await bcrypt.hash(password, 10)
  const result = db
    .prepare('INSERT INTO users (email, password_hash, created_at) VALUES (?, ?, ?)')
    .run(email, hash, Date.now())
  const userId = Number(result.lastInsertRowid)

  const token = createSession(userId, remember)
  setSessionCookie(res, token, remember)
  res.status(201).json({ user: { id: userId, email } })
})

router.post('/login', async (req, res) => {
  sweepExpired()
  const email = typeof req.body?.email === 'string' ? normalizeEmail(req.body.email) : ''
  const password = typeof req.body?.password === 'string' ? req.body.password : ''
  const remember = req.body?.remember === true

  const user = getUserByEmail(email)
  const ok = await bcrypt.compare(password, user?.password_hash ?? DUMMY_HASH)
  if (!user || !ok) return unauthorized(res, 'Incorrect email or password.')

  const token = createSession(user.id, remember)
  setSessionCookie(res, token, remember)
  res.json({ user: { id: user.id, email: user.email } })
})

router.post('/logout', (req, res) => {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE]
  if (token) destroySession(token)
  clearSessionCookie(res)
  res.json({ ok: true })
})

router.get('/me', (req: AuthedRequest, res) => {
  if (!req.userId) return unauthorized(res)
  const user = getUserById(req.userId)
  if (!user) return unauthorized(res)
  res.json({ user: { id: user.id, email: user.email } })
})

router.post('/forgot', (req, res) => {
  sweepExpired()
  const email = typeof req.body?.email === 'string' ? normalizeEmail(req.body.email) : ''
  if (!validEmail(email)) return fail(res, 400, 'Please enter a valid email address.')

  const user = getUserByEmail(email)
  // Always report success so the endpoint cannot be used to discover accounts.
  const response: { ok: true; resetCode?: string } = { ok: true }
  if (user) {
    const code = createPasswordReset(user.id)
    // No mail service is configured for this app, so in development the code is
    // returned to the client and also printed to the server console.
    if (process.env.NODE_ENV !== 'production') {
      response.resetCode = code
      console.log(`\n[todo] Password reset code for ${email}: ${code}\n`)
    }
  }
  res.json(response)
})

router.post('/reset', async (req, res) => {
  sweepExpired()
  const token = typeof req.body?.token === 'string' ? req.body.token.trim() : ''
  const password = req.body?.password
  if (!token) return fail(res, 400, 'Enter the reset code from your email.')
  const passwordError = validatePassword(password)
  if (passwordError) return fail(res, 400, passwordError)

  const userId = consumePasswordReset(token)
  if (!userId) return fail(res, 400, 'That reset code is invalid or has expired. Request a new one.')

  const hash = await bcrypt.hash(password, 10)
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, userId)
  destroyAllSessions(userId)
  res.json({ ok: true })
})

export default router
