import { type Example, dot, fitStandardizer, sigmoid, standardize, type Standardizer } from './math'

/**
 * Regularised logistic regression.
 *
 * The first model that is allowed to be more than the smoothed baseline. It is
 * trained by weighted gradient descent with L2 regularisation, on standardised
 * features, with a fixed number of steps and no randomness — so training the same
 * data twice gives byte-identical parameters. Features are standardised using the
 * training set's own mean and standard deviation, and those are stored with the
 * model so serving uses exactly the same transform.
 *
 * Strong regularisation is the default: with personal data there are few rows, so
 * a heavily-penalised model that shrinks toward the baseline is the honest choice.
 */

export interface LogisticModel {
  kind: 'logistic'
  weights: number[]
  bias: number
  standardizer: Standardizer
  lambda: number
  iterations: number
  learningRate: number
}

export interface LogisticOptions {
  lambda?: number
  iterations?: number
  learningRate?: number
  /** Continue from an existing model (used by warm starts). */
  init?: { weights: number[]; bias: number }
}

export const DEFAULT_LAMBDA = 1
export const DEFAULT_ITERATIONS = 400
export const DEFAULT_LEARNING_RATE = 0.5

export function trainLogistic(rows: Example[], nFeatures: number, options: LogisticOptions = {}): LogisticModel {
  const lambda = options.lambda ?? DEFAULT_LAMBDA
  const iterations = options.iterations ?? DEFAULT_ITERATIONS
  const learningRate = options.learningRate ?? DEFAULT_LEARNING_RATE
  const standardizer = fitStandardizer(rows, nFeatures)
  const xs = rows.map((row) => standardize(row.x, standardizer))
  const weights = options.init?.weights.slice(0, nFeatures) ?? new Array<number>(nFeatures).fill(0)
  let bias = options.init?.bias ?? 0

  let weightSum = 0
  for (const row of rows) weightSum += row.w
  const scale = weightSum > 0 ? 1 / weightSum : 0

  for (let step = 0; step < iterations; step += 1) {
    const gradW = new Array<number>(nFeatures).fill(0)
    let gradB = 0
    for (let i = 0; i < xs.length; i += 1) {
      const predicted = sigmoid(dot(weights, xs[i]) + bias)
      const error = (predicted - rows[i].y) * rows[i].w
      for (let j = 0; j < nFeatures; j += 1) gradW[j] += error * xs[i][j]
      gradB += error
    }
    for (let j = 0; j < nFeatures; j += 1) {
      weights[j] -= learningRate * (gradW[j] * scale + lambda * weights[j] * scale)
    }
    bias -= learningRate * gradB * scale
  }

  return { kind: 'logistic', weights, bias, standardizer, lambda, iterations, learningRate }
}

export function predictLogistic(model: LogisticModel, x: number[]): number {
  return sigmoid(dot(model.weights, standardize(x, model.standardizer)) + model.bias)
}

