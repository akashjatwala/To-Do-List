import type { DatabaseSync } from 'node:sqlite'
import {
  CHECKIN_ANSWER_KEYS,
  parseAnswer,
  type CheckinAnswerKey,
} from '../checkins-store'
import { configTagIds, endOfLocalDay, listTaskConfigs, type TaskConfigRow } from './task-config'
import { deriveDailyActivity, type ExplicitStatus } from './daily-activity'
import { listSessions, type SessionRow } from './sessions'
import { addDays as addDaysPure, diffDays, offDayDates, type OffDayKind } from './off-days'

/**
 * Personal statistics.
 *
 * Everything here is derived from the user's **own** recorded days. Nothing is
 * imported from other people, nothing is invented, and an off day is left out of
 * every rate (it is still counted, separately, as an off day). A day only enters
 * a rate when it is *labelled*: the user performed the activity or explicitly
 * said they did not. `unknown` and `pending` days are never treated as a miss.
 *
 * The module is split into pure maths (rates, durations, timing, mood) and a
 * gather step that reads the user's rows once. Predictors consume
 * these statistics; nothing here writes to the database.
 */

export const LOOKBACK_DAYS = 365
export const RECENT_WINDOW_DAYS = 14
export const DECAY_HALF_LIFE_DAYS = 21
export const TIMING_BINS = 12
export const TIMING_BIN_MINUTES = 120
/** Pseudo-observations of the prior. Small, so real data quickly outweighs it. */
export const PRIOR_WEIGHT = 3
export const MIN_MOOD_GROUP = 3
export const CONSISTENCY_WEEKS = 8

/** A day of real activity, reduced to what the statistics need. */
export interface LabelledDay {
  date: string
  /** true/false when the day is labelled; null when it is not. */
  performed: boolean | null
  targetAchieved: boolean | null
  totalMinutes: number
  /** Local time-of-day in minutes for each session that day. */
  sessionStarts: number[]
  offDay: boolean
  offDayKind: OffDayKind | null
  targetMinutes: number | null
  priority: string | null
  tagIds: number[]
  /** Check-in answers for the day, or null when there was none/skipped. */
  answers: Partial<Record<CheckinAnswerKey, number>> | null
}

export interface RateEstimate {
  /** Smoothed completion probability. */
  rate: number
  /** Raw rate over labelled days, or null when there are none. */
  raw: number | null
  labelled: number
  successes: number
  priorWeight: number
}

export interface DurationStats {
  count: number
  median: number | null
  mean: number | null
  /** Empirical 25th / 75th percentile, for an honest interval. */
  low: number | null
  high: number | null
}

export interface TimingProfile {
  bins: number
  binMinutes: number
  /** Smoothed weights over the bins; sums to 1. */
  weights: number[]
  sessions: number
  peakBin: number | null
}

export interface WeekdayRate {
  weekday: number
  rate: number
  labelled: number
}

export interface MoodGroup {
  /** The stored answer, 1 (best) to 5 (worst). */
  value: number
  days: number
  completionRate: number
}

export interface MoodAssociation {
  field: CheckinAnswerKey
  groups: MoodGroup[]
  /** The value with the highest / lowest observed completion rate. */
  best: number | null
  worst: number | null
  /** True only when at least two groups have enough observations. */
  enough: boolean
}

export interface GroupStatistics {
  key: string
  labelled: number
  completion: RateEstimate
  duration: DurationStats
  timing: TimingProfile
}

export interface ActivityStatistics {
  taskId: string
  from: string
  to: string
  /** Labelled days, off days excluded. */
  labelledDays: number
  offDays: number
  completion: RateEstimate
  recent: RateEstimate
  /** Exponential-decay-weighted completion rate. */
  decayedRate: number | null
  target: RateEstimate | null
  duration: DurationStats
  weekdayRates: WeekdayRate[]
  daysSinceLastCompletion: number | null
  recentMisses: number
  /** Share of the last weeks with data in which the activity happened at least once. */
  consistency: number | null
  timing: TimingProfile
  mood: MoodAssociation[]
  /** Enough labelled days to leave stage 1. */
  enough: boolean
}

// ---------------------------------------------------------------------------
// Pure maths
// ---------------------------------------------------------------------------

/**
 * Beta-style smoothing: blend the observed rate with a prior (the user's own
 * overall rate). With no personal data the prior stands alone; as labelled days
 * accumulate the prior fades.
 */
