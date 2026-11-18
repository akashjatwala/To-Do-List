import type { DatabaseSync } from 'node:sqlite'
import { activityStatistics, userCompletionPrior, userTaskIds } from './statistics'
import { configTagIds, listTaskConfigs, type TaskConfigRow } from './task-config'

/**
 * Drift handling.
 *
 * A person's routine and circumstances change. A model trained on last spring
 * should not quietly keep predicting last spring. This module does **not** try to
 * predict the change; it measures it, from the user's own recorded days, and
 * says so in plain words:
 *
 * - **Recent vs long-term.** For each activity it compares the recent window
 *   against the longer-term average and reports the difference, with a direction
 *   and a plain-language sentence. With too few labelled days on either side it
 *   makes no judgement rather than a noisy one.
 * - **Configuration changes.** A target, priority, tag set or preferred time that
 *   changed is read from the versioned config history and dated, so a shift that
 *   is really a changed target is not mistaken for a change in the person.
 * - **Explanations, not causes.** Everything here is an association over the
 *   user's own days. Nothing claims why a rate moved, and nothing here writes a
 *   prediction or an outcome.
 *
 * The notes are additive: they are surfaced next to predictions, never in place
 * of them, and they never change the numbers.
 */

/** The recent window used for the comparison, in days. */
export const DRIFT_RECENT_DAYS = 14
/** Each side needs at least this many labelled days before a comparison is made. */
export const DRIFT_MIN_LABELLED = 5
/** A rate difference smaller than this is called "steady", not a shift. */
export const DRIFT_RATE_DELTA = 0.15

export type DriftDirection = 'up' | 'down' | 'steady' | 'unknown'

export interface RateDrift {
  taskId: string
  recentRate: number | null
  recentLabelled: number
  longTermRate: number | null
  longTermLabelled: number
  /** Recent minus long-term, or null when either side is unjudgeable. */
  change: number | null
  direction: DriftDirection
  /** True only when both windows had enough labelled days. */
  judged: boolean
  note: string
}

export interface ConfigChange {
  /** The config version that introduced the change. */
  version: number
  effectiveFrom: number
  /** The local date the change took effect, `YYYY-MM-DD`. */
  date: string
  /** Which fields changed: `target`, `priority`, `tags`, `preferredTime`, `name`. */
  fields: string[]
  summary: string
}

export interface TaskDrift {
  taskId: string
  rate: RateDrift
  configChanges: ConfigChange[]
  notes: string[]
}

export interface DriftSummary {
  userId: number
  today: string
  generatedAt: number
  tasks: TaskDrift[]
  notes: string[]
}

