import type { DatabaseSync } from 'node:sqlite'
import { getCheckin, listCheckins, type CheckinRow } from '../checkins-store'
import {
  baselineComparison,
  learnedWeights,
  readinessAssociation,
  readinessFromCheckin,
  type AssociationResult,
  type BaselineComparison,
  type LearnedWeights,
  type ReadinessScore,
} from './readiness'
import { estimatesFor, type EstimatesResult } from './estimates'
import { similarDays, type SimilarDaysResult } from './similar-days'
import { recentContext, type RecentContextResult } from './recent-context'
import {
  getDayReview,
  reviewAlignment,
  type DayReviewAnswer,
  type ReviewAlignment,
} from './day-review'
import { dailyActivity } from './daily-activity'

/**
 * The daily-state layer (Phase 2a) — the single read-only view that ties the
 * pieces together for one day.
 *
 * It never writes to the check-in tables. Everything here is derived on demand
 * from what the user actually reported, plus their own history. Estimates for
 * skipped fields are returned alongside the summary but are never stored in a
 * check-in record and never treated as if the user had reported them.
 *
 * The turn-on-when-data-allows items (per-tag weights, smarter estimates,
 * low-capacity suggestions) are reported here but stay off below their
 * configurable minimums, so the simple versions always continue.
 */

export interface StatePrefs {
  showSummary: boolean
  showEstimates: boolean
}

export function getStatePrefs(db: DatabaseSync, userId: number): StatePrefs {
  const row = db
    .prepare('SELECT show_summary, show_estimates FROM state_prefs WHERE user_id = ?')
    .get(userId) as unknown as { show_summary: number; show_estimates: number } | undefined
  if (!row) return { showSummary: true, showEstimates: true }
  return { showSummary: row.show_summary === 1, showEstimates: row.show_estimates === 1 }
}

export function saveStatePrefs(
  db: DatabaseSync,
  userId: number,
  input: Partial<StatePrefs>,
  now = Date.now(),
): StatePrefs {
  const current = getStatePrefs(db, userId)
  const next: StatePrefs = {
    showSummary: input.showSummary ?? current.showSummary,
    showEstimates: input.showEstimates ?? current.showEstimates,
  }
  db.prepare(
    `INSERT INTO state_prefs (user_id, show_summary, show_estimates, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       show_summary = excluded.show_summary,
       show_estimates = excluded.show_estimates,
       updated_at = excluded.updated_at`,
  ).run(userId, next.showSummary ? 1 : 0, next.showEstimates ? 1 : 0, now)
  return next
}

export interface LowCapacitySuggestion {
  key: string
  taskId: string | null
  label: string
}

export interface LowCapacitySuggestions {
  enabled: boolean
  reason: string
  capacityScore: number | null
  suggestions: LowCapacitySuggestion[]
  choices: Array<{ key: string; choice: 'accepted' | 'dismissed' }>
}

/** Minimum labelled days before low-capacity suggestions may appear. */
export const MIN_SUGGESTION_DAYS = 14
/** Capacity sub-score at or below which the day counts as low-capacity. */
export const LOW_CAPACITY_THRESHOLD = 40

function labelledDayCount(db: DatabaseSync, userId: number, date: string): number {
  return listCheckins(db, userId, 400).filter((row) => row.date < date && row.skipped !== 1).length
}

/** 0–1 share of labelled tasks the user actually did that day, or null. */
export function completionRateForDate(
  db: DatabaseSync,
  userId: number,
  date: string,
  today: string,
): number | null {
  const tasks = db.prepare('SELECT id FROM tasks WHERE user_id = ?').all(userId) as unknown as Array<{ id: string }>
  let performed = 0
  let considered = 0
  for (const task of tasks) {
    const activity = dailyActivity(db, userId, task.id, date, today)
    if (activity.status === 'pending' || activity.status === 'unknown') continue
    considered += 1
    if (activity.performed === true || activity.status === 'completed' || activity.status === 'partial') {
      performed += 1
    }
  }
  return considered === 0 ? null : performed / considered
}