export function smoothedRate(
  successes: number,
  labelled: number,
  priorRate: number,
  priorWeight = PRIOR_WEIGHT,
): RateEstimate {
  const total = labelled + priorWeight
  const rate = total > 0 ? (successes + priorRate * priorWeight) / total : priorRate
  return {
    rate: clamp01(rate),
    raw: labelled > 0 ? successes / labelled : null,
    labelled,
    successes,
    priorWeight,
  }
}

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1, value))
}

/** Quantile of an ascending-sorted array using linear interpolation. */
export function quantile(sorted: number[], q: number): number | null {
  if (sorted.length === 0) return null
  if (sorted.length === 1) return sorted[0]
  const position = (sorted.length - 1) * clamp01(q)
  const lower = Math.floor(position)
  const upper = Math.ceil(position)
  if (lower === upper) return sorted[lower]
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower)
}

export function durationStats(values: number[]): DurationStats {
  const positive = values.filter((value) => Number.isFinite(value) && value > 0).sort((a, b) => a - b)
  if (positive.length === 0) {
    return { count: 0, median: null, mean: null, low: null, high: null }
  }
  const sum = positive.reduce((total, value) => total + value, 0)
  return {
    count: positive.length,
    median: quantile(positive, 0.5),
    mean: sum / positive.length,
    low: quantile(positive, 0.25),
    high: quantile(positive, 0.75),
  }
}

/** Local time-of-day in minutes (0–1439) for an epoch timestamp. */
export function minuteOfDay(timestamp: number): number {
  const date = new Date(timestamp)
  return date.getHours() * 60 + date.getMinutes()
}

export function binForMinute(minute: number, bins = TIMING_BINS): number {
  const binMinutes = 1440 / bins
  return Math.max(0, Math.min(bins - 1, Math.floor(minute / binMinutes)))
}

/** The centre minute of a bin, used to suggest a window. */
export function binCentreMinute(bin: number, bins = TIMING_BINS): number {
  const binMinutes = 1440 / bins
  return Math.round(bin * binMinutes + binMinutes / 2)
}

/**
 * A smoothed distribution over time-of-day bins, learned only from when the
 * activity actually happened. Unknown times stay uniformly distributed.
 */
export function timingProfile(sessionStarts: number[], bins = TIMING_BINS): TimingProfile {
  const counts = new Array<number>(bins).fill(0)
  for (const minute of sessionStarts) counts[binForMinute(minute, bins)] += 1
  const sessions = sessionStarts.length
  const smoothing = 2
  const total = sessions + smoothing
  const weights = counts.map((count) =>
    total > 0 ? (count + smoothing / bins) / total : 1 / bins,
  )
  let peakBin: number | null = null
  if (sessions > 0) {
    let best = -1
    weights.forEach((weight, index) => {
      if (weight > best) {
        best = weight
        peakBin = index
      }
    })
  }
  return { bins, binMinutes: 1440 / bins, weights: normalise(weights), sessions, peakBin }
}

function normalise(values: number[]): number[] {
  const sum = values.reduce((total, value) => total + value, 0)
  if (sum <= 0) return values.map(() => 1 / Math.max(1, values.length))
  return values.map((value) => value / sum)
}

/** Exponential-decay-weighted completion rate. `to` is the reference date. */
export function decayedCompletionRate(days: LabelledDay[], to: string, halfLifeDays = DECAY_HALF_LIFE_DAYS): number | null {
  let weightSum = 0
  let successSum = 0
  for (const day of days) {
    if (day.offDay || day.performed === null) continue
    const age = Math.max(0, diffDays(day.date, to))
    const weight = Math.pow(0.5, age / halfLifeDays)
    weightSum += weight
    if (day.performed) successSum += weight
  }
  if (weightSum === 0) return null
  return clamp01(successSum / weightSum)
}

/** Completion rate per weekday, each smoothed toward the overall rate. */
export function weekdayRates(days: LabelledDay[], priorRate: number): WeekdayRate[] {
  const totals = new Array<number>(7).fill(0)
  const successes = new Array<number>(7).fill(0)
  for (const day of days) {
    if (day.offDay || day.performed === null) continue
    const weekday = weekdayOf(day.date)
    totals[weekday] += 1
    if (day.performed) successes[weekday] += 1
  }
  return totals.map((labelled, weekday) => ({
    weekday,
    rate: smoothedRate(successes[weekday], labelled, priorRate, PRIOR_WEIGHT).rate,
    labelled,
  }))
}

