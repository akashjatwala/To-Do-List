import { type Example, sigmoid } from './math'

/**
 * A compact, deterministic gradient-boosted tree ensemble for binary
 * classification.
 *
 * This is the advanced challenger to logistic regression. It stays local and
 * reproducible: histogram-based split finding, deterministic feature
 * subsampling, L2-shrunk leaves and a small hyperparameter search in
 * `training.ts`. XGBoost/CatBoost are still skipped because personal data does
 * not justify a heavier toolchain, but this is a real boosted-tree model rather
 * than a toy stump.
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
  maxBins: number
  featureRatio: number
  seed: number
}

export interface GbmOptions {
  nTrees?: number
  learningRate?: number
  maxDepth?: number
  minSamplesLeaf?: number
  l2?: number
  maxBins?: number
  featureRatio?: number
  seed?: number
}

export const DEFAULT_GBM: Required<GbmOptions> = {
  nTrees: 80,
  learningRate: 0.08,
  maxDepth: 3,
  minSamplesLeaf: 12,
  l2: 2,
  maxBins: 48,
  featureRatio: 0.85,
  seed: 20261126,
}

interface Sums {
  weight: number
  weightedTarget: number
  weightedTarget2: number
  count: number
}

interface FeatureBins {
  min: number
  width: number
  count: number
}

interface TreeInput {
  xs: number[][]
  targets: number[]
  weights: number[]
  /** One bin index per row, per feature. */
  binIndices: number[][]
  binDetails: FeatureBins[]
  /** Features considered by this tree, after deterministic subsampling. */
  features: number[]
}

function emptySums(): Sums {
  return { weight: 0, weightedTarget: 0, weightedTarget2: 0, count: 0 }
}

function addRow(sums: Sums, index: number, input: TreeInput): void {
  const w = input.weights[index]
  const t = input.targets[index]
  sums.weight += w
  sums.weightedTarget += w * t
  sums.weightedTarget2 += w * t * t
  sums.count += 1
}

function addSums(target: Sums, source: Sums): void {
  target.weight += source.weight
  target.weightedTarget += source.weightedTarget
  target.weightedTarget2 += source.weightedTarget2
  target.count += source.count
}

function subtractSums(total: Sums, part: Sums): Sums {
  return {
    weight: total.weight - part.weight,
    weightedTarget: total.weightedTarget - part.weightedTarget,
    weightedTarget2: total.weightedTarget2 - part.weightedTarget2,
    count: total.count - part.count,
  }
}

/** Weighted variance numerator; lower means a purer node. */
function sse(sums: Sums): number {
  if (sums.weight <= 0) return 0
  return sums.weightedTarget2 - (sums.weightedTarget * sums.weightedTarget) / sums.weight
}

/** L2-shrunk weighted leaf value. */
function leafValue(input: TreeInput, indices: number[], l2: number): number {
  let weight = 0
  let weightedTarget = 0
  for (const index of indices) {
    weight += input.weights[index]
    weightedTarget += input.weights[index] * input.targets[index]
  }
  return weight > 0 ? weightedTarget / (weight + l2) : 0
}

function buildFeatureBins(xs: number[][], feature: number, maxBins: number): { detail: FeatureBins; indices: number[] } {
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  for (const row of xs) {
    const value = row[feature]
    if (!Number.isFinite(value)) continue
    if (value < min) min = value
    if (value > max) max = value
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    min = 0
    max = 0
  }
  const span = max - min
  const count = span > 0 ? Math.max(2, Math.min(maxBins, 48)) : 1
  const width = count > 1 ? span / count : 1
  const indices = xs.map((row) => {
    const value = Number.isFinite(row[feature]) ? row[feature] : min
    const bin = count > 1 ? Math.floor((value - min) / width) : 0
    return Math.min(count - 1, Math.max(0, bin))
  })
  return { detail: { min, width, count }, indices }
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function selectFeatures(nFeatures: number, options: Required<GbmOptions>, treeIndex: number): number[] {
  const all = Array.from({ length: nFeatures }, (_, index) => index)
  if (options.featureRatio >= 1) return all
  const wanted = Math.max(1, Math.min(nFeatures, Math.floor(nFeatures * options.featureRatio)))
  const pool = [...all]
  const random = mulberry32(options.seed + treeIndex * 7919)
  for (let i = pool.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1))
    const held = pool[i]
    pool[i] = pool[j]
    pool[j] = held
  }
  return pool.slice(0, wanted)
}

