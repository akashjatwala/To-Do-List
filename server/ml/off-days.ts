import type { DatabaseSync } from 'node:sqlite'
import { parseLocalDate } from '../checkins-store'

/**
 * Off days and reduced-confidence windows.
 *
 * An off day is a day the user was not available to do anything — sick,
 * travelling, on holiday, or off for a reason they would rather not name. It is
 * stored as its **own record** (type, start, end, optional note, timestamps) and
 * never overwrites a session or a per-day status. The rules this module exists
 * to enforce, in code:
 *
 * - Marking a day off is one tap, and the reason is optional: "off" with no
 *   reason works and is stored as `kind = NULL`.
 * - A record can be added after the fact, edited and removed. Removing it never
 *   deletes or rewrites anything the user recorded about what they actually did.
 * - An off day is never a failure. Nothing here writes a `skipped` status, a
 *   zero duration or any negative label. Off days are excluded from statistics
 *   by default and merely flagged wherever a day is read (see `daily-activity`).
 * - The first few days after an off period carry reduced prediction confidence;
 *   that window is configurable (`user_settings.reduced_confidence_days`).
 */

export const OFF_DAY_KINDS = ['sick', 'travel', 'holiday', 'other'] as const
export type OffDayKind = (typeof OFF_DAY_KINDS)[number]

export const OFF_DAY_NOTE_MAX = 500

export interface OffDayRow {
  id: number
  user_id: number
  /** Optional: `NULL` means "off, no reason given". */
  kind: OffDayKind | null
  start_date: string
  end_date: string
  note: string | null
  source: string
  created_at: number
  updated_at: number
}

/** A validated off-day period, ready to store. */
export interface OffDayInput {
  kind: OffDayKind | null
  startDate: string
  endDate: string
  note: string | null
}

/** The user's configurable prediction thresholds. */
export interface PredictionSettings {
  /** Days after an off period that carry reduced confidence. */
  reducedConfidenceDays: number
  /** Share of recommendations that may explore a new time (~1 in 10). */
  explorationShare: number
  /** Labelled days that move an activity from stage 1 to stage 2. */
  stage2MinDays: number
}

export const DEFAULT_PREDICTION_SETTINGS: PredictionSettings = {
  reducedConfidenceDays: 3,
  explorationShare: 0.1,
  stage2MinDays: 10,
}

/** Parse a day kind. `null` means "no reason"; `undefined` means invalid. */
export function parseOffDayKind(value: unknown): OffDayKind | null | undefined {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string') return undefined
  return (OFF_DAY_KINDS as readonly string[]).includes(value) ? (value as OffDayKind) : undefined
}

/** Parse an optional note. `null` when blank, `undefined` when invalid. */
export function parseOffDayNote(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed.length > OFF_DAY_NOTE_MAX) return undefined
  return trimmed || null
}

/** Whole days between two local dates (`b - a`). Pure; UTC-based so DST cannot skew it. */
export function diffDays(a: string, b: string): number {
  const [ay, am, ad] = a.split('-').map(Number)
  const [by, bm, bd] = b.split('-').map(Number)
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000)
}

/** Add whole days to a local date, returning `YYYY-MM-DD`. */
export function addDays(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number)
  const next = new Date(Date.UTC(year, month - 1, day + days))
  const m = `${next.getUTCMonth() + 1}`.padStart(2, '0')
  const d = `${next.getUTCDate()}`.padStart(2, '0')
  return `${next.getUTCFullYear()}-${m}-${d}`
}

function rowOf(db: DatabaseSync, userId: number, id: number): OffDayRow | undefined {
  return db
    .prepare('SELECT * FROM off_days WHERE user_id = ? AND id = ?')
    .get(userId, id) as unknown as OffDayRow | undefined
}

/** Every off-day record for a user, most recent first. */
export function listOffDays(db: DatabaseSync, userId: number): OffDayRow[] {
  return db
    .prepare('SELECT * FROM off_days WHERE user_id = ? ORDER BY start_date DESC, id DESC')
    .all(userId) as unknown as OffDayRow[]
}

