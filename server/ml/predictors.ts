import type { DatabaseSync } from 'node:sqlite'
import { getCheckin, type CheckinAnswerKey, type CheckinState } from '../checkins-store'
import { averageGoodness, readinessFromCheckin } from './readiness'
import { configForDate } from './task-config'
import { dailyActivity } from './daily-activity'
import { getPredictionSettings, offDayContext, type OffDayKind, type PredictionSettings } from './off-days'
import {
  PRIOR_WEIGHT,
  activityStatistics,
  clamp01,
  combineGroups,
  currentTagIds,
  durationStats,
  groupStatistics,
  userCompletionPrior,
  userTaskIds,
  type ActivityStatistics,
  type DurationStats,
  type GroupStatistics,
  type TimingProfile,
} from './statistics'
import { assessStage, confidenceFor, downgrade, isSkipped, stageNote, type Confidence, type Stage } from './cold-start'

/**
 * Predictors (Phase 4, §2).
 *
 * Every number here is an estimate from the user's **own** data plus today's
 * check-in. The design rules, in code:
 *
 * - Completion probability and target-achievement probability are separate: the
 *   first is "does anything happen at all", the second is "does the whole target
 *   get met".
 * - The expected duration comes from the user's recorded durations, never from
 *   the target. With no duration history it is left unknown rather than faked.
 * - The recommended time comes from when the activity actually happened. A
 *   preferred time is only a weak hint that fades as real sessions arrive.
 * - A skipped check-in widens uncertainty; it never invents check-in values.
 * - Off days suppress predictions entirely.
 * - A small, configurable share of recommendations explore a new time, clearly
 *   labelled, and only for a task with enough history, adequate confidence and
 *   no high priority.
 * - Reschedule/drop suggestions are offered, never forced, and only when the
 *   probability is low, the priority is low and confidence is not low.
 *
 * Nothing here writes to the database; `predictions.ts` logs the results.
 */

export const PHASE4_MODEL_VERSION = 'phase4-1.0.0'

export const CHECKIN_SENSITIVITY = 0.06
export const TAG_SHRINK = 0.5
export const PRIORITY_SHRINK = 0.5
export const CHECKIN_MAX_ADJUST = 0.15
export const TAG_MAX_ADJUST = 0.15
export const PRIORITY_MAX_ADJUST = 0.1
export const DEFAULT_SESSION_MINUTES = 30
export const MIN_WINDOW_MINUTES = 15

export interface PredictionInputs {
  baseRate: number
  priorRate: number
  stage: Stage
  checkinAdjustment: number
  tagAdjustment: number
  priorityAdjustment: number
  labelledDays: number
  peakBin: number | null
  offDaysExcluded: number
}

export interface TaskPrediction {
  taskId: string
  date: string
  source: 'baseline' | 'model'
  modelVersion: string
  stage: Stage
  confidence: Confidence
  dataSufficiencyDays: number
  completionProbability: number
  targetProbability: number | null
  expectedDuration: number | null
  durationLow: number | null
  durationHigh: number | null
  recommendedStart: number | null
  recommendedEnd: number | null
  exploratory: boolean
  explanation: string
  inputs: PredictionInputs
}

export interface PredictContext {
  date: string
  today: string
  /** Local time-of-day now, in minutes. */
  nowMinutes: number
  checkinState: CheckinState
  answers: Partial<Record<CheckinAnswerKey, number>> | null
  settings: PredictionSettings
  /** The user's overall completion rate, computed once per plan. */
  priorRate: number
  /** Tag statistics for the whole user, computed once per plan. */
  tagStats?: Map<string, GroupStatistics>
  /** Priority statistics for the whole user, computed once per plan. */
  priorityStats?: Map<string, GroupStatistics>
  /** Injectable for tests; defaults to `Math.random`. */
  random?: () => number
  /**
   * Leak-free cutoff for today's progress, in epoch ms. Set only by the
   * backtest/pipeline check so a past day is predicted from what was known
   * before it; production leaves it undefined and counts the whole day so far.
   */
  asOfEpoch?: number
}

// ---------------------------------------------------------------------------
// Small maths helpers
// ---------------------------------------------------------------------------

