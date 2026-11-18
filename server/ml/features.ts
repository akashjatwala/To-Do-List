import type { DatabaseSync } from 'node:sqlite'
import {
  CHECKIN_ANSWER_KEYS,
  checkinState,
  getCheckin,
  type CheckinAnswerKey,
  type CheckinState,
  type CheckinRow,
} from '../checkins-store'
import { configForDate, configTagIds } from './task-config'
import { dailyActivity } from './daily-activity'
import { freeTimeBudget } from './predictors'
import { addDays, diffDays } from './off-days'
import {
  LOOKBACK_DAYS,
  activityStatistics,
  clamp01,
  gatherTaskDays,
  weekdayOf,
  type GroupStatistics,
  type LabelledDay,
} from './statistics'

/**
 * Feature engineering (Phase 5, §1).
 *
 * One module builds the feature vector for **both** training and serving, so a
 * model can never be fed something at serve time that it did not see while
 * training. The rules this file exists to enforce, in code:
 *
 * - Every feature is computed strictly from data available **before** the
 *   prediction time. History features use days strictly earlier than the day
 *   being predicted; today's progress counts only sessions that had already
 *   started by the prediction minute.
 * - A missing check-in value is encoded as **explicit missing** — an indicator
 *   column plus a neutral (zero-centred) value — never as a normal or positive
 *   answer. The same holds for a missing priority, target, duration, tag or
 *   timing profile.
 * - Tags are multi-hot against a vocabulary fixed at training time; tags with
 *   too few observations collapse into `tag_other`, and a task with no tags is
 *   flagged `tag_missing`. Tag-level rates and durations come only from earlier
 *   days.
 * - Priority is an ordinal taken from the value that applied **on that day**
 *   (the versioned config), never a later edit.
 * - Recommendation exposure (shown / exploratory / followed) is summarised from
 *   earlier days as features, and used directly for evaluation. Following a
 *   recommendation is an outcome, so the *same-day* followed flag is never a
 *   training feature: it is not known at prediction time and would leak.
 * - Seasonal features are included only once at least a year of data exists.
 *
 * `computeFeatures` is pure. `gatherFeatureSnapshot` reads the database once and
 * returns the plain snapshot the pure function consumes.
 */

export const FEATURE_VERSION = 'phase5-1.0.0'
/** A tag needs at least this many labelled observations to earn its own column. */
export const MIN_TAG_OBSERVATIONS = 8
/** Seasonal features appear only once this many months of data exist. */
export const SEASONAL_MIN_MONTHS = 12
/** The default prediction time: 08:00 local. */
export const DEFAULT_PREDICTION_MINUTE = 8 * 60
export const EXPOSURE_WINDOW_DAYS = 14

export interface FeatureVocabulary {
  /** Tag ids (as strings) with enough observations to earn their own column. */
  tags: string[]
  /** Whether seasonal features are included (at least a year of data). */
  seasonal: boolean
}

export const EMPTY_VOCABULARY: FeatureVocabulary = { tags: [], seasonal: false }

export interface FeatureStats {
  labelledDays: number
  completionRate: number
  recentRate: number
  decayedRate: number | null
  consistency: number | null
  durationMean: number | null
  durationMedian: number | null
  /** Least-squares slope of duration over recent completions, minutes per day. */
  durationTrend: number | null
  targetRate: number | null
  daysSinceLastCompletion: number | null
  recentMisses: number
  weekdayRate: number
  peakBin: number | null
  timingConcentration: number | null
  /** Weighted completion rate of the task's tags, from earlier days. */
  tagCompletionRate: number | null
  /** Weighted median duration of the task's tags, from earlier days. */
  tagDurationMedian: number | null
}

export interface ExposureStats {
  shownRecent: number
  exploratoryRecent: number
  followedRate: number | null
}

