import type { CheckinState } from '../checkins-store'

/**
 * Cold-start stages (Phase 4, §3).
 *
 * The system must never claim personalisation before it has the data to back it
 * up. Two stages, with an explicit, configurable threshold:
 *
 * - **Stage 1 — no personal history.** Predictions come from the activity's own
 *   target, the day's check-in and the statistics of its tags, shrunk to the
 *   user's overall rates. Every output is labelled *insufficient personal
 *   history* and confidence is never higher than low.
 * - **Stage 2 — early data.** The activity's own statistics drive predictions.
 *   The threshold (`stage2_min_days` labelled days) is configurable per user.
 *
 * Confidence is a separate axis from the stage: it also drops when the check-in
 * was skipped (wider uncertainty, never an invented value) and in the reduced-
 * confidence window after an off period.
 */

export type Stage = 1 | 2
export type Confidence = 'low' | 'medium' | 'high'

export interface StageAssessment {
  stage: Stage
  labelledDays: number
  threshold: number
  /** True when the activity has no labelled days at all. */
  noHistory: boolean
  /** Short, factual reason a person can read. */
  reason: string
}

export function assessStage(labelledDays: number, stage2MinDays: number): StageAssessment {
  const threshold = Math.max(1, stage2MinDays)
  if (labelledDays <= 0) {
    return {
      stage: 1,
      labelledDays,
      threshold,
      noHistory: true,
      reason: 'No personal history for this activity yet.',
    }
  }
  if (labelledDays < threshold) {
    return {
      stage: 1,
      labelledDays,
      threshold,
      noHistory: false,
      reason: `${labelledDays} of ${threshold} labelled days so far, so this is still a starting estimate.`,
    }
  }
  return {
    stage: 2,
    labelledDays,
    threshold,
    noHistory: false,
    reason: `Based on ${labelledDays} labelled days for this activity.`,
  }
}

/** Drop one confidence level. */
export function downgrade(confidence: Confidence): Confidence {
  if (confidence === 'high') return 'medium'
  return 'low'
}

export interface ConfidenceInput {
  stage: Stage
  labelledDays: number
  stage2MinDays: number
  /** The check-in was skipped, so the context is unknown. */
  checkinSkipped: boolean
  /** Inside the reduced-confidence window after an off period. */
  reducedConfidence: boolean
}

/**
 * Confidence from the amount of data and the quality of today's context. The
 * order matters: a skipped check-in and a recent off period both widen the
 * uncertainty by one level, and a stage-1 activity can never exceed low.
 */
export function confidenceFor(input: ConfidenceInput): Confidence {
  let confidence: Confidence
  if (input.stage === 1) {
    confidence = 'low'
  } else {
    confidence = input.labelledDays >= Math.max(1, input.stage2MinDays) * 3 ? 'high' : 'medium'
  }
  if (input.reducedConfidence) confidence = downgrade(confidence)
  if (input.checkinSkipped) confidence = downgrade(confidence)
  return confidence
}

/** Whether a check-in state means the day's context is unknown. */
export function isSkipped(checkinState: CheckinState): boolean {
  return checkinState === 'skipped'
}

/**
 * The label a stage-1 prediction carries, so nothing is ever presented as more
 * personal than it is.
 */
export function stageNote(stage: Stage): string {
  return stage === 1 ? 'Insufficient personal history — starting estimate.' : 'Personalised from your own history.'
}