/** Epoch ms for a local date at a given minute-of-day. */
export function epochAtMinute(date: string, minute: number): number {
  const [year, month, day] = date.split('-').map(Number)
  const hours = Math.floor(minute / 60)
  const minutes = minute % 60
  return new Date(year, month - 1, day, hours, minutes, 0, 0).getTime()
}

/** A free-time answer (1 = plenty … 5 = very limited) as a rough minute budget. */
export function freeTimeBudget(answers: Partial<Record<CheckinAnswerKey, number>> | null): number | null {
  const value = answers?.free_time
  if (value === undefined) return null
  const table: Record<number, number> = { 1: 480, 2: 360, 3: 240, 4: 120, 5: 60 }
  return table[value] ?? null
}

/** Gumbel-max draw from a categorical distribution — Thompson sampling. */
export function thompsonBin(weights: number[], sessions: number, random: () => number): number {
  const concentration = weights.map((weight) => weight * Math.max(sessions, 1) + 1)
  let best = 0
  let bestScore = -Infinity
  for (let index = 0; index < concentration.length; index += 1) {
    const u = Math.min(1 - 1e-9, Math.max(1e-9, random()))
    const gumbel = -Math.log(-Math.log(u))
    const score = Math.log(concentration[index]) + gumbel
    if (score > bestScore) {
      bestScore = score
      best = index
    }
  }
  return best
}

// ---------------------------------------------------------------------------
// Check-in context
// ---------------------------------------------------------------------------

interface Adjustment {
  value: number
  note: string | null
}

/**
 * How today's check-in shifts the completion probability. Only answered fields
 * count, and only a modest, capped shift is applied — this describes an
 * association in the user's own history, never a cause. A skipped check-in
 * applies no shift at all: uncertainty widens instead.
 */
export function checkinAdjustment(answers: Partial<Record<CheckinAnswerKey, number>> | null): Adjustment {
  if (!answers) return { value: 0, note: null }
  const avg = averageGoodness(answers)
  if (avg === null) return { value: 0, note: null }
  const delta = avg - 3
  if (Math.abs(delta) < 0.25) return { value: 0, note: null }
  const value = Math.max(-CHECKIN_MAX_ADJUST, Math.min(CHECKIN_MAX_ADJUST, delta * CHECKIN_SENSITIVITY))
  return {
    value,
    note: delta > 0 ? 'today reads better than your usual' : 'today reads lower than your usual',
  }
}

/** A shrunk shift from the activity's tags, relative to the user's overall rate. */
export function tagAdjustment(tags: GroupStatistics[], overallRate: number): Adjustment {
  const usable = tags.filter((tag) => tag.labelled > 0)
  if (usable.length === 0) return { value: 0, note: null }
  let weighted = 0
  let weightSum = 0
  for (const tag of usable) {
    const weight = tag.labelled / (tag.labelled + PRIOR_WEIGHT)
    weighted += (tag.completion.rate - overallRate) * weight * tag.labelled
    weightSum += tag.labelled
  }
  if (weightSum === 0) return { value: 0, note: null }
  const signal = (weighted / weightSum) * TAG_SHRINK
  if (Math.abs(signal) < 0.01) return { value: 0, note: null }
  const value = Math.max(-TAG_MAX_ADJUST, Math.min(TAG_MAX_ADJUST, signal))
  return { value, note: 'your tags for this point one way' }
}

/** A shrunk shift from the activity's current priority. */
export function priorityAdjustment(priority: GroupStatistics | undefined, overallRate: number): Adjustment {
  if (!priority || priority.labelled < PRIOR_WEIGHT) return { value: 0, note: null }
  const weight = priority.labelled / (priority.labelled + PRIOR_WEIGHT)
  const signal = (priority.completion.rate - overallRate) * weight * PRIORITY_SHRINK
  if (Math.abs(signal) < 0.01) return { value: 0, note: null }
  const value = Math.max(-PRIORITY_MAX_ADJUST, Math.min(PRIORITY_MAX_ADJUST, signal))
  return { value, note: 'days at this priority have gone this way before' }
}

// ---------------------------------------------------------------------------
// Durations, timing and target
// ---------------------------------------------------------------------------