export interface FeatureSnapshot {
  taskId: string
  date: string
  weekday: number
  stats: FeatureStats
  targetMinutes: number | null
  /** Minutes already recorded today, as of the prediction time. */
  progressMinutes: number
  remainingTarget: number | null
  nowMinutes: number
  freeTimeMinutes: number | null
  answers: Partial<Record<CheckinAnswerKey, number>> | null
  checkinState: CheckinState
  priority: string | null
  tagIds: number[]
  exposure: ExposureStats
  monthsOfData: number
}

// ---------------------------------------------------------------------------
// The feature specification
// ---------------------------------------------------------------------------

interface FeatureSpec {
  name: string
  value: (snapshot: FeatureSnapshot) => number
}

const PRIORITY_LEVEL: Record<string, number> = { low: 0.25, medium: 0.5, high: 0.75, urgent: 1 }

function scaledDuration(minutes: number | null): number {
  if (minutes === null || !Number.isFinite(minutes)) return 0
  return clamp01(minutes / 120)
}

function scaledCount(value: number, cap: number): number {
  return clamp01(value / cap)
}

/** The goodness of an answer (1 best … 5 worst → 2 … −2), zero-centred. */
function centeredGoodness(answers: Partial<Record<CheckinAnswerKey, number>> | null, key: CheckinAnswerKey): number {
  const value = answers?.[key]
  if (value === undefined) return 0
  return ((6 - value) - 3) / 2
}

function isMissing(answers: Partial<Record<CheckinAnswerKey, number>> | null, key: CheckinAnswerKey): number {
  return answers?.[key] === undefined ? 1 : 0
}

