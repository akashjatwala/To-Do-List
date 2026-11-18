import type { DatabaseSync } from 'node:sqlite'
import { listCheckins, type CheckinAnswerKey, type CheckinRow } from '../checkins-store'
import { answeredValues } from './readiness'
import { dailyActivity, type DailyStatus } from './daily-activity'
import { configForDate, configTagIds } from './task-config'

/**
 * "Days like today".
 *
 * Finds the user's most similar past days using **only the fields they
 * answered**, then reports what actually happened on those days, per task and
 * per tag. It is descriptive, never a promise: it says what has happened on
 * similar days, not what will happen.
 *
 * Rules enforced here:
 * - Only days with enough overlapping answers are compared.
 * - Recent days count a little more, via a small similarity bonus.
 * - Only days with a labelled outcome are counted; pending days are never used.
 * - Nothing is shown below a configurable minimum number of similar days.
 * - The number of days the claim is based on is always reported.
 */

/** Minimum fields answered in both days before they can be compared. */
export const MIN_OVERLAP = 4
/** Minimum similar days before anything is shown. */
export const MIN_SIMILAR_DAYS = 5
/** How many similar days to keep. */
export const MAX_SIMILAR_DAYS = 12
/** Half-life (days) of the recency bonus — recent days weigh a little more. */
export const RECENCY_HALF_LIFE = 30
/** How large the recency bonus can get, in distance points. */
export const RECENCY_BONUS = 0.15

export interface SimilarDay {
  date: string
  /** Mean absolute difference over the overlapping answered fields. */
  distance: number
  /** How many fields the comparison used. */
  overlap: number
  /** Recency-weighted score actually used for ranking (lower = more similar). */
  score: number
}

export interface SimilarOutcome {
  id: string
  name: string
  /** Days the item actually happened. */
  performedDays: number
  /** Days that had a clear outcome for the item (never pending/unknown). */
  consideredDays: number
}

export interface SimilarDaysResult {
  available: boolean
  reason: string | null
  /** How many similar days the claim is based on. */
  dayCount: number
  days: SimilarDay[]
  tasks: SimilarOutcome[]
  tags: SimilarOutcome[]
  /** A plain sentence, or null when nothing is available. */
  line: string | null
}

function daysBetween(a: string, b: string): number {
  const [ay, am, ad] = a.split('-').map(Number)
  const [by, bm, bd] = b.split('-').map(Number)
  const first = Date.UTC(ay, am - 1, ad)
  const second = Date.UTC(by, bm - 1, bd)
  return Math.round((first - second) / 86_400_000)
}

/** A day is comparable when enough fields were answered in both days. */
export function overlapCount(
  a: Partial<Record<CheckinAnswerKey, number>>,
  b: Partial<Record<CheckinAnswerKey, number>>,
): number {
  let count = 0
  for (const key of Object.keys(a) as CheckinAnswerKey[]) {
    if (a[key] !== undefined && b[key] !== undefined) count += 1
  }
  return count
}

/** Mean absolute difference over the fields answered in both days. */
export function fieldDistance(
  a: Partial<Record<CheckinAnswerKey, number>>,
  b: Partial<Record<CheckinAnswerKey, number>>,
): number {
  let sum = 0
  let count = 0
  for (const key of Object.keys(a) as CheckinAnswerKey[]) {
    if (a[key] === undefined || b[key] === undefined) continue
    sum += Math.abs(a[key]! - b[key]!)
    count += 1
  }
  return count === 0 ? Number.POSITIVE_INFINITY : sum / count
}

/** Rank past days by similarity, letting recent days count a little more. */
export function rankSimilarDays(
  targetDate: string,
  targetAnswers: Partial<Record<CheckinAnswerKey, number>>,
  candidates: Array<{ date: string; answers: Partial<Record<CheckinAnswerKey, number>> }>,
): SimilarDay[] {
  const ranked: SimilarDay[] = []
  for (const candidate of candidates) {
    const overlap = overlapCount(targetAnswers, candidate.answers)
    if (overlap < MIN_OVERLAP) continue
    const distance = fieldDistance(targetAnswers, candidate.answers)
    const age = Math.max(0, daysBetween(targetDate, candidate.date))
    const recency = 1 / (1 + age / RECENCY_HALF_LIFE)
    const score = distance - RECENCY_BONUS * recency
    ranked.push({ date: candidate.date, distance, overlap, score })
  }
  ranked.sort((a, b) => a.score - b.score || (a.date < b.date ? 1 : -1))
  return ranked.slice(0, MAX_SIMILAR_DAYS)
}