function durationFor(stats: ActivityStatistics, combined: { duration: DurationStats } | null): DurationStats {
  if (stats.duration.count > 0) return stats.duration
  if (combined) return combined.duration
  return { count: 0, median: null, mean: null, low: null, high: null }
}

function timingFor(stats: ActivityStatistics, combined: { timing: TimingProfile } | null): TimingProfile {
  if (stats.timing.sessions > 0) return stats.timing
  if (combined) return combined.timing
  return stats.timing
}

/**
 * Probability of meeting the whole day's target, given what is left to do and
 * how much of the day remains. Separate from completion: this is the "full
 * target" question.
 */
export function targetAchievementProbability(
  stats: ActivityStatistics,
  remainingTarget: number,
  nowMinutes: number,
  freeTimeMinutes: number | null,
): number {
  if (remainingTarget <= 0) return 1
  const base = stats.target?.rate ?? stats.completion.rate
  const expected = stats.duration.median ?? remainingTarget
  const gapRatio = remainingTarget / Math.max(1, expected)
  // A gap of one typical session is comfortable; each extra session's worth
  // roughly halves the feasibility.
  const feasibility = 1 / (1 + Math.max(0, gapRatio - 1) * 0.6)
  const minutesLeftInDay = Math.max(0, 24 * 60 - nowMinutes)
  const budget = freeTimeMinutes ?? minutesLeftInDay
  const roomPenalty = remainingTarget > budget ? 0.5 : 1
  return clamp01(base * feasibility * roomPenalty)
}

// ---------------------------------------------------------------------------
// Recommended time
// ---------------------------------------------------------------------------

export interface TimeWindow {
  start: number
  end: number
  exploratory: boolean
  peakBin: number | null
}

/**
 * A recommended window from the learned timing profile, kept inside the free
 * time and never in the past. With no timing data it falls back to a sensible
 * next-hour window (low confidence is applied by the caller).
 */
export function recommendWindow(
  timing: TimingProfile,
  date: string,
  nowMinutes: number,
  expectedDuration: number | null,
  freeTimeMinutes: number | null,
  options: { explore?: boolean; random?: () => number } = {},
): TimeWindow {
  const duration = expectedDuration ?? DEFAULT_SESSION_MINUTES
  const binMinutes = 1440 / timing.bins
  let bin = timing.peakBin
  let exploratory = false
  if (timing.sessions > 0 && options.explore && timing.peakBin !== null) {
    bin = thompsonBin(timing.weights, timing.sessions, options.random ?? Math.random)
    exploratory = bin !== timing.peakBin
  }
  let startMinute: number
  if (bin !== null) {
    startMinute = Math.round(bin * binMinutes + binMinutes / 2 - duration / 2)
  } else {
    startMinute = Math.ceil(nowMinutes / 60) * 60
  }
  // Never suggest a time that has already passed.
  if (startMinute < nowMinutes) startMinute = Math.ceil(nowMinutes / MIN_WINDOW_MINUTES) * MIN_WINDOW_MINUTES
  const budget = freeTimeMinutes ?? 24 * 60
  const latestStart = Math.max(nowMinutes, 24 * 60 - Math.min(duration, budget))
  if (startMinute > latestStart) startMinute = Math.round(latestStart)
  return {
    start: epochAtMinute(date, Math.max(0, Math.round(startMinute))),
    end: epochAtMinute(date, Math.max(0, Math.round(startMinute) + duration)),
    exploratory,
    peakBin: bin,
  }
}

// ---------------------------------------------------------------------------
// One task
// ---------------------------------------------------------------------------

/** The task's own target and priority that applied on `date`. */
export interface TaskContext {
  text: string
  targetMinutes: number | null
  priority: string | null
  tagIds: number[]
  active: boolean
}

export function taskContext(db: DatabaseSync, taskId: string, date: string): TaskContext | null {
  const config = configForDate(db, taskId, date)
  if (!config) return null
  return {
    text: config.name,
    targetMinutes: config.target_duration,
    priority: config.priority,
    tagIds: currentTagIds(db, taskId, date),
    active: config.active === 1,
  }
}

export interface PredictOptions {
  /** Force exploration on/off; default decides from the exploration share. */
  explore?: boolean
}

