import type { DatabaseSync } from 'node:sqlite'
import { parseAnswer, parseLocalDate } from '../../checkins-store'
import { rangesOverlap, validateSession, type SessionRange } from '../sessions'
import { parseDayReviewAnswer } from '../day-review'
import { assertSynthetic } from './isolation'
import type { SyntheticModel } from './model'

/**
 * Write a fully-built model into the isolated synthetic database.
 *
 * Design notes (why this does not just call the app's store functions):
 * - The brief requires the whole run to build in memory and then write in bulk
 *   inside **one transaction**, and requires byte-identical exports for a given
 *   seed. The app's per-row writers each open their own transaction and stamp
 *   `Date.now()` / `randomUUID()`, which would break both. So ids and timestamps
 *   are assigned by the generator and inserted here directly.
 * - The app's **validation** functions are still applied to every batch first
 *   (`validateModel`), so nothing invalid is ever written. The schema is the
 *   app's own, created by the app's schema builders in `isolation.ts`.
 */

export function validateModel(model: SyntheticModel): void {
  const userId = model.userId

  for (const session of model.sessions) {
    if (!parseLocalDate(session.local_date)) throw new Error(`Bad session date: ${session.local_date}`)
    if (session.user_id !== userId) throw new Error('Session user mismatch')
    const result = validateSession(
      {
        taskId: session.task_id,
        localDate: session.local_date,
        startedAt: session.started_at,
        endedAt: session.ended_at,
        durationMinutes: session.duration_minutes,
        note: session.note,
      },
      { now: Number.MAX_SAFE_INTEGER, existing: [] },
    )
    if (!result.ok) throw new Error(`Invalid session ${session.id}: ${result.error}`)
  }

  // Overlap check within each task, using the app's own range rule.
  const byTask = new Map<string, SessionRange[]>()
  for (const session of model.sessions) {
    const list = byTask.get(session.task_id) ?? []
    const candidate: SessionRange = {
      id: session.id,
      startedAt: session.started_at,
      endedAt: session.ended_at,
      durationMinutes: session.duration_minutes,
    }
    for (const existing of list) {
      if (rangesOverlap(candidate, existing)) {
        throw new Error(`Overlapping sessions for ${session.task_id} on ${session.local_date}`)
      }
    }
    list.push(candidate)
    byTask.set(session.task_id, list)
  }

  for (const checkin of model.checkins) {
    if (!parseLocalDate(checkin.date)) throw new Error(`Bad check-in date: ${checkin.date}`)
    for (const key of ['feeling', 'energy', 'motivation', 'sleep', 'stress', 'free_time', 'focus', 'body', 'workload'] as const) {
      const parsed = parseAnswer(checkin[key])
      if (parsed === undefined) throw new Error(`Bad check-in answer ${key} on ${checkin.date}`)
    }
  }

  for (const review of model.reviews) {
    if (!parseDayReviewAnswer(review.answer)) throw new Error(`Bad review answer: ${review.answer}`)
    if (!parseLocalDate(review.local_date)) throw new Error(`Bad review date: ${review.local_date}`)
  }
}

export interface WriteCounts {
  tasks: number
  tags: number
  sessions: number
  statuses: number
  checkins: number
  reviews: number
  total: number
}

