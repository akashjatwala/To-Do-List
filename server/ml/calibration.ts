import { type Labelled } from './metrics'

/**
 * Probability calibration.
 *
 * A model's raw score is only used as a probability once it has been shown to be
 * one. Calibration is applied **only when there is enough data to fit it
 * honestly**; below the threshold nothing is applied and the reason is recorded,
 * rather than fitting a curve to a handful of points and calling it calibrated.
 *
 * Two methods, in order of preference once there is enough data:
 * - **Isotonic** (pool-adjacent-violators): flexible, needs more data.
 * - **Platt** (a logistic rescale of the log-odds): safer on smaller samples.
 *
 * Neither method invents data: with too few rows the result is `kind: 'none'`.
 */

export const MIN_CALIBRATION_SAMPLES = 60
/** Isotonic is only trusted with this much data; below it Platt is used. */
export const MIN_ISOTONIC_SAMPLES = 200

export interface Calibrator {
  kind: 'none' | 'platt' | 'isotonic'
  /** Platt parameters: sigmoid(a * logit(p) + b). */
  a: number
  b: number
  /** Isotonic breakpoints (ascending x) and their calibrated values. */
  thresholds: number[]
  values: number[]
  samples: number
  reason: string
}

const NONE: Calibrator = { kind: 'none', a: 1, b: 0, thresholds: [], values: [], samples: 0, reason: '' }

function logit(p: number, epsilon = 1e-6): number {
  const clamped = Math.min(1 - epsilon, Math.max(epsilon, p))
  return Math.log(clamped / (1 - clamped))
}

function sigmoid(z: number): number {
  if (z >= 0) return 1 / (1 + Math.exp(-z))
  const e = Math.exp(z)
  return e / (1 + e)
}

/**
 * Fit a calibrator. Returns `kind: 'none'` with a reason when there is not enough
 * data — never a fitted curve that cannot be justified.
 */
export function fitCalibrator(rows: Labelled[], minSamples = MIN_CALIBRATION_SAMPLES): Calibrator {
  const usable = rows.filter((row) => Number.isFinite(row.p))
  const positives = usable.filter((row) => row.y === 1).length
  if (usable.length < minSamples) {
    return { ...NONE, samples: usable.length, reason: `Not enough data to calibrate (${usable.length} of ${minSamples}); the raw scores are left as they are.` }
  }
  if (positives === 0 || positives === usable.length) {
    return { ...NONE, samples: usable.length, reason: 'Calibration needs both outcomes to be present; only one class is in the data, so nothing is applied.' }
  }
  if (usable.length >= MIN_ISOTONIC_SAMPLES) return fitIsotonic(usable)
  return fitPlatt(usable)
}

/** Platt scaling: fit a, b by gradient descent on the log-odds. Deterministic. */
function fitPlatt(rows: Labelled[]): Calibrator {
  const xs = rows.map((row) => logit(row.p))
  const ys = rows.map((row) => row.y)
  let a = 1
  let b = 0
  const rate = 0.1
  const iterations = 500
  for (let step = 0; step < iterations; step += 1) {
    let gradA = 0
    let gradB = 0
    for (let i = 0; i < xs.length; i += 1) {
      const predicted = sigmoid(a * xs[i] + b)
      const error = predicted - ys[i]
      gradA += error * xs[i]
      gradB += error
    }
    a -= (rate * gradA) / xs.length
    b -= (rate * gradB) / xs.length
  }
  return { kind: 'platt', a, b, thresholds: [], values: [], samples: rows.length, reason: `Platt scaling fitted on ${rows.length} rows.` }
}

/** Isotonic regression via pool-adjacent-violators. */
function fitIsotonic(rows: Labelled[]): Calibrator {
  const sorted = [...rows].sort((x, y) => x.p - y.p)
  const blocks = sorted.map((row) => ({ sum: row.y, weight: 1, maxP: row.p }))
  let index = 0
  while (index < blocks.length - 1) {
    if (blocks[index].sum / blocks[index].weight > blocks[index + 1].sum / blocks[index + 1].weight) {
      blocks[index] = {
        sum: blocks[index].sum + blocks[index + 1].sum,
        weight: blocks[index].weight + blocks[index + 1].weight,
        maxP: blocks[index + 1].maxP,
      }
      blocks.splice(index + 1, 1)
      if (index > 0) index -= 1
    } else {
      index += 1
    }
  }
  const thresholds = blocks.map((block) => block.maxP)
  const values = blocks.map((block) => block.sum / block.weight)
  return { kind: 'isotonic', a: 1, b: 0, thresholds, values, samples: rows.length, reason: `Isotonic regression fitted on ${rows.length} rows (${blocks.length} steps).` }
}

/** Apply a fitted calibrator to a raw probability. */
export function applyCalibrator(calibrator: Calibrator, p: number): number {
  if (calibrator.kind === 'none') return p
  if (calibrator.kind === 'platt') return sigmoid(calibrator.a * logit(p) + calibrator.b)
  // Isotonic: the calibrated value of the largest breakpoint not above p.
  const { thresholds, values } = calibrator
  if (thresholds.length === 0) return p
  let chosen = values[0]
  for (let i = 0; i < thresholds.length; i += 1) {
    if (p >= thresholds[i]) chosen = values[i]
    else break
  }
  return chosen
}
