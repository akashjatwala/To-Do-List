import { type Example, dot, fitStandardizer, standardize, type Standardizer } from './math'

/**
 * Linear quantile regression.
 *
 * The duration candidate after the median baseline. A quantile regression is
 * trained by minimising the pinball (quantile) loss with fixed, deterministic
 * gradient descent on standardised features. Three fits give an honest interval:
 * the 10th, 50th and 90th percentile of the expected duration. Gradient-boosted
 * quantiles are deliberately **not** implemented — the brief says they are used
 * only if the data justifies them, and with personal data it does not, so the
 * linear fit is the ceiling here.
 */

export interface LinearQuantileModel {
  kind: 'linear-quantile'
  quantile: number
  weights: number[]
  bias: number
  standardizer: Standardizer
  lambda: number
  iterations: number
  learningRate: number
}

export interface QuantileOptions {
  lambda?: number
  iterations?: number
  learningRate?: number
}

export const DEFAULT_QUANTILE_LAMBDA = 1
export const DEFAULT_QUANTILE_ITERATIONS = 500
export const DEFAULT_QUANTILE_LEARNING_RATE = 0.2

function weightedMedian(rows: Example[]): number {
  const sorted = [...rows].sort((a, b) => a.y - b.y)
  let total = 0
  for (const row of sorted) total += row.w
  let running = 0
  for (const row of sorted) {
    running += row.w
    if (running >= total / 2) return row.y
  }
  return sorted.length > 0 ? sorted[sorted.length - 1].y : 0
}

export function trainLinearQuantile(
  rows: Example[],
  nFeatures: number,
  quantile: number,
  options: QuantileOptions = {},
): LinearQuantileModel {
  const lambda = options.lambda ?? DEFAULT_QUANTILE_LAMBDA
  const iterations = options.iterations ?? DEFAULT_QUANTILE_ITERATIONS
  const learningRate = options.learningRate ?? DEFAULT_QUANTILE_LEARNING_RATE
  const standardizer = fitStandardizer(rows, nFeatures)
  const xs = rows.map((row) => standardize(row.x, standardizer))
  const weights = new Array<number>(nFeatures).fill(0)
  let bias = weightedMedian(rows)

  let weightSum = 0
  for (const row of rows) weightSum += row.w
  const scale = weightSum > 0 ? 1 / weightSum : 0

  for (let step = 0; step < iterations; step += 1) {
    const gradW = new Array<number>(nFeatures).fill(0)
    let gradB = 0
    for (let i = 0; i < xs.length; i += 1) {
      const residual = dot(weights, xs[i]) + bias - rows[i].y
      // Subgradient of the pinball loss: d/dpred = (1 - tau) when the
      // prediction is above the target, -tau when it is below.
      const g = (residual > 0 ? 1 - quantile : -quantile) * rows[i].w
      for (let j = 0; j < nFeatures; j += 1) gradW[j] += g * xs[i][j]
      gradB += g
    }
    for (let j = 0; j < nFeatures; j += 1) {
      weights[j] -= learningRate * (gradW[j] * scale + lambda * weights[j] * scale)
    }
    bias -= learningRate * gradB * scale
  }

  return { kind: 'linear-quantile', quantile, weights, bias, standardizer, lambda, iterations, learningRate }
}

export function predictQuantile(model: LinearQuantileModel, x: number[]): number {
  return dot(model.weights, standardize(x, model.standardizer)) + model.bias
}
