import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PIN_COLORS, noteTilt, pinClass, pinColor } from './notes'

test('noteTilt is stable for a given id', () => {
  assert.equal(noteTilt('task-abc'), noteTilt('task-abc'))
})

test('noteTilt stays within the gentle range', () => {
  for (const id of ['a', 'task-1', 'note-xyz', '12345', 'zzzz']) {
    const angle = noteTilt(id)
    assert.ok(angle >= -1.8 && angle <= 1.8, `${id} tilt ${angle} out of range`)
  }
})

test('pinColor is stable and always one of the known colours', () => {
  for (const id of ['a', 'task-1', 'note-xyz', '12345', 'zzzz']) {
    const colour = pinColor(id)
    assert.equal(colour, pinColor(id))
    assert.ok((PIN_COLORS as readonly string[]).includes(colour))
  }
})

test('pinClass returns a non-empty class for every note', () => {
  for (const id of ['a', 'task-1', 'note-xyz']) {
    assert.ok(pinClass(id).length > 0)
  }
})

test('different ids can land on different pins (not all one colour)', () => {
  const colours = new Set(Array.from({ length: 40 }, (_, index) => pinColor(`task-${index}`)))
  assert.ok(colours.size > 1)
})
