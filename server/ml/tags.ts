import type { DatabaseSync } from 'node:sqlite'
import { prepare } from '../statement-cache'

/**
 * Tag store.
 *
 * Tags are user-scoped and have stable ids. Everything that needs to remember
 * a tag (task links, versioned config snapshots) stores the id, so renaming a
 * tag never breaks a past record. Deleted tags are hidden rather than removed,
 * keeping historic ids resolvable. Names are always stored lower case.
 */
export interface TagRow {
  id: number
  user_id: number
  name: string
  normalized: string
  merged_into_id: number | null
  deleted_at: number | null
  created_at: number
}

/** The single canonical form for a tag: lower case, single spaces. */
export function normalizeTagName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase()
}

/** Raising this keeps a rename from silently absorbing another active tag. */
export class TagNameConflictError extends Error {
  constructor(name: string) {
    super(`A tag named “${name}” already exists.`)
    this.name = 'TagNameConflictError'
  }
}

function getTag(db: DatabaseSync, tagId: number): TagRow | undefined {
  return prepare(db, 'SELECT * FROM tags WHERE id = ?').get(tagId) as unknown as TagRow | undefined
}

function findActiveByName(db: DatabaseSync, userId: number, normalized: string): TagRow | undefined {
  return prepare(db,
      'SELECT * FROM tags WHERE user_id = ? AND normalized = ? AND merged_into_id IS NULL AND deleted_at IS NULL',
    )
    .get(userId, normalized) as unknown as TagRow | undefined
}

