import type { DatabaseSync } from 'node:sqlite'
import {
  LOOKBACK_DAYS,
  RECENT_WINDOW_DAYS,
  TIMING_BIN_MINUTES,
  TIMING_BINS,
  durationStats,
  gatherTaskDays,
  smoothedRate,
  userCompletionPrior,
  type GroupStatistics,
  type LabelledDay,
  type TimingProfile,
} from './statistics'
import { addDays, diffDays } from './off-days'
import { epochAtMinute } from './predictors'
import {
  DEFAULT_PREDICTION_MINUTE,
  MIN_TAG_OBSERVATIONS,
  SEASONAL_MIN_MONTHS,
  computeFeatures,
  featureNamesFor,
  gatherFeatureSnapshot,
  monthsBetween,
  type FeatureVocabulary,
} from './features'

/**
 * Training-set assembly.
 *
 * Turns the user's recorded days into supervised rows for the candidate models.
 * The rules this module exists to enforce, in code:
 *
 * - **Chronological only.** Rows are built day by day, and the features for a
 *   day use only days strictly before it. There is no shuffling and no random
 *   split anywhere in the training path.
 * - **Recency weighting.** Recent days carry more weight (an exponential decay),
 *   but long-term days are kept, so a slow drift is still visible.
 * - **Leak-free tag statistics.** Tag rates and durations are maintained by
 *   walking the days forward and only ever folding in days that already passed.
 * - **Vocabulary fixed here.** Tags with too few observations collapse into
 *   `tag_other`; the vocabulary (and the seasonal switch) is stored with the
 *   model so serving builds the identical vector.
 * - **Missing stays missing.** A day with no label contributes no completion
 *   row; a missing target or duration contributes no row of that kind.
 */

export const RECENT_WEIGHT_HALF_LIFE_DAYS = 60

export interface TrainingRow {
  taskId: string
  date: string
  features: number[]
  /** 1/0 completion label, or null when the day is not labelled. */
  completionLabel: number | null
  /** 1/0 target-achieved label, or null when there is no target/evidence. */
  targetLabel: number | null
  /** Completed minutes that day, or null when nothing was completed. */
  duration: number | null
  weight: number
}

export interface TrainingSet {
  rows: TrainingRow[]
  featureNames: string[]
  vocabulary: FeatureVocabulary
  taskIds: string[]
  from: string
  to: string
  monthsOfData: number
  labelledCount: number
  targetCount: number
  durationCount: number
}

export interface BuildTrainingOptions {
  /** Override the smoothing prior (defaults to the user's rate before `from`). */
  priorRate?: number
  recentHalfLifeDays?: number
}

function emptyTiming(): TimingProfile {
  return {
    bins: TIMING_BINS,
    binMinutes: TIMING_BIN_MINUTES,
    weights: new Array<number>(TIMING_BINS).fill(1 / TIMING_BINS),
    sessions: 0,
    peakBin: null,
  }
}

interface TagAccumulator {
  labelled: number
  successes: number
  durations: number[]
}

/** Fold one day into the running per-tag accumulators (used for later days only). */
function accumulateTags(accumulators: Map<string, TagAccumulator>, day: LabelledDay): void {
  if (day.offDay || day.performed === null) return
  for (const tagId of day.tagIds) {
    const key = String(tagId)
    const bucket = accumulators.get(key) ?? { labelled: 0, successes: 0, durations: [] }
    bucket.labelled += 1
    if (day.performed) bucket.successes += 1
    if (day.performed && day.totalMinutes > 0) bucket.durations.push(day.totalMinutes)
    accumulators.set(key, bucket)
  }
}

function tagStatisticsFrom(
  accumulators: Map<string, TagAccumulator>,
  priorRate: number,
): Map<string, GroupStatistics> {
  const out = new Map<string, GroupStatistics>()
  for (const [key, bucket] of accumulators) {
    out.set(key, {
      key,
      labelled: bucket.labelled,
      completion: smoothedRate(bucket.successes, bucket.labelled, priorRate),
      duration: durationStats(bucket.durations),
      timing: emptyTiming(),
    })
  }
  return out
}

/**
 * Build the chronological training set for a set of tasks over `[from, to]`.
 * `today` is the user's current local date (for the day-label cutoff).
 */
