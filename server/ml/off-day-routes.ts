import { Router } from 'express'
import { db } from '../db'
import { parseLocalDate } from '../checkins-store'
import { applyOffDayTaskMoves, restoreOffDayTaskMoves } from '../off-day-task-moves'
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
 * Marking a day off is one tap and the reason is optional. These routes write
 * `off_days` and shift open task due dates around that day (restoring them when
 * the day is cleared), but never touch sessions, per-day statuses or check-ins,
 * so marking or clearing an off day cannot change what the user actually did.
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
  const offDay = createOffDay(db, req.userId!, input)
  applyOffDayTaskMoves(db, req.userId!)
  res.status(201).json({ offDay: offDayDTO(offDay) })
})

router.patch('/:id', (req: AuthedRequest, res) => {
  const id = Number.parseInt(param(req, 'id'), 10)
  if (!Number.isInteger(id)) return badRequest(res, 'That off-day id is not valid.')
  if (!getOffDay(db, req.userId!, id)) return notFound(res, 'Off-day record not found.')
  const input = parseOffDayInput(req.body)
  if (!input) return badRequest(res, 'Provide a start date, an optional end date and an optional reason.')
  const offDay = updateOffDay(db, req.userId!, id, input)!
  restoreOffDayTaskMoves(db, req.userId!)
  applyOffDayTaskMoves(db, req.userId!)
  res.json({ offDay: offDayDTO(offDay) })
})

router.delete('/:id', (req: AuthedRequest, res) => {
  const id = Number.parseInt(param(req, 'id'), 10)
  if (!Number.isInteger(id)) return badRequest(res, 'That off-day id is not valid.')
  if (!deleteOffDay(db, req.userId!, id)) return notFound(res, 'Off-day record not found.')
  restoreOffDayTaskMoves(db, req.userId!)
  applyOffDayTaskMoves(db, req.userId!)
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