function buildBaseSpec(): FeatureSpec[] {
  const spec: FeatureSpec[] = [
    { name: 'labelled_days', value: (s) => scaledCount(s.stats.labelledDays, 30) },
    { name: 'completion_rate', value: (s) => clamp01(s.stats.completionRate) },
    { name: 'recent_completion_rate', value: (s) => clamp01(s.stats.recentRate) },
    { name: 'decayed_completion_rate', value: (s) => clamp01(s.stats.decayedRate ?? 0) },
    { name: 'decayed_missing', value: (s) => (s.stats.decayedRate === null ? 1 : 0) },
    { name: 'consistency', value: (s) => clamp01(s.stats.consistency ?? 0) },
    { name: 'consistency_missing', value: (s) => (s.stats.consistency === null ? 1 : 0) },
    { name: 'duration_mean', value: (s) => scaledDuration(s.stats.durationMean) },
    { name: 'duration_median', value: (s) => scaledDuration(s.stats.durationMedian) },
    { name: 'duration_trend', value: (s) => (s.stats.durationTrend === null ? 0 : Math.max(-1, Math.min(1, s.stats.durationTrend / 30))) },
    { name: 'duration_trend_missing', value: (s) => (s.stats.durationTrend === null ? 1 : 0) },
    { name: 'target_rate', value: (s) => clamp01(s.stats.targetRate ?? 0) },
    { name: 'target_rate_missing', value: (s) => (s.stats.targetRate === null ? 1 : 0) },
    { name: 'days_since_last_completion', value: (s) => (s.stats.daysSinceLastCompletion === null ? 0 : scaledCount(s.stats.daysSinceLastCompletion, 30)) },
    { name: 'never_completed', value: (s) => (s.stats.daysSinceLastCompletion === null ? 1 : 0) },
    { name: 'recent_misses', value: (s) => scaledCount(s.stats.recentMisses, 10) },
    { name: 'weekday_rate', value: (s) => clamp01(s.stats.weekdayRate) },
    { name: 'timing_peak', value: (s) => (s.stats.peakBin === null ? 0 : s.stats.peakBin / 12) },
    { name: 'timing_peak_missing', value: (s) => (s.stats.peakBin === null ? 1 : 0) },
    { name: 'timing_concentration', value: (s) => clamp01(s.stats.timingConcentration ?? 0) },
    { name: 'tag_completion_rate', value: (s) => clamp01(s.stats.tagCompletionRate ?? 0) },
    { name: 'tag_duration_median', value: (s) => scaledDuration(s.stats.tagDurationMedian) },
    { name: 'tag_stats_missing', value: (s) => (s.stats.tagCompletionRate === null ? 1 : 0) },
    { name: 'today_progress', value: (s) => (s.targetMinutes !== null && s.targetMinutes > 0 ? clamp01(s.progressMinutes / s.targetMinutes) : scaledDuration(s.progressMinutes)) },
    { name: 'target_minutes', value: (s) => scaledDuration(s.targetMinutes) },
    { name: 'target_missing', value: (s) => (s.targetMinutes === null ? 1 : 0) },
    { name: 'remaining_target', value: (s) => scaledDuration(s.remainingTarget) },
    { name: 'remaining_missing', value: (s) => (s.remainingTarget === null ? 1 : 0) },
    { name: 'remaining_ratio', value: (s) => (s.remainingTarget !== null && s.targetMinutes ? clamp01(s.remainingTarget / s.targetMinutes) : 0) },
    { name: 'minutes_left_in_day', value: (s) => clamp01((24 * 60 - s.nowMinutes) / (24 * 60)) },
    { name: 'free_time_budget', value: (s) => scaledDuration(s.freeTimeMinutes) },
    { name: 'free_time_missing', value: (s) => (s.freeTimeMinutes === null ? 1 : 0) },
    { name: 'checkin_any_answered', value: (s) => (s.answers && Object.keys(s.answers).length > 0 ? 1 : 0) },
    { name: 'checkin_skipped', value: (s) => (s.checkinState === 'skipped' ? 1 : 0) },
    { name: 'priority_level', value: (s) => (s.priority === null ? 0 : (PRIORITY_LEVEL[s.priority] ?? 0)) },
    { name: 'priority_missing', value: (s) => (s.priority === null ? 1 : 0) },
    { name: 'exposure_shown_recent', value: (s) => scaledCount(s.exposure.shownRecent, EXPOSURE_WINDOW_DAYS) },
    { name: 'exposure_exploratory_recent', value: (s) => scaledCount(s.exposure.exploratoryRecent, EXPOSURE_WINDOW_DAYS) },
    { name: 'exposure_followed_rate', value: (s) => clamp01(s.exposure.followedRate ?? 0) },
    { name: 'exposure_followed_missing', value: (s) => (s.exposure.followedRate === null ? 1 : 0) },
  ]
  for (const key of CHECKIN_ANSWER_KEYS) {
    spec.push({ name: `checkin_${key}`, value: (s) => centeredGoodness(s.answers, key) })
    spec.push({ name: `checkin_${key}_missing`, value: (s) => isMissing(s.answers, key) })
  }
  return spec
}

const BASE_SPEC: FeatureSpec[] = buildBaseSpec()
const SEASONAL_NAMES = ['season_sin', 'season_cos'] as const

export function baseFeatureNames(): string[] {
  return BASE_SPEC.map((spec) => spec.name)
}

export function tagFeatureNames(vocabulary: FeatureVocabulary): string[] {
  return [...vocabulary.tags.map((id) => `tag_${id}`), 'tag_other', 'tag_missing']
}

/** The full, ordered feature list for a vocabulary. Persisted with the model. */
export function featureNamesFor(vocabulary: FeatureVocabulary): string[] {
  return [...baseFeatureNames(), ...tagFeatureNames(vocabulary), ...(vocabulary.seasonal ? [...SEASONAL_NAMES] : [])]
}

function tagValues(snapshot: FeatureSnapshot, vocabulary: FeatureVocabulary): number[] {
  const present = new Set(snapshot.tagIds.map(String))
  const columns = vocabulary.tags.map((id) => (present.has(id) ? 1 : 0))
  const anyKnown = vocabulary.tags.some((id) => present.has(id))
  const hasTags = snapshot.tagIds.length > 0
  columns.push(hasTags && !anyKnown ? 1 : 0)
  columns.push(hasTags ? 0 : 1)
  return columns
}

