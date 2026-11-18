import { type Example, sigmoid } from './math'

/**
 * A small gradient-boosted tree ensemble for binary classification (Phase 5, §2).
 *
 * This exists to be the *second* candidate for completion and target
 * achievement: the brief says gradient boosting is only used if it beats logistic
 * regression on chronological validation, so the training pipeline trains both
 * and keeps whichever wins. It is deliberately small (shallow trees, no feature
 * subsampling, no randomness) so it stays reproducible and honest on personal
 * data volumes — XGBoost/CatBoost are skipped because the data does not justify
 * them.
 *
 * Boosting uses the logistic loss with a Newton step (fit trees to −g/h with
 * weights h), which is the standard second-order recipe.
 */

export interface TreeNode {
  /** Internal node: split feature index. Undefined for a leaf. */
  feature?: number
  threshold?: number
  left?: TreeNode
  right?: TreeNode
  /** Leaf value. */
  value: number
}

export interface GbmModel {
  kind: 'gbm'
  trees: TreeNode[]
  baseScore: number
  learningRate: number
  maxDepth: number
  minSamplesLeaf: number
  nTrees: number
  l2: number
}

export interface GbmOptions {
  nTrees?: number
  learningRate?: number
  maxDepth?: number
  minSamplesLeaf?: number
  l2?: number
}

export const DEFAULT_GBM: Required<GbmOptions> = {
  nTrees: 60,
  learningRate: 0.1,
  maxDepth: 3,
  minSamplesLeaf: 12,
  l2: 1,
}

interface TreeInput {
  xs: number[][]
  targets: number[]
  weights: number[]
  indices: number[]
}

function weightedMean(input: TreeInput, indices: number[]): number {
  let sum = 0
  let weight = 0
  for (const index of indices) {
    sum += input.weights[index] * input.targets[index]
    weight += input.weights[index]
  }
  return weight > 0 ? sum / weight : 0
}

/** Weighted sum of squared errors for a set of rows. */
function weightedSse(input: TreeInput, indices: number[]): number {
  let sumW = 0
  let sumWT = 0
  let sumWT2 = 0
  for (const index of indices) {
    const w = input.weights[index]
    const t = input.targets[index]
    sumW += w
    sumWT += w * t
    sumWT2 += w * t * t
  }
  if (sumW <= 0) return 0
  return sumWT2 - (sumWT * sumWT) / sumW
}

function buildTree(input: TreeInput, indices: number[], depth: number, options: Required<GbmOptions>): TreeNode {
  if (depth >= options.maxDepth || indices.length < 2 * options.minSamplesLeaf) {
    return { value: weightedMean(input, indices) }
  }
  const nFeatures = input.xs[0]?.length ?? 0
  let bestFeature = -1
  let bestThreshold = 0
  let bestReduction = 0
  let bestLeft: number[] = []
  let bestRight: number[] = []

  for (let feature = 0; feature < nFeatures; feature += 1) {
    const order = [...indices].sort((a, b) => input.xs[a][feature] - input.xs[b][feature])
    const totalSse = weightedSse(input, indices)
    let leftW = 0
    let leftWT = 0
    let leftWT2 = 0
    let totalW = 0
    let totalWT = 0
    let totalWT2 = 0
    for (const index of order) {
      const w = input.weights[index]
      const t = input.targets[index]
      totalW += w
      totalWT += w * t
      totalWT2 += w * t * t
    }
    for (let i = 0; i < order.length - 1; i += 1) {
      const index = order[i]
      const w = input.weights[index]
      const t = input.targets[index]
      leftW += w
      leftWT += w * t
      leftWT2 += w * t * t
      const rightW = totalW - leftW
      const rightWT = totalWT - leftWT
      const rightWT2 = totalWT2 - leftWT2
      if (leftW < options.minSamplesLeaf || rightW < options.minSamplesLeaf) continue
      const x1 = input.xs[order[i]][feature]
      const x2 = input.xs[order[i + 1]][feature]
      if (x1 === x2) continue
      const leftSse = leftWT2 - (leftWT * leftWT) / leftW
      const rightSse = rightWT2 - (rightWT * rightWT) / rightW
      const reduction = totalSse - leftSse - rightSse
      if (reduction > bestReduction + 1e-12) {
        bestReduction = reduction
        bestFeature = feature
        bestThreshold = (x1 + x2) / 2
        bestLeft = []
        bestRight = []
        for (const candidate of order) {
          if (input.xs[candidate][feature] <= bestThreshold) bestLeft.push(candidate)
          else bestRight.push(candidate)
        }
      }
    }
  }

  if (bestFeature < 0 || bestLeft.length === 0 || bestRight.length === 0) {
    return { value: weightedMean(input, indices) }
  }
  return {
    feature: bestFeature,
    threshold: bestThreshold,
    left: buildTree(input, bestLeft, depth + 1, options),
    right: buildTree(input, bestRight, depth + 1, options),
    value: weightedMean(input, indices),
  }
}

function treeValue(node: TreeNode, x: number[]): number {
  let current = node
  while (current.feature !== undefined && current.threshold !== undefined) {
    current = (x[current.feature] ?? 0) <= current.threshold ? current.left! : current.right!
  }
  return current.value
}

export function trainGbm(rows: Example[], _nFeatures: number, options: GbmOptions = {}): GbmModel {
  const opts = { ...DEFAULT_GBM, ...options }
  let weightSum = 0
  let positive = 0
  for (const row of rows) {
    weightSum += row.w
    positive += row.w * row.y
  }
  const baseRate = weightSum > 0 ? Math.min(1 - 1e-6, Math.max(1e-6, positive / weightSum)) : 0.5
  const baseScore = Math.log(baseRate / (1 - baseRate))

  const xs = rows.map((row) => row.x)
  const scores = new Array<number>(rows.length).fill(baseScore)
  const trees: TreeNode[] = []

  for (let t = 0; t < opts.nTrees; t += 1) {
    const targets = new Array<number>(rows.length).fill(0)
    const weights = new Array<number>(rows.length).fill(0)
    for (let i = 0; i < rows.length; i += 1) {
      const p = sigmoid(scores[i])
      const gradient = p - rows[i].y
      const hessian = Math.max(1e-6, p * (1 - p))
      targets[i] = -gradient / hessian
      weights[i] = hessian
    }
    const indices = rows.map((_, index) => index)
    const tree = buildTree({ xs, targets, weights, indices }, indices, 0, opts)
    trees.push(tree)
    for (let i = 0; i < rows.length; i += 1) {
      scores[i] += opts.learningRate * treeValue(tree, xs[i])
    }
  }

  return {
    kind: 'gbm',
    trees,
    baseScore,
    learningRate: opts.learningRate,
    maxDepth: opts.maxDepth,
    minSamplesLeaf: opts.minSamplesLeaf,
    nTrees: opts.nTrees,
    l2: opts.l2,
  }
}

export function predictGbm(model: GbmModel, x: number[]): number {
  let score = model.baseScore
  for (const tree of model.trees) score += model.learningRate * treeValue(tree, x)
  return sigmoid(score)
}
