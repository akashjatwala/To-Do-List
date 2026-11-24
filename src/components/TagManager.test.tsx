import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import type { UserTag } from '@/types'
import TagManagerDialog from './TagManager'

const tags: UserTag[] = [
  { id: 1, name: 'work' },
  { id: 2, name: 'health' },
]

function render(open: boolean) {
  return renderToStaticMarkup(
    <TagManagerDialog
      open={open}
      initialTags={tags}
      onClose={() => {}}
      onChanged={() => {}}
      notify={() => {}}
    />,
  )
}

test('tag manager lists lower-case tags with add, rename and delete actions only', () => {
  const html = render(true)
  assert.match(html, /role="dialog"/)
  assert.match(html, /aria-label="Tag manager"/)
  assert.match(html, /#work/)
  assert.match(html, /#health/)
  assert.doesNotMatch(html, /#Work/)
  assert.doesNotMatch(html, />\d+ tasks?<\/p>/)
  assert.match(html, /\+ Add tag/)
  assert.equal(html.match(/>Rename<\/button>/g)?.length, 2)
  assert.equal(html.match(/>Delete<\/button>/g)?.length, 2)
  assert.doesNotMatch(html, />Merge<\/button>/)
  assert.match(html, /max-w-2xl/)
  assert.match(html, /border-slate-200 bg-white/)
  assert.match(html, /px-6 sm:px-7/)
  assert.match(html, /min-w-\[5\.5rem\]/)
  assert.doesNotMatch(html, /#FFF9F3/)
  assert.doesNotMatch(html, /#EAD5C2/)
  assert.doesNotMatch(html, /#FDF3E7/)
})

test('tag manager uses the app modal and hides when closed', () => {
  assert.equal(render(false), '')
})
