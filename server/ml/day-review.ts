import type { DatabaseSync } from 'node:sqlite'
import { listCheckins } from '../checkins-store'
import { readinessFromCheckin } from './readiness'

/**
 * End-of-day check (Phase 2a).
 *
 * One optional tap in the evening: how did today go compared with this morning?
 * It is stored in its own table, keyed by user and date. It **never** overwrites
 * the morning check-in, and a day with no answer simply has no row — missing
 * stays missing. Asking happens once; there are no repeated reminders.
 *
 * The review is also the honest feedback signal for the state layer: it lets us
 * check whether the morning score and estimates lined up with how the day
 * actually felt, and how often the state changes between morning and evening.
 */

export const DAY_REVIEW_ANSWERS = [
  'much_better',
  'better',
  'about_same',
  'worse',
  'much_worse',
] as const

export type DayReviewAnswer = (typeof DAY_REVIEW_ANSWERS)[number]

export interface DayReviewRow {
  id: number
  user_id: number
  local_date: string
  answer: DayReviewAnswer
  created_at: number
  updated_at: number
}

/** Signed value of a review, higher = the day went better than the morning. */
export const REVIEW_VALUE: Record<DayReviewAnswer, number> = {
  much_better: 2,
  better: 1,
  about_same: 0,
  worse: -1,
  much_worse: -2,
}

export function parseDayReviewAnswer(value: unknown): DayReviewAnswer | undefined {
  if (typeof value !== 'string') return undefined
  return (DAY_REVIEW_ANSWERS as readonly string[]).includes(value) ? (value as DayReviewAnswer) : undefined
}

export function getDayReview(db: DatabaseSync, userId: number, date: string): DayReviewRow | undefined {
  return db
    .prepare('SELECT * FROM day_reviews WHERE user_id = ? AND local_date = ?')
    .get(userId, date) as unknown as DayReviewRow | undefined
}

/**
 * Record the evening review. Idempotent per day: a second tap updates the same
 * row rather than creating a second one. The morning check-in is untouched.
 */
export function saveDayReview(
  db: DatabaseSync,
  userId: number,
  date: string,
  answer: DayReviewAnswer,
  now = Date.now(),
): DayReviewRow {
  db.prepare(
    `INSERT INTO day_reviews (user_id, local_date, answer, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id, local_date) DO UPDATE SET
       answer = excluded.answer,
       updated_at = excluded.updated_at`,
  ).run(userId, date, answer, now, now)
  return getDayReview(db, userId, date)!
}

export function listDayReviews(db: DatabaseSync, userId: number, limit = 400): DayReviewRow[] {
  return db
    .prepare('SELECT * FROM day_reviews WHERE user_id = ? ORDER BY local_date DESC LIMIT ?')
    .all(userId, limit) as unknown as DayReviewRow[]
}

export interface ReviewAlignment {
  /** Days with both a check-in and a review. */
  sample: number
  /** Correlation between the morning score and the review; null when unclear. */
  correlation: number | null
  /** Share of reviewed days where the state changed (not "about the same"). */
  changeRate: number | null
  note: string
}

function pearson(pairs: Array<[number, number]>): number | null {
  const n = pairs.length
  if (n < 2) return null
  const meanX = pairs.reduce((s, [x]) => s + x, 0) / n
  const meanY = pairs.reduce((s, [, y]) => s + y, 0) / n
  let num = 0
  let denX = 0
  let denY = 0
  for (const [x, y] of pairs) {
    const dx = x - meanX
    const dy = y - meanY
    num += dx * dy
    denX += dx * dx
    denY += dy * dy
  }
  if (denX === 0 || denY === 0) return null
  return num / Math.sqrt(denX * denY)
}

/** Minimum reviewed days before any alignment claim is made. */
export const MIN_ALIGNMENT_REVIEWS = 5

/**
 * Check whether the morning score lined up with the evening review, and how
 * often the day differed from the morning. Honest about small samples.
 */
export function reviewAlignment(db: DatabaseSync, userId: number, date: string): ReviewAlignment {
  const reviews = listDayReviews(db, userId).filter((review) => review.local_date < date)
  const byDate = new Map(reviews.map((review) => [review.local_date, review.answer]))
  const pairs: Array<[number, number]> = []
  let changed = 0
  for (const row of listCheckins(db, userId, 400)) {
    const answer = byDate.get(row.date)
    if (!answer) continue
    const score = readinessFromCheckin(row).score
    if (score === null) continue
    pairs.push([score, REVIEW_VALUE[answer]])
    if (answer !== 'about_same') changed += 1
  }

  if (pairs.length < MIN_ALIGNMENT_REVIEWS) {
    return {
      sample: pairs.length,
      correlation: null,
      changeRate: null,
      note: `Not enough evening reviews yet to check how well the score matched the day (${pairs.length} of ${MIN_ALIGNMENT_REVIEWS}).`,
    }
  }

  const correlation = pearson(pairs)
  const changeRate = changed / pairs.length
  const changeLine = `On ${Math.round(changeRate * 100)}% of reviewed days the evening felt different from the morning.`
  let note: string
  if (correlation !== null && correlation >= 0.3) {
    note = `The morning score has tended to line up with how the day went. ${changeLine}`
  } else {
    note = `So far the morning score has not clearly predicted how the day felt. ${changeLine}`
  }
  return { sample: pairs.length, correlation, changeRate, note }
}
