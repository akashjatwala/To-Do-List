import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openSyntheticDb, createSyntheticUser, assertSynthetic } from './isolation'
import { OBSERVED_DIR } from './export-csv'
import { fromIso, intCell, optionalCell, optionalInt, parseCsvRecords, type CsvRecord } from './csv'
import type { SyntheticConfig } from './config'

/**
 * Reload an exported dataset into the isolated synthetic database.
 *
 * This reads the CSV files back in (never the in-memory model), so it proves the
 * export round-trips: what a script would load is exactly what the checks then
 * run against. It writes into `synthetic-data/synthetic.db` — never the app's
 * `server/data/todo.db` — and only into a database that carries the synthetic
 * marker table.
 *
 * Layer files and ground truth are deliberately **not** loaded into the
 * database. They stay file-only (a known limitation noted in the README): the
 * database mirrors the app's own tables, and the app has no tables for the
 * synthetic-only layers.
 */

export const SYNTHETIC_DB_PATH = join(OBSERVED_DIR, 'synthetic.db')

export interface ReloadResult {
  dbPath: string
  personId: string
  userId: number
  counts: Record<string, number>
}

function readRecords(dir: string, name: string): CsvRecord[] {
  const path = join(dir, name)
  if (!existsSync(path)) return []
  return parseCsvRecords(readFileSync(path, 'utf8'))
}

/** The core observed files the reload expects to find. */
export const RELOAD_FILES = [
  'tags.csv',
  'tag_history.csv',
  'tasks.csv',
  'task_configs.csv',
  'task_tags.csv',
  'activity_sessions.csv',
  'daily_activity_status.csv',
  'checkins.csv',
  'checkin_history.csv',
  'day_reviews.csv',
  'context_questions.csv',
  'session_context.csv',
  'state_suggestion_choices.csv',
] as const

