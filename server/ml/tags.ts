import type { DatabaseSync } from 'node:sqlite'

/**
 * Tag store.
 *
 * Tags are user-scoped and have stable ids. Everything that needs to remember
 * a tag (task links, versioned config snapshots) stores the id, so renaming or
 * merging a tag never breaks a past record: a merged tag simply resolves
 * through `merged_into_id` to the tag that survived.
 */
export interface TagRow {
  id: number
  user_id: number
  name: string
  normalized: string
  merged_into_id: number | null
  created_at: number
}

/** Case- and whitespace-insensitive key used to spot the "same" tag. */
export function normalizeTagName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase()
}

function getTag(db: DatabaseSync, tagId: number): TagRow | undefined {
  return db.prepare('SELECT * FROM tags WHERE id = ?').get(tagId) as unknown as TagRow | undefined
}

function findActiveByName(db: DatabaseSync, userId: number, normalized: string): TagRow | undefined {
  return db
    .prepare('SELECT * FROM tags WHERE user_id = ? AND normalized = ? AND merged_into_id IS NULL')
    .get(userId, normalized) as unknown as TagRow | undefined
}

function recordHistory(
  db: DatabaseSync,
  tag: TagRow,
  action: 'create' | 'rename' | 'merge',
  now: number,
  mergedIntoId: number | null = null,
): void {
  db.prepare(
    `INSERT INTO tag_history (tag_id, user_id, name, normalized, action, merged_into_id, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(tag.id, tag.user_id, tag.name, tag.normalized, action, mergedIntoId, now)
}

function createTag(db: DatabaseSync, userId: number, name: string, now: number): TagRow {
  const normalized = normalizeTagName(name)
  const result = db
    .prepare('INSERT INTO tags (user_id, name, normalized, merged_into_id, created_at) VALUES (?, ?, ?, NULL, ?)')
    .run(userId, name, normalized, now)
  const tag = getTag(db, Number(result.lastInsertRowid))!
  recordHistory(db, tag, 'create', now)
  return tag
}

/**
 * Find the tag with this name, creating it when it does not exist yet. A name
 * that belongs to a merged tag resolves to the tag that absorbed it, so a merge
 * is respected rather than silently re-created. A blank name is rejected.
 */
export function resolveTag(db: DatabaseSync, userId: number, name: string, now = Date.now()): TagRow | null {
  const trimmed = name.trim().replace(/\s+/g, ' ')
  if (!trimmed) return null
  const normalized = normalizeTagName(trimmed)
  const existing = db
    .prepare(
      `SELECT * FROM tags WHERE user_id = ? AND normalized = ?
       ORDER BY (merged_into_id IS NULL) DESC, id ASC LIMIT 1`,
    )
    .get(userId, normalized) as unknown as TagRow | undefined
  if (existing) return resolveTagChain(db, existing.id) ?? null
  return createTag(db, userId, trimmed, now)
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
  taskCount: number
}

/** Active tags with how many tasks currently use them. */
export function listTags(db: DatabaseSync, userId: number): TagSummary[] {
  return db
    .prepare(
      `SELECT t.id AS id, t.name AS name, COUNT(tt.task_id) AS taskCount
       FROM tags t
       LEFT JOIN task_tags tt ON tt.tag_id = t.id
       WHERE t.user_id = ? AND t.merged_into_id IS NULL
       GROUP BY t.id
       ORDER BY t.name COLLATE NOCASE ASC`,
    )
    .all(userId) as unknown as TagSummary[]
}

function moveTaskLinks(db: DatabaseSync, sourceId: number, targetId: number): void {
  db.prepare(
    `INSERT OR IGNORE INTO task_tags (task_id, tag_id, user_id, created_at)
     SELECT task_id, ?, user_id, created_at FROM task_tags WHERE tag_id = ?`,
  ).run(targetId, sourceId)
  db.prepare('DELETE FROM task_tags WHERE tag_id = ?').run(sourceId)
  // Any context question suggested by the old tag now follows the new one.
  db.prepare('UPDATE context_questions SET tag_id = ? WHERE tag_id = ?').run(targetId, sourceId)
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
  db.prepare('UPDATE tags SET merged_into_id = ? WHERE id = ?').run(targetId, sourceId)
  recordHistory(db, source, 'merge', now, targetId)
  return target
}

/**
 * Rename a tag. Renaming onto a name that already exists merges the two tags
 * instead, so a rename can never create a duplicate or orphan a past record.
 */
export function renameTag(
  db: DatabaseSync,
  userId: number,
  tagId: number,
  newName: string,
  now = Date.now(),
): TagRow | null {
  const tag = getTag(db, tagId)
  if (!tag || tag.user_id !== userId || tag.merged_into_id !== null) return null
  const trimmed = newName.trim().replace(/\s+/g, ' ')
  if (!trimmed) return null
  const normalized = normalizeTagName(trimmed)

  const clash = findActiveByName(db, userId, normalized)
  if (clash && clash.id !== tag.id) return mergeTags(db, userId, tag.id, clash.id, now)

  db.prepare('UPDATE tags SET name = ?, normalized = ? WHERE id = ?').run(trimmed, normalized, tag.id)
  const updated = getTag(db, tag.id)!
  recordHistory(db, updated, 'rename', now)
  return updated
}

/** Tag ids currently linked to a task. */
export function tagIdsForTask(db: DatabaseSync, taskId: string): number[] {
  return (
    db.prepare('SELECT tag_id FROM task_tags WHERE task_id = ? ORDER BY tag_id').all(taskId) as unknown as Array<{
      tag_id: number
    }>
  ).map((row) => row.tag_id)
}

/** Resolved tag names for a task (merged tags fold into their survivor). */
export function tagsForTask(db: DatabaseSync, taskId: string): string[] {
  const ids = tagIdsForTask(db, taskId)
  const names: string[] = []
  for (const id of ids) {
    const tag = resolveTagChain(db, id)
    if (tag && !names.includes(tag.name)) names.push(tag.name)
  }
  return names
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
      db.prepare('INSERT OR IGNORE INTO task_tags (task_id, tag_id, user_id, created_at) VALUES (?, ?, ?, ?)').run(
        taskId,
        id,
        userId,
        now,
      )
    }
  }
  for (const id of current) {
    if (!wanted.has(id)) db.prepare('DELETE FROM task_tags WHERE task_id = ? AND tag_id = ?').run(taskId, id)
  }
  return [...wanted].sort((a, b) => a - b)
}
