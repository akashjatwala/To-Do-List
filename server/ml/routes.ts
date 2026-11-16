import { Router } from 'express'
import { db } from '../db'
import { parseLocalDate } from '../checkins-store'
import { badRequest, forbidden, notFound, param, text, type AuthedRequest } from '../http'
import { listTags, mergeTags, renameTag, resolveTagChain } from './tags'
import { configTagIds, listTaskConfigs, type TaskConfigRow } from './task-config'
import {
  createSession,
  deleteSession,
  existingRanges,
  listSessions,
  validateSession,
  type SessionRow,
} from './sessions'
import {
  clearDailyStatus,
  dailyActivity,
  setDailyStatus,
  type DailyActivity,
  type ExplicitStatus,
} from './daily-activity'
import {
  addContextQuestion,
  deleteContextQuestion,
  listContextQuestions,
  questionsForTask,
  suggestedQuestionsForTask,
  type QuestionKind,
} from './context-questions'

const TAG_NAME_MAX = 24
const REASON_MAX = 500
const PROMPT_MAX = 200
const KEY_MAX = 40
const EXPLICIT_STATUSES: ExplicitStatus[] = ['completed', 'partial', 'skipped', 'postponed']
const QUESTION_KINDS: QuestionKind[] = ['text', 'number', 'scale', 'boolean']

