import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isCurrentPlanLoad } from './PredictionPanel'

test('only the newest plan request may update the panel', () => {
  assert.equal(isCurrentPlanLoad(2, 2), true)
  assert.equal(isCurrentPlanLoad(1, 2), false)
})