export function predictTask(
  db: DatabaseSync,
  userId: number,
  taskId: string,
  context: PredictContext,
  options: PredictOptions = {},
): TaskPrediction | null {
  const task = taskContext(db, taskId, context.date)
  if (!task) return null

  // Off days suppress predictions entirely; the caller shows "off day" instead.
  const off = offDayContext(db, userId, context.date, context.settings)
  if (off.onOffDay) return null

  const stats = activityStatistics(db, userId, taskId, context.today, context.priorRate, {
    stage2MinDays: context.settings.stage2MinDays,
  })
  const stageInfo = assessStage(stats.labelledDays, context.settings.stage2MinDays)

  // Stage-1 fallback: the statistics of the activity's tags, shrunk to the
  // user's overall rate. With no tags either, the overall rate stands alone.
  const tagGroups = task.tagIds
    .map((id) => context.tagStats?.get(String(id)))
    .filter((group): group is GroupStatistics => group !== undefined)
  const combined = tagGroups.length > 0 ? combineGroups(tagGroups, context.priorRate) : null

  const baseRate =
    stageInfo.stage === 2
      ? stats.decayedRate !== null
        ? clamp01(0.6 * stats.completion.rate + 0.4 * stats.decayedRate)
        : stats.completion.rate
      : combined
        ? combined.completion.rate
        : context.priorRate

  const checkin = checkinAdjustment(context.answers)
  const tagAdj = tagAdjustment(tagGroups, context.priorRate)
  const priorityAdj = task.priority
    ? priorityAdjustment(context.priorityStats?.get(task.priority), context.priorRate)
    : { value: 0, note: null }

  const completionProbability = clamp01(
    Math.max(0.02, Math.min(0.98, baseRate + checkin.value + tagAdj.value + priorityAdj.value)),
  )

  const duration = durationFor(stats, combined)
  const timing = timingFor(stats, combined)

  // Today's progress, so target probability and the window reflect reality.
  const today = dailyActivity(db, userId, taskId, context.date, context.today, { asOf: context.asOfEpoch })
  const remainingTarget = task.targetMinutes === null ? null : Math.max(0, task.targetMinutes - today.totalMinutes)
  const freeTime = freeTimeBudget(context.answers)
  const targetProbability =
    remainingTarget === null
      ? null
      : targetAchievementProbability(stats, remainingTarget, context.nowMinutes, freeTime)

  const confidence = confidenceFor({
    stage: stageInfo.stage,
    labelledDays: stats.labelledDays,
    stage2MinDays: context.settings.stage2MinDays,
    checkinSkipped: isSkipped(context.checkinState),
    reducedConfidence: off.reducedConfidence,
  })

  // Exploration is only allowed for a task with enough history, adequate
  // confidence, a light priority and a fitting window.
  const random = context.random ?? Math.random
  const mayExplore =
    stats.timing.sessions > 0 &&
    stageInfo.stage === 2 &&
    confidence !== 'low' &&
    task.priority !== 'high' &&
    task.priority !== 'urgent'
  const explore =
    mayExplore && (options.explore ?? random() < context.settings.explorationShare)

  const window = recommendWindow(timing, context.date, context.nowMinutes, duration.median, freeTime, {
    explore,
    random,
  })

  const explanation = buildExplanation({
    stage: stageInfo.stage,
    stats,
    checkin,
    tagAdj,
    priorityAdj,
    hasTarget: remainingTarget !== null,
    remainingTarget,
    exploratory: window.exploratory,
    checkinSkipped: isSkipped(context.checkinState),
  })

  return {
    taskId,
    date: context.date,
    source: stageInfo.stage === 2 ? 'model' : 'baseline',
    modelVersion: PHASE4_MODEL_VERSION,
    stage: stageInfo.stage,
    confidence,
    dataSufficiencyDays: stats.labelledDays,
    completionProbability,
    targetProbability,
    expectedDuration: duration.median === null ? null : Math.round(duration.median),
    durationLow: duration.low === null ? null : Math.round(duration.low),
    durationHigh: duration.high === null ? null : Math.round(duration.high),
    recommendedStart: window.start,
    recommendedEnd: window.end,
    exploratory: window.exploratory,
    explanation,
    inputs: {
      baseRate,
      priorRate: context.priorRate,
      stage: stageInfo.stage,
      checkinAdjustment: checkin.value,
      tagAdjustment: tagAdj.value,
      priorityAdjustment: priorityAdj.value,
      labelledDays: stats.labelledDays,
      peakBin: timing.peakBin,
      offDaysExcluded: stats.offDays,
    },
  }
}