export function getOffDay(db: DatabaseSync, userId: number, id: number): OffDayRow | undefined {
  return rowOf(db, userId, id)
}

/** Create a new off-day record. Never touches sessions or daily statuses. */
export function createOffDay(
  db: DatabaseSync,
  userId: number,
  input: OffDayInput,
  source = 'user',
  now = Date.now(),
): OffDayRow {
  const result = db
    .prepare(
      `INSERT INTO off_days (user_id, kind, start_date, end_date, note, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(userId, input.kind, input.startDate, input.endDate, input.note, source, now, now)
  return rowOf(db, userId, Number(result.lastInsertRowid))!
}

/** Edit an off-day record in place. Returns undefined when it does not exist. */
export function updateOffDay(
  db: DatabaseSync,
  userId: number,
  id: number,
  input: OffDayInput,
  now = Date.now(),
): OffDayRow | undefined {
  const existing = rowOf(db, userId, id)
  if (!existing) return undefined
  db.prepare(
    `UPDATE off_days
     SET kind = ?, start_date = ?, end_date = ?, note = ?, updated_at = ?
     WHERE user_id = ? AND id = ?`,
  ).run(input.kind, input.startDate, input.endDate, input.note, now, userId, id)
  return rowOf(db, userId, id)
}

/** Remove an off-day record and its note. Observed activity is left untouched. */
export function deleteOffDay(db: DatabaseSync, userId: number, id: number): boolean {
  const result = db.prepare('DELETE FROM off_days WHERE user_id = ? AND id = ?').run(userId, id)
  return Number(result.changes) > 0
}

/** The record covering a date, or undefined. Overlaps resolve to the latest start. */
export function offDayCovering(db: DatabaseSync, userId: number, date: string): OffDayRow | undefined {
  return db
    .prepare(
      `SELECT * FROM off_days
       WHERE user_id = ? AND start_date <= ? AND end_date >= ?
       ORDER BY start_date DESC, id DESC
       LIMIT 1`,
    )
    .get(userId, date, date) as unknown as OffDayRow | undefined
}

/** True when the whole day is an off day. */
export function isOffDay(db: DatabaseSync, userId: number, date: string): boolean {
  return offDayCovering(db, userId, date) !== undefined
}

/** Every off day falling inside `[from, to]`, as a set of `YYYY-MM-DD` dates. */
export function offDayDates(
  db: DatabaseSync,
  userId: number,
  from: string,
  to: string,
): Set<string> {
  const rows = db
    .prepare(
      `SELECT * FROM off_days
       WHERE user_id = ? AND start_date <= ? AND end_date >= ?
       ORDER BY start_date`,
    )
    .all(userId, to, from) as unknown as OffDayRow[]
  const out = new Set<string>()
  for (const row of rows) {
    let cursor = row.start_date < from ? from : row.start_date
    const end = row.end_date > to ? to : row.end_date
    while (cursor <= end) {
      out.add(cursor)
      cursor = addDays(cursor, 1)
    }
  }
  return out
}

/** The most recent off period that ended strictly before `date`, or undefined. */
function latestOffEndBefore(db: DatabaseSync, userId: number, date: string): OffDayRow | undefined {
  return db
    .prepare(
      `SELECT * FROM off_days
       WHERE user_id = ? AND end_date < ?
       ORDER BY end_date DESC, id DESC
       LIMIT 1`,
    )
    .get(userId, date) as unknown as OffDayRow | undefined
}

export interface OffDayContext {
  /** The whole day is an off day, so predictions are suppressed. */
  onOffDay: boolean
  /** The record covering `date`, when there is one. */
  offDay: OffDayRow | null
  /** Days since the most recent off period that ended before `date`, or null. */
  daysSinceOff: number | null
  /** Inside the configurable post-off reduced-confidence window. */
  reducedConfidence: boolean
  /** The most recent off period the window refers to, when there is one. */
  lastOffDay: OffDayRow | null
}

/**
 * Everything the prediction layer needs to know about off days for one date:
 * whether the day is off, and whether it sits in the reduced-confidence window
 * that follows an off period.
 */
export function offDayContext(
  db: DatabaseSync,
  userId: number,
  date: string,
  settings: PredictionSettings = DEFAULT_PREDICTION_SETTINGS,
): OffDayContext {
  const covering = offDayCovering(db, userId, date)
  if (covering) {
    return {
      onOffDay: true,
      offDay: covering,
      daysSinceOff: 0,
      reducedConfidence: false,
      lastOffDay: covering,
    }
  }
  const last = latestOffEndBefore(db, userId, date)
  if (!last) {
    return { onOffDay: false, offDay: null, daysSinceOff: null, reducedConfidence: false, lastOffDay: null }
  }
  const daysSince = diffDays(last.end_date, date)
  const reduced = daysSince >= 1 && daysSince <= settings.reducedConfidenceDays
  return { onOffDay: false, offDay: null, daysSinceOff: daysSince, reducedConfidence: reduced, lastOffDay: last }
}

// ---------------------------------------------------------------------------
// Prediction settings
// ---------------------------------------------------------------------------

interface UserSettingsRow {
  user_id: number
  show_summary: number
  show_estimates: number
  reduced_confidence_days: number
  exploration_share: number
  stage2_min_days: number
  updated_at: number
}

/** The user's thresholds, falling back to the defaults when none are stored. */
export function getPredictionSettings(db: DatabaseSync, userId: number): PredictionSettings {
  const row = db
    .prepare('SELECT * FROM user_settings WHERE user_id = ?')
    .get(userId) as unknown as UserSettingsRow | undefined
  if (!row) return { ...DEFAULT_PREDICTION_SETTINGS }
  return {
    reducedConfidenceDays: row.reduced_confidence_days,
    explorationShare: row.exploration_share,
    stage2MinDays: row.stage2_min_days,
  }
}

/** Store the user's thresholds. Only the supplied fields change. */
export function savePredictionSettings(
  db: DatabaseSync,
  userId: number,
  input: Partial<PredictionSettings>,
  now = Date.now(),
): PredictionSettings {
  const next: PredictionSettings = { ...getPredictionSettings(db, userId), ...input }
  db.prepare(
    `INSERT INTO user_settings
       (user_id, reduced_confidence_days, exploration_share, stage2_min_days, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       reduced_confidence_days = excluded.reduced_confidence_days,
       exploration_share = excluded.exploration_share,
       stage2_min_days = excluded.stage2_min_days,
       updated_at = excluded.updated_at`,
  ).run(userId, next.reducedConfidenceDays, next.explorationShare, next.stage2MinDays, now)
  return next
}

/** Validate a settings patch from a request body. Returns null when invalid. */
export function parsePredictionSettings(value: unknown): Partial<PredictionSettings> | null {
  if (typeof value !== 'object' || value === null) return null
  const body = value as Record<string, unknown>
  const out: Partial<PredictionSettings> = {}
  if (body.reducedConfidenceDays !== undefined) {
    const n = body.reducedConfidenceDays
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > 60) return null
    out.reducedConfidenceDays = n
  }
  if (body.explorationShare !== undefined) {
    const n = body.explorationShare
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 1) return null
    out.explorationShare = n
  }
  if (body.stage2MinDays !== undefined) {
    const n = body.stage2MinDays
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 400) return null
    out.stage2MinDays = n
  }
  return out
}

/** Validate an off-day payload (create or edit). Returns null when invalid. */
export function parseOffDayInput(value: unknown): OffDayInput | null {
  if (typeof value !== 'object' || value === null) return null
  const body = value as Record<string, unknown>
  const startDate = parseLocalDate(body.startDate ?? body.date)
  const endDate = parseLocalDate(body.endDate ?? body.startDate ?? body.date)
  if (!startDate || !endDate) return null
  if (endDate < startDate) return null
  const kind = parseOffDayKind(body.kind)
  if (kind === undefined) return null
  const note = parseOffDayNote(body.note)
  if (note === undefined) return null
  return { kind, startDate, endDate, note }
}