/** 0 = Sunday … 6 = Saturday, from a `YYYY-MM-DD` date. */
export function weekdayOf(date: string): number {
  const [year, month, day] = date.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay()
}

/** The most recent labelled day on which the activity happened. */
export function daysSinceLastCompletion(days: LabelledDay[], to: string): number | null {
  let latest: string | null = null
  for (const day of days) {
    if (day.performed === true && !day.offDay) {
      if (latest === null || day.date > latest) latest = day.date
    }
  }
  return latest === null ? null : Math.max(0, diffDays(latest, to))
}

/** Labelled misses in the most recent `window` labelled days. */
export function recentMisses(days: LabelledDay[], window = 10): number {
  const labelled = days
    .filter((day) => !day.offDay && day.performed !== null)
    .sort((a, b) => (a.date < b.date ? 1 : -1))
    .slice(0, window)
  return labelled.filter((day) => day.performed === false).length
}

/** Share of the last weeks (with data) in which the activity happened at least once. */
export function consistency(days: LabelledDay[], to: string, weeks = CONSISTENCY_WEEKS): number | null {
  const buckets = new Map<number, { labelled: number; success: boolean }>()
  for (const day of days) {
    if (day.offDay || day.performed === null) continue
    const age = diffDays(day.date, to)
    if (age < 0) continue
    const week = Math.floor(age / 7)
    if (week >= weeks) continue
    const bucket = buckets.get(week) ?? { labelled: 0, success: false }
    bucket.labelled += 1
    if (day.performed) bucket.success = true
    buckets.set(week, bucket)
  }
  const withData = [...buckets.values()].filter((bucket) => bucket.labelled > 0)
  if (withData.length === 0) return null
  return withData.filter((bucket) => bucket.success).length / withData.length
}

/**
 * Mood associations: how completion varied with each check-in answer. Groups
 * with too few observations are omitted, and a field only reports an
 * association when at least two groups have enough data. This describes an
 * association in the user's own history — never a cause.
 */
export function moodAssociations(days: LabelledDay[], minPerGroup = MIN_MOOD_GROUP): MoodAssociation[] {
  return CHECKIN_ANSWER_KEYS.map((field) => {
    const totals = new Map<number, { labelled: number; successes: number }>()
    for (const day of days) {
      if (day.offDay || day.performed === null || !day.answers) continue
      const value = day.answers[field]
      if (value === undefined) continue
      const bucket = totals.get(value) ?? { labelled: 0, successes: 0 }
      bucket.labelled += 1
      if (day.performed) bucket.successes += 1
      totals.set(value, bucket)
    }
    const groups: MoodGroup[] = [...totals.entries()]
      .filter(([, bucket]) => bucket.labelled >= minPerGroup)
      .map(([value, bucket]) => ({ value, days: bucket.labelled, completionRate: bucket.successes / bucket.labelled }))
      .sort((a, b) => a.value - b.value)
    const enough = groups.length >= 2
    let best: number | null = null
    let worst: number | null = null
    if (enough) {
      const sorted = [...groups].sort((a, b) => b.completionRate - a.completionRate)
      best = sorted[0].value
      worst = sorted[sorted.length - 1].value
    }
    return { field, groups, best, worst, enough }
  })
}

/**
 * Combine several tag (or group) statistics into one for a task with no history
 * of its own: each group's completion rate is weighted by how many labelled days
 * it rests on, then shrunk toward the user's overall rate.
 */
