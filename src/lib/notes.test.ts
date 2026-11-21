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

test('every pin is the same red accent', () => {
  assert.deepEqual(PIN_COLORS, ['red'])
  for (const id of ['a', 'task-1', 'note-xyz', '12345', 'zzzz']) {
    assert.equal(pinColor(id), 'red')
    assert.equal(pinClass(id), 'text-[#D9480F]')
  }
})

test('pinClass stays red for every id', () => {
  const classes = new Set(Array.from({ length: 40 }, (_, index) => pinClass(`task-${index}`)))
  assert.deepEqual([...classes], ['text-[#D9480F]'])
})
