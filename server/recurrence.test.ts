import { test } from 'node:test'
import assert from 'node:assert/strict'
import { advanceDue, dueOnDate, localDateValue } from './recurrence'

test('dueOnDate moves a task onto the completed date and keeps its local clock time', () => {
  const anchor = new Date(2024, 11, 31, 9, 30, 15, 123).getTime()
  const moved = dueOnDate(anchor, '2026-11-27')
  const movedDate = new Date(moved)

  assert.equal(localDateValue(moved), '2026-11-27')
  assert.equal(movedDate.getHours(), 9)
  assert.equal(movedDate.getMinutes(), 30)
  assert.equal(movedDate.getSeconds(), 15)
  assert.equal(movedDate.getMilliseconds(), 123)
})

test('a daily repeat rolls forward from the completed date, not its stale anchor', () => {
  const anchor = new Date(2024, 11, 31, 9, 0, 0).getTime()
  const completed = dueOnDate(anchor, '2026-11-27')
  const next = advanceDue(completed, 'daily', null)

  assert.equal(localDateValue(completed), '2026-11-27')
  assert.equal(localDateValue(next), '2026-11-28')
  assert.equal(new Date(next).getHours(), 9)
})

test('a weekly repeat keeps its weekday when rolled forward from the completed date', () => {
  // 2026-11-27 is a Friday; completing Friday's occurrence should schedule next Friday.
  const anchor = new Date(2024, 11, 31, 9, 0, 0).getTime()
  const completed = dueOnDate(anchor, '2026-11-27')
  const next = advanceDue(completed, 'weekly', null)

  assert.equal(localDateValue(next), '2026-12-04')
})