export function combineGroups(groups: GroupStatistics[], priorRate: number): {
  completion: RateEstimate
  duration: DurationStats
  timing: TimingProfile
} {
  const totalLabelled = groups.reduce((total, group) => total + group.labelled, 0)
  let successes = 0
  for (const group of groups) {
    successes += group.completion.rate * group.labelled
  }
  const completion = smoothedRate(successes, totalLabelled, priorRate, PRIOR_WEIGHT)

  const durationWeights = groups.filter((group) => group.duration.count > 0)
  const weightSum = durationWeights.reduce((total, group) => total + group.duration.count, 0)
  const duration: DurationStats =
    weightSum > 0
      ? {
          count: weightSum,
          median: weightedAverage(durationWeights.map((group) => ({ value: group.duration.median ?? 0, weight: group.duration.count }))),
          mean: weightedAverage(durationWeights.map((group) => ({ value: group.duration.mean ?? 0, weight: group.duration.count }))),
          low: weightedAverage(durationWeights.map((group) => ({ value: group.duration.low ?? 0, weight: group.duration.count }))),
          high: weightedAverage(durationWeights.map((group) => ({ value: group.duration.high ?? 0, weight: group.duration.count }))),
        }
      : { count: 0, median: null, mean: null, low: null, high: null }

  const timingWeights = groups.reduce<number[]>(
    (acc, group) => acc.map((value, index) => value + group.timing.weights[index] * Math.max(1, group.timing.sessions)),
    new Array(TIMING_BINS).fill(0),
  )
  const timing = normalise(timingWeights)
  const peakBin = groups.length === 0 ? null : timing.indexOf(Math.max(...timing))

  return { completion, duration, timing: { bins: TIMING_BINS, binMinutes: TIMING_BIN_MINUTES, weights: timing, sessions: groups.reduce((t, g) => t + g.timing.sessions, 0), peakBin } }
}

function weightedAverage(items: Array<{ value: number; weight: number }>): number {
  const weightSum = items.reduce((total, item) => total + item.weight, 0)
  if (weightSum === 0) return 0
  return items.reduce((total, item) => total + item.value * item.weight, 0) / weightSum
}

// ---------------------------------------------------------------------------
// Gathering from the database
// ---------------------------------------------------------------------------

interface StatusRow {
  local_date: string
  status: ExplicitStatus
  reason: string | null
}

function checkinsInRange(db: DatabaseSync, userId: number, from: string, to: string): Map<string, Partial<Record<CheckinAnswerKey, number>>> {
  const rows = db
    .prepare(
      `SELECT * FROM checkins
       WHERE user_id = ? AND date >= ? AND date <= ? AND skipped = 0
       ORDER BY date`,
    )
    .all(userId, from, to) as unknown as Array<Record<string, unknown>>
  const out = new Map<string, Partial<Record<CheckinAnswerKey, number>>>()
  for (const row of rows) {
    const answers: Partial<Record<CheckinAnswerKey, number>> = {}
    let any = false
    for (const key of CHECKIN_ANSWER_KEYS) {
      const parsed = parseAnswer(row[key])
      if (typeof parsed === 'number') {
        answers[key] = parsed
        any = true
      }
    }
    if (any) out.set(String(row.date), answers)
  }
  return out
}

function configForDateFromList(configs: TaskConfigRow[], date: string): TaskConfigRow | undefined {
  const cutoff = endOfLocalDay(date)
  let chosen: TaskConfigRow | undefined
  for (const config of configs) {
    if (config.effective_from > cutoff) continue
    if (!chosen || config.effective_from > chosen.effective_from) chosen = config
  }
  return chosen
}

/**
 * Read every labelled day for one task in `[from, to]`, in a small fixed number
 * of queries. Off days are gathered too, but flagged, so callers can exclude
 * them from rates without losing the fact that the day was off.
 */
