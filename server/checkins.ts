import { Router } from 'express'
import { db } from './db'
import {
  CHECKIN_ANSWER_KEYS,
  checkinState,
  getCheckin,
  listCheckins,
  parseAnswer,
  parseContext,
  parseLocalDate,
  saveCheckin,
  skipCheckin,
  type CheckinAnswerKey,
  type CheckinRow,
} from './checkins-store'
import { badRequest, type AuthedRequest } from './http'

const router = Router()

function toDTO(row: CheckinRow) {
  const answers = {} as Record<CheckinAnswerKey, number | null>
  for (const key of CHECKIN_ANSWER_KEYS) answers[key] = row[key]
  return {
    id: row.id,
    date: row.date,
    answers,
    skipped: row.skipped === 1,
    context: row.context,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function statusFor(row: CheckinRow | undefined, date: string) {
  return {
    date,
    state: row ? checkinState(row) : ('not_asked' as const),
    checkin: row ? toDTO(row) : null,
  }
}

/** State and stored answers for one local day, used on app start and for edits. */
router.get('/', (req: AuthedRequest, res) => {
  const date = parseLocalDate(req.query.date)
  if (!date) return badRequest(res, 'Provide a valid local date as YYYY-MM-DD.')
  const row = getCheckin(db, req.userId!, date)
  res.json(statusFor(row, date))
})

/** Recent days for the "view your history" screen. */
router.get('/history', (req: AuthedRequest, res) => {
  const requested = Number.parseInt(String(req.query.limit ?? '30'), 10)
  const limit = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), 365) : 30
  res.json({ items: listCheckins(db, req.userId!, limit).map(toDTO) })
})

/** Save (or update) the answers for a day. */
router.put('/', (req: AuthedRequest, res) => {
  const date = parseLocalDate(req.body?.date)
  if (!date) return badRequest(res, 'Provide a valid local date as YYYY-MM-DD.')

  const rawAnswers = req.body?.answers
  if (
    rawAnswers !== undefined &&
    (typeof rawAnswers !== 'object' || rawAnswers === null || Array.isArray(rawAnswers))
  ) {
    return badRequest(res, 'Answers must be an object.')
  }

  const answers = {} as Record<CheckinAnswerKey, number | null>
  for (const key of CHECKIN_ANSWER_KEYS) {
    const parsed = parseAnswer((rawAnswers as Record<string, unknown> | undefined)?.[key])
    if (parsed === undefined) {
      return badRequest(res, `The answer for “${key}” must be a whole number from 1 to 5.`)
    }
    answers[key] = parsed
  }

  const context = parseContext(req.body?.context)
  if (context === undefined) return badRequest(res, 'That context note is too long.')

  const row = saveCheckin(db, req.userId!, { date, answers, context })
  res.json(statusFor(row, date))
})

/** Dismiss the whole check-in for a day. */
router.post('/skip', (req: AuthedRequest, res) => {
  const date = parseLocalDate(req.body?.date)
  if (!date) return badRequest(res, 'Provide a valid local date as YYYY-MM-DD.')
  const row = skipCheckin(db, req.userId!, date)
  res.json(statusFor(row, date))
})

export default router
