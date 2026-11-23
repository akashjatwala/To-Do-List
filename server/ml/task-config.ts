import type { DatabaseSync } from 'node:sqlite'
import { prepare } from '../statement-cache'

/**
 * Versioned task configuration.
 *
 * A task's interpretation inputs — its name, priority, tags, frequency, target
 * duration and preferred time — change over time. Rather than overwriting them,
 * every change appends a new version with an `effective_from` timestamp, so a
 * past day can always be read with the configuration that applied back then.
 *
 * Priority is stored exactly as it was set. The app's "no priority" value
 * (`'none'`) is stored as NULL, because a missing priority is missing — it is
 * never inferred or defaulted to a low priority.
 */
export interface TaskConfigRow {
  id: number
  task_id: string
  user_id: number
  version: number
  effective_from: number
  name: string
  category: string | null
  priority: string | null
  frequency: string | null
  frequency_config: string | null
  target_duration: number | null
  preferred_time: string | null
  active: number
  created_at: number
}

/** The subset of a task row the configuration is built from. */
export interface TaskLike {
  id: string
  user_id: number
  text: string
  priority: string
  tags: string
  recurrence: string
  recurrence_config: string | null
  duration: number | null
  preferred_time: string | null
}

export interface ConfigSnapshot {
  name: string
  category: string | null
  priority: string | null
  frequency: string | null
  frequency_config: string | null
  target_duration: number | null
  preferred_time: string | null
  active: number
  tagIds: number[]
}

/** The app stores "no priority" as 'none'; for the model that is simply missing. */
export function priorityForConfig(priority: string | null | undefined): string | null {
  if (!priority || priority === 'none') return null
  return priority
}

/** 'none' recurrence means "no frequency", i.e. missing. */
export function frequencyForConfig(recurrence: string | null | undefined): string | null {
  if (!recurrence || recurrence === 'none') return null
  return recurrence
}

function parseTagNames(value: string | null | undefined): string[] {
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

export function snapshotFromTask(task: TaskLike, tagIds: number[]): ConfigSnapshot {
  return {
    name: task.text,
    category: null,
    priority: priorityForConfig(task.priority),
    frequency: frequencyForConfig(task.recurrence),
    frequency_config: task.recurrence_config,
    target_duration: task.duration,
    preferred_time: task.preferred_time,
    active: 1,
    tagIds: [...tagIds].sort((a, b) => a - b),
  }
}

/** Canonical string so two snapshots can be compared cheaply. */
function signature(snapshot: ConfigSnapshot): string {
  return JSON.stringify([
    snapshot.name,
    snapshot.category,
    snapshot.priority,
    snapshot.frequency,
    snapshot.frequency_config,
    snapshot.target_duration,
    snapshot.preferred_time,
    snapshot.active,
    snapshot.tagIds,
  ])
}

export function latestConfig(db: DatabaseSync, taskId: string): TaskConfigRow | undefined {
  return prepare(db, 'SELECT * FROM task_configs WHERE task_id = ? ORDER BY version DESC LIMIT 1')
    .get(taskId) as unknown as TaskConfigRow | undefined
}

export function configTagIds(db: DatabaseSync, configId: number): number[] {
  return (
    prepare(db, 'SELECT tag_id FROM task_config_tags WHERE config_id = ? ORDER BY tag_id').all(configId) as unknown as Array<{
      tag_id: number
    }>
  ).map((row) => row.tag_id)
}

function snapshotOfRow(db: DatabaseSync, row: TaskConfigRow): ConfigSnapshot {
  return {
    name: row.name,
    category: row.category,
    priority: row.priority,
    frequency: row.frequency,
    frequency_config: row.frequency_config,
    target_duration: row.target_duration,
    preferred_time: row.preferred_time,
    active: row.active,
    tagIds: configTagIds(db, row.id),
  }
}

/**
 * Record the task's configuration, appending a new version only when something
 * versioned actually changed. Returns the current (possibly unchanged) version.
 */
export function recordTaskConfig(
  db: DatabaseSync,
  task: TaskLike,
  tagIds: number[],
  effectiveFrom = Date.now(),
): TaskConfigRow {
  const snapshot = snapshotFromTask(task, tagIds)
  const latest = latestConfig(db, task.id)
  if (latest && signature(snapshotOfRow(db, latest)) === signature(snapshot)) return latest

  const version = (latest?.version ?? 0) + 1
  const result = prepare(db,
      `INSERT INTO task_configs
         (task_id, user_id, version, effective_from, name, category, priority, frequency,
          frequency_config, target_duration, preferred_time, active, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      task.id,
      task.user_id,
      version,
      effectiveFrom,
      snapshot.name,
      snapshot.category,
      snapshot.priority,
      snapshot.frequency,
      snapshot.frequency_config,
      snapshot.target_duration,
      snapshot.preferred_time,
      snapshot.active,
      Date.now(),
    )
  const configId = Number(result.lastInsertRowid)
  const insertTag = prepare(db, 'INSERT OR IGNORE INTO task_config_tags (config_id, tag_id) VALUES (?, ?)')
  for (const tagId of snapshot.tagIds) insertTag.run(configId, tagId)
  return prepare(db, 'SELECT * FROM task_configs WHERE id = ?').get(configId) as unknown as TaskConfigRow
}

/** Every version for a task, newest first. */
export function listTaskConfigs(db: DatabaseSync, taskId: string): TaskConfigRow[] {
  return prepare(db, 'SELECT * FROM task_configs WHERE task_id = ? ORDER BY version DESC')
    .all(taskId) as unknown as TaskConfigRow[]
}

/** Start of a local calendar day, used to scope tasks to a due date. */
export function startOfLocalDay(date: string): number {
  const [year, month, day] = date.split('-').map(Number)
  return new Date(year, month - 1, day).getTime()
}

/** End of a local calendar day, used to decide which version applied. */
export function endOfLocalDay(date: string): number {
  const [year, month, day] = date.split('-').map(Number)
  return new Date(year, month - 1, day, 23, 59, 59, 999).getTime()
}

/**
 * The configuration version that applied on a given local date: the newest
 * version that had taken effect by the end of that day.
 */
export function configForDate(db: DatabaseSync, taskId: string, date: string): TaskConfigRow | undefined {
  return prepare(db,
      `SELECT * FROM task_configs
       WHERE task_id = ? AND effective_from <= ?
       ORDER BY effective_from DESC, version DESC
       LIMIT 1`,
    )
    .get(taskId, endOfLocalDay(date)) as unknown as TaskConfigRow | undefined
}

export { parseTagNames }
