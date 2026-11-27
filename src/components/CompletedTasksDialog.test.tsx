import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Task } from '@/types'
import CompletedTasksDialog from './CompletedTasksDialog'

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    text: 'Read a book',
    done: true,
    createdAt: 0,
    due: null,
    progress: 100,
    priority: 'medium',
    tags: [],
    recurrence: 'none',
    recurrenceConfig: null,
    duration: null,
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

function render(tasks: Task[], showOwner = false) {
  return renderToStaticMarkup(
    <CompletedTasksDialog
      open
      tasks={tasks}
      currentUserId={1}
      showOwner={showOwner}
      canDelete={() => true}
      onClose={() => undefined}
      onOpenTask={() => undefined}
      onToggleTask={() => undefined}
      onDeleteTask={() => undefined}
    />,
  )
}

test('the completed modal lists finished notes with an uncomplete action', () => {
  const html = render([makeTask(), makeTask({ id: 'task-2', text: 'Water the plants' })])

  assert.match(html, /aria-label="All completed tasks"/)
  assert.match(html, /sticky-board/)
  assert.match(html, /Read a book/)
  assert.match(html, /Water the plants/)
  assert.equal((html.match(/aria-label="Mark as not done"/g) ?? []).length, 2)
})

test('the completed modal never offers Create similar', () => {
  const html = render([makeTask()])

  assert.doesNotMatch(html, /Similar/)
  assert.doesNotMatch(html, /Create similar/)
})

test('team completed notes show their owner', () => {
  const html = render(
    [makeTask({ userId: 2, ownerEmail: 'asha@example.com' })],
    true,
  )

  assert.match(html, />asha</)
})

test('an empty completed modal explains where finished notes appear', () => {
  const html = render([])

  assert.match(html, /Nothing completed yet/)
  assert.match(html, /Finished tasks for this day will collect here\./)
})
