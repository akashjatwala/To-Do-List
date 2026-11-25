import type { DatabaseSync } from 'node:sqlite'

/**
 * The nine daily check-in questions.
 *
 * Every answer is stored as an ordinal **1–5**, where 1 is the first option
 * shown to the user and 5 is the last. The option labels live in
 * `src/lib/checkin.ts`; the key order here is fixed so the direction never
 * drifts between the API and the UI.
 *
 * Missing stays missing: a question the user never touched is stored as NULL,
 * and it is never defaulted, inferred or filled in.
 */
export const CHECKIN_ANSWER_KEYS = [
  'feeling',
  'energy',
  'motivation',
  'sleep',
  'stress',
  'free_time',
  'focus',
  'body',
  'workload',
] as const

export type CheckinAnswerKey = (typeof CHECKIN_ANSWER_KEYS)[number]

/** `not_asked` means there is no record at all for that day. */
export type CheckinState = 'not_asked' | 'completed' | 'partial' | 'skipped'

export interface CheckinRow {
  id: number
  user_id: number
  date: string
  feeling: number | null
  energy: number | null
  motivation: number | null
  sleep: number | null
  stress: number | null
  free_time: number | null
  focus: number | null
  body: number | null
  workload: number | null
  skipped: number
  context: string | null
  source: string
  created_at: number
  updated_at: number
}

export interface CheckinHistoryRow extends Omit<CheckinRow, 'created_at' | 'updated_at'> {
  checkin_id: number
  recorded_at: number
}

export interface CheckinInput {
  date: string
  answers: Record<CheckinAnswerKey, number | null>
  context: string | null
}

const CONTEXT_MAX = 500
const LOCAL_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** Create the check-in tables if they do not exist yet (safe to run on every boot). */
export function createCheckinSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS checkins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      feeling INTEGER,
      energy INTEGER,
      motivation INTEGER,
      sleep INTEGER,
      stress INTEGER,
      free_time INTEGER,
      focus INTEGER,
      body INTEGER,
      workload INTEGER,
      skipped INTEGER NOT NULL DEFAULT 0,
      context TEXT,
      source TEXT NOT NULL DEFAULT 'user',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (user_id, date),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    -- Append-only trail of every edit, so a mid-day change keeps its timestamp.
    CREATE TABLE IF NOT EXISTS checkin_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      checkin_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      feeling INTEGER,
      energy INTEGER,
      motivation INTEGER,
      sleep INTEGER,
      stress INTEGER,
      free_time INTEGER,
      focus INTEGER,
      body INTEGER,
      workload INTEGER,
      skipped INTEGER NOT NULL DEFAULT 0,
      context TEXT,
      source TEXT NOT NULL DEFAULT 'user',
      recorded_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_checkins_user_date ON checkins(user_id, date);
    CREATE INDEX IF NOT EXISTS idx_checkin_history_user ON checkin_history(user_id, recorded_at);
    CREATE INDEX IF NOT EXISTS idx_checkin_history_user_date_asof ON checkin_history(user_id, date, recorded_at);
  `)
}

/** Validate a local calendar date (`YYYY-MM-DD`). Returns null when invalid. */
export function parseLocalDate(value: unknown): string | null {
  if (typeof value !== 'string' || !LOCAL_DATE_RE.test(value)) return null
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null
  }
  return value
}

/**
 * An answer is an ordinal 1–5. `null` means it was left blank (stays missing);
 * `undefined` means the value was invalid.
 */
export function parseAnswer(value: unknown): number | null | undefined {
  if (value === undefined || value === null) return null
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 5) {
    return undefined
  }
  return value
}

/** Optional free-text context. `null` when blank, `undefined` when invalid. */
export function parseContext(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed.length > CONTEXT_MAX) return undefined
  return trimmed || null
}

/** Derive the queryable state of a day from its stored row. */
export function checkinState(row: CheckinRow): CheckinState {
  if (row.skipped === 1) return 'skipped'
  const answered = CHECKIN_ANSWER_KEYS.filter((key) => row[key] !== null).length
  return answered === CHECKIN_ANSWER_KEYS.length ? 'completed' : 'partial'
}

/** The answered questions only; NULL stays absent rather than becoming a value. */
export function answeredValues(row: CheckinRow): Partial<Record<CheckinAnswerKey, number>> {
  const out: Partial<Record<CheckinAnswerKey, number>> = {}
  for (const key of CHECKIN_ANSWER_KEYS) {
    const value = row[key]
    if (value !== null) out[key] = value
  }
  return out
}

export function getCheckin(
  db: DatabaseSync,
  userId: number,
  date: string,
): CheckinRow | undefined {
  return db
    .prepare('SELECT * FROM checkins WHERE user_id = ? AND date = ?')
    .get(userId, date) as unknown as CheckinRow | undefined
}

/**
 * The check-in state as it was known at `asOfEpoch`, reconstructed from the
 * append-only history. A later edit must not change an earlier prediction.
 * Falls back to the current row only when it was created before the cutoff and
 * has no history (older databases and direct inserts).
 */
export function getCheckinAsOf(
  db: DatabaseSync,
  userId: number,
  date: string,
  asOfEpoch: number,
): CheckinRow | undefined {
  const history = db
    .prepare(
      `SELECT * FROM checkin_history
       WHERE user_id = ? AND date = ? AND recorded_at <= ?
       ORDER BY recorded_at DESC, id DESC LIMIT 1`,
    )
    .get(userId, date, asOfEpoch) as unknown as CheckinHistoryRow | undefined
  if (history) {
    return {
      id: history.checkin_id,
      user_id: history.user_id,
      date: history.date,
      feeling: history.feeling,
      energy: history.energy,
      motivation: history.motivation,
      sleep: history.sleep,
      stress: history.stress,
      free_time: history.free_time,
      focus: history.focus,
      body: history.body,
      workload: history.workload,
      skipped: history.skipped,
      context: history.context,
      source: history.source,
      created_at: history.recorded_at,
      updated_at: history.recorded_at,
    }
  }
  const current = getCheckin(db, userId, date)
  return current && current.created_at <= asOfEpoch ? current : undefined
}

/** Most recent days first, for the "view your history" screen. */
export function listCheckins(db: DatabaseSync, userId: number, limit = 30): CheckinRow[] {
  return db
    .prepare('SELECT * FROM checkins WHERE user_id = ? ORDER BY date DESC LIMIT ?')
    .all(userId, limit) as unknown as CheckinRow[]
}

/** Append-only edit trail, newest first. */
export function listCheckinHistory(
  db: DatabaseSync,
  userId: number,
  limit = 60,
): CheckinHistoryRow[] {
  return db
    .prepare(
      'SELECT * FROM checkin_history WHERE user_id = ? ORDER BY recorded_at DESC, id DESC LIMIT ?',
    )
    .all(userId, limit) as unknown as CheckinHistoryRow[]
}

function recordHistory(db: DatabaseSync, row: CheckinRow, recordedAt: number): void {
  db.prepare(
    `INSERT INTO checkin_history
       (checkin_id, user_id, date, feeling, energy, motivation, sleep, stress,
        free_time, focus, body, workload, skipped, context, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.user_id,
    row.date,
    row.feeling,
    row.energy,
    row.motivation,
    row.sleep,
    row.stress,
    row.free_time,
    row.focus,
    row.body,
    row.workload,
    row.skipped,
    row.context,
    recordedAt,
  )
}