function lowCapacitySuggestions(
  db: DatabaseSync,
  userId: number,
  date: string,
  capacityScore: number | null,
  similar: SimilarDaysResult,
): LowCapacitySuggestions {
  const choices = (
    db
      .prepare('SELECT suggestion_key, choice FROM state_suggestion_choices WHERE user_id = ? AND local_date = ?')
      .all(userId, date) as unknown as Array<{ suggestion_key: string; choice: 'accepted' | 'dismissed' }>
  ).map((row) => ({ key: row.suggestion_key, choice: row.choice }))

  const labelled = labelledDayCount(db, userId, date)
  if (capacityScore === null || capacityScore > LOW_CAPACITY_THRESHOLD) {
    return {
      enabled: false,
      reason: 'Suggestions only appear on low-capacity days, and only as an offer.',
      capacityScore,
      suggestions: [],
      choices,
    }
  }
  if (labelled < MIN_SUGGESTION_DAYS) {
    return {
      enabled: false,
      reason: `Low-capacity suggestions stay off until there are ${MIN_SUGGESTION_DAYS} labelled days (there are ${labelled}).`,
      capacityScore,
      suggestions: [],
      choices,
    }
  }
  if (!similar.available) {
    return {
      enabled: false,
      reason: 'Low-capacity suggestions need enough similar days to know what usually still happens.',
      capacityScore,
      suggestions: [],
      choices,
    }
  }

  const suggestions: LowCapacitySuggestion[] = []
  for (const task of similar.tasks) {
    if (task.performedDays === 0 || task.consideredDays === 0) continue
    if (task.performedDays / task.consideredDays < 0.5) continue
    suggestions.push({
      key: `task:${task.id}`,
      taskId: task.id,
      label: `${task.name} — you usually still manage this on days like today`,
    })
    if (suggestions.length >= 3) break
  }
  if (suggestions.length === 0) {
    return {
      enabled: false,
      reason: 'No task reliably still happens on similar days, so nothing is suggested.',
      capacityScore,
      suggestions: [],
      choices,
    }
  }
  return {
    enabled: true,
    reason: 'Offered only — nothing is changed or dropped for you.',
    capacityScore,
    suggestions,
    choices,
  }
}

export interface DailyState {
  date: string
  today: string
  prefs: StatePrefs
  /** The plain-language summary and score, from answered fields only. */
  summary: {
    shown: boolean
    readiness: ReadinessScore
    baseline: BaselineComparison
  }
  /** Display-only estimates for skipped fields, never stored as answers. */
  estimates: EstimatesResult & { shown: boolean }
  similarDays: SimilarDaysResult
  recentContext: RecentContextResult
  association: AssociationResult
  review: { date: string; answer: DayReviewAnswer } | null
  reviewAlignment: ReviewAlignment
  advanced: {
    perTagWeights: LearnedWeights
    smarterEstimates: { enabled: boolean; reason: string }
    lowCapacity: LowCapacitySuggestions
  }
}

/**
 * Build the whole read-only state for a day. `today` is the user's local date,
 * used as the evaluation cutoff so future or pending days never leak in.
 */
export function dailyState(
  db: DatabaseSync,
  userId: number,
  date: string,
  today: string,
): DailyState {
  const row: CheckinRow | undefined = getCheckin(db, userId, date)
  const prefs = getStatePrefs(db, userId)
  const readiness = readinessFromCheckin(row)
  const baseline = baselineComparison(db, userId, date, readiness.score)

  const estimatesBase = estimatesFor(db, userId, date, row)
  const estimates = { ...estimatesBase, shown: prefs.showEstimates && estimatesBase.shown }

  const similar = similarDays(db, userId, date, today, row)
  const context = recentContext(db, userId, date)

  const outcome = (day: string) => completionRateForDate(db, userId, day, today)
  const association = readinessAssociation(db, userId, date, outcome)
  const weights = learnedWeights(db, userId, date, outcome)

  const labelled = labelledDayCount(db, userId, date)
  const smarterEstimates =
    labelled >= 30 && estimatesBase.beatsBaseline === true
      ? { enabled: false, reason: 'Smarter estimates are not enabled in this build; the simple estimates continue.' }
      : {
          enabled: false,
          reason: `Smarter estimates stay off until there are at least 30 labelled days and they beat the simple estimates (there are ${labelled} days).`,
        }

  const reviewRow = getDayReview(db, userId, date)
  const review = reviewRow ? { date: reviewRow.local_date, answer: reviewRow.answer } : null
  const alignment = reviewAlignment(db, userId, date)

  return {
    date,
    today,
    prefs,
    summary: { shown: prefs.showSummary, readiness, baseline },
    estimates,
    similarDays: similar,
    recentContext: context,
    association,
    review,
    reviewAlignment: alignment,
    advanced: {
      perTagWeights: weights,
      smarterEstimates,
      lowCapacity: lowCapacitySuggestions(db, userId, date, readiness.subScores.find((s) => s.name === 'capacity')?.score ?? null, similar),
    },
  }
}
