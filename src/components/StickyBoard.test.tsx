import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Task } from '@/types'
import { CompletedColumn, RepeatingColumn, StickyBoard } from './StickyBoard'

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
    assignees: [],
    ...overrides,
  }
}

function renderBoard(tasks: Task[], allowReorder = true) {
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
      allowReorder={allowReorder}
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

test('every pin uses the same red accent', () => {
  const html = renderBoard([makeTask({ id: 'note-a' }), makeTask({ id: 'note-b' })])
  const pins = html.match(/class="sticky-pin[^"]*"/g) ?? []
  assert.equal(pins.length, 2)
  for (const pin of pins) assert.match(pin, /text-\[#D9480F\]/)
  assert.doesNotMatch(html, /text-(sky|amber|emerald)-500/)
})

test('notes follow the reference layout with tags, tear line and time row', () => {
  const html = renderBoard([
    makeTask({
      text: 'Finish quarterly report',
      priority: 'high',
      tags: ['work'],
      due: new Date(2026, 10, 21, 23, 59).getTime(),
      duration: 90,
    }),
  ])
  assert.doesNotMatch(html, />High</)
  assert.doesNotMatch(html, /sticky-note[^>]*border-\[?/)
  assert.match(html, />#work</)
  assert.match(html, /sticky-tear/)
  assert.match(html, /@ /)
  assert.match(html, /1 hr 30 min/)
})

test('the none priority note uses its gray color code', () => {
  const html = renderBoard([makeTask({ priority: 'none' })])
  assert.match(html, /bg-\[#E6E8EB\] text-\[#3A404B\]/)
})

test('notes sit on a board and keep a small stable tilt', () => {
  const html = renderBoard([makeTask()])
  assert.match(html, /sticky-board/)
  assert.match(html, /--tilt:\s*-?\d+(\.\d+)?deg/)
})

test('notes use a normal cursor and no native drag ghost', () => {
  const html = renderBoard([makeTask()])
  assert.match(html, /cursor-default/)
  assert.doesNotMatch(html, /cursor-(grab|grabbing)/)
  assert.doesNotMatch(html, /draggable=/)
})

test('the note content and actions are unchanged', () => {
  const html = renderBoard([makeTask({ text: 'Read a book' })])
  assert.match(html, /Read a book/)
})

test('an empty board shows its empty state', () => {
  const html = renderBoard([])
  assert.match(html, /Nothing here/)
})

test('an overview board hides the grip and drag affordance', () => {
  const html = renderBoard([makeTask()], false)
  assert.doesNotMatch(html, /Drag to reorder/)
  assert.match(html, /title="Click to open"/)
  assert.doesNotMatch(html, /Click to open · drag to rearrange/)
})

const columnProps = {
  tasks: [makeTask()],
  currentUserId: 1,
  showOwner: false,
  canDelete: () => false,
  onOpen: () => undefined,
  onToggle: () => undefined,
  onDelete: () => undefined,
  onReorder: () => undefined,
  allowReorder: false,
}

test('Completed keeps its green card but drops the header count', () => {
  const html = renderToStaticMarkup(<CompletedColumn {...columnProps} />)
  assert.match(html, /bg-\[#DCEBDF\]/)
  assert.match(html, /Completed<\/h2>/)
  assert.doesNotMatch(html, /Completed<\/h2><span/)
})

test('Completed offers Create similar without exposing a time label', () => {
  const html = renderToStaticMarkup(
    <CompletedColumn {...columnProps} onCreateSimilar={() => undefined} />,
  )
  assert.match(html, /aria-label="Create similar to Read a book"/)
  assert.match(html, />Similar</)
  assert.doesNotMatch(html, /\d{2}:\d{2}/)
})

test('Repeating uses its own light blue card and drops the header count', () => {
  const html = renderToStaticMarkup(<RepeatingColumn {...columnProps} />)
  assert.match(html, /bg-\[#E7F0F9\]/)
  assert.match(html, /Repeating<\/h2>/)
  assert.doesNotMatch(html, /Repeating<\/h2><span/)
  assert.match(html, /rounded-2xl bg-white\/55/)
})
