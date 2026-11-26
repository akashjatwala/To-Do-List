import type { DatabaseSync } from 'node:sqlite'
import { configForDate, configTagIds } from './task-config'
import { dailyActivity } from './daily-activity'
import { buildTrainingSet } from './dataset'
import { trainUserModels } from './pipeline'
import { promoteCandidate, shouldRetrain } from './registry'
import type { ModelKind } from './training'
import { userTaskIds } from './statistics'
import { mlLog, safeRun } from './logging'
import { clearFallback, evaluateModelHealth, labelHealthForDay } from './health'

/**
 * Continuous learning.
 *
 * Recording activity is the moment the system learns something real. This module
 * is the bridge between the recording path and the learning path, and it keeps
 * three promises, in code:
 *
 * - **The linkage is stored, not guessed.** Whenever a session or a day status is
 *   written or removed, `recordActivityOutcome` recomputes one row per
 *   (task, day) in `activity_outcome_links`: the check-in state that preceded the
 *   day, the observed outcome (performed / target met / minutes), the tags and
 *   priority that applied. A missing value stays NULL.
 * - **Statistics follow immediately.** `tagLevelStatistics` reads those links and
 *   returns completion by tag straight away, without waiting for a retrain.
 * - **Retraining is gated and rate-limited.** `maybeRetrain` retrains only when
 *   the retrain gate says enough new labelled data has accumulated (or the model
 *   is stale), never more often than the configured interval, and it still runs
 *   the ordinary promotion gate. It never fabricates rows and never marks a
 *   prediction as an outcome.
 *
 * Every failure here is logged and swallowed: learning never blocks recording.
 */

/** How often, at most, a user's models may be retrained (6 hours). */
export const RETRAIN_MIN_INTERVAL_MS = 6 * 60 * 60 * 1000
/** A model older than this also triggers a retrain, even without new labels. */
export const RETRAIN_MAX_STALENESS_DAYS = 30
/**
 * The kinds that have a served model and therefore a retrain gate. Only the
 * completion classifier is trained; `timing` is a profile, not a model.
 */
export const RETRAIN_KINDS: ModelKind[] = ['completion']

export interface OutcomeLinkRow {
  user_id: number
  task_id: string
  local_date: string
  checkin_state: string
  performed: number | null
  target_achieved: number | null
  total_minutes: number
  tag_ids: string
  priority: string | null
  config_version_id: number | null
  recorded_at: number
  updated_at: number
}

/**
 * Recompute the check-in/outcome link for one (task, day). Idempotent: calling it
 * twice for the same day writes the same row. It reads the day through the shared
 * `dailyActivity` derivation, so it can never disagree with what the app shows.
 */
export function recordActivityOutcome(
  db: DatabaseSync,
  userId: number,
  taskId: string,
  date: string,
  today: string,
  now = Date.now(),
): void {
  const config = configForDate(db, taskId, date)
  const day = dailyActivity(db, userId, taskId, date, today)
  const checkin = db
    .prepare('SELECT skipped FROM checkins WHERE user_id = ? AND date = ?')
    .get(userId, date) as unknown as { skipped: number } | undefined
  const state = checkin ? (checkin.skipped === 1 ? 'skipped' : 'completed') : 'not_asked'
  const tagIds = config ? configTagIds(db, config.id) : []

  db.prepare(
    `INSERT INTO activity_outcome_links
       (user_id, task_id, local_date, checkin_state, performed, target_achieved,
        total_minutes, tag_ids, priority, config_version_id, recorded_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, task_id, local_date) DO UPDATE SET
       checkin_state = excluded.checkin_state,
       performed = excluded.performed,
       target_achieved = excluded.target_achieved,
       total_minutes = excluded.total_minutes,
       tag_ids = excluded.tag_ids,
       priority = excluded.priority,
       config_version_id = excluded.config_version_id,
       updated_at = excluded.updated_at`,
  ).run(
    userId,
    taskId,
    date,
    state,
    day.performed === null ? null : day.performed ? 1 : 0,
    day.targetAchieved === null ? null : day.targetAchieved ? 1 : 0,
    day.totalMinutes,
    JSON.stringify(tagIds),
    config?.priority ?? null,
    config?.id ?? null,
    now,
    now,
  )

  // Attach the observed outcome to any health prediction stored for this day, so
  // the live model can be scored later against the baseline. Only ever fills a
  // NULL label; a prediction is never written back as an outcome.
  labelHealthForDay(db, userId, date, taskId, {
    performed: day.performed,
  }, now)
}

/** Record the link for every task touched by an activity write, safely. */
export function recordActivityOutcomeSafe(
  db: DatabaseSync,
  userId: number,
  taskId: string,
  date: string,
  today: string,
): void {
  safeRun('learning.record-outcome', () => recordActivityOutcome(db, userId, taskId, date, today), undefined)
}

export interface OutcomeLinkQuery {
  taskId?: string
  from?: string
  to?: string
  limit?: number
}

