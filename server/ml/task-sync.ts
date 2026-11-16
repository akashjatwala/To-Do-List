import type { DatabaseSync } from 'node:sqlite'
import { syncTaskTags } from './tags'
import { parseTagNames, recordTaskConfig, type TaskConfigRow, type TaskLike } from './task-config'

/**
 * Keep the learning data in step with the app's task table.
 *
 * Called after a task is created or edited. It mirrors the task's tags into the
 * tag tables and appends a new configuration version when a versioned field
 * changed. It never changes the task itself, so app behaviour is untouched.
 */
export function syncTaskFoundation(db: DatabaseSync, task: TaskLike, now = Date.now()): TaskConfigRow {
  const names = parseTagNames(task.tags)
  const tagIds = syncTaskTags(db, task.user_id, task.id, names, now)
  return recordTaskConfig(db, task, tagIds, now)
}

export type { TaskLike }
