import {
  CHECKIN_QUESTIONS,
  labelForKey,
  type CheckinAnswerKey,
  type CheckinAnswerValues,
} from './checkin'

/**
 * Display-only helpers for the "Energy Level" card.
 *
 * These are presentation helpers only. They do **not** change the score the
 * server computes, the stored answers, or any API. The overall score and its
 * three internal groups still come from `server/ml/readiness.ts`;
 * this module just re-groups the same answered fields into the four sub-scores
 * the card shows, and describes an answer next to the person's own usual in
 * neutral words.
 *
 * Every answer is stored as an ordinal 1–5 where **1 is the best end**. To keep
 * the wording neutral and the comparisons meaningful, the helpers here flip the
 * ordinal into "goodness" (5 is best) exactly as the readiness scorer does. Missing answers
 * stay missing: a skipped field is never counted, defaulted or filled in.
 */

/** Flip a stored 1–5 answer so 5 is always the best. Mirrors the readiness scorer. */
export function goodness(value: number): number {
  return 6 - value
}

/** Map a 1–5 goodness value onto 0–100. Mirrors the readiness score mapping. */
export function goodnessToScore(goodnessValue: number): number {
  const clamped = Math.min(5, Math.max(1, goodnessValue))
  return Math.round(((clamped - 1) / 4) * 100)
}

export type EnergyTone = 'peach' | 'butter' | 'cyan' | 'lime' | 'plain'

export interface EnergyBand {
  key: 'drained' | 'low' | 'good' | 'strong' | 'steady'
  /** Decorative band emoji. Always paired with the text label. */
  emoji: string
  /** Neutral, non-judgemental label. */
  label: string
  /** Which soft background the card uses. Never red. */
  tone: EnergyTone
}

/**
 * The four score bands. Boundaries are inclusive of the lower number:
 * 0–20, 21–50, 51–80, 81–100. A withheld score (including no check-in)
 * uses the plain white band.
 */
export function scoreBand(score: number | null): EnergyBand {
  if (score === null || Number.isNaN(score)) {
    return { key: 'steady', emoji: '🙂', label: 'Steady', tone: 'plain' }
  }
  const value = Math.max(0, Math.min(100, score))
  if (value <= 20) return { key: 'drained', emoji: '🪫', label: 'Running low', tone: 'peach' }
  if (value <= 50) return { key: 'low', emoji: '😴', label: 'Low', tone: 'butter' }
  if (value <= 80) return { key: 'good', emoji: '💪', label: 'Good', tone: 'cyan' }
  return { key: 'strong', emoji: '⚡', label: 'Strong', tone: 'lime' }
}

export type EnergySubScoreKey = 'physical' | 'mood' | 'focus' | 'capacity'

export interface EnergySubScoreGroup {
  key: EnergySubScoreKey
  emoji: string
  label: string
  fields: readonly CheckinAnswerKey[]
}

/**
 * The four sub-scores the card shows. For **display only** this replaces the
 * three internal groups the readiness scorer uses for the overall score. The overall score
 * itself is unchanged; the internal grouping stays in the server config.
 */
export const ENERGY_SUB_SCORES: readonly EnergySubScoreGroup[] = [
  { key: 'physical', emoji: '💪', label: 'Physical', fields: ['energy', 'sleep', 'body'] },
  { key: 'mood', emoji: '😊', label: 'Mood', fields: ['feeling', 'stress'] },
  { key: 'focus', emoji: '🎯', label: 'Focus', fields: ['focus', 'motivation'] },
  { key: 'capacity', emoji: '⏳', label: 'Capacity', fields: ['free_time', 'workload'] },
]

export interface EnergySubScore {
  key: EnergySubScoreKey
  emoji: string
  label: string
  /** 0–100 over the group's answered fields, or null when none were answered. */
  score: number | null
  /** How many of the group's fields were answered. */
  answered: number
  /** How many fields the group has. */
  total: number
  /** The group's fields, in order. */
  fields: readonly CheckinAnswerKey[]
}

