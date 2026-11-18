import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { tagIdsForTask } from './tags'

/**
 * Task-specific context questions.
 *
 * A task may carry a short list of optional extra questions (for example
 * "What was the weather?" for a walk). Tags can suggest defaults, so an
 * exercise tag can ask about recovery. Nothing is asked by default: a task with
 * no questions and no matching tag has an empty list.
 */
export type QuestionKind = 'text' | 'number' | 'scale' | 'boolean'

export interface ContextQuestionRow {
  id: string
  user_id: number
  task_id: string | null
  tag_id: number | null
  key: string
  prompt: string
  kind: QuestionKind
  options_json: string | null
  position: number
  active: number
  created_at: number
}

export interface ContextQuestionInput {
  taskId: string | null
  tagId: number | null
  key: string
  prompt: string
  kind: QuestionKind
  options?: string[] | null
  position?: number
}

export function listContextQuestions(db: DatabaseSync, userId: number, taskId: string): ContextQuestionRow[] {
  return db
    .prepare(
      'SELECT * FROM context_questions WHERE user_id = ? AND task_id = ? AND active = 1 ORDER BY position ASC, created_at ASC',
    )
    .all(userId, taskId) as unknown as ContextQuestionRow[]
}

export function addContextQuestion(
  db: DatabaseSync,
  userId: number,
  input: ContextQuestionInput,
  now = Date.now(),
): ContextQuestionRow {
  const id = randomUUID()
  db.prepare(
    `INSERT INTO context_questions
       (id, user_id, task_id, tag_id, key, prompt, kind, options_json, position, active, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
  ).run(
    id,
    userId,
    input.taskId,
    input.tagId,
    input.key,
    input.prompt,
    input.kind,
    input.options && input.options.length ? JSON.stringify(input.options) : null,
    input.position ?? 0,
    now,
  )
  return db.prepare('SELECT * FROM context_questions WHERE id = ?').get(id) as unknown as ContextQuestionRow
}

export function deleteContextQuestion(db: DatabaseSync, userId: number, id: string): boolean {
  const result = db
    .prepare('DELETE FROM context_questions WHERE id = ? AND user_id = ?')
    .run(id, userId)
  return Number(result.changes) > 0
}

/** Questions suggested by the tags a task currently carries. */
export function suggestedQuestionsForTask(
  db: DatabaseSync,
  userId: number,
  taskId: string,
): ContextQuestionRow[] {
  const tagIds = tagIdsForTask(db, taskId)
  if (tagIds.length === 0) return []
  const placeholders = tagIds.map(() => '?').join(', ')
  return db
    .prepare(
      `SELECT * FROM context_questions
       WHERE user_id = ? AND task_id IS NULL AND active = 1 AND tag_id IN (${placeholders})
       ORDER BY position ASC, created_at ASC`,
    )
    .all(userId, ...tagIds) as unknown as ContextQuestionRow[]
}

/** Task questions plus tag suggestions, de-duplicated by key. */
export function questionsForTask(db: DatabaseSync, userId: number, taskId: string): ContextQuestionRow[] {
  const out: ContextQuestionRow[] = []
  const seen = new Set<string>()
  for (const question of [...listContextQuestions(db, userId, taskId), ...suggestedQuestionsForTask(db, userId, taskId)]) {
    if (seen.has(question.key)) continue
    seen.add(question.key)
    out.push(question)
  }
  return out
}


