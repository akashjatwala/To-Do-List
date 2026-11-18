import { Router } from 'express'
import { db } from '../db'
import { parseLocalDate } from '../checkins-store'
import { badRequest, localDateString, resolveDate, text, type AuthedRequest } from '../http'
import {
  dailyState,
  getStatePrefs,
  saveStatePrefs,
  type StatePrefs,
} from './state'
import {
  getDayReview,
  parseDayReviewAnswer,
  saveDayReview,
} from './day-review'

/**
 * Read-only daily-state routes.
 *
 * The GET endpoints only read. The PUT endpoints only ever write to the
 * state layer's own tables (`user_settings`, `day_reviews`,
 * `state_suggestion_choices`) — never to the check-in records.
 */
const router = Router()

router.get('/', (req: AuthedRequest, res) => {
  const date = resolveDate(req) ?? localDateString()
  const today = parseLocalDate(req.query.today) ?? localDateString()
  res.json(dailyState(db, req.userId!, date, today))
})

router.get('/prefs', (req: AuthedRequest, res) => {
  res.json(getStatePrefs(db, req.userId!))
})

router.put('/prefs', (req: AuthedRequest, res) => {
  const body = req.body as Record<string, unknown>
  const input: Partial<StatePrefs> = {}
  if (body.showSummary !== undefined) {
    if (typeof body.showSummary !== 'boolean') return badRequest(res, 'showSummary must be true or false.')
    input.showSummary = body.showSummary
  }
  if (body.showEstimates !== undefined) {
    if (typeof body.showEstimates !== 'boolean') return badRequest(res, 'showEstimates must be true or false.')
    input.showEstimates = body.showEstimates
  }
  res.json(saveStatePrefs(db, req.userId!, input))
})

router.get('/review', (req: AuthedRequest, res) => {
  const date = resolveDate(req) ?? localDateString()
  const row = getDayReview(db, req.userId!, date)
  res.json(row ? { date: row.local_date, answer: row.answer, createdAt: row.created_at, updatedAt: row.updated_at } : null)
})

router.put('/review', (req: AuthedRequest, res) => {
  const date = resolveDate(req)
  if (!date) return badRequest(res, 'Provide a valid date as YYYY-MM-DD.')
  const answer = parseDayReviewAnswer((req.body as Record<string, unknown>)?.answer)
  if (!answer) return badRequest(res, 'Choose one of the five review options.')
  const row = saveDayReview(db, req.userId!, date, answer)
  res.json({ date: row.local_date, answer: row.answer, createdAt: row.created_at, updatedAt: row.updated_at })
})

router.put('/suggestions', (req: AuthedRequest, res) => {
  const date = resolveDate(req)
  if (!date) return badRequest(res, 'Provide a valid date as YYYY-MM-DD.')
  const body = req.body as Record<string, unknown>
  const key = text(body?.key, 80)
  if (!key) return badRequest(res, 'A suggestion key is needed.')
  const choice = body?.choice
  if (choice !== 'accepted' && choice !== 'dismissed') {
    return badRequest(res, 'choice must be accepted or dismissed.')
  }
  db.prepare(
    `INSERT INTO state_suggestion_choices (user_id, local_date, suggestion_key, choice, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id, local_date, suggestion_key) DO UPDATE SET choice = excluded.choice`,
  ).run(req.userId!, date, key.slice(0, 80), choice, Date.now())
  res.json({ ok: true })
})

export default router
