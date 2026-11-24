import { Router } from 'express'
import type { DatabaseSync } from 'node:sqlite'
import { db } from '../db'
import { answeredValues, checkinState, getCheckin, parseLocalDate } from '../checkins-store'
import { badRequest, localDateString, notFound, resolveDate, type AuthedRequest } from '../http'
import { buildPlan, isPersonalTask, taskContext } from './predictors'
import { livePredictor } from './live-predictor'
import { addDays, getPredictionSettings, offDayContext } from './off-days'
import { buildDaySchedule } from './day-planner'
import { rescheduleSuggestions } from './reschedule'
import {
  listFeedback,
  listPredictions,
  logPlanPredictions,
  logTaskPrediction,
  parseFeedback,
  recordFeedback,
} from './predictions'
import { activityStatistics, groupStatistics, userCompletionPrior, userTaskIds } from './statistics'
import { driftForTask } from './drift'

/**
 * Prediction interface routes.
 *
 * Predictions are produced and logged **by the server**, never by the client,
 * and never written back as an outcome. They are strictly for personal tasks:
 * team tasks are never predicted, nor used as training/history input. The plan
 * is available immediately for the selected date — an unanswered check-in is
 * simply one missing input, not a barrier. An off day returns an explicit
 * "off day" answer with no predictions.
 */
const router = Router()

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

  // No check-in gate: today's tasks get a prediction straight away. An
  // unanswered check-in is handled by the predictor as missing context.
  const plan = buildPlan(db, userId, date, today, nowMinutesFor(date, today), state, {
    predict: livePredictor,
  })
  if (!plan.offDay) logPlanPredictions(db, userId, plan)
  const driftNotes = plan.offDay ? [] : driftNotesForPlan(db, userId, plan, date)
  res.json({
    gate: false,
    checkinState: state,
    offDay: plan.offDay,
    plan,
    schedule: buildDaySchedule(db, userId, plan, {
      date,
      today,
      nowMinutes: nowMinutesFor(date, today),
      answers: row && row.skipped === 0 ? answeredValues(row) : null,
    }),
    reschedules: plan.offDay
      ? { available: false, reason: 'Off days have no reschedule ideas.', suggestions: [] }
      : rescheduleSuggestions(db, userId, { date, today }),
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
): string[] {
  const priorRate = userCompletionPrior(db, userId, userTaskIds(db, userId), addDays(date, -1))
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
  if (!isPersonalTask(db, userId, taskId)) return notFound(res, 'Predictions are only available for your personal tasks.')
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
  // An unanswered check-in is one missing input, not a gate: still return a value.

  const taskIds = userTaskIds(db, userId)
  // Match /plan: no history from the day being predicted may enter the features.
  const historyEnd = addDays(date, -1)
  const priorRate = userCompletionPrior(db, userId, taskIds, historyEnd)
  const tagStats = groupStatistics(db, userId, taskIds, historyEnd, priorRate, 'tag', { to: historyEnd })
  const priorityStats = groupStatistics(db, userId, taskIds, historyEnd, priorRate, 'priority', { to: historyEnd })
  const prediction = livePredictor(
    db,
    userId,
    taskId,
    {
      date,
      today,
      nowMinutes: nowMinutesFor(date, today),
      checkinState: state,
      answers: row && row.skipped === 0 ? answeredValues(row) : null,
      settings,
      priorRate,
      tagStats,
      priorityStats,
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
  if (!isPersonalTask(db, userId, taskId)) return notFound(res, 'Predictions are only available for your personal tasks.')
  const today = parseLocalDate(req.query.today) ?? localDateString()
  const settings = getPredictionSettings(db, userId)
  const priorRate = userCompletionPrior(db, userId, userTaskIds(db, userId), today)
  res.json({
    statistics: activityStatistics(db, userId, taskId, today, priorRate, { stage2MinDays: settings.stage2MinDays }),
    drift: driftForTask(db, userId, taskId, today, priorRate),
  })
})

export default router
