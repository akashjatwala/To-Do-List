import { Router } from 'express'
import { db } from '../db'
import { parseLocalDate } from '../checkins-store'
import { badRequest, localDateString, notFound, param, type AuthedRequest } from '../http'
import {
  createOffDay,
  deleteOffDay,
  getOffDay,
  getPredictionSettings,
  listOffDays,
  offDayContext,
  parseOffDayInput,
  parsePredictionSettings,
  savePredictionSettings,
  updateOffDay,
  type OffDayRow,
} from './off-days'

/**
 * Off-day and prediction-settings routes.
 *
 * Marking a day off is one tap and the reason is optional. These routes only
 * ever write to `off_days` and the prediction fields of `user_settings` — never to sessions, the
 * per-day statuses or the check-ins — so marking or clearing an off day cannot
 * change what the user actually recorded.
 */
const router = Router()

function offDayDTO(row: OffDayRow) {
  return {
    id: row.id,
    kind: row.kind,
    startDate: row.start_date,
    endDate: row.end_date,
    note: row.note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

router.get('/', (req: AuthedRequest, res) => {
  res.json({ items: listOffDays(db, req.userId!).map(offDayDTO) })
})

/** The off-day state of one date, plus the reduced-confidence window context. */
router.get('/day', (req: AuthedRequest, res) => {
  const date = parseLocalDate(req.query.date) ?? localDateString()
  const settings = getPredictionSettings(db, req.userId!)
  const context = offDayContext(db, req.userId!, date, settings)
  res.json({
    date,
    offDay: context.offDay ? offDayDTO(context.offDay) : null,
    onOffDay: context.onOffDay,
    daysSinceOff: context.daysSinceOff,
    reducedConfidence: context.reducedConfidence,
  })
})

router.post('/', (req: AuthedRequest, res) => {
  const input = parseOffDayInput(req.body)
  if (!input) return badRequest(res, 'Provide a start date, an optional end date and an optional reason.')
  res.status(201).json({ offDay: offDayDTO(createOffDay(db, req.userId!, input)) })
})

router.patch('/:id', (req: AuthedRequest, res) => {
  const id = Number.parseInt(param(req, 'id'), 10)
  if (!Number.isInteger(id)) return badRequest(res, 'That off-day id is not valid.')
  if (!getOffDay(db, req.userId!, id)) return notFound(res, 'Off-day record not found.')
  const input = parseOffDayInput(req.body)
  if (!input) return badRequest(res, 'Provide a start date, an optional end date and an optional reason.')
  res.json({ offDay: offDayDTO(updateOffDay(db, req.userId!, id, input)!) })
})

router.delete('/:id', (req: AuthedRequest, res) => {
  const id = Number.parseInt(param(req, 'id'), 10)
  if (!Number.isInteger(id)) return badRequest(res, 'That off-day id is not valid.')
  if (!deleteOffDay(db, req.userId!, id)) return notFound(res, 'Off-day record not found.')
  res.json({ ok: true })
})

router.get('/settings', (req: AuthedRequest, res) => {
  res.json({ settings: getPredictionSettings(db, req.userId!) })
})

router.put('/settings', (req: AuthedRequest, res) => {
  const patch = parsePredictionSettings(req.body)
  if (!patch) return badRequest(res, 'Check the reduced-confidence days, exploration share and stage-2 threshold.')
  res.json({ settings: savePredictionSettings(db, req.userId!, patch) })
})

export default router