export function gatherTaskDays(
  db: DatabaseSync,
  userId: number,
  taskId: string,
  from: string,
  to: string,
  today: string,
): LabelledDay[] {
  const statusRows = db
    .prepare(
      `SELECT local_date, status, reason FROM daily_activity_status
       WHERE user_id = ? AND task_id = ? AND local_date >= ? AND local_date <= ?`,
    )
    .all(userId, taskId, from, to) as unknown as StatusRow[]
  const configs = listTaskConfigs(db, taskId)
  const offDates = offDayDates(db, userId, from, to)
  const checkins = checkinsInRange(db, userId, from, to)

  const sessionsByDate = new Map<string, SessionRow[]>()
  const startsByDate = new Map<string, number[]>()
  for (const session of listSessions(db, userId, { taskId, from, to, limit: 100000 })) {
    const list = sessionsByDate.get(session.local_date) ?? []
    list.push(session)
    sessionsByDate.set(session.local_date, list)
    const starts = startsByDate.get(session.local_date) ?? []
    starts.push(minuteOfDay(session.started_at))
    startsByDate.set(session.local_date, starts)
  }
  const statusByDate = new Map<string, StatusRow>()
  for (const row of statusRows) statusByDate.set(row.local_date, row)

  const days: LabelledDay[] = []
  let cursor = from
  let guard = 0
  while (cursor <= to && guard < 2000) {
    const config = configForDateFromList(configs, cursor)
    const status = statusByDate.get(cursor)
    const daySessions = sessionsByDate.get(cursor) ?? []
    const derived = deriveDailyActivity({
      date: cursor,
      today,
      targetMinutes: config?.target_duration ?? null,
      sessions: daySessions.map((session) => ({ durationMinutes: session.duration_minutes })),
      explicitStatus: status?.status ?? null,
      explicitReason: status?.reason ?? null,
      configVersionId: config?.id ?? null,
      checkinId: null,
      offDay: offDates.has(cursor),
      offDayKind: null,
    })
    days.push({
      date: cursor,
      performed: derived.performed,
      targetAchieved: derived.targetAchieved,
      totalMinutes: derived.totalMinutes,
      sessionStarts: startsByDate.get(cursor) ?? [],
      offDay: offDates.has(cursor),
      offDayKind: null,
      targetMinutes: config?.target_duration ?? null,
      priority: config?.priority ?? null,
      tagIds: config ? configTagIds(db, config.id) : [],
      answers: checkins.get(cursor) ?? null,
    })
    cursor = nextDate(cursor)
    guard += 1
  }
  return days
}

function nextDate(date: string): string {
  const [year, month, day] = date.split('-').map(Number)
  const next = new Date(Date.UTC(year, month - 1, day + 1))
  const m = `${next.getUTCMonth() + 1}`.padStart(2, '0')
  const d = `${next.getUTCDate()}`.padStart(2, '0')
  return `${next.getUTCFullYear()}-${m}-${d}`
}

/** The user's own overall completion rate, used as the prior everywhere. */
export function userCompletionPrior(db: DatabaseSync, userId: number, taskIds: string[], today: string): number {
  const from = addDaysPure(today, -LOOKBACK_DAYS)
  let labelled = 0
  let successes = 0
  for (const taskId of taskIds) {
    for (const day of gatherTaskDays(db, userId, taskId, from, today, today)) {
      if (day.offDay || day.performed === null) continue
      labelled += 1
      if (day.performed) successes += 1
    }
  }
  if (labelled === 0) return 0.5
  return clamp01(successes / labelled)
}

// ---------------------------------------------------------------------------
// Activity-level statistics
// ---------------------------------------------------------------------------

function rateFor(days: LabelledDay[], priorRate: number): RateEstimate {
  const labelled = days.filter((day) => !day.offDay && day.performed !== null)
  const successes = labelled.filter((day) => day.performed).length
  return smoothedRate(successes, labelled.length, priorRate)
}

export interface ActivityStatisticsOptions {
  from?: string
  to?: string
  recentDays?: number
  stage2MinDays?: number
  /** Days already gathered, to avoid a second read. */
  days?: LabelledDay[]
}

/** Every statistic the prediction layer needs for one activity. */
export function activityStatistics(
  db: DatabaseSync,
  userId: number,
  taskId: string,
  today: string,
  priorRate: number,
  options: ActivityStatisticsOptions = {},
): ActivityStatistics {
  const to = options.to ?? today
  const from = options.from ?? addDaysPure(to, -LOOKBACK_DAYS)
  const days = options.days ?? gatherTaskDays(db, userId, taskId, from, to, today)
  const stage2MinDays = options.stage2MinDays ?? 10

  const labelledDays = days.filter((day) => !day.offDay && day.performed !== null)
  const offDays = days.filter((day) => day.offDay).length
  const recentFrom = addDaysPure(to, -Math.max(0, (options.recentDays ?? RECENT_WINDOW_DAYS) - 1))
  const recent = rateFor(days.filter((day) => day.date >= recentFrom), priorRate)

  const targetDays = labelledDays.filter((day) => day.targetAchieved !== null)
  const targetSuccesses = targetDays.filter((day) => day.targetAchieved).length
  const target =
    targetDays.length > 0 ? smoothedRate(targetSuccesses, targetDays.length, priorRate) : null

  const durations = labelledDays.filter((day) => day.performed).map((day) => day.totalMinutes)
  const sessionStarts = labelledDays.flatMap((day) => day.sessionStarts)

  return {
    taskId,
    from,
    to,
    labelledDays: labelledDays.length,
    offDays,
    completion: rateFor(days, priorRate),
    recent,
    decayedRate: decayedCompletionRate(days, to),
    target,
    duration: durationStats(durations),
    weekdayRates: weekdayRates(days, priorRate),
    daysSinceLastCompletion: daysSinceLastCompletion(days, to),
    recentMisses: recentMisses(days),
    consistency: consistency(days, to),
    timing: timingProfile(sessionStarts),
    mood: moodAssociations(days),
    enough: labelledDays.length >= stage2MinDays,
  }
}

