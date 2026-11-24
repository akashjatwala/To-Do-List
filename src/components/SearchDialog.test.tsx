import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Task, Team } from '@/types'
import SearchDialog from './SearchDialog'

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    text: 'Write quarterly report',
    done: false,
    createdAt: 0,
    due: null,
    progress: 0,
    priority: 'high',
    tags: ['work'],
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

const team: Team = {
  id: 'crew',
  name: 'Launch crew',
  createdAt: 0,
  role: 'host',
  members: [{ id: 1, email: 'me@example.com', role: 'host' }],
}

function render(
  open: boolean,
  tasks: Task[] = [makeTask(), makeTask({ id: 'task-2', text: 'Plan picnic' })],
  query = '',
) {
  return renderToStaticMarkup(
    <SearchDialog
      open={open}
      tasks={tasks}
      teams={[team]}
      currentUserId={1}
      todayValue="2026-11-23"
      initialQuery={query}
      canDelete={() => true}
      onClose={() => {}}
      onOpenTask={() => {}}
      onToggleTask={() => {}}
      onDeleteTask={() => {}}
    />,
  )
}

test('search dialog reuses the modal shell and exposes the local filters', () => {
  const html = render(true)
  assert.match(html, /role="dialog"/)
  assert.match(html, /aria-label="Search tasks"/)
  assert.doesNotMatch(html, /\d+ tasks? found/)
  assert.match(html, /role="combobox"/)
  assert.match(html, /aria-autocomplete="list"/)
  assert.match(html, /aria-controls="search-task-suggestions"/)
  assert.doesNotMatch(html, /role="listbox"/)
  assert.match(html, /aria-label="Clear search"/)
  assert.match(html, /Clear search/)
  assert.match(html, /All tasks/)
  assert.match(html, /All statuses/)
  assert.match(html, /All priorities/)
  assert.match(html, /Any due date/)
  assert.match(html, /All tags/)
  assert.match(html, /Anyone/)
  assert.match(html, /lg:grid-cols-6/)
  assert.ok(html.indexOf('aria-label="Tag"') < html.indexOf('aria-label="Assignee"'))
  assert.doesNotMatch(html, /block sm:max-w-xs/)
  assert.doesNotMatch(html, /Urgent/)
})

test('no criteria shows no sticky notes until the user searches', () => {
  const html = render(true)
  assert.match(html, /Nothing to show yet/)
  assert.match(html, /Enter a search term or choose a filter/)
  assert.doesNotMatch(html, /sticky-board/)
  assert.doesNotMatch(html, /Write quarterly report/)
  assert.doesNotMatch(html, /Plan picnic/)
})

test('search results use sticky notes without reordering', () => {
  const html = render(true, undefined, 'quarterly')
  assert.match(html, /Write quarterly report/)
  assert.doesNotMatch(html, /Plan picnic/)
  assert.match(html, /sticky-board/)
  assert.doesNotMatch(html, /Drag to reorder/)
})

test('an empty result set keeps the sticky-note empty state', () => {
  const html = render(true, [], 'nothing matches this')
  assert.doesNotMatch(html, /\d+ tasks? found/)
  assert.match(html, /No matching tasks/)
  assert.match(html, /Try another search or filter\./)
})

test('a closed search dialog renders nothing', () => {
  assert.equal(render(false), '')
})
