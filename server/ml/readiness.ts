import type { DatabaseSync } from 'node:sqlite'
import {
  CHECKIN_ANSWER_KEYS,
  listCheckins,
  type CheckinAnswerKey,
  type CheckinRow,
} from '../checkins-store'

/**
 * Readiness scoring.
 *
 * Every check-in answer is stored as an ordinal 1–5 where **1 is the best end**
 * and 5 the worst. Before anything is scored the value is flipped so that
 * higher is always better (`goodness`), which is what lets stress and workload
 * sit next to energy and sleep without special cases.
 *
 * The score is deliberately simple and explainable: equal weights over the
 * fields the user actually answered. Skipped fields are **left out entirely**,
 * never counted as a neutral 3. A score built from too few answers is marked
 * `partial` or withheld. Weights are only ever learned from real outcomes, and
 * only when there are enough labelled days to do so honestly (see
 * `learnedWeights`, which is off by default).
 *
 * None of this is a diagnosis or a measure of worth; it describes how the
 * answers compare with the user's own recent baseline.
 */

export const ANSWER_MIN = 1
export const ANSWER_MAX = 5

/** Flip a stored 1–5 answer so 5 is always the best. */
export function goodness(value: number): number {
  return ANSWER_MAX + ANSWER_MIN - value
}

/** Map a 1–5 goodness value onto a 0–100 scale. */
export function goodnessToScore(goodnessValue: number): number {
  const clamped = Math.min(ANSWER_MAX, Math.max(ANSWER_MIN, goodnessValue))
  return Math.round(((clamped - ANSWER_MIN) / (ANSWER_MAX - ANSWER_MIN)) * 100)
}

/** The three sub-scores, each from a fixed group of answered fields only. */
export const SUB_SCORE_GROUPS = {
  physical: ['energy', 'sleep', 'body'],
  mental: ['feeling', 'focus', 'motivation'],
  capacity: ['free_time', 'workload', 'stress'],
} as const satisfies Record<string, readonly CheckinAnswerKey[]>

export type SubScoreName = keyof typeof SUB_SCORE_GROUPS
export const SUB_SCORE_NAMES = Object.keys(SUB_SCORE_GROUPS) as SubScoreName[]

export interface SubScore {
  name: SubScoreName
  /** 0–100, or null when too few of its fields were answered. */
  score: number | null
  /** How many of the group's fields were answered. */
  answered: number
  /** How many fields the group has. */
  total: number
}

export interface ReadinessScore {
  /** 0–100 over the answered fields, or null when too few were answered. */
  score: number | null
  /** How many fields the score is built from. */
  answered: number
  /** How many fields the check-in has. */
  total: number
  /** 'ready' when the score is trustworthy, 'partial' when thin, 'none' when withheld. */
  state: 'ready' | 'partial' | 'none'
  /** Plain-language fragments for the answered fields, most notable first. */
  phrases: string[]
  /** One sentence describing today, from answered fields only. */
  line: string
  subScores: SubScore[]
}

/** Minimum answered fields before a score is shown at all. */
export const MIN_SCORE_FIELDS = 3
/** Below this many answered fields the score is shown but marked partial. */
export const PARTIAL_SCORE_FIELDS = 5
/** A sub-score needs at least this many of its three fields. */
export const MIN_SUB_SCORE_FIELDS = 2

/** The answers actually present in a check-in row, keyed by field. */
export function answeredValues(row: CheckinRow | null | undefined): Partial<Record<CheckinAnswerKey, number>> {
  const out: Partial<Record<CheckinAnswerKey, number>> = {}
  if (!row || row.skipped === 1) return out
  for (const key of CHECKIN_ANSWER_KEYS) {
    const value = row[key]
    if (value !== null) out[key] = value
  }
  return out
}

interface Phrase {
  low: string
  high: string
}

/**
 * A plain, non-judgemental phrase for each field at each end of the scale.
 * Only clear ends (goodness ≤ 2 or ≥ 4) produce a phrase; the middle is left
 * silent so the line does not pad itself out with noise.
 */
const FIELD_PHRASES: Record<CheckinAnswerKey, Phrase> = {
  feeling: { low: 'feeling low', high: 'in good spirits' },
  energy: { low: 'low energy', high: 'energised' },
  motivation: { low: 'low motivation', high: 'motivated' },
  sleep: { low: 'slept poorly', high: 'slept well' },
  stress: { low: 'stressed', high: 'relaxed' },
  free_time: { low: 'limited free time', high: 'plenty of free time' },
  focus: { low: 'scattered', high: 'sharp focus' },
  body: { low: 'body not feeling great', high: 'body feels good' },
  workload: { low: 'heavy workload', high: 'light workload' },
}