export function writeModel(db: DatabaseSync, model: SyntheticModel): WriteCounts {
  assertSynthetic(db)
  validateModel(model)

  db.exec('BEGIN')
  try {
    const tag = db.prepare(
      'INSERT INTO tags (id, user_id, name, normalized, merged_into_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    // Insert with a null merge target first, then point merged tags at their
    // survivor: the survivor may sort after the merged tag, and the foreign key
    // is checked per statement.
    for (const row of model.tags) tag.run(row.id, row.user_id, row.name, row.normalized, null, row.created_at)
    const setMerge = db.prepare('UPDATE tags SET merged_into_id = ? WHERE id = ?')
    for (const row of model.tags) {
      if (row.merged_into_id !== null) setMerge.run(row.merged_into_id, row.id)
    }

    const tagHistory = db.prepare(
      `INSERT INTO tag_history (id, tag_id, user_id, name, normalized, action, merged_into_id, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    for (const row of model.tagHistory) {
      tagHistory.run(row.id, row.tag_id, row.user_id, row.name, row.normalized, row.action, row.merged_into_id, row.recorded_at)
    }

    const task = db.prepare(
      `INSERT INTO tasks (id, user_id, text, done, created_at, due, position, progress, priority, tags, recurrence, duration, recurrence_config, preferred_time)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    for (const row of model.tasks) {
      task.run(
        row.id,
        row.user_id,
        row.text,
        row.done,
        row.created_at,
        row.due,
        row.position,
        row.progress,
        row.priority,
        row.tags,
        row.recurrence,
        row.duration,
        row.recurrence_config,
        row.preferred_time,
      )
    }

    const config = db.prepare(
      `INSERT INTO task_configs (id, task_id, user_id, version, effective_from, name, category, priority, frequency, frequency_config, target_duration, preferred_time, active, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    const configTag = db.prepare('INSERT OR IGNORE INTO task_config_tags (config_id, tag_id) VALUES (?, ?)')
    for (const row of model.taskConfigs) {
      config.run(
        row.id,
        row.task_id,
        row.user_id,
        row.version,
        row.effective_from,
        row.name,
        row.category,
        row.priority,
        row.frequency,
        row.frequency_config,
        row.target_duration,
        row.preferred_time,
        row.active,
        row.created_at,
      )
      for (const tagId of row.tag_ids) configTag.run(row.id, tagId)
    }

    const taskTag = db.prepare(
      'INSERT OR IGNORE INTO task_tags (task_id, tag_id, user_id, created_at) VALUES (?, ?, ?, ?)',
    )
    for (const row of model.taskTags) taskTag.run(row.task_id, row.tag_id, row.user_id, row.created_at)

    const session = db.prepare(
      `INSERT INTO activity_sessions (id, user_id, task_id, local_date, started_at, ended_at, duration_minutes, note, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    for (const row of model.sessions) {
      session.run(
        row.id,
        row.user_id,
        row.task_id,
        row.local_date,
        row.started_at,
        row.ended_at,
        row.duration_minutes,
        row.note,
        row.source,
        row.created_at,
        row.updated_at,
      )
    }

    const status = db.prepare(
      `INSERT INTO daily_activity_status (id, user_id, task_id, local_date, status, reason, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    for (const row of model.dailyStatus) {
      status.run(row.id, row.user_id, row.task_id, row.local_date, row.status, row.reason, row.source, row.created_at, row.updated_at)
    }

    const checkin = db.prepare(
      `INSERT INTO checkins (id, user_id, date, feeling, energy, motivation, sleep, stress, free_time, focus, body, workload, skipped, context, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    for (const row of model.checkins) {
      checkin.run(
        row.id,
        row.user_id,
        row.date,
        row.feeling,
        row.energy,
        row.motivation,
        row.sleep,
        row.stress,
        row.free_time,
        row.focus,
        row.body,
        row.workload,
        row.skipped,
        row.context,
        row.source,
        row.created_at,
        row.updated_at,
      )
    }

    const history = db.prepare(
      `INSERT INTO checkin_history (id, checkin_id, user_id, date, feeling, energy, motivation, sleep, stress, free_time, focus, body, workload, skipped, context, source, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    for (const row of model.checkinHistory) {
      history.run(
        row.id,
        row.checkin_id,
        row.user_id,
        row.date,
        row.feeling,
        row.energy,
        row.motivation,
        row.sleep,
        row.stress,
        row.free_time,
        row.focus,
        row.body,
        row.workload,
        row.skipped,
        row.context,
        row.source,
        row.recorded_at,
      )
    }

    const review = db.prepare(
      'INSERT INTO day_reviews (id, user_id, local_date, answer, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    for (const row of model.reviews) review.run(row.id, row.user_id, row.local_date, row.answer, row.created_at, row.updated_at)

    const question = db.prepare(
      `INSERT INTO context_questions (id, user_id, task_id, tag_id, key, prompt, kind, options_json, position, active, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    for (const row of model.contextQuestions) {
      question.run(row.id, row.user_id, row.task_id, row.tag_id, row.key, row.prompt, row.kind, row.options_json, row.position, row.active, row.created_at)
    }

    const sessionContext = db.prepare(
      'INSERT INTO session_context (id, session_id, question_id, value, created_at) VALUES (?, ?, ?, ?, ?)',
    )
    for (const row of model.sessionContext) {
      sessionContext.run(row.id, row.session_id, row.question_id, row.value, row.created_at)
    }

    const choice = db.prepare(
      'INSERT INTO state_suggestion_choices (id, user_id, local_date, suggestion_key, choice, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    for (const row of model.suggestionChoices) {
      choice.run(row.id, row.user_id, row.local_date, row.suggestion_key, row.choice, row.created_at)
    }

    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }

  return {
    tasks: model.tasks.length,
    tags: model.tags.length,
    sessions: model.sessions.length,
    statuses: model.dailyStatus.length,
    checkins: model.checkins.length,
    reviews: model.reviews.length,
    total: 0,
  }
}