function isLabelled(status: DailyStatus): boolean {
  return status !== 'pending' && status !== 'unknown'
}

function performedOn(db: DatabaseSync, userId: number, taskId: string, date: string, today: string): { labelled: boolean; performed: boolean } {
  const activity = dailyActivity(db, userId, taskId, date, today)
  const labelled = isLabelled(activity.status)
  const performed =
    activity.performed === true || activity.status === 'completed' || activity.status === 'partial'
  return { labelled, performed }
}

interface TaskRow {
  id: string
  text: string
}

/**
 * Find the days most like the target date and report what happened on them.
 */
export function similarDays(
  db: DatabaseSync,
  userId: number,
  date: string,
  today: string,
  row: CheckinRow | null | undefined,
): SimilarDaysResult {
  const target = answeredValues(row)
  if (Object.keys(target).length < MIN_OVERLAP) {
    return {
      available: false,
      reason: `Days like today need at least ${MIN_OVERLAP} answered fields; there are not enough yet.`,
      dayCount: 0,
      days: [],
      tasks: [],
      tags: [],
      line: null,
    }
  }

  const candidates = listCheckins(db, userId, 400)
    .filter((item) => item.date < date && item.skipped !== 1)
    .map((item) => ({ date: item.date, answers: answeredValues(item) }))

  const days = rankSimilarDays(date, target, candidates)
  if (days.length < MIN_SIMILAR_DAYS) {
    return {
      available: false,
      reason: `Only ${days.length} similar day${days.length === 1 ? '' : 's'} so far; at least ${MIN_SIMILAR_DAYS} are needed.`,
      dayCount: days.length,
      days,
      tasks: [],
      tags: [],
      line: null,
    }
  }

  const tasks = db
    .prepare('SELECT id, text FROM tasks WHERE user_id = ?')
    .all(userId) as unknown as TaskRow[]

  const taskOutcomes: SimilarOutcome[] = []
  const tagTallies = new Map<number, { performed: number; considered: number }>()

  for (const task of tasks) {
    let performedDays = 0
    let consideredDays = 0
    for (const day of days) {
      const { labelled, performed } = performedOn(db, userId, task.id, day.date, today)
      if (!labelled) continue
      consideredDays += 1
      if (performed) performedDays += 1
      const config = configForDate(db, task.id, day.date)
      if (!config) continue
      for (const tagId of configTagIds(db, config.id)) {
        const tally = tagTallies.get(tagId) ?? { performed: 0, considered: 0 }
        if (!labelled) continue
        tally.considered += 1
        if (performed) tally.performed += 1
        tagTallies.set(tagId, tally)
      }
    }
    if (consideredDays > 0) {
      taskOutcomes.push({ id: task.id, name: task.text, performedDays, consideredDays })
    }
  }

  taskOutcomes.sort((a, b) => b.performedDays - a.performedDays || a.name.localeCompare(b.name))

  const tagOutcomes: SimilarOutcome[] = []
  if (tagTallies.size > 0) {
    const tagRows = db
      .prepare('SELECT id, name FROM tags WHERE user_id = ? AND merged_into_id IS NULL')
      .all(userId) as unknown as Array<{ id: number; name: string }>
    for (const tag of tagRows) {
      const tally = tagTallies.get(tag.id)
      if (!tally || tally.considered === 0) continue
      tagOutcomes.push({
        id: String(tag.id),
        name: tag.name,
        performedDays: tally.performed,
        consideredDays: tally.considered,
      })
    }
    tagOutcomes.sort((a, b) => b.performedDays - a.performedDays || a.name.localeCompare(b.name))
  }

  const top = taskOutcomes.filter((task) => task.performedDays > 0).slice(0, 3)
  let line: string
  if (top.length === 0) {
    line = `On your ${days.length} most similar days, none of your current tasks had a clear "done" record.`
  } else {
    const parts = top.map((task) => `${task.name} on ${task.performedDays}`)
    line = `On your ${days.length} most similar days, you did ${parts.join(', ')}.`
  }

  return {
    available: true,
    reason: null,
    dayCount: days.length,
    days,
    tasks: taskOutcomes,
    tags: tagOutcomes,
    line,
  }
}
