import { Router } from 'express'
import type { DatabaseSync } from 'node:sqlite'
import { db } from '../db'
import { checkinState, getCheckin, parseLocalDate } from '../checkins-store'
import { badRequest, notFound, type AuthedRequest } from '../http'
import { buildPlan, predictTask, taskContext } from './predictors'
import { getPredictionSettings, offDayContext } from './off-days'
import {
  listFeedback,
  listPredictions,
  logPlanPredictions,
  logTaskPrediction,
  parseFeedback,
  recordFeedback,
} from './predictions'
import { activityStatistics, userCompletionPrior, userTaskIds } from './statistics'
import { driftForTask } from './drift'

/**
 * Prediction interface routes (Phase 4, §4).
 *
 * Predictions are produced and logged **by the server**, never by the client,
 * and never written back as an outcome. The plan endpoint is gated on today's
 * check-in: until it is completed or skipped the client is told to show the
 * Phase 1 check-in first. An off day returns an explicit "off day" answer with
 * no predictions.
 */
const router = Router()

function localDateString(date = new Date()): string {
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

function resolveDate(req: AuthedRequest, field = 'date'): string | null {
  const value = req.method === 'GET' ? req.query[field] : (req.body as Record<string, unknown>)?.[field]
  if (value === undefined || value === null || value === '') return null
  return parseLocalDate(value)
}

/** Local minute-of-day, or 0 for a past date. */
function nowMinutesFor(date: string, today: string): number {
  if (date !== today) return 0
  const now = new Date()
  return now.getHours() * 60 + now.getMinutes()
}

router.get('/plan', (req: AuthedRequest, res) => {
  const userId = req.userId!
  const date = resolveDate(req) ?? localDateString()
  const today = parseLocalDate(req.query.today) ?? localDateString()
  const row = getCheckin(db, userId, date)
  const state = row ? checkinState(row) : 'not_asked'

  // Gate: the day's context must be captured before predictions are shown.
  if (state !== 'completed' && state !== 'skipped') {
    res.json({ gate: true, checkinState: state, offDay: false, plan: null, predictions: [] })
    return
  }

  const plan = buildPlan(db, userId, date, today, nowMinutesFor(date, today), state)
  if (!plan.offDay) logPlanPredictions(db, userId, plan)
  const driftNotes = plan.offDay ? [] : driftNotesForPlan(db, userId, plan, date, today)
  res.json({
    gate: false,
    checkinState: state,
    offDay: plan.offDay,
    plan,
    predictions: plan.offDay ? [] : listPredictions(db, userId, date),
    driftNotes,
  })
})

/**
 * Additive, plain-language drift notes for today's open tasks: a recent-vs-
 * long-term shift or a dated configuration change. Informational only — they
 * never change a prediction.
 */
function driftNotesForPlan(
  db: DatabaseSync,
  userId: number,
  plan: { entries: Array<{ taskId: string; text: string }> },
  date: string,
  today: string,
): string[] {
  const priorRate = userCompletionPrior(db, userId, userTaskIds(db, userId), today)
  const notes: string[] = []
  for (const entry of plan.entries) {
    const drift = driftForTask(db, userId, entry.taskId, date, priorRate)
    if (drift.rate.judged && drift.rate.direction !== 'steady') notes.push(`${entry.text}: ${drift.rate.note}`)
    for (const change of drift.configChanges) notes.push(`${entry.text}: ${change.summary}`)
  }
  return notes
}

router.get('/task', (req: AuthedRequest, res) => {
  const userId = req.userId!
  const taskId = typeof req.query.taskId === 'string' ? req.query.taskId : ''
  if (!taskId) return badRequest(res, 'A task is needed.')
  const task = taskContext(db, taskId, resolveDate(req) ?? localDateString())
  if (!task) return notFound(res, 'Task not found.')
  const date = resolveDate(req) ?? localDateString()
  const today = parseLocalDate(req.query.today) ?? localDateString()
  const row = getCheckin(db, userId, date)
  const state = row ? checkinState(row) : 'not_asked'
  const settings = getPredictionSettings(db, userId)

  const off = offDayContext(db, userId, date, settings)
  if (off.onOffDay) {
    res.json({ gate: false, checkinState: state, offDay: true, prediction: null })
    return
  }
  if (state !== 'completed' && state !== 'skipped') {
    res.json({ gate: true, checkinState: state, offDay: false, prediction: null })
    return
  }

  const taskIds = userTaskIds(db, userId)
  const priorRate = userCompletionPrior(db, userId, taskIds, today)
  const prediction = predictTask(
    db,
    userId,
    taskId,
    {
      date,
      today,
      nowMinutes: nowMinutesFor(date, today),
      checkinState: state,
      answers: row && row.skipped === 0 ? answersOf(row) : null,
      settings,
      priorRate,
    },
  )
  if (!prediction) return notFound(res, 'No prediction is available for this task.')
  logTaskPrediction(db, userId, prediction, state)
  res.json({ gate: false, checkinState: state, offDay: false, prediction })
})

router.get('/history', (req: AuthedRequest, res) => {
  const date = resolveDate(req) ?? localDateString()
  res.json({ items: listPredictions(db, req.userId!, date), feedback: listFeedback(db, req.userId!, date) })
})

router.post('/feedback', (req: AuthedRequest, res) => {
  const date = resolveDate(req)
  if (!date) return badRequest(res, 'Provide a valid date as YYYY-MM-DD.')
  const parsed = parseFeedback(req.body)
  if (!parsed) return badRequest(res, 'Check the task, kind and feedback flags.')
  recordFeedback(db, req.userId!, { date, ...parsed })
  res.json({ ok: true })
})

/** Statistics for one activity — the numbers behind its prediction. */
router.get('/statistics', (req: AuthedRequest, res) => {
  const userId = req.userId!
  const taskId = typeof req.query.taskId === 'string' ? req.query.taskId : ''
  if (!taskId) return badRequest(res, 'A task is needed.')
  const today = parseLocalDate(req.query.today) ?? localDateString()
  const settings = getPredictionSettings(db, userId)
  const priorRate = userCompletionPrior(db, userId, userTaskIds(db, userId), today)
  res.json({
    statistics: activityStatistics(db, userId, taskId, today, priorRate, { stage2MinDays: settings.stage2MinDays }),
    drift: driftForTask(db, userId, taskId, today, priorRate),
  })
})

function answersOf(row: NonNullable<ReturnType<typeof getCheckin>>) {
  const out: Record<string, number> = {}
  for (const key of [
    'feeling',
    'energy',
    'motivation',
    'sleep',
    'stress',
    'free_time',
    'focus',
    'body',
    'workload',
  ] as const) {
    const value = row[key]
    if (value !== null) out[key] = value
  }
  return out
}

export default router
