import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clockParts } from './useHeaderClock'

test('clock label pads local hour and minute', () => {
  assert.deepEqual(clockParts(new Date(2026, 10, 23, 9, 5)), {
    currentHour: 9,
    clockLabel: '09:05',
  })
})

test('clock label keeps midnight as 00:00', () => {
  assert.deepEqual(clockParts(new Date(2026, 10, 23, 0, 0)), {
    currentHour: 0,
    clockLabel: '00:00',
  })
})

test('clock label uses the local afternoon hour', () => {
  assert.deepEqual(clockParts(new Date(2026, 10, 23, 17, 42)), {
    currentHour: 17,
    clockLabel: '17:42',
  })
})
