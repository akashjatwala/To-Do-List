/**
 * Evaluation metrics (Phase 5, §3).
 *
 * These are plain, well-defined numbers with no interpretation attached. Every
 * metric returns `null` when it cannot be computed honestly — for example ROC-AUC
 * needs both classes to be present, and an interval coverage needs at least one
 * scored point. Nothing here fabricates a value to fill a gap.
 *
 * A metric is only ever reported next to the baseline it is compared against and
 * labelled with where its data came from (real or synthetic). The metric itself
 * makes no accuracy claim.
 */

export interface Labelled {
  /** Predicted probability in [0, 1]. */
  p: number
  /** Observed outcome: 0 or 1. */
  y: number
  /** Optional sample weight. */
  w?: number
}

export interface RegressionPoint {
  predicted: number
  actual: number
  low?: number | null
  high?: number | null
  w?: number
}

export function mean(values: number[]): number | null {
  if (values.length === 0) return null
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

/** Brier score: mean squared error of the probabilities. Lower is better. */
export function brier(rows: Labelled[]): number | null {
  if (rows.length === 0) return null
  let weightSum = 0
  let sum = 0
  for (const row of rows) {
    const w = row.w ?? 1
    sum += w * (row.p - row.y) ** 2
    weightSum += w
  }
  return weightSum > 0 ? sum / weightSum : null
}

/** Log loss, clipped so a confident wrong answer cannot be infinite. */
export function logLoss(rows: Labelled[], epsilon = 1e-9): number | null {
  if (rows.length === 0) return null
  let weightSum = 0
  let sum = 0
  for (const row of rows) {
    const w = row.w ?? 1
    const p = Math.min(1 - epsilon, Math.max(epsilon, row.p))
    sum += w * -(row.y * Math.log(p) + (1 - row.y) * Math.log(1 - p))
    weightSum += w
  }
  return weightSum > 0 ? sum / weightSum : null
}

/**
 * ROC-AUC via the rank (Mann–Whitney U) method, with ties averaged. Needs at
 * least one positive and one negative; otherwise returns null.
 */
export function rocAuc(rows: Labelled[]): number | null {
  const positives = rows.filter((row) => row.y === 1)
  const negatives = rows.filter((row) => row.y === 0)
  if (positives.length === 0 || negatives.length === 0) return null
  const sorted = [...rows].map((row, index) => ({ row, index })).sort((a, b) => a.row.p - b.row.p)
  const ranks = new Array<number>(sorted.length).fill(0)
  let i = 0
  while (i < sorted.length) {
    let j = i
    while (j + 1 < sorted.length && sorted[j + 1].row.p === sorted[i].row.p) j += 1
    const averageRank = (i + j) / 2 + 1
    for (let k = i; k <= j; k += 1) ranks[k] = averageRank
    i = j + 1
  }
  let positiveRankSum = 0
  for (let k = 0; k < sorted.length; k += 1) {
    if (sorted[k].row.y === 1) positiveRankSum += ranks[k]
  }
  const nP = positives.length
  const nN = negatives.length
  return (positiveRankSum - (nP * (nP + 1)) / 2) / (nP * nN)
}

export interface Confusion {
  tp: number
  fp: number
  tn: number
  fn: number
  precision: number | null
  recall: number | null
  f1: number | null
  accuracy: number | null
  threshold: number
}

/** Confusion matrix and precision/recall/F1 at a fixed decision threshold. */
export function confusion(rows: Labelled[], threshold = 0.5): Confusion {
  let tp = 0
  let fp = 0
  let tn = 0
  let fn = 0
  for (const row of rows) {
    const predicted = row.p >= threshold ? 1 : 0
    if (predicted === 1 && row.y === 1) tp += 1
    else if (predicted === 1 && row.y === 0) fp += 1
    else if (predicted === 0 && row.y === 0) tn += 1
    else fn += 1
  }
  const precision = tp + fp > 0 ? tp / (tp + fp) : null
  const recall = tp + fn > 0 ? tp / (tp + fn) : null
  const f1 = precision !== null && recall !== null && precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : null
  const accuracy = rows.length > 0 ? (tp + tn) / rows.length : null
  return { tp, fp, tn, fn, precision, recall, f1, accuracy, threshold }
}

export interface ReliabilityBin {
  low: number
  high: number
  n: number
  meanPredicted: number
  observed: number
}

/** Reliability curve: predicted vs observed in equal-width bins. */
export function reliability(rows: Labelled[], bins = 5): ReliabilityBin[] {
  const out: ReliabilityBin[] = []
  for (let bin = 0; bin < bins; bin += 1) {
    const low = bin / bins
    const high = (bin + 1) / bins
    const inBin = rows.filter((row) => (bin === bins - 1 ? row.p >= low && row.p <= high : row.p >= low && row.p < high))
    if (inBin.length === 0) continue
    out.push({
      low,
      high,
      n: inBin.length,
      meanPredicted: inBin.reduce((sum, row) => sum + row.p, 0) / inBin.length,
      observed: inBin.reduce((sum, row) => sum + row.y, 0) / inBin.length,
    })
  }
  return out
}

/** Expected calibration error over the reliability bins (weighted by bin size). */
export function calibrationError(rows: Labelled[], bins = 5): number | null {
  if (rows.length === 0) return null
  const curve = reliability(rows, bins)
  if (curve.length === 0) return null
  return curve.reduce((sum, bin) => sum + (bin.n / rows.length) * Math.abs(bin.meanPredicted - bin.observed), 0)
}

/** Mean absolute error. */
export function mae(points: RegressionPoint[]): number | null {
  if (points.length === 0) return null
  let weightSum = 0
  let sum = 0
  for (const point of points) {
    const w = point.w ?? 1
    sum += w * Math.abs(point.predicted - point.actual)
    weightSum += w
  }
  return weightSum > 0 ? sum / weightSum : null
}

/** Root mean squared error. */
export function rmse(points: RegressionPoint[]): number | null {
  if (points.length === 0) return null
  let weightSum = 0
  let sum = 0
  for (const point of points) {
    const w = point.w ?? 1
    sum += w * (point.predicted - point.actual) ** 2
    weightSum += w
  }
  return weightSum > 0 ? Math.sqrt(sum / weightSum) : null
}

/** Share of points whose actual value fell inside the predicted interval. */
export function intervalCoverage(points: RegressionPoint[]): number | null {
  const usable = points.filter((point) => point.low !== null && point.low !== undefined && point.high !== null && point.high !== undefined)
  if (usable.length === 0) return null
  const covered = usable.filter((point) => point.actual >= point.low! && point.actual <= point.high!).length
  return covered / usable.length
}

/** Mean interval width — narrow intervals that still cover are the goal. */
export function intervalWidth(points: RegressionPoint[]): number | null {
  const usable = points.filter((point) => point.low !== null && point.low !== undefined && point.high !== null && point.high !== undefined)
  if (usable.length === 0) return null
  return usable.reduce((sum, point) => sum + (point.high! - point.low!), 0) / usable.length
}

/** Pearson correlation between two equal-length series, or null. */
export function pearson(xs: number[], ys: number[]): number | null {
  const n = Math.min(xs.length, ys.length)
  if (n < 2) return null
  const mx = xs.slice(0, n).reduce((a, b) => a + b, 0) / n
  const my = ys.slice(0, n).reduce((a, b) => a + b, 0) / n
  let num = 0
  let dx = 0
  let dy = 0
  for (let i = 0; i < n; i += 1) {
    const a = xs[i] - mx
    const b = ys[i] - my
    num += a * b
    dx += a * a
    dy += b * b
  }
  if (dx === 0 || dy === 0) return null
  return num / Math.sqrt(dx * dy)
}