export function listOutcomeLinks(db: DatabaseSync, userId: number, query: OutcomeLinkQuery = {}): OutcomeLinkRow[] {
  const clauses = ['user_id = ?']
  const args: Array<string | number> = [userId]
  if (query.taskId) {
    clauses.push('task_id = ?')
    args.push(query.taskId)
  }
  if (query.from) {
    clauses.push('local_date >= ?')
    args.push(query.from)
  }
  if (query.to) {
    clauses.push('local_date <= ?')
    args.push(query.to)
  }
  args.push(query.limit ?? 1000)
  return db
    .prepare(`SELECT * FROM activity_outcome_links WHERE ${clauses.join(' AND ')} ORDER BY local_date DESC LIMIT ?`)
    .all(...args) as unknown as OutcomeLinkRow[]
}

export interface TagLevelStatistic {
  tagId: string
  labelled: number
  performed: number
  completionRate: number | null
}

/**
 * Completion by tag, read straight from the stored links — the immediate,
 * per-tag statistic. Tags with no labelled day are reported with a null rate
 * rather than a fabricated one.
 */
export function tagLevelStatistics(db: DatabaseSync, userId: number, query: OutcomeLinkQuery = {}): TagLevelStatistic[] {
  const links = listOutcomeLinks(db, userId, { ...query, limit: query.limit ?? 100000 })
  const totals = new Map<string, { labelled: number; performed: number }>()
  for (const link of links) {
    if (link.performed === null) continue
    let tags: string[] = []
    try {
      const parsed = JSON.parse(link.tag_ids) as unknown
      if (Array.isArray(parsed)) tags = parsed.map(String)
    } catch {
      tags = []
    }
    for (const tagId of tags) {
      const bucket = totals.get(tagId) ?? { labelled: 0, performed: 0 }
      bucket.labelled += 1
      if (link.performed === 1) bucket.performed += 1
      totals.set(tagId, bucket)
    }
  }
  return [...totals.entries()]
    .map(([tagId, bucket]) => ({
      tagId,
      labelled: bucket.labelled,
      performed: bucket.performed,
      completionRate: bucket.labelled > 0 ? bucket.performed / bucket.labelled : null,
    }))
    .sort((a, b) => b.labelled - a.labelled || a.tagId.localeCompare(b.tagId))
}

// ---------------------------------------------------------------------------
// Retraining trigger
// ---------------------------------------------------------------------------

export interface RetrainDecisionRow {
  kind: ModelKind
  should: boolean
  reason: string
  newLabelled: number
  currentLabelled: number
}

export interface RetrainOptions {
  /** Minimum new labelled observations before retraining. Defaults to the gate. */
  minNewLabelled?: number
  /** Staleness limit in days. Defaults to `RETRAIN_MAX_STALENESS_DAYS`. */
  maxDays?: number
  /** Minimum time between retrains. Defaults to `RETRAIN_MIN_INTERVAL_MS`. */
  minIntervalMs?: number
  /** Set to bypass the rate limit (used by the explicit retrain command). */
  force?: boolean
  /** The user's local date; defaults to the newest recorded session. */
  today?: string
  now?: number
}

export interface RetrainOutcome {
  ran: boolean
  reason: string
  decisions: RetrainDecisionRow[]
  promoted: Array<{ kind: ModelKind; ok: boolean; reason: string }>
  version: string | null
}

function latestRecordedDate(db: DatabaseSync, userId: number): string | null {
  const row = db
    .prepare('SELECT MAX(local_date) AS d FROM activity_sessions WHERE user_id = ?')
    .get(userId) as unknown as { d: string | null }
  return row.d ?? null
}

/** The most recent retrain attempt for a user, or null. */
export function lastRetrainAt(db: DatabaseSync, userId: number): number | null {
  const row = db
    .prepare('SELECT MAX(created_at) AS t FROM ml_retrain_log WHERE user_id = ?')
    .get(userId) as unknown as { t: number | null }
  return row.t ?? null
}

/**
 * Ask the retrain gate, per kind, whether a retrain is due. This reads the
 * training set once (the same set training would use) so the counts are real.
 */
export function retrainStatus(db: DatabaseSync, userId: number, options: RetrainOptions = {}): RetrainDecisionRow[] {
  const today = options.today ?? latestRecordedDate(db, userId)
  if (!today) {
    return RETRAIN_KINDS.map((kind) => ({
      kind,
      should: false,
      reason: 'No activity has been recorded yet.',
      newLabelled: 0,
      currentLabelled: 0,
    }))
  }
  const set = buildTrainingSet(db, userId, userTaskIds(db, userId), '1970-01-01', today, today)
  return RETRAIN_KINDS.map((kind) => {
    const decision = shouldRetrain(db, userId, kind, set.labelledCount, {
      minNewLabelled: options.minNewLabelled,
      maxDays: options.maxDays ?? RETRAIN_MAX_STALENESS_DAYS,
    })
    return { kind, should: decision.should, reason: decision.reason, newLabelled: decision.newLabelled, currentLabelled: set.labelledCount }
  })
}