export function reloadDataset(config: SyntheticConfig, dbPath = SYNTHETIC_DB_PATH): ReloadResult {
  const dir = join(OBSERVED_DIR, config.personId)
  const db = openSyntheticDb(dbPath)
  try {
    assertSynthetic(db)
    const user = createSyntheticUser(db, {
      personId: config.personId,
      label: config.personLabel,
      kind: 'named',
      archetype: null,
      heldOut: false,
      seed: config.seed,
    })
    const userId = user.userId
    const counts: Record<string, number> = {}

    // Clear this person's rows so reload is idempotent (FK-safe order).
    db.exec('BEGIN')
    try {
      const userIdTables = [
        'session_context',
        'context_questions',
        'day_reviews',
        'checkin_history',
        'checkins',
        'daily_activity_status',
        'activity_sessions',
        'task_config_tags',
        'task_configs',
        'task_tags',
        'tag_history',
        'tags',
        'tasks',
        'state_suggestion_choices',
      ]
      for (const table of userIdTables) {
        if (table === 'task_config_tags') {
          db.prepare(
            `DELETE FROM task_config_tags WHERE config_id IN (SELECT id FROM task_configs WHERE user_id = ?)`,
          ).run(userId)
          continue
        }
        if (table === 'session_context') {
          // `session_context` has no `user_id`; it is owned through its session.
          db.prepare(
            `DELETE FROM session_context WHERE session_id IN (SELECT id FROM activity_sessions WHERE user_id = ?)`,
          ).run(userId)
          continue
        }
        db.prepare(`DELETE FROM ${table} WHERE user_id = ?`).run(userId)
      }
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }

    const insertAll = <T>(name: string, rows: T[], insert: (row: T) => void) => {
      db.exec('BEGIN')
      try {
        for (const row of rows) insert(row)
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
      counts[name] = rows.length
    }

    insertAll('tags', readRecords(dir, 'tags.csv'), (row) => {
      db.prepare('INSERT INTO tags (id, user_id, name, normalized, merged_into_id, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
        intCell(row.id),
        userId,
        row.name,
        row.normalized,
        null,
        fromIso(row.created_at),
      )
    })
    // Point merged tags at their survivor after every tag exists: the survivor
    // may sort after the merged tag, and the foreign key is checked per statement.
    db.exec('BEGIN')
    try {
      for (const row of readRecords(dir, 'tags.csv')) {
        const merged = optionalInt(row.merged_into_id)
        if (merged === null) continue
        db.prepare('UPDATE tags SET merged_into_id = ? WHERE id = ?').run(merged, intCell(row.id))
      }
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }

    insertAll('tag_history', readRecords(dir, 'tag_history.csv'), (row) => {
      db.prepare(
        'INSERT INTO tag_history (id, tag_id, user_id, name, normalized, action, merged_into_id, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(intCell(row.id), intCell(row.tag_id), userId, row.name, row.normalized, row.action, optionalInt(row.merged_into_id), fromIso(row.recorded_at))
    })

    insertAll('tasks', readRecords(dir, 'tasks.csv'), (row) => {
      db.prepare(
        `INSERT INTO tasks (id, user_id, text, done, created_at, due, position, progress, priority, tags, recurrence, duration, recurrence_config, preferred_time)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        row.id,
        userId,
        row.text,
        intCell(row.done),
        fromIso(row.created_at),
        row.due ? fromIso(row.due) : null,
        intCell(row.position),
        intCell(row.progress),
        row.priority,
        row.tags,
        row.recurrence,
        optionalInt(row.duration),
        optionalCell(row.recurrence_config),
        optionalCell(row.preferred_time),
      )
    })

    insertAll('task_configs', readRecords(dir, 'task_configs.csv'), (row) => {
      const configId = intCell(row.id)
      db.prepare(
        `INSERT INTO task_configs (id, task_id, user_id, version, effective_from, name, category, priority, frequency, frequency_config, target_duration, preferred_time, active, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        configId,
        row.task_id,
        userId,
        intCell(row.version),
        fromIso(row.effective_from),
        row.name,
        optionalCell(row.category),
        optionalCell(row.priority),
        optionalCell(row.frequency),
        optionalCell(row.frequency_config),
        optionalInt(row.target_duration),
        optionalCell(row.preferred_time),
        intCell(row.active),
        fromIso(row.created_at),
      )
      for (const tagId of row.tag_ids ? row.tag_ids.split('|').filter(Boolean) : []) {
        db.prepare('INSERT OR IGNORE INTO task_config_tags (config_id, tag_id) VALUES (?, ?)').run(configId, intCell(tagId))
      }
    })

    insertAll('task_tags', readRecords(dir, 'task_tags.csv'), (row) => {
      db.prepare('INSERT OR IGNORE INTO task_tags (task_id, tag_id, user_id, created_at) VALUES (?, ?, ?, ?)').run(
        row.task_id,
        intCell(row.tag_id),
        userId,
        fromIso(row.created_at),
      )
    })

    insertAll('activity_sessions', readRecords(dir, 'activity_sessions.csv'), (row) => {
      db.prepare(
        `INSERT INTO activity_sessions (id, user_id, task_id, local_date, started_at, ended_at, duration_minutes, note, source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        row.id,
        userId,
        row.task_id,
        row.local_date,
        fromIso(row.started_at),
        row.ended_at ? fromIso(row.ended_at) : null,
        intCell(row.duration_minutes),
        optionalCell(row.note),
        row.source,
        fromIso(row.created_at),
        fromIso(row.updated_at),
      )
    })

    insertAll('daily_activity_status', readRecords(dir, 'daily_activity_status.csv'), (row) => {
      db.prepare(
        `INSERT INTO daily_activity_status (id, user_id, task_id, local_date, status, reason, source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(intCell(row.id), userId, row.task_id, row.local_date, row.status, optionalCell(row.reason), row.source, fromIso(row.created_at), fromIso(row.updated_at))
    })

    insertAll('checkins', readRecords(dir, 'checkins.csv'), (row) => {
      db.prepare(
        `INSERT INTO checkins (id, user_id, date, feeling, energy, motivation, sleep, stress, free_time, focus, body, workload, skipped, context, source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        intCell(row.id),
        userId,
        row.date,
        optionalInt(row.feeling),
        optionalInt(row.energy),
        optionalInt(row.motivation),
        optionalInt(row.sleep),
        optionalInt(row.stress),
        optionalInt(row.free_time),
        optionalInt(row.focus),
        optionalInt(row.body),
        optionalInt(row.workload),
        intCell(row.skipped),
        optionalCell(row.context),
        row.source,
        fromIso(row.created_at),
        fromIso(row.updated_at),
      )
    })

    insertAll('checkin_history', readRecords(dir, 'checkin_history.csv'), (row) => {
      db.prepare(
        `INSERT INTO checkin_history (id, checkin_id, user_id, date, feeling, energy, motivation, sleep, stress, free_time, focus, body, workload, skipped, context, source, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        intCell(row.id),
        intCell(row.checkin_id),
        userId,
        row.date,
        optionalInt(row.feeling),
        optionalInt(row.energy),
        optionalInt(row.motivation),
        optionalInt(row.sleep),
        optionalInt(row.stress),
        optionalInt(row.free_time),
        optionalInt(row.focus),
        optionalInt(row.body),
        optionalInt(row.workload),
        intCell(row.skipped),
        optionalCell(row.context),
        row.source,
        fromIso(row.recorded_at),
      )
    })

    insertAll('day_reviews', readRecords(dir, 'day_reviews.csv'), (row) => {
      db.prepare('INSERT INTO day_reviews (id, user_id, local_date, answer, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(
        intCell(row.id),
        userId,
        row.local_date,
        row.answer,
        fromIso(row.created_at),
        fromIso(row.updated_at),
      )
    })

    insertAll('context_questions', readRecords(dir, 'context_questions.csv'), (row) => {
      db.prepare(
        `INSERT INTO context_questions (id, user_id, task_id, tag_id, key, prompt, kind, options_json, position, active, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(row.id, userId, optionalCell(row.task_id), optionalInt(row.tag_id), row.key, row.prompt, row.kind, optionalCell(row.options_json), intCell(row.position), intCell(row.active), fromIso(row.created_at))
    })

    insertAll('session_context', readRecords(dir, 'session_context.csv'), (row) => {
      db.prepare('INSERT INTO session_context (id, session_id, question_id, value, created_at) VALUES (?, ?, ?, ?, ?)').run(
        intCell(row.id),
        row.session_id,
        row.question_id,
        row.value,
        fromIso(row.created_at),
      )
    })

    insertAll('state_suggestion_choices', readRecords(dir, 'state_suggestion_choices.csv'), (row) => {
      db.prepare('INSERT INTO state_suggestion_choices (id, user_id, local_date, suggestion_key, choice, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
        intCell(row.id),
        userId,
        row.local_date,
        row.suggestion_key,
        row.choice,
        fromIso(row.created_at),
      )
    })

    return { dbPath, personId: config.personId, userId, counts }
  } finally {
    db.close()
  }
}

export function openReloadedDb(dbPath = SYNTHETIC_DB_PATH): DatabaseSync {
  return openSyntheticDb(dbPath)
}
