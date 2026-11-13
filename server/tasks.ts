import { randomUUID } from 'node:crypto'
import { Router } from 'express'
import { db, type SubtaskRow, type TaskRow } from './db'
import {
  badRequest,
  forbidden,
  notFound,
  optionalTimestamp,
  param,
  text,
  type AuthedRequest,
} from './http'

const router = Router()

const TASK_MAX = 500
const COMMENT_MAX = 2000
const SUBTASK_MAX = 200
const TAG_MAX = 24
const TAGS_MAX = 8

const PRIORITIES = ['none', 'low', 'medium', 'high', 'urgent'] as const
const RECURRENCES = ['none', 'daily', 'weekly', 'monthly'] as const
type Priority = (typeof PRIORITIES)[number]
type Recurrence = (typeof RECURRENCES)[number]

/** Priority is optional on create; anything unrecognised is rejected. */
function parsePriority(value: unknown): Priority | null {
  if (value === undefined) return 'none'
  return typeof value === 'string' && (PRIORITIES as readonly string[]).includes(value)
    ? (value as Priority)
    : null
}

function parseRecurrence(value: unknown): Recurrence | null {
  if (value === undefined) return 'none'
  return typeof value === 'string' && (RECURRENCES as readonly string[]).includes(value)
    ? (value as Recurrence)
    : null
}

/** Tags are a deduped list of short labels. */
function parseTags(value: unknown): string[] | null {
  if (value === undefined) return []
  if (!Array.isArray(value)) return null
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') return null
    const tag = item.trim().replace(/\s+/g, ' ')
    if (!tag) continue
    if (tag.length > TAG_MAX) return null
    if (!out.includes(tag)) out.push(tag)
  }
  if (out.length > TAGS_MAX) return null
  return out
}

/** Move a due date forward by one recurrence interval, keeping the time of day. */
function advanceDue(due: number, recurrence: Recurrence): number {
  const date = new Date(due)
  if (recurrence === 'daily') {
    date.setDate(date.getDate() + 1)
  } else if (recurrence === 'weekly') {
    date.setDate(date.getDate() + 7)
  } else if (recurrence === 'monthly') {
    const day = date.getDate()
    date.setDate(1)
    date.setMonth(date.getMonth() + 1)
    const lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate()
    date.setDate(Math.min(day, lastDay))
  }
  return date.getTime()
}

/**
 * Completing a recurring task creates the next occurrence: a fresh copy with
 * the due date moved forward, subtasks reset, and no comments carried over.
 */
function spawnNextOccurrence(task: TaskRow): string {
  const id = randomUUID()
  const now = Date.now()
  const nextDue = advanceDue(task.due ?? now, task.recurrence as Recurrence)
  db.prepare(
    `INSERT INTO tasks (id, user_id, team_id, text, done, created_at, due, position, progress, priority, tags, recurrence)
     VALUES (?, ?, ?, ?, 0, ?, ?, ?, 0, ?, ?, ?)`,
  ).run(
    id,
    task.user_id,
    task.team_id,
    task.text,
    now,
    nextDue,
    now,
    task.priority,
    task.tags,
    task.recurrence,
  )

  const subtasks = db
    .prepare('SELECT * FROM subtasks WHERE task_id = ? ORDER BY position ASC, rowid ASC')
    .all(task.id) as unknown as SubtaskRow[]
  const insert = db.prepare(
    'INSERT INTO subtasks (id, task_id, text, done, position) VALUES (?, ?, ?, 0, ?)',
  )
  for (const subtask of subtasks) insert.run(randomUUID(), id, subtask.text, subtask.position)

  return id
}

interface MemberRow {
  role: 'host' | 'member'
}

interface LoadedTask {
  task: TaskRow
  host: boolean
}

/** Load a task only if the user may see it (owner of a personal task, or a team member). */
function loadTask(taskId: string, userId: number): LoadedTask | null {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as unknown as
    | TaskRow
    | undefined
  if (!task) return null
  if (task.team_id === null) {
    return task.user_id === userId ? { task, host: false } : null
  }
  const member = db
    .prepare('SELECT role FROM team_members WHERE team_id = ? AND user_id = ?')
    .get(task.team_id, userId) as unknown as MemberRow | undefined
  if (!member) return null
  return { task, host: member.role === 'host' }
}

function canDelete(loaded: LoadedTask, userId: number): boolean {
  return loaded.host || loaded.task.user_id === userId
}

function loadSubtask(taskId: string, subtaskId: string): SubtaskRow | undefined {
  return db
    .prepare('SELECT * FROM subtasks WHERE id = ? AND task_id = ?')
    .get(subtaskId, taskId) as unknown as SubtaskRow | undefined
}

