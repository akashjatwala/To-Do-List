import { test } from 'node:test'
import assert from 'node:assert/strict'
import { idealTime } from './PredictionPanel'
import type { TaskPrediction } from '@/types'

const start = new Date(2026, 10, 22, 10, 0).getTime()
const end = start + 30 * 60_000

function predictionWith(sessions: number): TaskPrediction {
  return {
    inputs: { timingSessions: sessions },
    recommendedStart: start,
    recommendedEnd: end,
  } as unknown as TaskPrediction
}

test('ideal time is shown only when timing history exists', () => {
  const label = idealTime(predictionWith(2))
  assert.ok(label)
  assert.match(label, /–/)
  assert.equal(idealTime(predictionWith(0)), null)
})

test('ideal time is hidden when the window is missing', () => {
  const prediction = predictionWith(2)
  prediction.recommendedStart = null
  assert.equal(idealTime(prediction), null)
})
