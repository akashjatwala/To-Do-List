import type { DatabaseSync } from 'node:sqlite'
import { CHECKIN_ANSWER_KEYS, deleteCheckins, type CheckinAnswerKey } from '../checkins-store'

/**
 * Privacy and retention.
 *
 * The learning system runs entirely on the user's own machine. There is no
 * external ML service, no telemetry and no upload path anywhere in this module
 * or the ones it calls — every model, statistic and log line is derived from,
 * and written back to, the local database only.
 *
 * The rules this module keeps, in code:
 * - **Every check-in field is optional.** Missing stays missing; nothing is
 *   defaulted, inferred or filled in. The free-text context note and the mood /
 *   body / workload answers are the most personal, and are never required to use
 *   the app.
 * - **Retention is stated, not implied.** The retention note below is returned
 *   by the API so the user can read exactly what is kept and for how long.
 * - **Deletion is real.** `deleteCheckinHistory` removes every check-in and its
 *   edit trail, and marks the derived check-in state in the outcome links as
 *   "not asked" again. It never deletes the user's recorded activity — what they
 *   actually did is theirs to keep.
 */

/** The check-in fields that are both optional and personal. */
export const SENSITIVE_CHECKIN_FIELDS: CheckinAnswerKey[] = [
  'feeling',
  'stress',
  'body',
  'sleep',
  'workload',
]

/** Plain-language retention note, returned by the privacy endpoint. */
export const DATA_RETENTION_NOTE =
  'Everything the learning system uses stays in this app\'s own local database on your machine. ' +
  'No personal data is sent to any external ML service. ' +
  'Check-ins are kept until you delete them; deleting them removes the check-ins and their edit trail, ' +
  'and clears the check-in state from the outcome links. ' +
  'Your recorded activity and the models trained from it are kept until you remove them.'

/** What the user can rely on, stated once and reused. */
export const PRIVACY_NOTES: string[] = [
  'All learning runs locally; nothing is uploaded.',
  'Every check-in question is optional, including the mood, body, workload and free-text context fields.',
  'A missing answer is stored as missing and is never filled in with a default.',
  'Mood and energy are used only as predictive inputs, never as a diagnosis or a measure of worth.',
]

export interface CheckinDataSummary {
  checkins: number
  historyRows: number
  /** Days with a free-text context note (the most personal field). */
  contextNotes: number
}

/** Counts only. No check-in content is read or returned. */
export function checkinDataSummary(db: DatabaseSync, userId: number): CheckinDataSummary {
  const checkins = db
    .prepare('SELECT COUNT(*) AS n FROM checkins WHERE user_id = ?')
    .get(userId) as unknown as { n: number }
  const historyRows = db
    .prepare('SELECT COUNT(*) AS n FROM checkin_history WHERE user_id = ?')
    .get(userId) as unknown as { n: number }
  const contextNotes = db
    .prepare("SELECT COUNT(*) AS n FROM checkins WHERE user_id = ? AND context IS NOT NULL AND context <> ''")
    .get(userId) as unknown as { n: number }
  return { checkins: checkins.n, historyRows: historyRows.n, contextNotes: contextNotes.n }
}

export interface DeletionResult {
  checkinsDeleted: number
  historyRowsDeleted: number
  /** Outcome-link rows whose derived check-in state was cleared. */
  linksCleared: number
}

/**
 * Delete every check-in and its edit trail for a user, and clear the derived
 * check-in state in the outcome links. Recorded activity is untouched.
 * `deleteCheckins` is already transactional; the link update is a single
 * statement, so both steps are safe without nesting a transaction.
 */
export function deleteCheckinHistory(db: DatabaseSync, userId: number): DeletionResult {
  const before = checkinDataSummary(db, userId)
  deleteCheckins(db, userId)
  const cleared = db
    .prepare("UPDATE activity_outcome_links SET checkin_state = 'not_asked', updated_at = ? WHERE user_id = ? AND checkin_state <> 'not_asked'")
    .run(Date.now(), userId)
  return {
    checkinsDeleted: before.checkins,
    historyRowsDeleted: before.historyRows,
    linksCleared: Number(cleared.changes),
  }
}

export interface PrivacySummary {
  userId: number
  generatedAt: number
  localOnly: true
  optionalFields: CheckinAnswerKey[]
  sensitiveFields: CheckinAnswerKey[]
  contextNoteOptional: true
  retentionNote: string
  notes: string[]
  data: CheckinDataSummary
}

/** A read-only privacy summary: what is kept, what is optional and how to delete. */
export function privacySummary(db: DatabaseSync, userId: number, now = Date.now()): PrivacySummary {
  return {
    userId,
    generatedAt: now,
    localOnly: true,
    optionalFields: [...CHECKIN_ANSWER_KEYS],
    sensitiveFields: SENSITIVE_CHECKIN_FIELDS,
    contextNoteOptional: true,
    retentionNote: DATA_RETENTION_NOTE,
    notes: PRIVACY_NOTES,
    data: checkinDataSummary(db, userId),
  }
}
