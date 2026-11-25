import { Router } from 'express'
import { db } from '../db'
import { parseLocalDate } from '../checkins-store'
import { badRequest, localDateString, type AuthedRequest } from '../http'
import { modelHealthView } from './health'
import { refreshHealth, retrainStatus, maybeRetrain, lastRetrainAt } from './learning'
import { driftSummary } from './drift'

/**
 * Learning health, drift and retraining routes.
 *
 * These are read-mostly, informational endpoints. `GET /health` re-evaluates the
 * live model health and returns a plain-words view — it never nags and never
 * hides a number it does not have. `POST /retrain` is the explicit, rate-limited
 * retrain (the same gate the scheduler uses). Nothing here records a prediction
 * as an outcome.
 */
const router = Router()

/** Which model is active, when it last trained and whether the baseline is used. */
router.get('/health', (req: AuthedRequest, res) => {
  const userId = req.userId!
  refreshHealth(db, userId)
  res.json({
    health: modelHealthView(db, userId),
    retrain: retrainStatus(db, userId),
    lastRetrainAt: lastRetrainAt(db, userId),
  })
})

/** Recent-vs-long-term drift and dated configuration changes, in plain words. */
router.get('/drift', (req: AuthedRequest, res) => {
  const userId = req.userId!
  const today = parseLocalDate(req.query.today) ?? localDateString()
  const sinceDate = parseLocalDate(req.query.since) ?? undefined
  res.json({ drift: driftSummary(db, userId, today, { sinceDate }) })
})

/** Explicitly retrain now (rate-limited unless `force` is set). */
router.post('/retrain', (req: AuthedRequest, res) => {
  const force = (req.body as Record<string, unknown> | undefined)?.force === true
  const outcome = maybeRetrain(db, req.userId!, { force })
  if (!outcome.ran && !outcome.reason) return badRequest(res, 'The retrain could not be started.')
  res.json({ outcome })
})

export default router
