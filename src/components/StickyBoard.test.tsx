import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Task } from '@/types'
import { StickyBoard } from './StickyBoard'

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    text: 'Read a book',
    done: false,
    createdAt: 0,
    due: null,
    progress: 0,
    priority: 'medium',
    tags: [],
    recurrence: 'none',
    recurrenceConfig: null,
    duration: null,
    preferredTime: null,
    teamId: null,
    teamName: null,
    userId: 1,
    ownerEmail: 'me@example.com',
    subtasks: [],
    comments: [],
    ...overrides,
  }
}

function renderBoard(tasks: Task[]) {
  return renderToStaticMarkup(
    <StickyBoard
      tasks={tasks}
      emptyTitle="Nothing here"
      emptyText="Add something."
      currentUserId={1}
      showOwner={false}
      canDelete={() => true}
      onOpen={() => {}}
      onToggle={() => {}}
      onDelete={() => {}}
      onReorder={() => {}}
    />,
  )
}

test('every note carries a decorative push-pin that cannot be clicked', () => {
  const html = renderBoard([makeTask({ id: 'note-a' }), makeTask({ id: 'note-b', text: 'Walk' })])
  const pins = html.match(/class="sticky-pin[^"]*"/g) ?? []
  assert.equal(pins.length, 2)
  for (const pin of pins) {
    assert.match(pin, /pointer-events-none/)
  }
})

test('the pins are hidden from screen readers', () => {
  const html = renderBoard([makeTask()])
  // The pin wrapper is marked aria-hidden.
  assert.match(html, /aria-hidden="true"[^>]*class="sticky-pin/)
})

test('notes sit on a board and keep a small stable tilt', () => {
  const html = renderBoard([makeTask()])
  assert.match(html, /sticky-board/)
  assert.match(html, /--tilt:\s*-?\d+(\.\d+)?deg/)
})

test('the note content and actions are unchanged', () => {
  const html = renderBoard([makeTask({ text: 'Read a book' })])
  assert.match(html, /Read a book/)
})

test('an empty board shows its empty state', () => {
  const html = renderBoard([])
  assert.match(html, /Nothing here/)
})