// ---------------------------------------------------------------------------
// Tag and priority statistics
// ---------------------------------------------------------------------------

/**
 * Completion, duration and timing grouped by tag id or by priority, pooled over
 * every task that carried that group on a given day.
 */
export function groupStatistics(
  db: DatabaseSync,
  userId: number,
  taskIds: string[],
  today: string,
  priorRate: number,
  groupBy: 'tag' | 'priority',
  options: { from?: string; to?: string; stage2MinDays?: number } = {},
): Map<string, GroupStatistics> {
  const to = options.to ?? today
  const from = options.from ?? addDaysPure(to, -LOOKBACK_DAYS)
  const accum = new Map<string, { days: LabelledDay[] }>()

  for (const taskId of taskIds) {
    for (const day of gatherTaskDays(db, userId, taskId, from, to, today)) {
      const keys = groupBy === 'tag' ? day.tagIds.map(String) : day.priority ? [day.priority] : []
      for (const key of keys) {
        const bucket = accum.get(key) ?? { days: [] }
        bucket.days.push(day)
        accum.set(key, bucket)
      }
    }
  }

  const out = new Map<string, GroupStatistics>()
  for (const [key, bucket] of accum) {
    const labelled = bucket.days.filter((day) => !day.offDay && day.performed !== null)
    const successes = labelled.filter((day) => day.performed).length
    out.set(key, {
      key,
      labelled: labelled.length,
      completion: smoothedRate(successes, labelled.length, priorRate),
      duration: durationStats(labelled.filter((day) => day.performed).map((day) => day.totalMinutes)),
      timing: timingProfile(labelled.flatMap((day) => day.sessionStarts)),
    })
  }
  return out
}

/** Look at whether priority was associated with completion, from the data only. */
export function priorityAssociation(days: LabelledDay[], minPerGroup = MIN_MOOD_GROUP): { associated: boolean; detail: string } | null {
  const groups = new Map<string, { labelled: number; successes: number }>()
  for (const day of days) {
    if (day.offDay || day.performed === null || !day.priority) continue
    const bucket = groups.get(day.priority) ?? { labelled: 0, successes: 0 }
    bucket.labelled += 1
    if (day.performed) bucket.successes += 1
    groups.set(day.priority, bucket)
  }
  const usable = [...groups.entries()].filter(([, bucket]) => bucket.labelled >= minPerGroup)
  if (usable.length < 2) return null
  const rates = usable.map(([key, bucket]) => ({ key, rate: bucket.successes / bucket.labelled, labelled: bucket.labelled }))
  const sorted = [...rates].sort((a, b) => b.rate - a.rate)
  const spread = sorted[0].rate - sorted[sorted.length - 1].rate
  const associated = spread >= 0.15
  return {
    associated,
    detail: associated
      ? `In your history, ${sorted[0].key}-priority days were completed more often than ${sorted[sorted.length - 1].key}-priority days.`
      : 'Priority did not clearly change completion in your history.',
  }
}

/** The tag ids attached to a task today (for tag-based cold-start statistics). */
export function currentTagIds(db: DatabaseSync, taskId: string, today: string): number[] {
  const configs = listTaskConfigs(db, taskId)
  const config = configForDateFromList(configs, today) ?? configs[0]
  return config ? configTagIds(db, config.id) : []
}

/** Every personal task the user owns, oldest first. Team tasks never feed ML. */
export function userTaskIds(db: DatabaseSync, userId: number): string[] {
  return (
    db
      .prepare('SELECT id FROM tasks WHERE user_id = ? AND team_id IS NULL ORDER BY created_at')
      .all(userId) as unknown as Array<{ id: string }>
  ).map((row) => row.id)
}

export { addDaysPure as addDays, nextDate }