/**
 * Retrain the user's completion model when the gate says so and the rate limit
 * allows it, then run the ordinary promotion gate. Returns what happened.
 */
export function maybeRetrain(db: DatabaseSync, userId: number, options: RetrainOptions = {}): RetrainOutcome {
  const now = options.now ?? Date.now()
  const decisions = retrainStatus(db, userId, options)
  const due = decisions.filter((row) => row.should)

  if (due.length === 0) {
    return { ran: false, reason: 'No retrain is due: the labelled data has not grown enough and the model is not stale.', decisions, promoted: [], version: null }
  }

  const interval = options.minIntervalMs ?? RETRAIN_MIN_INTERVAL_MS
  const last = lastRetrainAt(db, userId)
  if (!options.force && last !== null && now - last < interval) {
    const hours = ((interval - (now - last)) / 3_600_000).toFixed(1)
    return { ran: false, reason: `A retrain is due but the rate limit is in effect for another ${hours} hour(s).`, decisions, promoted: [], version: null }
  }

  const today = options.today ?? latestRecordedDate(db, userId) ?? new Date(now).toISOString().slice(0, 10)
  const version = `retrain-${today}`
  const result = safeRun(
    'learning.retrain',
    () => trainUserModels(db, userId, { register: true, today, version, from: '1970-01-01', to: today }),
    null,
  )

  if (!result) {
    for (const row of due) {
      logRetrain(db, userId, row.kind, 'threshold', row.newLabelled, false, false, 'The training run failed; the previous model is kept.', now)
    }
    return { ran: false, reason: 'The retrain failed and was logged; the previous models are still served.', decisions, promoted: [], version: null }
  }

  const promoted: Array<{ kind: ModelKind; ok: boolean; reason: string }> = []
  for (const candidate of result.candidates) {
    if (candidate.id === null) continue
    const decision = promoteCandidate(db, userId, candidate.id)
    promoted.push({ kind: candidate.kind, ok: decision.ok, reason: decision.reason })
    logRetrain(db, userId, candidate.kind, 'threshold', result.labelledCount, true, decision.ok, decision.reason, now)
  }

  // A successful retrain clears any health fallback so the fresh model gets a
  // chance; it still has to prove itself in the rolling health window again.
  // (`trainUserModels` has already updated the retrain bookkeeping per kind.)
  safeRun('learning.clear-fallback', () => clearFallback(db, userId), undefined)

  mlLog('info', 'learning.retrain', `version ${version}; ${promoted.filter((row) => row.ok).length} promoted`)
  return { ran: true, reason: `Retrained as ${version}.`, decisions, promoted, version }
}

function logRetrain(
  db: DatabaseSync,
  userId: number,
  kind: ModelKind,
  trigger: string,
  newLabelled: number,
  trained: boolean,
  promoted: boolean,
  detail: string,
  now: number,
): void {
  db.prepare(
    `INSERT INTO ml_retrain_log (user_id, kind, trigger, new_labelled, trained, promoted, detail, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(userId, kind, trigger, newLabelled, trained ? 1 : 0, promoted ? 1 : 0, detail, now)
}

/**
 * Re-evaluate the rolling health for a user's live model. Called after a
 * retrain and on demand from the health view.
 */
export function refreshHealth(db: DatabaseSync, userId: number, now = Date.now()): void {
  safeRun('learning.refresh-health', () => {
    for (const kind of RETRAIN_KINDS) evaluateModelHealth(db, userId, kind, { now })
  }, undefined)
}

export interface SchedulerHandle {
  stop: () => void
}

/**
 * A lightweight periodic trigger: it wakes up on an interval and calls
 * `maybeRetrain` for the given user. The timer is unref'd so it never keeps the
 * process alive on its own, and the work is rate-limited inside `maybeRetrain`.
 * If the caller does not pass a user, it discovers users that have activity.
 */
export function startRetrainScheduler(
  db: DatabaseSync,
  options: { userId?: number; everyMs?: number; onRun?: (userId: number, outcome: RetrainOutcome) => void } = {},
): SchedulerHandle {
  const everyMs = options.everyMs ?? 6 * 60 * 60 * 1000
  const timer = setInterval(() => {
    const users =
      options.userId !== undefined
        ? [options.userId]
        : (db.prepare('SELECT DISTINCT user_id FROM activity_sessions').all() as unknown as Array<{ user_id: number }>).map((row) => row.user_id)
    for (const userId of users) {
      const outcome = safeRun('learning.scheduler', () => maybeRetrain(db, userId), null)
      if (outcome && options.onRun) options.onRun(userId, outcome)
    }
  }, everyMs)
  timer.unref?.()
  return { stop: () => clearInterval(timer) }
}
