import type { DatabaseSync } from 'node:sqlite'
import {
  CHECKIN_ANSWER_KEYS,
  listCheckins,
  type CheckinAnswerKey,
  type CheckinRow,
} from '../checkins-store'
import { answeredValues } from './readiness'

/**
 * Estimates for fields the user did not answer.
 *
 * These are **display-only**. They are computed on demand, never written into a
 * check-in record, and never fed into the prediction stages as if the user had
 * reported them — a missing answer stays missing everywhere that matters.
 *
 * The starting method is deliberately simple and personal: a smoothed average
 * of the user's own history, blending the same weekday with the last few days,
 * shown with a range. Nothing is invented from population data, and an estimate
 * is only produced when there are enough past check-ins for that field. A
 * smarter version that also uses the other answered fields is a turn-on-when-
 * data-allows item and stays off until it beats these simple baselines on
 * chronological validation (see `evaluateEstimates`).
 */

/** A single past answer for one field. */
export interface PriorValue {
  date: string
  value: number
}

export interface FieldEstimate {
  key: CheckinAnswerKey
  /** Rounded estimate, 1–5, on the same scale as a real answer. */
  value: number
  /** The likely range [low, high], inclusive, clamped to 1–5. */
  range: [number, number]
  /** Plain-language basis, e.g. "typical for you on Mondays". */
  basis: string
  /** How many past answers the estimate is built from. */
  sample: number
}

export interface FieldEvaluation {
  key: CheckinAnswerKey
  /** Days where a real answer existed and a prior-only estimate could be made. */
  sample: number
  /** Mean absolute error of the smoothed estimate. */
  mae: number | null
  /** Share of estimates whose range covered the real answer. */
  coverage: number | null
  /** MAE of each simple baseline, for comparison. */
  baselines: { sameAsYesterday: number | null; personalAverage: number | null; sameWeekday: number | null }
  /** True when the estimate is at least as good as the best simple baseline. */
  beatsBaseline: boolean
}

export interface EstimatesResult {
  /** Whether any estimate could be computed at all (enough per-field history). */
  available: boolean
  /**
   * Whether the estimates may be shown. An estimate is only shown once the
   * chronological validation says it beats the best simple baseline; below that
   * it stays hidden and the note explains why. This is the rule "show estimate
   * only if it beats the best simple baseline; say so if the data is too small".
   */
  shown: boolean
  /** Why estimates are withheld, when they are. */
  reason: string | null
  estimates: FieldEstimate[]
  /** Chronological validation across the fields that could be checked. */
  evaluation: FieldEvaluation[]
  /** Whether the estimates beat the best simple baseline on past data. */
  beatsBaseline: boolean | null
  /** Plain-language summary of the validation, honest about small samples. */
  evaluationNote: string
}

/** Minimum past answers for a field before an estimate is offered. */
export const MIN_HISTORY_FOR_ESTIMATES = 7
/** Minimum days before the chronological validation can say anything. */
export const MIN_HISTORY_FOR_VALIDATION = 14

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

