import { test } from 'node:test'
import assert from 'node:assert/strict'
import { type Example } from './model/math'
import { predictGbm, trainGbm } from './model/gbm'
import { predictLogistic, trainLogistic } from './model/logistic'
import { brier } from './metrics'

/**
 * Tests for the stronger, still-deterministic boosted-tree challenger.
 * The synthetic interaction below is not a demo accuracy claim: it only checks
 * that the tree model can learn a non-linear boundary and stays reproducible.
 */

function interactionRows(): Example[] {
  const rows: Example[] = []
  for (let i = 0; i < 20; i += 1) {
    for (let j = 0; j < 20; j += 1) {
      const x = [i / 19, j / 19]
      const high = i > 9 && j > 9 ? 1 : 0
      rows.push({ x, y: high, w: 1 })
    }
  }
  return rows
}

test('gbm: a small boosted-tree ensemble learns a non-linear interaction', () => {
  const rows = interactionRows()
  const options = { nTrees: 40, learningRate: 0.1, maxDepth: 2, minSamplesLeaf: 8, l2: 1, maxBins: 16, featureRatio: 1, seed: 7 }
  const gbm = trainGbm(rows, 2, options)
  const logistic = trainLogistic(rows, 2)

  const gbmBrier = brier(rows.map((row) => ({ p: predictGbm(gbm, row.x), y: row.y, w: row.w }))) ?? 1
  const logisticBrier = brier(rows.map((row) => ({ p: predictLogistic(logistic, row.x), y: row.y, w: row.w }))) ?? 1

  assert.ok(gbmBrier < logisticBrier - 0.02, `gbm ${gbmBrier.toFixed(3)} should beat logistic ${logisticBrier.toFixed(3)}`)
  assert.equal(gbm.nTrees, options.nTrees)
  assert.equal(gbm.maxDepth, options.maxDepth)
  assert.equal(gbm.featureRatio, options.featureRatio)
  assert.equal(gbm.seed, options.seed)
})

test('gbm: training is deterministic and serialises without loss', () => {
  const rows = interactionRows()
  const options = { nTrees: 12, learningRate: 0.1, maxDepth: 2, minSamplesLeaf: 10, l2: 2, maxBins: 12, featureRatio: 0.75, seed: 77 }
  const first = trainGbm(rows, 2, options)
  const second = trainGbm(rows, 2, options)
  assert.deepEqual(first, second)

  const restored = JSON.parse(JSON.stringify(first)) as typeof first
  const x = [0.3, 0.8]
  assert.equal(predictGbm(restored, x), predictGbm(first, x))
})