/** Build the four display sub-scores from the answered fields only. */
export function displaySubScores(answers: CheckinAnswerValues): EnergySubScore[] {
  return ENERGY_SUB_SCORES.map((group) => {
    const present = group.fields.filter((key) => {
      const value = answers[key]
      return value !== null && value !== undefined
    })
    const score =
      present.length === 0
        ? null
        : goodnessToScore(
            present.reduce((sum, key) => sum + goodness(answers[key] as number), 0) / present.length,
          )
    return {
      key: group.key,
      emoji: group.emoji,
      label: group.label,
      score,
      answered: present.length,
      total: group.fields.length,
      fields: group.fields,
    }
  })
}

/** Decorative field emoji (for example ⚡ for energy). */
export function fieldEmoji(key: CheckinAnswerKey): string {
  return CHECKIN_QUESTIONS.find((question) => question.key === key)?.emoji ?? ''
}

/** The human label for a field, for example "Energy". */
export function fieldLabel(key: CheckinAnswerKey): string {
  return labelForKey(key)
}

/** The option text the person actually chose, or null when it was skipped. */
export function answerText(key: CheckinAnswerKey, value: number | null | undefined): string | null {
  if (value === null || value === undefined) return null
  const question = CHECKIN_QUESTIONS.find((item) => item.key === key)
  return question?.options[value - 1] ?? null
}

export type UsualComparison = 'above' | 'below' | 'about'

/** Below this many past answers, no "your usual" comparison is made. */
export const MIN_USUAL_SAMPLE = 5

export interface FieldUsual {
  /** Mean goodness (1–5, higher is better) over past answers. */
  goodness: number
  sample: number
}

/**
 * The person's own usual for one field, averaged over past check-ins only.
 * Returns null when there is not enough history, so nothing is invented.
 */
export function usualForField(
  rows: ReadonlyArray<{ answers: CheckinAnswerValues }>,
  key: CheckinAnswerKey,
): FieldUsual | null {
  let sum = 0
  let count = 0
  for (const row of rows) {
    const value = row.answers[key]
    if (value === null || value === undefined) continue
    sum += goodness(value)
    count += 1
  }
  if (count < MIN_USUAL_SAMPLE) return null
  return { goodness: sum / count, sample: count }
}

/** Where an answer sits next to the person's own usual, in neutral terms. */
export function compareToUsual(
  value: number | null | undefined,
  usual: FieldUsual | null,
): UsualComparison | null {
  if (value === null || value === undefined || usual === null) return null
  const diff = goodness(value) - usual.goodness
  if (diff >= 0.5) return 'above'
  if (diff <= -0.5) return 'below'
  return 'about'
}

/** Neutral phrasing for a usual comparison. Never good or bad, never a cause. */
export function usualPhrase(comparison: UsualComparison | null): string | null {
  if (comparison === 'above') return 'A little above your usual'
  if (comparison === 'below') return 'A little below your usual'
  if (comparison === 'about') return 'About your usual'
  return null
}

/** The CSS colour token for a sub-score number, from its value. */
export function subScoreTextClass(score: number | null): string {
  if (score === null) return 'text-slate-400'
  if (score <= 40) return 'text-amber-600'
  if (score <= 60) return 'text-sky-700'
  return 'text-emerald-600'
}

/** The bar fill class for a sub-score, from its value. */
export function subScoreBarClass(score: number | null): string {
  if (score === null) return 'bg-slate-300'
  if (score <= 40) return 'bg-amber-400'
  if (score <= 60) return 'bg-sky-500'
  return 'bg-emerald-500'
}

/** The ring stroke colour class for a band, dark enough to read on its background. */
export function bandRingClass(tone: EnergyTone): string {
  if (tone === 'peach') return 'text-[#c25e3a]'
  if (tone === 'butter') return 'text-[#a67c00]'
  if (tone === 'cyan') return 'text-energy-teal'
  if (tone === 'lime') return 'text-[#5b8c3e]'
  return 'text-slate-300'
}