/** Plain-language fragments for the answered fields, notable ones first. */
export function statePhrases(answers: Partial<Record<CheckinAnswerKey, number>>): string[] {
  const scored: Array<{ key: CheckinAnswerKey; distance: number; phrase: string }> = []
  for (const key of CHECKIN_ANSWER_KEYS) {
    const value = answers[key]
    if (value === undefined) continue
    const g = goodness(value)
    if (g >= 3 && g <= 3) continue
    const phrase = g < 3 ? FIELD_PHRASES[key].low : FIELD_PHRASES[key].high
    scored.push({ key, distance: Math.abs(g - 3), phrase })
  }
  scored.sort((a, b) => b.distance - a.distance || a.key.localeCompare(b.key))
  return scored.map((item) => item.phrase)
}

/** The simple average goodness over the answered fields, or null. */
export function averageGoodness(answers: Partial<Record<CheckinAnswerKey, number>>): number | null {
  let sum = 0
  let count = 0
  for (const key of CHECKIN_ANSWER_KEYS) {
    const value = answers[key]
    if (value === undefined) continue
    sum += goodness(value)
    count += 1
  }
  if (count === 0) return null
  return sum / count
}

function subScoresFor(answers: Partial<Record<CheckinAnswerKey, number>>): SubScore[] {
  return SUB_SCORE_NAMES.map((name) => {
    const fields = SUB_SCORE_GROUPS[name]
    const present = fields.filter((key) => answers[key] !== undefined)
    const score =
      present.length >= MIN_SUB_SCORE_FIELDS
        ? goodnessToScore(
            present.reduce((sum, key) => sum + goodness(answers[key]!), 0) / present.length,
          )
        : null
    return { name, score, answered: present.length, total: fields.length }
  })
}

function sentenceFromPhrases(phrases: string[], answered: number): string {
  if (answered === 0) return 'Nothing was shared for today, so there is nothing to describe.'
  if (phrases.length === 0) return 'Today looks close to your usual.'
  if (phrases.length === 1) return capitalize(phrases[0]) + '.'
  const head = phrases.slice(0, -1).join(', ')
  return `${capitalize(head)} and ${phrases[phrases.length - 1]}.`
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1)
}

/**
 * Build the readiness score, sub-scores and plain-language line from a check-in
 * row. Only answered fields are used; a skipped check-in yields `state: 'none'`.
 */
export function readinessFromCheckin(row: CheckinRow | null | undefined): ReadinessScore {
  const answers = answeredValues(row)
  const answered = Object.keys(answers).length
  const total = CHECKIN_ANSWER_KEYS.length
  const phrases = statePhrases(answers)
  const line = sentenceFromPhrases(phrases, answered)

  const avg = averageGoodness(answers)
  let score: number | null = null
  let state: ReadinessScore['state'] = 'none'
  if (avg !== null && answered >= MIN_SCORE_FIELDS) {
    score = goodnessToScore(avg)
    state = answered >= PARTIAL_SCORE_FIELDS ? 'ready' : 'partial'
  }

  return { score, answered, total, state, phrases, line, subScores: subScoresFor(answers) }
}

// ---------------------------------------------------------------------------
// Baseline comparison (against the user's own recent history, never a standard)
// ---------------------------------------------------------------------------

/** A same-weekday baseline for the given date, from the user's own check-ins. */
export interface BaselineComparison {
  /** The user's average score on this weekday, or null when there is no history. */
  weekdayAverage: number | null
  /** How many past same-weekday days it is based on. */
  weekdaySample: number
  /** Difference (today − baseline) in score points; positive means higher today. */
  delta: number | null
  /** Plain-language comparison, or null when there is not enough history. */
  line: string | null
}

/** Minimum past same-weekday days before a comparison is offered. */
export const MIN_BASELINE_DAYS = 3

function dayOfWeek(date: string): number {
  const [year, month, day] = date.split('-').map(Number)
  return new Date(year, month - 1, day).getDay()
}

/** Average readiness score over every fully-answered day before `date`. */
function scoreForRow(row: CheckinRow): number | null {
  const readiness = readinessFromCheckin(row)
  return readiness.score
}

export function baselineComparison(
  db: DatabaseSync,
  userId: number,
  date: string,
  todayScore: number | null,
): BaselineComparison {
  if (todayScore === null) {
    return { weekdayAverage: null, weekdaySample: 0, delta: null, line: null }
  }
  const weekday = dayOfWeek(date)
  const history = listCheckins(db, userId, 400).filter((row) => row.date < date)
  const sameWeekday: number[] = []
  for (const row of history) {
    if (dayOfWeek(row.date) !== weekday) continue
    const score = scoreForRow(row)
    if (score !== null) sameWeekday.push(score)
  }
  if (sameWeekday.length < MIN_BASELINE_DAYS) {
    return { weekdayAverage: null, weekdaySample: sameWeekday.length, delta: null, line: null }
  }
  const weekdayAverage = Math.round(sameWeekday.reduce((a, b) => a + b, 0) / sameWeekday.length)
  const delta = todayScore - weekdayAverage
  return {
    weekdayAverage,
    weekdaySample: sameWeekday.length,
    delta,
    line: describeDelta(delta, weekday),
  }
}

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

