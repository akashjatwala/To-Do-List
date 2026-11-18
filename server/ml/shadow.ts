import type { DatabaseSync } from 'node:sqlite'
import { brier, type Labelled } from './metrics'
import { promoteCandidate, type PromotionDecision } from './registry'
import type { ModelKind } from './training'

/**
 * Shadow mode (Phase 5, §5).
 *
 * A candidate that looks good on the historical validation window is not served
 * straight away. It runs **silently beside the champion** on live data: its
 * predictions are logged here, next to the champion's and the baseline's, and
 * are **never shown to the user and never treated as outcomes**. A `label` stays
 * NULL until the day is actually labelled, and even then it is the observed
 * outcome, never the prediction.
 *
 * Only after the candidate has beaten both the champion and the baseline over a
 * configurable minimum number of days and labelled predictions is it eligible for
 * promotion — and promotion still runs the ordinary chronological-validation
 * gate. This is what lets a candidate that wins on the validation window but
 * loses in shadow be caught and left unpromoted.
 */

export type ShadowKind = Exclude<ModelKind, 'timing'>

export interface ShadowInput {
  kind: ShadowKind
  candidateId: number
  championId: number | null
  date: string
  taskId: string
  candidateProbability: number | null
  championProbability: number | null
  baselineProbability: number | null
}

/**
 * Log a shadow prediction. Upserts on (user, kind, candidate, date, task) so a
 * re-run updates the row instead of piling up. The label is left untouched.
 */
export function logShadow(db: DatabaseSync, userId: number, input: ShadowInput, now = Date.now()): void {
  db.prepare(
    `INSERT INTO ml_shadow
       (user_id, kind, candidate_id, champion_id, local_date, task_id,
        candidate_probability, champion_probability, baseline_probability, label, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
     ON CONFLICT(user_id, kind, candidate_id, local_date, task_id) DO UPDATE SET
       champion_id = excluded.champion_id,
       candidate_probability = excluded.candidate_probability,
       champion_probability = excluded.champion_probability,
       baseline_probability = excluded.baseline_probability,
       updated_at = excluded.updated_at`,
  ).run(
    userId,
    input.kind,
    input.candidateId,
    input.championId,
    input.date,
    input.taskId,
    input.candidateProbability,
    input.championProbability,
    input.baselineProbability,
    now,
    now,
  )
}

/**
 * Attach the **observed** outcome to a shadow row once the day is labelled.
 * Only ever fills a NULL label, so a label can never be overwritten by another
 * prediction. Returns false when there is no such row or it is already labelled.
 */
export function labelShadow(
  db: DatabaseSync,
  userId: number,
  kind: ShadowKind,
  candidateId: number,
  date: string,
  taskId: string,
  label: 0 | 1,
  now = Date.now(),
): boolean {
  const result = db
    .prepare(
      `UPDATE ml_shadow SET label = ?, updated_at = ?
       WHERE user_id = ? AND kind = ? AND candidate_id = ? AND local_date = ? AND task_id = ? AND label IS NULL`,
    )
    .run(label, now, userId, kind, candidateId, date, taskId)
  return Number(result.changes) > 0
}

export interface ShadowSummary {
  rows: number
  /** Distinct days with at least one shadow prediction. */
  days: number
  labelled: number
  candidateBrier: number | null
  championBrier: number | null
  baselineBrier: number | null
  candidateBeatsChampion: boolean | null
  candidateBeatsBaseline: boolean | null
}

function brierOf(rows: Array<{ p: number | null; y: number }>): number | null {
  const labelled: Labelled[] = rows
    .filter((row) => row.p !== null && Number.isFinite(row.p))
    .map((row) => ({ p: row.p as number, y: row.y }))
  return brier(labelled)
}

/** Summarise a candidate's shadow predictions on the labelled subset. */
export function shadowSummary(db: DatabaseSync, userId: number, kind: ShadowKind, candidateId: number): ShadowSummary {
  const rows = db
    .prepare(
      `SELECT local_date, candidate_probability, champion_probability, baseline_probability, label
       FROM ml_shadow
       WHERE user_id = ? AND kind = ? AND candidate_id = ?`,
    )
    .all(userId, kind, candidateId) as unknown as Array<{
    local_date: string
    candidate_probability: number | null
    champion_probability: number | null
    baseline_probability: number | null
    label: number | null
  }>

  const days = new Set(rows.map((row) => row.local_date)).size
  const labelled = rows.filter((row) => row.label !== null)
  const candidateBrier = brierOf(labelled.map((row) => ({ p: row.candidate_probability, y: row.label as number })))
  const championBrier = brierOf(labelled.map((row) => ({ p: row.champion_probability, y: row.label as number })))
  const baselineBrier = brierOf(labelled.map((row) => ({ p: row.baseline_probability, y: row.label as number })))

  return {
    rows: rows.length,
    days,
    labelled: labelled.length,
    candidateBrier,
    championBrier,
    baselineBrier,
    candidateBeatsChampion: championBrier !== null && candidateBrier !== null ? candidateBrier < championBrier : null,
    candidateBeatsBaseline: baselineBrier !== null && candidateBrier !== null ? candidateBrier < baselineBrier : null,
  }
}

export interface ShadowGate {
  /** Minimum distinct days of shadow predictions. */
  minDays?: number
  /** Minimum labelled shadow predictions. */
  minLabelled?: number
}

export const DEFAULT_SHADOW_MIN_DAYS = 14
export const DEFAULT_SHADOW_MIN_LABELLED = 30

/**
 * Promote a candidate only after it has won in shadow over the minimum period,
 * and then only if it also passes the ordinary validation gate. A candidate that
 * wins on validation but loses in shadow is left unpromoted.
 */
export function promoteAfterShadow(
  db: DatabaseSync,
  userId: number,
  kind: ShadowKind,
  candidateId: number,
  options: ShadowGate = {},
): PromotionDecision {
  const minDays = options.minDays ?? DEFAULT_SHADOW_MIN_DAYS
  const minLabelled = options.minLabelled ?? DEFAULT_SHADOW_MIN_LABELLED
  const summary = shadowSummary(db, userId, kind, candidateId)

  if (summary.days < minDays) {
    return { ok: false, reason: `Shadow period too short: ${summary.days} day(s) of predictions (need ${minDays}).` }
  }
  if (summary.labelled < minLabelled) {
    return { ok: false, reason: `Not enough labelled shadow predictions: ${summary.labelled} (need ${minLabelled}).` }
  }
  if (summary.candidateBrier === null) {
    return { ok: false, reason: 'The candidate has no scoreable shadow predictions.' }
  }
  if (summary.candidateBeatsBaseline === false) {
    return {
      ok: false,
      reason: `Not promoted: in shadow the candidate (Brier ${summary.candidateBrier.toFixed(3)}) did not beat the baseline (${summary.baselineBrier!.toFixed(3)}).`,
    }
  }
  if (summary.candidateBeatsChampion === false) {
    return {
      ok: false,
      reason: `Not promoted: in shadow the candidate (Brier ${summary.candidateBrier.toFixed(3)}) did not beat the current model (${summary.championBrier!.toFixed(3)}).`,
    }
  }
  // Shadow won: still run the ordinary validation + reliability gate.
  return promoteCandidate(db, userId, candidateId)
}
