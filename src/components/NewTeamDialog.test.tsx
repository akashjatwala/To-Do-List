import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import NewTeamDialog from './NewTeamDialog'

const props = {
  onClose: () => {},
  onChanged: async () => {},
  notify: () => {},
}

test('the new team dialog shows the reference form and preview', () => {
  const html = renderToStaticMarkup(<NewTeamDialog {...props} />)

  assert.match(html, /aria-label="New team"/)
  assert.match(html, /Team name/)
  assert.match(html, /What is it for\?/)
  assert.match(html, /Team color/)
  assert.match(html, /Lilac/)
  assert.match(html, /Invite people/)
  assert.match(html, /name@example\.com/)
  assert.match(html, /Preview/)
  assert.match(html, /1 member/)
  assert.match(html, /0 invited/)
  assert.match(html, /0 open tasks/)
  assert.match(html, /You will be the host/)
  assert.match(html, /only the host or the person who created a task can delete it/i)
  assert.match(html, /You can invite people later from the Members panel/)
  assert.match(html, /The team color tints its panels/)
  assert.match(html, /Create team/)
})

test('the new team dialog offers the four reference colors', () => {
  const html = renderToStaticMarkup(<NewTeamDialog {...props} />)

  for (const color of ['Sand', 'Lilac', 'Sky', 'Rose', 'Mint', 'Peach', 'Butter', 'Aqua']) {
    assert.match(html, new RegExp(`aria-label="${color} team color"`))
  }
  assert.match(html, /#E7E1F5/)
})

test('dialog labels use proper case rather than uppercase', () => {
  const html = renderToStaticMarkup(<NewTeamDialog {...props} />)
  assert.match(html, /normal-case/)
  assert.doesNotMatch(html, /uppercase/)
})