function buildExplanation(args: {
  stage: Stage
  stats: ActivityStatistics
  checkin: Adjustment
  tagAdj: Adjustment
  priorityAdj: Adjustment
  hasTarget: boolean
  remainingTarget: number | null
  exploratory: boolean
  checkinSkipped: boolean
}): string {
  const parts: string[] = []
  if (args.stats.labelledDays > 0) {
    parts.push(`You've done this on ${args.stats.labelledDays} labelled day${args.stats.labelledDays === 1 ? '' : 's'}.`)
  } else {
    parts.push('No personal history for this activity yet.')
  }
  if (args.checkinSkipped) {
    parts.push('The check-in was skipped, so today reads with wider uncertainty.')
  } else if (args.checkin.note) {
    parts.push(`This estimate also reflects that ${args.checkin.note}.`)
  }
  if (args.tagAdj.note) parts.push(`Your tags suggest ${args.tagAdj.note}.`)
  if (args.priorityAdj.note) parts.push(`Your priority suggests ${args.priorityAdj.note}.`)
  if (args.hasTarget && args.remainingTarget !== null && args.remainingTarget > 0) {
    parts.push(`${args.remainingTarget} min left to reach today's target.`)
  }
  if (args.exploratory) parts.push('Trying a new time here.')
  return `${parts.join(' ')} ${stageNote(args.stage)}`
}

// ---------------------------------------------------------------------------
// Today's plan
// ---------------------------------------------------------------------------

export interface PlanEntry {
  taskId: string
  text: string
  priority: string | null
  remainingTargetMinutes: number | null
  doneMinutes: number
  prediction: TaskPrediction
  /** Higher ranks earlier; a suggestion only, never a change to the numbers. */
  rankScore: number
}

export interface Suggestion {
  taskId: string
  text: string
  kind: 'reschedule' | 'drop'
  message: string
}

export interface PlanResult {
  date: string
  offDay: boolean
  offDayKind: OffDayKind | null
  reducedConfidence: boolean
  checkinState: CheckinState
  readiness: { score: number | null; line: string; state: 'ready' | 'partial' | 'none' }
  entries: PlanEntry[]
  suggestions: Suggestion[]
  note: string
}

const PRIORITY_WEIGHT_RANK: Record<string, number> = { urgent: 4, high: 3, medium: 2, low: 1 }

/**
 * Rank today's open tasks. The ranking is a suggestion built from the completion
 * probability, the priority, what is left of the target and how much time is
 * left — it never changes any probability, and nothing is forced.
 */
