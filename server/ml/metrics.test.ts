import { test } from 'node:test'
import assert from 'node:assert/strict'
import { brier, calibrationError, reliability } from './metrics'

/**
 * Metric definitions. These tests pin the weighting rules so Brier and ECE
 * cannot silently disagree about which rows matter.
 */

test('metrics: ECE and Brier use the same sample weights', () => {
  const rows = [
    { p: 0.5, y: 1, w: 9 },
    { p: 0.9, y: 0, w: 1 },
  ]

  const curve = reliability(rows)
  assert.equal(curve.length, 2)
  assert.equal(curve[0].weight, 9)
  assert.equal(curve[1].weight, 1)
  assert.equal(curve[0].observed, 1)
  assert.equal(curve[1].observed, 0)

  // Weighted: 0.9 * |0.5 - 1| + 0.1 * |0.9 - 0| = 0.54.
  // An unweighted curve would report (0.5 + 0.9) / 2 = 0.70.
  assert.ok(Math.abs(calibrationError(rows)! - 0.54) < 1e-9)

  // The same weights give (9 * 0.25 + 1 * 0.81) / 10 = 0.306.
  assert.ok(Math.abs(brier(rows)! - 0.306) < 1e-9)
})

test('metrics: unweighted rows keep the original ECE behaviour', () => {
  const rows = [
    { p: 0.5, y: 1 },
    { p: 0.9, y: 0 },
  ]
  assert.ok(Math.abs(calibrationError(rows)! - 0.7) < 1e-9)
})