function buildTree(input: TreeInput, indices: number[], depth: number, options: Required<GbmOptions>): TreeNode {
  if (depth >= options.maxDepth || indices.length < 2 * options.minSamplesLeaf) {
    return { value: leafValue(input, indices, options.l2) }
  }

  const total = emptySums()
  for (const index of indices) addRow(total, index, input)
  const totalSse = sse(total)

  let bestFeature = -1
  let bestBin = -1
  let bestThreshold = 0
  let bestReduction = 0

  for (const feature of input.features) {
    const detail = input.binDetails[feature]
    if (!detail || detail.count < 2) continue
    const histogram = Array.from({ length: detail.count }, emptySums)
    for (const index of indices) {
      const bin = input.binIndices[feature][index]
      addRow(histogram[bin], index, input)
    }

    const left = emptySums()
    let leftCount = 0
    for (let bin = 0; bin < detail.count - 1; bin += 1) {
      addSums(left, histogram[bin])
      leftCount += histogram[bin].count
      const right = subtractSums(total, left)
      const rightCount = total.count - leftCount
      if (leftCount < options.minSamplesLeaf || rightCount < options.minSamplesLeaf) continue
      if (left.weight <= 0 || right.weight <= 0) continue
      const reduction = totalSse - sse(left) - sse(right)
      if (reduction > bestReduction + 1e-12) {
        bestReduction = reduction
        bestFeature = feature
        bestBin = bin
        bestThreshold = detail.min + (bin + 1) * detail.width
      }
    }
  }

  if (bestFeature < 0 || bestBin < 0) {
    return { value: leafValue(input, indices, options.l2) }
  }

  const leftIndices: number[] = []
  const rightIndices: number[] = []
  for (const index of indices) {
    if (input.binIndices[bestFeature][index] <= bestBin) leftIndices.push(index)
    else rightIndices.push(index)
  }
  if (leftIndices.length === 0 || rightIndices.length === 0) {
    return { value: leafValue(input, indices, options.l2) }
  }

  return {
    feature: bestFeature,
    threshold: bestThreshold,
    left: buildTree(input, leftIndices, depth + 1, options),
    right: buildTree(input, rightIndices, depth + 1, options),
    value: leafValue(input, indices, options.l2),
  }
}

function treeValue(node: TreeNode, x: number[]): number {
  let current = node
  while (current.feature !== undefined && current.threshold !== undefined) {
    current = (x[current.feature] ?? 0) <= current.threshold ? current.left! : current.right!
  }
  return current.value
}

export function trainGbm(rows: Example[], nFeatures: number, options: GbmOptions = {}): GbmModel {
  const opts = { ...DEFAULT_GBM, ...options }
  const featureCount = nFeatures > 0 ? nFeatures : (rows[0]?.x.length ?? 0)
  let weightSum = 0
  let positive = 0
  for (const row of rows) {
    weightSum += row.w
    positive += row.w * row.y
  }
  const baseRate = weightSum > 0 ? Math.min(1 - 1e-6, Math.max(1e-6, positive / weightSum)) : 0.5
  const baseScore = Math.log(baseRate / (1 - baseRate))

  const xs = rows.map((row) => row.x)
  const binDetails: FeatureBins[] = []
  const binIndices: number[][] = []
  for (let feature = 0; feature < featureCount; feature += 1) {
    const binned = buildFeatureBins(xs, feature, opts.maxBins)
    binDetails.push(binned.detail)
    binIndices.push(binned.indices)
  }

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
    const input: TreeInput = {
      xs,
      targets,
      weights,
      binIndices,
      binDetails,
      features: selectFeatures(featureCount, opts, t),
    }
    const tree = buildTree(input, indices, 0, opts)
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
    nTrees: trees.length,
    l2: opts.l2,
    maxBins: opts.maxBins,
    featureRatio: opts.featureRatio,
    seed: opts.seed,
  }
}

export function predictGbm(model: GbmModel, x: number[]): number {
  let score = model.baseScore
  for (const tree of model.trees) score += model.learningRate * treeValue(tree, x)
  return sigmoid(score)
}
