import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import type { User } from '@/types'
import MyAccountDialog from './MyAccountDialog'

const user: User = { id: 1, name: 'Akash', email: 'akash@example.com' }

function render() {
  return renderToStaticMarkup(
    <MyAccountDialog
      open
      onClose={() => {}}
      user={user}
      teams={[]}
      onUserChanged={() => {}}
      onPasswordChanged={() => {}}
      onTagsChanged={() => {}}
      onDeleted={() => {}}
      notify={() => {}}
    />,
  )
}

test('My Account dialog uses the neutral surface and keeps its actions', () => {
  const html = render()
  assert.match(html, /aria-label="My Account"/)
  assert.match(html, /max-w-2xl/)
  assert.match(html, /border-slate-200 bg-white/)
  assert.match(html, /px-6 sm:px-7/)
  assert.match(html, /min-w-\[5\.5rem\]/)
  assert.doesNotMatch(html, /#FFF9F3/)
  assert.doesNotMatch(html, /#FFFDF9/)
  assert.doesNotMatch(html, /#EAD5C2/)
  assert.doesNotMatch(html, /#E6C7AC/)
  assert.match(html, /Manage/)
  assert.match(html, /Change/)
  assert.match(html, /Delete account/)
})