export function buildTrainingSet(
  db: DatabaseSync,
  userId: number,
  taskIds: string[],
  from: string,
  to: string,
  today: string,
  options: BuildTrainingOptions = {},
): TrainingSet {
  const priorRate = options.priorRate ?? userCompletionPrior(db, userId, taskIds, addDays(from, -1))
  const halfLife = options.recentHalfLifeDays ?? RECENT_WEIGHT_HALF_LIFE_DAYS

  const bounds = db
    .prepare('SELECT MIN(local_date) AS d FROM activity_sessions WHERE user_id = ?')
    .get(userId) as unknown as { d: string | null }
  const monthsOfData = monthsBetween(bounds.d ?? from, to)

  // Per-task labelled days over the lookback window, so each day can see its past.
  const daysByTask = new Map<string, LabelledDay[]>()
  const indexByTask = new Map<string, Map<string, number>>()
  for (const taskId of taskIds) {
    const days = gatherTaskDays(db, userId, taskId, addDays(from, -LOOKBACK_DAYS), to, today)
    daysByTask.set(taskId, days)
    const index = new Map<string, number>()
    days.forEach((day, i) => index.set(day.date, i))
    indexByTask.set(taskId, index)
  }

  // Vocabulary: tag observations on labelled days inside the window.
  const tagCounts = new Map<string, number>()
  for (const taskId of taskIds) {
    for (const day of daysByTask.get(taskId) ?? []) {
      if (day.date < from || day.date > to || day.offDay || day.performed === null) continue
      for (const id of day.tagIds) tagCounts.set(String(id), (tagCounts.get(String(id)) ?? 0) + 1)
    }
  }
  const vocabulary: FeatureVocabulary = {
    tags: [...tagCounts.entries()]
      .filter(([, count]) => count >= MIN_TAG_OBSERVATIONS)
      .map(([id]) => id)
      .sort((a, b) => Number(a) - Number(b)),
    seasonal: monthsOfData >= SEASONAL_MIN_MONTHS,
  }

  // Every (task, day) pair, ascending, for the leak-free tag walk.
  const pairs: Array<{ taskId: string; day: LabelledDay }> = []
  for (const taskId of taskIds) for (const day of daysByTask.get(taskId) ?? []) pairs.push({ taskId, day })
  pairs.sort((a, b) => (a.day.date < b.day.date ? -1 : a.day.date > b.day.date ? 1 : 0))

  const targetDates = [...new Set(pairs.filter((pair) => pair.day.date >= from && pair.day.date <= to).map((pair) => pair.day.date))].sort()

  const accumulators = new Map<string, TagAccumulator>()
  let pointer = 0
  const rows: TrainingRow[] = []

  for (const date of targetDates) {
    // Fold in every day strictly before this one before building its features.
    while (pointer < pairs.length && pairs[pointer].day.date < date) {
      accumulateTags(accumulators, pairs[pointer].day)
      pointer += 1
    }
    const tagStats = tagStatisticsFrom(accumulators, priorRate)
    const age = diffDays(date, to)
    const weight = Math.pow(0.5, Math.max(0, age) / halfLife)
    const asOfEpoch = epochAtMinute(date, DEFAULT_PREDICTION_MINUTE) - 1

    for (const taskId of taskIds) {
      const days = daysByTask.get(taskId) ?? []
      const index = indexByTask.get(taskId)?.get(date)
      if (index === undefined) continue
      const day = days[index]
      if (day.offDay || day.performed === null) continue

      const snapshot = gatherFeatureSnapshot(db, {
        userId,
        taskId,
        date,
        today,
        asOfEpoch,
        nowMinutes: DEFAULT_PREDICTION_MINUTE,
        priorRate,
        tagStats,
        monthsOfData,
        priorDays: days.slice(0, index),
      })
      rows.push({
        taskId,
        date,
        features: computeFeatures(snapshot, vocabulary),
        completionLabel: day.performed ? 1 : 0,
        targetLabel: day.targetAchieved === null ? null : day.targetAchieved ? 1 : 0,
        duration: day.performed && day.totalMinutes > 0 ? day.totalMinutes : null,
        weight,
      })
    }
  }

  return {
    rows,
    featureNames: featureNamesFor(vocabulary),
    vocabulary,
    taskIds,
    from,
    to,
    monthsOfData,
    labelledCount: rows.filter((row) => row.completionLabel !== null).length,
    targetCount: rows.filter((row) => row.targetLabel !== null).length,
    durationCount: rows.filter((row) => row.duration !== null).length,
  }
}

// Kept in one place so the dataset and serving cannot drift.
export { RECENT_WINDOW_DAYS }
