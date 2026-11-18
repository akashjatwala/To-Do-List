import { Router } from 'express'
import { db } from '../db'
import { parseLocalDate } from '../checkins-store'
import { badRequest, type AuthedRequest } from '../http'
import { modelHealthView } from './health'
import { refreshHealth, retrainStatus, maybeRetrain, lastRetrainAt } from './learning'
import { driftSummary } from './drift'
import { deleteCheckinHistory, privacySummary } from './privacy'

/**
 * Learning health, drift and privacy routes (Phase 6, §2/§3/§4).
 *
 * These are read-mostly, informational endpoints. `GET /health` re-evaluates the
 * live model health and returns a plain-words view — it never nags and never
 * hides a number it does not have. `POST /retrain` is the explicit, rate-limited
 * retrain (the same gate the scheduler uses). The privacy routes state what is
 * kept and let the user delete their check-in history. Nothing here records a
 * prediction as an outcome.
 */
const router = Router()

function localDateString(date = new Date()): string {
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

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

/** What is kept, what is optional, and how to delete it. */
router.get('/privacy', (req: AuthedRequest, res) => {
  res.json({ privacy: privacySummary(db, req.userId!) })
})

/** Delete every check-in and its edit trail. Recorded activity is kept. */
router.delete('/privacy/checkins', (req: AuthedRequest, res) => {
  const result = deleteCheckinHistory(db, req.userId!)
  res.json({ ok: true, deleted: result })
})

/** Explicitly retrain now (rate-limited unless `force` is set). */
router.post('/retrain', (req: AuthedRequest, res) => {
  const force = (req.body as Record<string, unknown> | undefined)?.force === true
  const outcome = maybeRetrain(db, req.userId!, { force })
  if (!outcome.ran && !outcome.reason) return badRequest(res, 'The retrain could not be started.')
  res.json({ outcome })
})

export default router