export function buildPlan(
  db: DatabaseSync,
  userId: number,
  date: string,
  today: string,
  nowMinutes: number,
  checkinState: CheckinState,
  options: { random?: () => number } = {},
): PlanResult {
  const settings = getPredictionSettings(db, userId)
  const offContext = offDayContext(db, userId, date, settings)

  const checkinRow = getCheckin(db, userId, date)
  const readiness = readinessFromCheckin(checkinRow)
  const answers = checkinRow && checkinRow.skipped === 0 ? answersOf(checkinRow) : null

  if (offContext.onOffDay) {
    return {
      date,
      offDay: true,
      offDayKind: offContext.offDay?.kind ?? null,
      reducedConfidence: false,
      checkinState,
      readiness: { score: readiness.score, line: readiness.line, state: readiness.state },
      entries: [],
      suggestions: [],
      note: 'This is an off day — no predictions are shown. You can still check in if you like.',
    }
  }

  const taskIds = userTaskIds(db, userId)
  const priorRate = userCompletionPrior(db, userId, taskIds, today)
  const tagStats = groupStatistics(db, userId, taskIds, today, priorRate, 'tag')
  const priorityStats = groupStatistics(db, userId, taskIds, today, priorRate, 'priority')

  const openTasks = db
    .prepare('SELECT id FROM tasks WHERE user_id = ? AND done = 0 AND team_id IS NULL ORDER BY created_at')
    .all(userId) as unknown as Array<{ id: string }>

  const context: PredictContext = {
    date,
    today,
    nowMinutes,
    checkinState,
    answers,
    settings,
    priorRate,
    tagStats,
    priorityStats,
    random: options.random,
  }

  const entries: PlanEntry[] = []
  const suggestions: Suggestion[] = []
  for (const { id } of openTasks) {
    const prediction = predictTask(db, userId, id, context)
    if (!prediction) continue
    const task = taskContext(db, id, date)
    if (!task || !task.active) continue
    const day = dailyActivity(db, userId, id, date, today)
    if (day.status === 'completed') continue
    const remainingTargetMinutes =
      task.targetMinutes === null ? null : Math.max(0, task.targetMinutes - day.totalMinutes)

    entries.push({
      taskId: id,
      text: task.text,
      priority: task.priority,
      remainingTargetMinutes,
      doneMinutes: day.totalMinutes,
      prediction,
      rankScore: rankScore(prediction, task.priority, remainingTargetMinutes),
    })

    const suggestion = suggest(prediction, task.priority, task.text)
    if (suggestion) suggestions.push({ taskId: id, text: task.text, ...suggestion })
  }

  entries.sort((a, b) => b.rankScore - a.rankScore || a.taskId.localeCompare(b.taskId))

  let note = 'A suggestion only — every recommendation can be ignored or changed.'
  if (offContext.reducedConfidence) {
    note = 'Just back from an off period, so these estimates carry reduced confidence. ' + note
  }
  if (isSkipped(checkinState)) {
    note = 'The check-in was skipped, so today reads with wider uncertainty. ' + note
  }

  return {
    date,
    offDay: false,
    offDayKind: null,
    reducedConfidence: offContext.reducedConfidence,
    checkinState,
    readiness: { score: readiness.score, line: readiness.line, state: readiness.state },
    entries,
    suggestions,
    note,
  }
}

function answersOf(row: NonNullable<ReturnType<typeof getCheckin>>): Partial<Record<CheckinAnswerKey, number>> {
  const out: Partial<Record<CheckinAnswerKey, number>> = {}
  for (const key of [
    'feeling',
    'energy',
    'motivation',
    'sleep',
    'stress',
    'free_time',
    'focus',
    'body',
    'workload',
  ] as const) {
    const value = row[key]
    if (value !== null) out[key] = value
  }
  return out
}

/** Readiness plus probability plus priority plus remaining target. */
export function rankScore(prediction: TaskPrediction, priority: string | null, remainingTarget: number | null): number {
  const priorityBoost = priority ? (PRIORITY_WEIGHT_RANK[priority] ?? 0) / 4 : 0
  const targetBoost = remainingTarget !== null && remainingTarget > 0 ? 0.1 : 0
  const readinessBoost = prediction.confidence === 'high' ? 0.05 : 0
  return prediction.completionProbability * 0.6 + priorityBoost * 0.3 + targetBoost + readinessBoost
}

/**
 * Reschedule/drop suggestions. Offered, never forced: only when the probability
 * is low, the priority is low and confidence is not low. A high-priority task is
 * never suggested for dropping.
 */
export function suggest(
  prediction: TaskPrediction,
  priority: string | null,
  text: string,
): { kind: 'reschedule' | 'drop'; message: string } | null {
  if (prediction.confidence === 'low') return null
  if (prediction.completionProbability >= 0.4) return null
  const lowPriority = priority === null || priority === 'low' || priority === 'medium'
  if (!lowPriority) return null
  const percent = Math.round(prediction.completionProbability * 100)
  if (priority === 'low' && prediction.completionProbability < 0.25) {
    return {
      kind: 'drop',
      message: `"${text}" has come up at ${percent}% before. Want to drop it, or move it to another day? It's your call.`,
    }
  }
  return {
    kind: 'reschedule',
    message: `"${text}" looks unlikely today (${percent}%). Want to move it? It's your call.`,
  }
}

export { activityStatistics, combineGroups, durationStats, userCompletionPrior, downgrade }
