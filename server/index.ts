import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import express from 'express'
import type { Response } from 'express'
import { getUserById, userIdForToken } from './auth'
import { bootstrap } from './data'
import authRoutes from './auth-routes'
import teamRoutes, { invitesRouter } from './teams'
import taskRoutes from './tasks'
import checkinRoutes from './checkins'
import {
  activityRoutes,
  contextQuestionRoutes,
  tagRoutes,
  taskConfigRoutes,
} from './ml/routes'
import stateRoutes from './ml/state-routes'
import offDayRoutes from './ml/off-day-routes'
import predictionRoutes from './ml/prediction-routes'
import learningRoutes from './ml/health-routes'
import { startRetrainScheduler } from './ml/learning'
import { db } from './db'
import { fail, parseCookies, SESSION_COOKIE, unauthorized, type AuthedRequest } from './http'

const app = express()
const PORT = Number(process.env.PORT ?? 3001)

app.disable('x-powered-by')
app.use(express.json({ limit: '100kb' }))

// ---- Session middleware ----
app.use((req: AuthedRequest, _res, next) => {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE]
  const userId = userIdForToken(token)
  if (userId !== null && getUserById(userId)) req.userId = userId
  next()
})

function requireUser(req: AuthedRequest, res: Response): number | null {
  if (!req.userId) {
    unauthorized(res)
    return null
  }
  return req.userId
}

// ---- API ----
app.get('/api/health', (_req, res) => {
  res.json({ ok: true })
})

app.use('/api/auth', authRoutes)

app.get('/api/bootstrap', (req: AuthedRequest, res) => {
  const userId = requireUser(req, res)
  if (userId === null) return
  const data = bootstrap(userId)
  if (!data) return fail(res, 401, 'Your account could not be found.')
  res.json(data)
})

app.use('/api/teams', (req: AuthedRequest, res, next) => {
  if (requireUser(req, res) === null) return
  next()
})
app.use('/api/teams', teamRoutes)

app.use('/api/invites', (req: AuthedRequest, res, next) => {
  if (requireUser(req, res) === null) return
  next()
})
app.use('/api/invites', invitesRouter)

app.use('/api/tasks', (req: AuthedRequest, res, next) => {
  if (requireUser(req, res) === null) return
  next()
})
app.use('/api/tasks', taskRoutes)

app.use('/api/checkins', (req: AuthedRequest, res, next) => {
  if (requireUser(req, res) === null) return
  next()
})
app.use('/api/checkins', checkinRoutes)

for (const [prefix, router] of [
  ['/api/activity', activityRoutes],
  ['/api/tags', tagRoutes],
  ['/api/task-configs', taskConfigRoutes],
  ['/api/context-questions', contextQuestionRoutes],
  ['/api/state', stateRoutes],
  ['/api/off-days', offDayRoutes],
  ['/api/predictions', predictionRoutes],
  ['/api/ml', learningRoutes],
] as const) {
  app.use(prefix, (req: AuthedRequest, res, next) => {
    if (requireUser(req, res) === null) return
    next()
  })
  app.use(prefix, router)
}

app.use('/api', (_req, res) => {
  fail(res, 404, 'API route not found.')
})

// ---- Production static hosting ----
const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist')
if (existsSync(dist)) {
  app.use(express.static(dist))
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api')) return next()
    res.sendFile(join(dist, 'index.html'))
  })
}

// ---- Errors ----
app.use(
  (
    err: Error & { status?: number; type?: string },
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    if (err.type === 'entity.parse.failed') return fail(res, 400, 'Invalid JSON body.')
    if (err.status && err.status < 500) return fail(res, err.status, err.message)
    console.error(err)
    fail(res, 500, 'Something went wrong on the server.')
  },
)

app.listen(PORT, () => {
  console.log(`\n  To-Do API ready at http://localhost:${PORT}\n`)
})

// ---- Periodic retraining ----
// A lightweight, unref'd timer that asks the retrain gate whether a retrain is
// due and rate-limits the work inside `maybeRetrain`. Set ML_RETRAIN_EVERY_MS to
// change the interval, or ML_DISABLE_SCHEDULER=1 to turn it off.
if (process.env.ML_DISABLE_SCHEDULER !== '1') {
  const everyMs = Number(process.env.ML_RETRAIN_EVERY_MS ?? 6 * 60 * 60 * 1000)
  startRetrainScheduler(db, { everyMs: Number.isFinite(everyMs) ? everyMs : 6 * 60 * 60 * 1000 })
}
