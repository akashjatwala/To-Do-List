import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import NewTaskDialog from './NewTaskDialog'

const props = {
  open: true,
  onClose: () => {},
  teams: [{ id: 'team-1', name: 'Launch crew', createdAt: 0, role: 'host' as const, members: [] }],
  defaultTeamId: 'team-1',
  defaultDue: '2026-11-21',
  onAdd: async () => true,
}

test('the new task dialog shows the reference sections and live preview', () => {
  const html = renderToStaticMarkup(<NewTaskDialog {...props} />)

  assert.match(html, /aria-label="New task"/)
  assert.match(html, /Priority/)
  assert.match(html, /Due date/)
  assert.match(html, /Time \(optional\)/)
  assert.match(html, /How long will it take\?/)
  assert.match(html, /Repeats/)
  assert.match(html, /Add to/)
  assert.match(html, /Launch crew/)
  assert.match(html, /Tags/)
  assert.match(html, /Preview/)
  assert.match(html, /Suggested time/)
  assert.match(html, /Low confidence until it has more of your history/)
  assert.match(html, /Add and create another/)
  assert.match(html, /Add task/)
  assert.match(html, /normal-case/)
  assert.doesNotMatch(html, /uppercase/)
})

test('the priority chips use the sticky-note palette', () => {
  const html = renderToStaticMarkup(<NewTaskDialog {...props} />)

  assert.match(html, /bg-\[#E6E8EB\]/)
  assert.match(html, /bg-\[#4aa96c\]\/30/)
  assert.match(html, /bg-\[#F5E9A8\]/)
  assert.match(html, /bg-\[#e0716a\]\/30/)
})

test('the new task dialog keeps the no-Urgent priority rule', () => {
  const html = renderToStaticMarkup(<NewTaskDialog {...props} />)
  assert.doesNotMatch(html, /Urgent/)
})

test('a closed new task dialog renders nothing', () => {
  const html = renderToStaticMarkup(<NewTaskDialog {...props} open={false} />)
  assert.equal(html, '')
})