/**
 * Save the answers for a day, creating the record on first write and updating
 * it afterwards. `created_at` is preserved on updates; each write appends a
 * snapshot to the history table.
 */
export function saveCheckin(db: DatabaseSync, userId: number, input: CheckinInput, now = Date.now()): CheckinRow {
  db.exec('BEGIN')
  try {
    db.prepare(
      `INSERT INTO checkins
         (user_id, date, feeling, energy, motivation, sleep, stress,
          free_time, focus, body, workload, skipped, context, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
       ON CONFLICT(user_id, date) DO UPDATE SET
         feeling = excluded.feeling,
         energy = excluded.energy,
         motivation = excluded.motivation,
         sleep = excluded.sleep,
         stress = excluded.stress,
         free_time = excluded.free_time,
         focus = excluded.focus,
         body = excluded.body,
         workload = excluded.workload,
         skipped = 0,
         context = excluded.context,
         updated_at = excluded.updated_at`,
    ).run(
      userId,
      input.date,
      input.answers.feeling,
      input.answers.energy,
      input.answers.motivation,
      input.answers.sleep,
      input.answers.stress,
      input.answers.free_time,
      input.answers.focus,
      input.answers.body,
      input.answers.workload,
      input.context,
      now,
      now,
    )

    const row = getCheckin(db, userId, input.date)
    if (!row) throw new Error('Check-in could not be saved.')
    recordHistory(db, row, now)
    db.exec('COMMIT')
    return row
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

/**
 * Skip the whole check-in for a day. Recorded as skipped with no answers —
 * never as neutral values.
 */
export function skipCheckin(db: DatabaseSync, userId: number, date: string, now = Date.now()): CheckinRow {
  db.exec('BEGIN')
  try {
    db.prepare(
      `INSERT INTO checkins
         (user_id, date, feeling, energy, motivation, sleep, stress,
          free_time, focus, body, workload, skipped, context, created_at, updated_at)
       VALUES (?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 1, NULL, ?, ?)
       ON CONFLICT(user_id, date) DO UPDATE SET
         feeling = NULL,
         energy = NULL,
         motivation = NULL,
         sleep = NULL,
         stress = NULL,
         free_time = NULL,
         focus = NULL,
         body = NULL,
         workload = NULL,
         skipped = 1,
         context = NULL,
         updated_at = excluded.updated_at`,
    ).run(userId, date, now, now)

    const row = getCheckin(db, userId, date)
    if (!row) throw new Error('Check-in could not be skipped.')
    recordHistory(db, row, now)
    db.exec('COMMIT')
    return row
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