function dayOfYear(date: string): number {
  const [year, month, day] = date.split('-').map(Number)
  const start = Date.UTC(year, 0, 1)
  const current = Date.UTC(year, month - 1, day)
  return Math.round((current - start) / 86_400_000) + 1
}

function seasonalValues(snapshot: FeatureSnapshot): number[] {
  const angle = (2 * Math.PI * dayOfYear(snapshot.date)) / 365.25
  return [Math.sin(angle), Math.cos(angle)]
}

/**
 * Build the feature vector for a snapshot. Pure: the same snapshot and
 * vocabulary always give the same vector, and it is exactly what training saw.
 */
export function computeFeatures(snapshot: FeatureSnapshot, vocabulary: FeatureVocabulary): number[] {
  const out = BASE_SPEC.map((spec) => spec.value(snapshot))
  out.push(...tagValues(snapshot, vocabulary))
  if (vocabulary.seasonal) out.push(...seasonalValues(snapshot))
  return out
}

// ---------------------------------------------------------------------------
// Gathering the snapshot from the database
// ---------------------------------------------------------------------------

function tableExists(db: DatabaseSync, name: string): boolean {
  return (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined
  )
}

function answersOf(row: CheckinRow): Partial<Record<CheckinAnswerKey, number>> {
  const out: Partial<Record<CheckinAnswerKey, number>> = {}
  for (const key of CHECKIN_ANSWER_KEYS) {
    const value = row[key]
    if (value !== null) out[key] = value
  }
  return out
}

/**
 * Recommendation exposure over a window of **earlier** days, read from the real
 * feedback trail.
 */
export function gatherExposure(
  db: DatabaseSync,
  userId: number,
  taskId: string,
  from: string,
  to: string,
): ExposureStats {
  let shown = 0
  let exploratory = 0
  let followed = 0
  let ignored = 0

  if (tableExists(db, 'prediction_feedback')) {
    const rows = db
      .prepare(
        `SELECT exploratory, shown, followed FROM prediction_feedback
         WHERE user_id = ? AND task_id = ? AND local_date >= ? AND local_date <= ?`,
      )
      .all(userId, taskId, from, to) as unknown as Array<{ exploratory: number; shown: number; followed: number | null }>
    for (const row of rows) {
      if (row.shown) shown += 1
      if (row.exploratory) exploratory += 1
      if (row.followed === 1) followed += 1
      if (row.followed === 0) ignored += 1
    }
  }

  const denominator = followed + ignored
  return { shownRecent: shown, exploratoryRecent: exploratory, followedRate: denominator > 0 ? followed / denominator : null }
}

/** Least-squares slope of completed durations over time (minutes per day). */
export function durationTrend(days: LabelledDay[]): number | null {
  const points = days
    .filter((day) => !day.offDay && day.performed === true && day.totalMinutes > 0)
    .sort((a, b) => (a.date < b.date ? -1 : 1))
  if (points.length < 4) return null
  const n = points.length
  const meanX = (n - 1) / 2
  const meanY = points.reduce((sum, day) => sum + day.totalMinutes, 0) / n
  let numerator = 0
  let denominator = 0
  for (let i = 0; i < n; i += 1) {
    numerator += (i - meanX) * (points[i].totalMinutes - meanY)
    denominator += (i - meanX) ** 2
  }
  if (denominator === 0) return null
  return numerator / denominator
}

/** Peak timing concentration (largest smoothed bin weight), or null. */
function timingConcentration(weights: number[]): number | null {
  if (weights.length === 0) return null
  return Math.max(...weights)
}