function recordHistory(
  db: DatabaseSync,
  tag: TagRow,
  action: 'create' | 'rename' | 'merge',
  now: number,
  mergedIntoId: number | null = null,
): void {
  prepare(db,
    `INSERT INTO tag_history (tag_id, user_id, name, normalized, action, merged_into_id, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(tag.id, tag.user_id, tag.name, tag.normalized, action, mergedIntoId, now)
}

/**
 * Create a tag explicitly from the Tag Manager. The stored name is always the
 * canonical lower-case form. An active tag with the same name is returned
 * unchanged so the action is idempotent.
 */
export function createTag(db: DatabaseSync, userId: number, name: string, now = Date.now()): TagRow | null {
  const normalized = normalizeTagName(name)
  if (!normalized) return null
  const existing = findActiveByName(db, userId, normalized)
  if (existing) return existing
  const result = prepare(db,
      'INSERT INTO tags (user_id, name, normalized, merged_into_id, deleted_at, created_at) VALUES (?, ?, ?, NULL, NULL, ?)',
    )
    .run(userId, normalized, normalized, now)
  const tag = getTag(db, Number(result.lastInsertRowid))!
  recordHistory(db, tag, 'create', now)
  return tag
}

/**
 * Find the tag with this name, creating it when it does not exist yet. A name
 * that belongs to a merged tag resolves to the tag that absorbed it, so a merge
 * is respected rather than silently re-created. Deleted tags are ignored, so a
 * deleted name can be used again as a fresh tag. A blank name is rejected.
 */
export function resolveTag(db: DatabaseSync, userId: number, name: string, now = Date.now()): TagRow | null {
  const normalized = normalizeTagName(name)
  if (!normalized) return null
  const existing = prepare(db,
      `SELECT * FROM tags WHERE user_id = ? AND normalized = ? AND deleted_at IS NULL
       ORDER BY (merged_into_id IS NULL) DESC, id ASC LIMIT 1`,
    )
    .get(userId, normalized) as unknown as TagRow | undefined
  if (existing) return resolveTagChain(db, existing.id) ?? null
  return createTag(db, userId, normalized, now)
}

/** Follow a merge chain to the tag that is still active. */
export function resolveTagChain(db: DatabaseSync, tagId: number): TagRow | undefined {
  let current = getTag(db, tagId)
  const seen = new Set<number>()
  while (current && current.merged_into_id !== null && !seen.has(current.id)) {
    seen.add(current.id)
    current = getTag(db, current.merged_into_id)
  }
  return current
}

export interface TagSummary {
  id: number
  name: string
}

/** Active, non-deleted tags for this user. */
export function listTags(db: DatabaseSync, userId: number): TagSummary[] {
  return prepare(db,
      `SELECT id, name FROM tags
       WHERE user_id = ? AND merged_into_id IS NULL AND deleted_at IS NULL
       ORDER BY name ASC`,
    )
    .all(userId) as unknown as TagSummary[]
}

/** Keep the JSON tag labels on tasks in step with the stable tag ids. */
function parseTaskTagNames(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((value): value is string => typeof value === 'string')
  } catch {
    return []
  }
}

function rewriteTaskTagNames(
  db: DatabaseSync,
  userId: number,
  replacements: Map<string, string>,
): void {
  if (replacements.size === 0) return
  const rows = prepare(db, 'SELECT id, tags FROM tasks WHERE user_id = ?').all(userId) as unknown as Array<{
    id: string
    tags: string
  }>
  const update = prepare(db, 'UPDATE tasks SET tags = ? WHERE id = ?')

  for (const row of rows) {
    const seen = new Set<string>()
    const next: string[] = []
    let changed = false
    for (const name of parseTaskTagNames(row.tags)) {
      // Any task we touch has all of its labels canonicalised, not just the
      // one being renamed or removed.
      const canonical = normalizeTagName(name)
      const replacement = replacements.get(canonical) ?? canonical
      const key = normalizeTagName(replacement)
      if (replacement !== name) changed = true
      if (!key || seen.has(key)) continue
      seen.add(key)
      next.push(replacement)
    }
    if (changed) update.run(JSON.stringify(next), row.id)
  }
}

function moveTaskLinks(db: DatabaseSync, sourceId: number, targetId: number): void {
  prepare(db,
    `INSERT OR IGNORE INTO task_tags (task_id, tag_id, user_id, created_at)
     SELECT task_id, ?, user_id, created_at FROM task_tags WHERE tag_id = ?`,
  ).run(targetId, sourceId)
  prepare(db, 'DELETE FROM task_tags WHERE tag_id = ?').run(sourceId)
  // Any context question suggested by the old tag now follows the new one.
  prepare(db, 'UPDATE context_questions SET tag_id = ? WHERE tag_id = ?').run(targetId, sourceId)
}

/** Merge `sourceId` into `targetId`, keeping both ids resolvable. */
export function mergeTags(
  db: DatabaseSync,
  userId: number,
  sourceId: number,
  targetId: number,
  now = Date.now(),
): TagRow | null {
  if (sourceId === targetId) return resolveTagChain(db, targetId) ?? null
  const source = getTag(db, sourceId)
  const target = getTag(db, targetId)
  if (!source || !target || source.user_id !== userId || target.user_id !== userId) return null
  if (source.merged_into_id !== null) return resolveTagChain(db, targetId) ?? null

  moveTaskLinks(db, sourceId, targetId)
  prepare(db, 'UPDATE tags SET merged_into_id = ? WHERE id = ?').run(targetId, sourceId)
  recordHistory(db, source, 'merge', now, targetId)
  rewriteTaskTagNames(db, userId, new Map([[source.normalized, target.name]]))
  return target
}

/**
 * Rename a tag to its lower-case canonical name. Renaming onto a name that is
 * already taken is rejected so a rename never silently merges two tags.
 */
export function renameTag(
  db: DatabaseSync,
  userId: number,
  tagId: number,
  newName: string,
  now = Date.now(),
): TagRow | null {
  const tag = getTag(db, tagId)
  if (!tag || tag.user_id !== userId || tag.merged_into_id !== null || tag.deleted_at !== null) return null
  const normalized = normalizeTagName(newName)
  if (!normalized) return null

  const clash = findActiveByName(db, userId, normalized)
  if (clash && clash.id !== tag.id) throw new TagNameConflictError(normalized)

  const previousNormalized = tag.normalized
  prepare(db, 'UPDATE tags SET name = ?, normalized = ? WHERE id = ?').run(normalized, normalized, tag.id)
  const updated = getTag(db, tag.id)!
  recordHistory(db, updated, 'rename', now)
  rewriteTaskTagNames(db, userId, new Map([[previousNormalized, normalized]]))
  return updated
}

/**
 * Delete a tag from the active list. The row is kept so historic ids in config
 * snapshots stay resolvable; current task links and JSON labels are cleared,
 * and any context question suggested by it is detached.
 */
export function deleteTag(
  db: DatabaseSync,
  userId: number,
  tagId: number,
  now = Date.now(),
): TagRow | null {
  const tag = getTag(db, tagId)
  if (!tag || tag.user_id !== userId || tag.merged_into_id !== null || tag.deleted_at !== null) return null

  prepare(db, 'UPDATE tags SET deleted_at = ? WHERE id = ?').run(now, tag.id)
  prepare(db, 'DELETE FROM task_tags WHERE tag_id = ?').run(tag.id)
  prepare(db, 'UPDATE context_questions SET tag_id = NULL WHERE tag_id = ?').run(tag.id)
  rewriteTaskTagNames(db, userId, new Map([[tag.normalized, '']]))
  return tag
}

/** Tag ids currently linked to a task. */
export function tagIdsForTask(db: DatabaseSync, taskId: string): number[] {
  return (
    prepare(db, 'SELECT tag_id FROM task_tags WHERE task_id = ? ORDER BY tag_id').all(taskId) as unknown as Array<{
      tag_id: number
    }>
  ).map((row) => row.tag_id)
}

/**
 * Make the current task<->tag links match `names` exactly, creating tags as
 * needed. Returns the resolved tag ids.
 */
export function syncTaskTags(
  db: DatabaseSync,
  userId: number,
  taskId: string,
  names: string[],
  now = Date.now(),
): number[] {
  const wanted = new Set<number>()
  for (const name of names) {
    const tag = resolveTag(db, userId, name, now)
    if (tag) wanted.add(tag.id)
  }

  const current = new Set(tagIdsForTask(db, taskId))
  for (const id of wanted) {
    if (!current.has(id)) {
      prepare(db, 'INSERT OR IGNORE INTO task_tags (task_id, tag_id, user_id, created_at) VALUES (?, ?, ?, ?)').run(
        taskId,
        id,
        userId,
        now,
      )
    }
  }
  for (const id of current) {
    if (!wanted.has(id)) prepare(db, 'DELETE FROM task_tags WHERE task_id = ? AND tag_id = ?').run(taskId, id)
  }
  return [...wanted].sort((a, b) => a - b)
}