router.post('/', (req: AuthedRequest, res) => {
  const userId = req.userId!
  const title = text(req.body?.text, TASK_MAX)
  if (!title) return badRequest(res, `Task text must be 1–${TASK_MAX} characters.`)

  const teamId = typeof req.body?.teamId === 'string' ? req.body.teamId : null
  if (teamId) {
    const member = db
      .prepare('SELECT 1 FROM team_members WHERE team_id = ? AND user_id = ?')
      .get(teamId, userId)
    if (!member) return forbidden(res, 'You are not a member of that team.')
  }

  const due = optionalTimestamp(req.body?.due)
  if (due === undefined) return badRequest(res, 'That due date is not valid.')

  const priority = parsePriority(req.body?.priority)
  if (priority === null) return badRequest(res, 'That priority is not valid.')
  const recurrence = parseRecurrence(req.body?.recurrence)
  if (recurrence === null) return badRequest(res, 'That repeat option is not valid.')
  const tags = parseTags(req.body?.tags)
  if (tags === null) return badRequest(res, 'Those tags are not valid.')

  const id = randomUUID()
  const now = Date.now()
  db.prepare(
    `INSERT INTO tasks (id, user_id, team_id, text, done, created_at, due, position, priority, tags, recurrence)
     VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
  ).run(id, userId, teamId, title, now, due ?? null, now, priority, JSON.stringify(tags), recurrence)

  res.status(201).json({ id })
})

router.patch('/:taskId', (req: AuthedRequest, res) => {
  const userId = req.userId!
  const loaded = loadTask(param(req, 'taskId'), userId)
  if (!loaded) return notFound(res, 'Task not found.')

  const updates: string[] = []
  const values: Array<string | number | null> = []
  let completing = false

  if (req.body?.text !== undefined) {
    const title = text(req.body.text, TASK_MAX)
    if (!title) return badRequest(res, `Task text must be 1–${TASK_MAX} characters.`)
    updates.push('text = ?')
    values.push(title)
  }

  if (req.body?.progress !== undefined) {
    const progress = req.body.progress
    if (
      typeof progress !== 'number' ||
      !Number.isInteger(progress) ||
      progress < 0 ||
      progress > 100
    ) {
      return badRequest(res, 'Progress must be a whole number between 0 and 100.')
    }
    // Progress drives completion, so 100% means done and anything less means open.
    completing = progress === 100
    updates.push('progress = ?', 'done = ?')
    values.push(progress, progress === 100 ? 1 : 0)
  } else if (req.body?.done !== undefined) {
    if (typeof req.body.done !== 'boolean') return badRequest(res, '“done” must be true or false.')
    completing = req.body.done
    updates.push('done = ?')
    values.push(req.body.done ? 1 : 0)
    if (req.body.done) {
      updates.push('progress = ?')
      values.push(100)
    } else if (loaded.task.progress === 100) {
      updates.push('progress = ?')
      values.push(0)
    }
  }

  if (req.body?.due !== undefined) {
    const due = optionalTimestamp(req.body.due)
    if (due === undefined) return badRequest(res, 'That due date is not valid.')
    updates.push('due = ?')
    values.push(due)
  }

  if (req.body?.position !== undefined) {
    if (typeof req.body.position !== 'number' || !Number.isFinite(req.body.position)) {
      return badRequest(res, 'Invalid position.')
    }
    updates.push('position = ?')
    values.push(req.body.position)
  }

  if (req.body?.priority !== undefined) {
    const priority = parsePriority(req.body.priority)
    if (priority === null) return badRequest(res, 'That priority is not valid.')
    updates.push('priority = ?')
    values.push(priority)
  }

  if (req.body?.recurrence !== undefined) {
    const recurrence = parseRecurrence(req.body.recurrence)
    if (recurrence === null) return badRequest(res, 'That repeat option is not valid.')
    updates.push('recurrence = ?')
    values.push(recurrence)
  }

  if (req.body?.tags !== undefined) {
    const tags = parseTags(req.body.tags)
    if (tags === null) return badRequest(res, 'Those tags are not valid.')
    updates.push('tags = ?')
    values.push(JSON.stringify(tags))
  }

  if (updates.length === 0) return badRequest(res, 'Nothing to update.')
  values.push(loaded.task.id)
  db.prepare(`UPDATE tasks SET ${updates.join(', ')} WHERE id = ?`).run(...values)

  // Completing a recurring task rolls it forward to the next occurrence. The
  // finished instance stops repeating so it never spawns twice.
  let spawnedId: string | null = null
  if (completing && loaded.task.done === 0 && loaded.task.recurrence !== 'none') {
    spawnedId = spawnNextOccurrence(loaded.task)
    db.prepare("UPDATE tasks SET recurrence = 'none' WHERE id = ?").run(loaded.task.id)
  }

  res.json({ ok: true, spawnedId })
})

router.delete('/:taskId', (req: AuthedRequest, res) => {
  const userId = req.userId!
  const loaded = loadTask(param(req, 'taskId'), userId)
  if (!loaded) return notFound(res, 'Task not found.')
  if (!canDelete(loaded, userId)) {
    return forbidden(res, 'Only the person who added this task or the team host can delete it.')
  }
  db.prepare('DELETE FROM tasks WHERE id = ?').run(loaded.task.id)
  res.json({ ok: true })
})

// ---- Subtasks ----

router.post('/:taskId/subtasks', (req: AuthedRequest, res) => {
  const loaded = loadTask(param(req, 'taskId'), req.userId!)
  if (!loaded) return notFound(res, 'Task not found.')

  const label = text(req.body?.text, SUBTASK_MAX)
  if (!label) return badRequest(res, `Subtask text must be 1–${SUBTASK_MAX} characters.`)

  const id = randomUUID()
  const max = db
    .prepare('SELECT COALESCE(MAX(position), 0) AS p FROM subtasks WHERE task_id = ?')
    .get(loaded.task.id) as unknown as { p: number }
  db.prepare(
    'INSERT INTO subtasks (id, task_id, text, done, position) VALUES (?, ?, ?, 0, ?)',
  ).run(id, loaded.task.id, label, max.p + 1)

  res.status(201).json({ id })
})

router.patch('/:taskId/subtasks/:subtaskId', (req: AuthedRequest, res) => {
  const loaded = loadTask(param(req, 'taskId'), req.userId!)
  if (!loaded) return notFound(res, 'Task not found.')
  const subtask = loadSubtask(loaded.task.id, param(req, 'subtaskId'))
  if (!subtask) return notFound(res, 'Subtask not found.')

  const updates: string[] = []
  const values: Array<string | number> = []

  if (req.body?.text !== undefined) {
    const label = text(req.body.text, SUBTASK_MAX)
    if (!label) return badRequest(res, `Subtask text must be 1–${SUBTASK_MAX} characters.`)
    updates.push('text = ?')
    values.push(label)
  }
  if (req.body?.done !== undefined) {
    if (typeof req.body.done !== 'boolean') return badRequest(res, '“done” must be true or false.')
    updates.push('done = ?')
    values.push(req.body.done ? 1 : 0)
  }

  if (updates.length === 0) return badRequest(res, 'Nothing to update.')
  values.push(subtask.id)
  db.prepare(`UPDATE subtasks SET ${updates.join(', ')} WHERE id = ?`).run(...values)
  res.json({ ok: true })
})

router.delete('/:taskId/subtasks/:subtaskId', (req: AuthedRequest, res) => {
  const loaded = loadTask(param(req, 'taskId'), req.userId!)
  if (!loaded) return notFound(res, 'Task not found.')
  const subtask = loadSubtask(loaded.task.id, param(req, 'subtaskId'))
  if (!subtask) return notFound(res, 'Subtask not found.')
  db.prepare('DELETE FROM subtasks WHERE id = ?').run(subtask.id)
  res.json({ ok: true })
})

// ---- Comments ----

router.post('/:taskId/comments', (req: AuthedRequest, res) => {
  const userId = req.userId!
  const loaded = loadTask(param(req, 'taskId'), userId)
  if (!loaded) return notFound(res, 'Task not found.')

  const body = text(req.body?.text, COMMENT_MAX)
  if (!body) return badRequest(res, `Comments must be 1–${COMMENT_MAX} characters.`)

  db.prepare(
    'INSERT INTO comments (id, task_id, user_id, text, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(randomUUID(), loaded.task.id, userId, body, Date.now())
  res.status(201).json({ ok: true })
})

router.delete('/:taskId/comments/:commentId', (req: AuthedRequest, res) => {
  const userId = req.userId!
  const loaded = loadTask(param(req, 'taskId'), userId)
  if (!loaded) return notFound(res, 'Task not found.')

  const comment = db
    .prepare('SELECT * FROM comments WHERE id = ? AND task_id = ?')
    .get(param(req, 'commentId'), loaded.task.id) as unknown as
    | { id: string; user_id: number }
    | undefined
  if (!comment) return notFound(res, 'Comment not found.')
  if (comment.user_id !== userId && !loaded.host) {
    return forbidden(res, 'You can only delete your own comments.')
  }
  db.prepare('DELETE FROM comments WHERE id = ?').run(comment.id)
  res.json({ ok: true })
})

export default router
