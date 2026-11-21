import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import { ConfirmDialog } from './ui'

test('the confirm dialog uses the app modal with cancel and confirm actions', () => {
  const html = renderToStaticMarkup(
    <ConfirmDialog
      open
      title="Delete task?"
      description="“Read a book” will be removed from your list."
      confirmLabel="Delete task"
      onConfirm={() => {}}
      onClose={() => {}}
    />,
  )

  assert.match(html, /role="dialog"/)
  assert.match(html, /aria-label="Delete task\?"/)
  assert.match(html, /will be removed from your list/)
  assert.match(html, /btn-ghost/)
  assert.match(html, /Cancel/)
  assert.match(html, /btn-danger/)
  assert.match(html, /Delete task/)
})

test('a closed confirm dialog renders nothing', () => {
  const html = renderToStaticMarkup(
    <ConfirmDialog open={false} title="Delete task?" onConfirm={() => {}} onClose={() => {}} />,
  )
  assert.equal(html, '')
})