/** The user's local date on the server, used only when the client omits it. */
function serverToday(): string {
  const now = new Date()
  const month = `${now.getMonth() + 1}`.padStart(2, '0')
  const day = `${now.getDate()}`.padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

interface TaskAccess {
  id: string
  user_id: number
  team_id: string | null
}

/** A task the user may act on: their own personal task, or one of their teams'. */
function accessibleTask(taskId: string, userId: number): TaskAccess | null {
  const task = db.prepare('SELECT id, user_id, team_id FROM tasks WHERE id = ?').get(taskId) as unknown as
    | TaskAccess
    | undefined
  if (!task) return null
  if (task.team_id === null) return task.user_id === userId ? task : null
  const member = db
    .prepare('SELECT 1 FROM team_members WHERE team_id = ? AND user_id = ?')
    .get(task.team_id, userId)
  return member ? task : null
}

function sessionDTO(row: SessionRow) {
  return {
    id: row.id,
    taskId: row.task_id,
    date: row.local_date,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    durationMinutes: row.duration_minutes,
    note: row.note,
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function configDTO(row: TaskConfigRow) {
  return {
    id: row.id,
    taskId: row.task_id,
    version: row.version,
    effectiveFrom: row.effective_from,
    name: row.name,
    category: row.category,
    priority: row.priority,
    frequency: row.frequency,
    frequencyConfig: row.frequency_config,
    targetDuration: row.target_duration,
    preferredTime: row.preferred_time,
    active: row.active === 1,
    tagIds: configTagIds(db, row.id),
  }
}

// ---- Activity sessions and daily records ----

export const activityRoutes = Router()

activityRoutes.get('/sessions', (req: AuthedRequest, res) => {
  const userId = req.userId!
  const taskId = typeof req.query.taskId === 'string' ? req.query.taskId : undefined
  if (taskId && !accessibleTask(taskId, userId)) return notFound(res, 'Task not found.')
  const from = parseLocalDate(req.query.from) ?? undefined
  const to = parseLocalDate(req.query.to) ?? undefined
  const limit = Number.parseInt(String(req.query.limit ?? '200'), 10)
  res.json({
    items: listSessions(db, userId, {
      taskId,
      from,
      to,
      limit: Number.isFinite(limit) ? limit : 200,
    }).map(sessionDTO),
  })
})

activityRoutes.post('/sessions', (req: AuthedRequest, res) => {
  const userId = req.userId!
  const taskId = typeof req.body?.taskId === 'string' ? req.body.taskId : ''
  if (!accessibleTask(taskId, userId)) return notFound(res, 'Task not found.')

  const result = validateSession(req.body, {
    now: Date.now(),
    existing: existingRanges(db, taskId),
  })
  if (!result.ok) return badRequest(res, result.error)

  const row = createSession(db, userId, result.value)
  res.status(201).json({ session: sessionDTO(row) })
})

activityRoutes.delete('/sessions/:id', (req: AuthedRequest, res) => {
  const deleted = deleteSession(db, req.userId!, param(req, 'id'))
  if (!deleted) return notFound(res, 'Session not found.')
  res.json({ ok: true })
})

activityRoutes.get('/day', (req: AuthedRequest, res) => {
  const userId = req.userId!
  const taskId = typeof req.query.taskId === 'string' ? req.query.taskId : ''
  if (!accessibleTask(taskId, userId)) return notFound(res, 'Task not found.')
  const date = parseLocalDate(req.query.date)
  if (!date) return badRequest(res, 'Provide a valid local date as YYYY-MM-DD.')
  const today = parseLocalDate(req.query.today) ?? serverToday()
  res.json({ day: dailyActivity(db, userId, taskId, date, today) })
})

activityRoutes.get('/range', (req: AuthedRequest, res) => {
  const userId = req.userId!
  const taskId = typeof req.query.taskId === 'string' ? req.query.taskId : ''
  if (!accessibleTask(taskId, userId)) return notFound(res, 'Task not found.')
  const from = parseLocalDate(req.query.from)
  const to = parseLocalDate(req.query.to)
  if (!from || !to) return badRequest(res, 'Provide a valid from and to date as YYYY-MM-DD.')
  if (from > to) return badRequest(res, 'The from date must not be after the to date.')
  const today = parseLocalDate(req.query.today) ?? serverToday()

  const days: DailyActivity[] = []
  const cursor = new Date(`${from}T00:00:00`)
  const end = new Date(`${to}T00:00:00`)
  let guard = 0
  while (cursor <= end && guard < 400) {
    const month = `${cursor.getMonth() + 1}`.padStart(2, '0')
    const day = `${cursor.getDate()}`.padStart(2, '0')
    const date = `${cursor.getFullYear()}-${month}-${day}`
    days.push(dailyActivity(db, userId, taskId, date, today))
    cursor.setDate(cursor.getDate() + 1)
    guard += 1
  }
  res.json({ items: days })
})

activityRoutes.put('/day', (req: AuthedRequest, res) => {
  const userId = req.userId!
  const taskId = typeof req.body?.taskId === 'string' ? req.body.taskId : ''
  if (!accessibleTask(taskId, userId)) return notFound(res, 'Task not found.')
  const date = parseLocalDate(req.body?.date)
  if (!date) return badRequest(res, 'Provide a valid local date as YYYY-MM-DD.')
  const status = req.body?.status
  if (typeof status !== 'string' || !(EXPLICIT_STATUSES as string[]).includes(status)) {
    return badRequest(res, 'Choose completed, partial, skipped or postponed.')
  }
  let reason: string | null = null
  if (req.body?.reason !== undefined && req.body.reason !== null) {
    const parsed = text(req.body.reason, REASON_MAX)
    if (!parsed) return badRequest(res, `Keep the reason under ${REASON_MAX} characters.`)
    reason = parsed
  }
  setDailyStatus(db, userId, taskId, date, status as ExplicitStatus, reason)
  const today = parseLocalDate(req.body?.today) ?? serverToday()
  res.json({ day: dailyActivity(db, userId, taskId, date, today) })
})

activityRoutes.delete('/day', (req: AuthedRequest, res) => {
  const userId = req.userId!
  const taskId = typeof req.query.taskId === 'string' ? req.query.taskId : ''
  if (!accessibleTask(taskId, userId)) return notFound(res, 'Task not found.')
  const date = parseLocalDate(req.query.date)
  if (!date) return badRequest(res, 'Provide a valid local date as YYYY-MM-DD.')
  clearDailyStatus(db, userId, taskId, date)
  const today = parseLocalDate(req.query.today) ?? serverToday()
  res.json({ day: dailyActivity(db, userId, taskId, date, today) })
})

// ---- Tags ----

export const tagRoutes = Router()

tagRoutes.get('/', (req: AuthedRequest, res) => {
  res.json({ items: listTags(db, req.userId!) })
})

tagRoutes.patch('/:id', (req: AuthedRequest, res) => {
  const id = Number.parseInt(param(req, 'id'), 10)
  if (!Number.isInteger(id)) return badRequest(res, 'That tag id is not valid.')
  const name = text(req.body?.name, TAG_NAME_MAX)
  if (!name) return badRequest(res, `Tag names must be 1–${TAG_NAME_MAX} characters.`)
  const tag = renameTag(db, req.userId!, id, name)
  if (!tag) return notFound(res, 'Tag not found.')
  res.json({ tag: { id: tag.id, name: tag.name } })
})

tagRoutes.post('/merge', (req: AuthedRequest, res) => {
  const userId = req.userId!
  const sourceId = Number.parseInt(String(req.body?.sourceId), 10)
  const targetId = Number.parseInt(String(req.body?.targetId), 10)
  if (!Number.isInteger(sourceId) || !Number.isInteger(targetId)) {
    return badRequest(res, 'Provide two tag ids to merge.')
  }
  const tag = mergeTags(db, userId, sourceId, targetId)
  if (!tag) return forbidden(res, 'Those tags cannot be merged.')
  res.json({ tag: { id: tag.id, name: tag.name } })
})

/** Resolve a possibly-merged tag id to the tag that is still active. */
tagRoutes.get('/:id', (req: AuthedRequest, res) => {
  const id = Number.parseInt(param(req, 'id'), 10)
  if (!Number.isInteger(id)) return badRequest(res, 'That tag id is not valid.')
  const tag = resolveTagChain(db, id)
  if (!tag || tag.user_id !== req.userId!) return notFound(res, 'Tag not found.')
  res.json({ tag: { id: tag.id, name: tag.name } })
})

// ---- Task configuration history ----

export const taskConfigRoutes = Router()

taskConfigRoutes.get('/:taskId', (req: AuthedRequest, res) => {
  const taskId = param(req, 'taskId')
  if (!accessibleTask(taskId, req.userId!)) return notFound(res, 'Task not found.')
  res.json({ items: listTaskConfigs(db, taskId).map(configDTO) })
})

// ---- Context questions ----

export const contextQuestionRoutes = Router()

contextQuestionRoutes.get('/', (req: AuthedRequest, res) => {
  const userId = req.userId!
  const taskId = typeof req.query.taskId === 'string' ? req.query.taskId : ''
  if (!accessibleTask(taskId, userId)) return notFound(res, 'Task not found.')
  res.json({
    items: listContextQuestions(db, userId, taskId),
    suggested: suggestedQuestionsForTask(db, userId, taskId),
    effective: questionsForTask(db, userId, taskId),
  })
})

contextQuestionRoutes.post('/', (req: AuthedRequest, res) => {
  const userId = req.userId!
  const taskId = typeof req.body?.taskId === 'string' ? req.body.taskId : null
  if (taskId && !accessibleTask(taskId, userId)) return notFound(res, 'Task not found.')
  const tagId =
    req.body?.tagId === undefined || req.body.tagId === null ? null : Number.parseInt(String(req.body.tagId), 10)
  if (tagId !== null && !Number.isInteger(tagId)) return badRequest(res, 'That tag id is not valid.')
  if (!taskId && tagId === null) return badRequest(res, 'Attach the question to a task or a tag.')

  const key = text(req.body?.key, KEY_MAX)
  if (!key) return badRequest(res, `Give the question a key of 1–${KEY_MAX} characters.`)
  const prompt = text(req.body?.prompt, PROMPT_MAX)
  if (!prompt) return badRequest(res, `The question must be 1–${PROMPT_MAX} characters.`)
  const kind = req.body?.kind
  if (typeof kind !== 'string' || !(QUESTION_KINDS as string[]).includes(kind)) {
    return badRequest(res, 'Choose a question type.')
  }
  let options: string[] | null = null
  if (req.body?.options !== undefined && req.body.options !== null) {
    if (!Array.isArray(req.body.options) || req.body.options.some((item: unknown) => typeof item !== 'string')) {
      return badRequest(res, 'Options must be a list of labels.')
    }
    options = req.body.options as string[]
  }

  const question = addContextQuestion(db, userId, {
    taskId,
    tagId,
    key,
    prompt,
    kind: kind as QuestionKind,
    options,
  })
  res.status(201).json({ question })
})

contextQuestionRoutes.delete('/:id', (req: AuthedRequest, res) => {
  const deleted = deleteContextQuestion(db, req.userId!, param(req, 'id'))
  if (!deleted) return notFound(res, 'Question not found.')
  res.json({ ok: true })
})
