import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import AccountMenu from './AccountMenu'

function render(defaultOpen = false) {
  return renderToStaticMarkup(
    <AccountMenu
      name="demo"
      email="demo@example.com"
      onOpenAccount={() => {}}
      onLogout={() => {}}
      defaultOpen={defaultOpen}
    />,
  )
}

test('account chip and dropdown keep the previous neutral style', () => {
  const html = render(true)
  assert.match(html, /aria-expanded="true"/)
  assert.match(html, /bg-\[#15181E\]/)
  assert.match(html, /border-slate-200 bg-white/)
  assert.match(html, /right-0/)
  assert.match(html, /gap-2\.5/)
  assert.doesNotMatch(html, /bg-\[#FDF3E7\]/)
  assert.doesNotMatch(html, /bg-\[#B4552A\]/)
  assert.doesNotMatch(html, /border-\[#E6C7AC\]/)
})

test('account chip is closed by default without an oval outline', () => {
  const html = render()
  assert.match(html, /aria-expanded="false"/)
  assert.doesNotMatch(html, /role="menu"/)
})