function describeDelta(delta: number, weekday: number): string {
  const name = WEEKDAY_NAMES[weekday]
  if (Math.abs(delta) <= 5) return `About your usual ${name}.`
  if (Math.abs(delta) <= 15) {
    return delta > 0 ? `A bit higher than your usual ${name}.` : `A bit lower than your usual ${name}.`
  }
  return delta > 0 ? `Higher than your usual ${name}.` : `Lower than your usual ${name}.`
}

// ---------------------------------------------------------------------------
// Association check: is the score actually related to outcomes?
// ---------------------------------------------------------------------------

export interface AssociationResult {
  /** Pearson correlation between readiness and the day's completion rate. */
  correlation: number | null
  /** How many labelled days the correlation uses. */
  sample: number
  /** Whether the association is worth presenting as useful. */
  useful: boolean
  /** Plain-language description, honest about small samples. */
  note: string
}

/** Below this many labelled days no association claim is made at all. */
export const MIN_ASSOCIATION_DAYS = 10
/** |r| below this is treated as "no clear association". */
export const ASSOCIATION_THRESHOLD = 0.3

function pearson(pairs: Array<[number, number]>): number | null {
  const n = pairs.length
  if (n < 2) return null
  const meanX = pairs.reduce((s, [x]) => s + x, 0) / n
  const meanY = pairs.reduce((s, [, y]) => s + y, 0) / n
  let num = 0
  let denX = 0
  let denY = 0
  for (const [x, y] of pairs) {
    const dx = x - meanX
    const dy = y - meanY
    num += dx * dy
    denX += dx * dx
    denY += dy * dy
  }
  if (denX === 0 || denY === 0) return null
  return num / Math.sqrt(denX * denY)
}

/**
 * Check whether the readiness score is related to what the user actually got
 * done. `outcomeForDate` returns a 0–1 completion rate, or null when the day has
 * no labelled outcome. The caller supplies it so this module stays free of the
 * activity tables. If there is no clear association, say so rather than imply
 * one.
 */
export function readinessAssociation(
  db: DatabaseSync,
  userId: number,
  date: string,
  outcomeForDate: (date: string) => number | null,
): AssociationResult {
  const history = listCheckins(db, userId, 400).filter((row) => row.date < date)
  const pairs: Array<[number, number]> = []
  for (const row of history) {
    const score = scoreForRow(row)
    if (score === null) continue
    const outcome = outcomeForDate(row.date)
    if (outcome === null) continue
    pairs.push([score, outcome])
  }
  if (pairs.length < MIN_ASSOCIATION_DAYS) {
    return {
      correlation: null,
      sample: pairs.length,
      useful: false,
      note: `Not enough days yet to check whether the score relates to what you get done (${pairs.length} of ${MIN_ASSOCIATION_DAYS}).`,
    }
  }
  const correlation = pearson(pairs)
  if (correlation === null || Math.abs(correlation) < ASSOCIATION_THRESHOLD) {
    return {
      correlation,
      sample: pairs.length,
      useful: false,
      note: 'So far the score has not clearly lined up with what you got done, so it is shown as a description only.',
    }
  }
  const direction = correlation > 0 ? 'higher' : 'lower'
  return {
    correlation,
    sample: pairs.length,
    useful: true,
    note: `On days with a ${direction} score you have tended to get more done (based on ${pairs.length} days). This is an association, not a cause.`,
  }
}

// ---------------------------------------------------------------------------
// Learned per-field weights (turn-on-when-data-allows; off by default)
// ---------------------------------------------------------------------------

export interface LearnedWeights {
  /** Whether learned weights are used at all. */
  enabled: boolean
  /** Per-field weight, or null when the field is not modelled. */
  weights: Partial<Record<CheckinAnswerKey, number>>
  /** Why they are off, when they are off. */
  reason: string
}

/**
 * Per-field weights learned from outcomes. Off until there are enough labelled
 * days; until then the equal-weight score continues to be used. This function
 * only *reports* whether weights could be learned — it does not change the
 * simple score, so the two never disagree silently.
 */
export function learnedWeights(
  db: DatabaseSync,
  userId: number,
  date: string,
  outcomeForDate: (date: string) => number | null,
  minDays = 30,
): LearnedWeights {
  const history = listCheckins(db, userId, 400).filter((row) => row.date < date)
  const usable = history.filter((row) => outcomeForDate(row.date) !== null && readinessFromCheckin(row).score !== null)
  if (usable.length < minDays) {
    return {
      enabled: false,
      weights: {},
      reason: `Learned weights stay off until there are ${minDays} labelled days (there are ${usable.length}). The equal-weight score is used for now.`,
    }
  }
  return {
    enabled: false,
    weights: {},
    reason: 'Learned weights are not enabled in this build; the equal-weight score continues.',
  }
}