function weekdayOf(date: string): number {
  const [year, month, day] = date.split('-').map(Number)
  return new Date(year, month - 1, day).getDay()
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function stdDev(values: number[]): number {
  if (values.length < 2) return 0
  const m = mean(values)
  return Math.sqrt(mean(values.map((value) => (value - m) ** 2)))
}

function clampAnswer(value: number): number {
  return Math.min(5, Math.max(1, Math.round(value)))
}

/**
 * The smoothed personal estimate for one field: blend the same-weekday average
 * towards the recent average, weighting each by how many examples it has.
 */
export function estimateField(
  key: CheckinAnswerKey,
  targetDate: string,
  values: PriorValue[],
): FieldEstimate | null {
  if (values.length < MIN_HISTORY_FOR_ESTIMATES) return null
  const weekday = weekdayOf(targetDate)
  const sameWeekday = values.filter((item) => weekdayOf(item.date) === weekday).slice(-6)
  const recent = values.slice(-7)

  const recentMean = mean(recent.map((item) => item.value))
  let estimate: number
  let basis: string
  if (sameWeekday.length === 0) {
    estimate = recentMean
    basis = 'close to your recent average'
  } else {
    const wWeekday = Math.min(sameWeekday.length, 3)
    const wRecent = Math.min(recent.length, 4)
    const weekdayMean = mean(sameWeekday.map((item) => item.value))
    estimate = (weekdayMean * wWeekday + recentMean * wRecent) / (wWeekday + wRecent)
    basis = `typical for you on ${WEEKDAY_NAMES[weekday]}s`
  }

  const pool = [...sameWeekday, ...recent].map((item) => item.value)
  const spread = Math.max(0.75, stdDev(pool))
  const low = clampAnswer(estimate - spread)
  const high = clampAnswer(estimate + spread)
  const value = clampAnswer(estimate)
  return {
    key,
    value,
    range: [Math.min(low, value), Math.max(high, value)],
    basis,
    sample: values.length,
  }
}

/** Pull the prior answers for one field, strictly before `date`. */
function priorValues(history: CheckinRow[], key: CheckinAnswerKey, date: string): PriorValue[] {
  const out: PriorValue[] = []
  for (const row of history) {
    if (row.date >= date) continue
    const value = row[key]
    if (value === null) continue
    out.push({ date: row.date, value })
  }
  return out
}

function historyFor(db: DatabaseSync, userId: number, date: string): CheckinRow[] {
  return listCheckins(db, userId, 400)
    .filter((row) => row.date < date && row.skipped !== 1)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
}

/**
 * Validate the estimate against the answers the user later gave, walking time
 * forwards so every estimate only ever sees the past. Compares mean absolute
 * error and range coverage with three simple baselines.
 */
export function evaluateEstimates(
  db: DatabaseSync,
  userId: number,
  date: string,
): { evaluations: FieldEvaluation[]; beatsBaseline: boolean | null; note: string } {
  const history = historyFor(db, userId, date)
  const labelledDays = history.length
  if (labelledDays < MIN_HISTORY_FOR_VALIDATION) {
    return {
      evaluations: [],
      beatsBaseline: null,
      note: `Not enough history to check the estimates yet (${labelledDays} of ${MIN_HISTORY_FOR_VALIDATION} days).`,
    }
  }

  const evaluations: FieldEvaluation[] = []
  let methodError = 0
  let methodCovered = 0
  let methodCount = 0
  const baselineError = { sameAsYesterday: 0, personalAverage: 0, sameWeekday: 0 }
  const baselineCount = { sameAsYesterday: 0, personalAverage: 0, sameWeekday: 0 }

  for (const key of CHECKIN_ANSWER_KEYS) {
    let fieldError = 0
    let fieldCovered = 0
    let fieldCount = 0
    const bError = { sameAsYesterday: 0, personalAverage: 0, sameWeekday: 0 }
    const bCount = { sameAsYesterday: 0, personalAverage: 0, sameWeekday: 0 }

    for (let i = 0; i < history.length; i += 1) {
      const row = history[i]
      const actual = row[key]
      if (actual === null) continue
      const prior = history.slice(0, i)
      const values = priorValues(prior, key, row.date)
      if (values.length < MIN_HISTORY_FOR_ESTIMATES) continue

      const estimate = estimateField(key, row.date, values)
      if (!estimate) continue
      fieldError += Math.abs(estimate.value - actual)
      if (actual >= estimate.range[0] && actual <= estimate.range[1]) fieldCovered += 1
      fieldCount += 1

      // Baselines
      const lastValue = values[values.length - 1].value
      bError.sameAsYesterday += Math.abs(lastValue - actual)
      bCount.sameAsYesterday += 1

      const personal = mean(values.map((item) => item.value))
      bError.personalAverage += Math.abs(clampAnswer(personal) - actual)
      bCount.personalAverage += 1

      const weekday = weekdayOf(row.date)
      const sameWeekdayValues = values.filter((item) => weekdayOf(item.date) === weekday).map((item) => item.value)
      const weekdayMean = sameWeekdayValues.length ? mean(sameWeekdayValues) : personal
      bError.sameWeekday += Math.abs(clampAnswer(weekdayMean) - actual)
      bCount.sameWeekday += 1
    }

    if (fieldCount === 0) continue

    const mae = fieldError / fieldCount
    const baselines = {
      sameAsYesterday: bCount.sameAsYesterday ? bError.sameAsYesterday / bCount.sameAsYesterday : null,
      personalAverage: bCount.personalAverage ? bError.personalAverage / bCount.personalAverage : null,
      sameWeekday: bCount.sameWeekday ? bError.sameWeekday / bCount.sameWeekday : null,
    }
    const bestBaseline = Math.min(
      ...[baselines.sameAsYesterday, baselines.personalAverage, baselines.sameWeekday].filter(
        (value): value is number => value !== null,
      ),
    )
    evaluations.push({
      key,
      sample: fieldCount,
      mae,
      coverage: fieldCovered / fieldCount,
      baselines,
      beatsBaseline: mae <= bestBaseline + 1e-9,
    })

    methodError += fieldError
    methodCovered += fieldCovered
    methodCount += fieldCount
    baselineError.sameAsYesterday += bError.sameAsYesterday
    baselineError.personalAverage += bError.personalAverage
    baselineError.sameWeekday += bError.sameWeekday
    baselineCount.sameAsYesterday += bCount.sameAsYesterday
    baselineCount.personalAverage += bCount.personalAverage
    baselineCount.sameWeekday += bCount.sameWeekday
  }

  if (methodCount === 0) {
    return {
      evaluations,
      beatsBaseline: null,
      note: 'There are not yet enough repeated fields to check the estimates against your own answers.',
    }
  }

  const methodMae = methodError / methodCount
  const baselineMaes = [
    baselineCount.sameAsYesterday ? baselineError.sameAsYesterday / baselineCount.sameAsYesterday : null,
    baselineCount.personalAverage ? baselineError.personalAverage / baselineCount.personalAverage : null,
    baselineCount.sameWeekday ? baselineError.sameWeekday / baselineCount.sameWeekday : null,
  ].filter((value): value is number => value !== null)
  const bestBaseline = Math.min(...baselineMaes)
  const beats = methodMae <= bestBaseline + 1e-9
  const coverage = methodCovered / methodCount
  return {
    evaluations,
    beatsBaseline: beats,
    note: beats
      ? `The estimate has matched your own answers about as well as or better than a simple average so far (mean error ${methodMae.toFixed(2)} on the 1–5 scale; the range covered ${Math.round(coverage * 100)}% of answers).`
      : `So far a simple average matches your answers at least as well, so no estimate is shown (mean error ${methodMae.toFixed(2)}).`,
  }
}

/**
 * Build the display-only estimates for the fields missing from a check-in.
 * `evaluation` says whether they beat the simple baselines; when they do not,
 * the estimate is still labelled as a rough guide rather than withheld, so the
 * user is never shown a false precision claim.
 */
export function estimatesFor(
  db: DatabaseSync,
  userId: number,
  date: string,
  row: CheckinRow | null | undefined,
): EstimatesResult {
  const answered = answeredValues(row)
  const missing = CHECKIN_ANSWER_KEYS.filter((key) => answered[key] === undefined)
  if (missing.length === 0) {
    return {
      available: false,
      shown: false,
      reason: 'Every field was answered, so nothing needs estimating.',
      estimates: [],
      evaluation: [],
      beatsBaseline: null,
      evaluationNote: '',
    }
  }

  const history = historyFor(db, userId, date)
  const estimates: FieldEstimate[] = []
  for (const key of missing) {
    const values = priorValues(history, key, date)
    const estimate = estimateField(key, date, values)
    if (estimate) estimates.push(estimate)
  }

  const { evaluations, beatsBaseline, note } = evaluateEstimates(db, userId, date)
  // The estimate is only shown once the chronological validation says it beats
  // the best simple baseline. Below that the numbers stay hidden and the note
  // says why (too little history, or a simple average matches just as well).
  const shown = estimates.length > 0 && beatsBaseline === true

  if (estimates.length === 0) {
    return {
      available: false,
      shown: false,
      reason: `Estimates need about ${MIN_HISTORY_FOR_ESTIMATES} past check-ins for a field; there is not enough yet.`,
      estimates: [],
      evaluation: evaluations,
      beatsBaseline,
      evaluationNote: note,
    }
  }

  return {
    available: true,
    shown,
    reason: shown ? null : note,
    estimates,
    evaluation: evaluations,
    beatsBaseline,
    evaluationNote: note,
  }
}