function localDateFromMs(ms: number): string {
  const date = new Date(ms)
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

function pct(rate: number | null): string {
  return rate === null ? 'no data' : `${Math.round(rate * 100)}%`
}

// ---------------------------------------------------------------------------
// Recent vs long-term
// ---------------------------------------------------------------------------

/**
 * Compare one activity's recent completion against its longer-term average.
 * Reads through `activityStatistics`, so it can never disagree with the numbers
 * the app already shows.
 */
export function rateDriftForTask(
  db: DatabaseSync,
  userId: number,
  taskId: string,
  today: string,
  priorRate: number,
  options: { recentDays?: number; minLabelled?: number } = {},
): RateDrift {
  const recentDays = options.recentDays ?? DRIFT_RECENT_DAYS
  const minLabelled = options.minLabelled ?? DRIFT_MIN_LABELLED
  const stats = activityStatistics(db, userId, taskId, today, priorRate, { recentDays })

  const recentRate = stats.recent.raw
  const longTermRate = stats.completion.raw
  const judged = stats.recent.labelled >= minLabelled && stats.completion.labelled >= minLabelled

  let change: number | null = null
  let direction: DriftDirection = 'unknown'
  if (judged && recentRate !== null && longTermRate !== null) {
    change = recentRate - longTermRate
    direction = change > DRIFT_RATE_DELTA ? 'up' : change < -DRIFT_RATE_DELTA ? 'down' : 'steady'
  }

  let note: string
  if (!judged) {
    note = `Not enough recent labelled days yet to compare with the longer-term average (${stats.recent.labelled} recent, ${stats.completion.labelled} overall).`
  } else if (direction === 'steady') {
    note = `Recent completion (${pct(recentRate)} over the last ${recentDays} days) matches the longer-term average (${pct(longTermRate)}).`
  } else if (direction === 'up') {
    note = `Recent completion (${pct(recentRate)} over the last ${recentDays} days) is higher than the longer-term average (${pct(longTermRate)}) — a recent routine shift, shown as an association, not a cause.`
  } else {
    note = `Recent completion (${pct(recentRate)} over the last ${recentDays} days) is lower than the longer-term average (${pct(longTermRate)}) — a recent routine shift, shown as an association, not a cause.`
  }

  return {
    taskId,
    recentRate,
    recentLabelled: stats.recent.labelled,
    longTermRate,
    longTermLabelled: stats.completion.labelled,
    change,
    direction,
    judged,
    note,
  }
}

// ---------------------------------------------------------------------------
// Configuration changes
// ---------------------------------------------------------------------------

function sameTags(db: DatabaseSync, a: TaskConfigRow, b: TaskConfigRow): boolean {
  const left = [...configTagIds(db, a.id)].sort((x, y) => x - y)
  const right = [...configTagIds(db, b.id)].sort((x, y) => x - y)
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function describeChange(
  previous: TaskConfigRow,
  current: TaskConfigRow,
  fields: string[],
  date: string,
): string {
  const parts: string[] = []
  if (fields.includes('target')) {
    parts.push(`daily target changed from ${previous.target_duration ?? 'none'} to ${current.target_duration ?? 'none'} minute(s)`)
  }
  if (fields.includes('priority')) {
    parts.push(`priority changed from ${previous.priority ?? 'none'} to ${current.priority ?? 'none'}`)
  }
  if (fields.includes('tags')) parts.push('tags changed')
  if (fields.includes('preferredTime')) {
    parts.push(`preferred time changed from ${previous.preferred_time ?? 'none'} to ${current.preferred_time ?? 'none'} (an optional hint only)`)
  }
  if (fields.includes('name')) parts.push(`name changed to "${current.name}"`)
  return parts.length === 0 ? `Configuration updated on ${date}.` : `${parts.join('; ')} on ${date}.`
}

/**
 * The configuration changes for one activity, newest first, each dated. The
 * oldest version is a starting point, not a change.
 */
export function configChangesForTask(
  db: DatabaseSync,
  taskId: string,
  options: { sinceDate?: string } = {},
): ConfigChange[] {
  const configs = listTaskConfigs(db, taskId) // newest first
  const changes: ConfigChange[] = []
  for (let i = 0; i < configs.length - 1; i += 1) {
    const current = configs[i]
    const previous = configs[i + 1]
    const date = localDateFromMs(current.effective_from)
    if (options.sinceDate && date < options.sinceDate) continue
    const fields: string[] = []
    if (current.target_duration !== previous.target_duration) fields.push('target')
    if ((current.priority ?? null) !== (previous.priority ?? null)) fields.push('priority')
    if (!sameTags(db, previous, current)) fields.push('tags')
    if ((current.preferred_time ?? null) !== (previous.preferred_time ?? null)) fields.push('preferredTime')
    if (current.name !== previous.name) fields.push('name')
    if (fields.length === 0) continue
    changes.push({
      version: current.version,
      effectiveFrom: current.effective_from,
      date,
      fields,
      summary: describeChange(previous, current, fields, date),
    })
  }
  return changes
}

// ---------------------------------------------------------------------------
// Per-task and per-user summaries
// ---------------------------------------------------------------------------

export function driftForTask(
  db: DatabaseSync,
  userId: number,
  taskId: string,
  today: string,
  priorRate: number,
  options: { recentDays?: number; minLabelled?: number; sinceDate?: string } = {},
): TaskDrift {
  const rate = rateDriftForTask(db, userId, taskId, today, priorRate, options)
  const configChanges = configChangesForTask(db, taskId, { sinceDate: options.sinceDate })
  const notes = [rate.note, ...configChanges.map((change) => change.summary)]
  return { taskId, rate, configChanges, notes }
}

/**
 * A drift summary for every one of the user's activities. Read-only; safe to
 * call from a GET. It makes no prediction and writes nothing.
 */
export function driftSummary(
  db: DatabaseSync,
  userId: number,
  today: string,
  options: { recentDays?: number; minLabelled?: number; sinceDate?: string; now?: number } = {},
): DriftSummary {
  const taskIds = userTaskIds(db, userId)
  const priorRate = userCompletionPrior(db, userId, taskIds, today)
  const tasks = taskIds.map((taskId) => driftForTask(db, userId, taskId, today, priorRate, options))
  const notes: string[] = []
  for (const task of tasks) {
    if (task.rate.judged && task.rate.direction !== 'steady') notes.push(task.rate.note)
    for (const change of task.configChanges) notes.push(change.summary)
  }
  return { userId, today, generatedAt: options.now ?? Date.now(), tasks, notes }
}

