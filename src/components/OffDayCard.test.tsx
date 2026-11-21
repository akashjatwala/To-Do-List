import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { OffDayKind } from '@/types'
import { offDayEmoji } from './OffDayCard'

test('each off-day reason has its own emoji, with just off kept distinct', () => {
  const reasons: OffDayKind[] = ['sick', 'travel', 'holiday', 'other']
  const emojis = reasons.map((reason) => offDayEmoji(reason))

  assert.equal(new Set(emojis).size, reasons.length)
  assert.equal(offDayEmoji(null), '😌')
  assert.ok(!emojis.includes(offDayEmoji(null)))
})

test('off-day emojis are the expected decorative symbols', () => {
  assert.equal(offDayEmoji(null), '😌')
  assert.equal(offDayEmoji('sick'), '🤒')
  assert.equal(offDayEmoji('travel'), '🧳')
  assert.equal(offDayEmoji('holiday'), '🌴')
  assert.equal(offDayEmoji('other'), '✨')
})