function weightedTagValue(groups: GroupStatistics[], pick: (group: GroupStatistics) => number | null): number | null {
  let weightSum = 0
  let sum = 0
  for (const group of groups) {
    const value = pick(group)
    if (value === null || group.labelled <= 0) continue
    sum += value * group.labelled
    weightSum += group.labelled
  }
  return weightSum > 0 ? sum / weightSum : null
}

export interface GatherFeatureOptions {
  userId: number
  taskId: string
  date: string
  /** The user's current local date, used as the day-label cutoff. */
  today: string
  /** Leak-free cutoff for today's progress, in epoch ms. */
  asOfEpoch: number
  /** Local time-of-day in minutes when the prediction is made. */
  nowMinutes: number
  priorRate: number
  tagStats?: Map<string, GroupStatistics>
  monthsOfData: number
  /** Days strictly before `date`, when the caller has them already. */
  priorDays?: LabelledDay[]
  stage2MinDays?: number
}

/**
 * Read everything the features need for one (task, day), using only data
 * available before the prediction time. Nothing is written.
 */
export function gatherFeatureSnapshot(db: DatabaseSync, options: GatherFeatureOptions): FeatureSnapshot {
  const { userId, taskId, date, today } = options
  const previous = addDays(date, -1)
  const from = addDays(date, -LOOKBACK_DAYS)
  const priorDays = options.priorDays ?? gatherTaskDays(db, userId, taskId, from, previous, today)

  const stats = activityStatistics(db, userId, taskId, today, options.priorRate, {
    from,
    to: previous,
    days: priorDays,
    stage2MinDays: options.stage2MinDays,
  })

  const config = configForDate(db, taskId, date)
  const tagIds = config ? configTagIds(db, config.id) : []
  const tagGroups = (options.tagStats ? tagIds.map((id) => options.tagStats!.get(String(id))) : []).filter(
    (group): group is GroupStatistics => group !== undefined,
  )

  const checkinRow = getCheckin(db, userId, date)
  const answers = checkinRow && checkinRow.skipped === 0 ? answersOf(checkinRow) : null
  const state: CheckinState = checkinRow ? checkinState(checkinRow) : 'not_asked'

  const day = dailyActivity(db, userId, taskId, date, today, { asOf: options.asOfEpoch })
  const targetMinutes = config?.target_duration ?? null
  const remainingTarget = targetMinutes === null ? null : Math.max(0, targetMinutes - day.totalMinutes)
  const exposure = gatherExposure(db, userId, taskId, addDays(date, -EXPOSURE_WINDOW_DAYS), previous)

  return {
    taskId,
    date,
    weekday: weekdayOf(date),
    stats: {
      labelledDays: stats.labelledDays,
      completionRate: stats.completion.rate,
      recentRate: stats.recent.rate,
      decayedRate: stats.decayedRate,
      consistency: stats.consistency,
      durationMean: stats.duration.mean,
      durationMedian: stats.duration.median,
      durationTrend: durationTrend(priorDays),
      targetRate: stats.target?.rate ?? null,
      daysSinceLastCompletion: stats.daysSinceLastCompletion,
      recentMisses: stats.recentMisses,
      weekdayRate: stats.weekdayRates[weekdayOf(date)]?.rate ?? options.priorRate,
      peakBin: stats.timing.peakBin,
      timingConcentration: timingConcentration(stats.timing.weights),
      tagCompletionRate: weightedTagValue(tagGroups, (group) => group.completion.rate),
      tagDurationMedian: weightedTagValue(tagGroups, (group) => group.duration.median),
    },
    targetMinutes,
    progressMinutes: day.totalMinutes,
    remainingTarget,
    nowMinutes: options.nowMinutes,
    freeTimeMinutes: freeTimeBudget(answers),
    answers,
    checkinState: state,
    priority: config?.priority ?? null,
    tagIds,
    exposure,
    monthsOfData: options.monthsOfData,
  }
}

/** Months of calendar data spanned between two dates. */
export function monthsBetween(from: string, to: string): number {
  return Math.max(0, diffDays(from, to)) / 30.44
}
