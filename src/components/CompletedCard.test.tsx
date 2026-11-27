import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Task } from '@/types'
import CompletedCard from './CompletedCard'

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

function render(tasks: Task[] = []) {
  return renderToStaticMarkup(<CompletedCard tasks={tasks} onViewAll={() => undefined} />)
}

test('completed card mirrors the overdue card: compact header and no inline list', () => {
  const html = render([
    makeTask(),
    makeTask({ id: 'task-2', text: 'Water the plants' }),
  ])

  assert.match(html, /aria-label="Completed"/)
  assert.match(html, /bg-\[#DCEBDF\]/)
  assert.match(html, /Completed<\/h2>/)
  assert.doesNotMatch(html, /Completed<\/h2><span/)
  assert.doesNotMatch(html, /Read a book/)
  assert.doesNotMatch(html, /Water the plants/)
  assert.doesNotMatch(html, /Similar/)
  assert.doesNotMatch(html, /Mark as not done/)
})

test('completed card always links to the completed-only modal with a count', () => {
  const html = render([
    makeTask(),
    makeTask({ id: 'task-2', text: 'Water the plants' }),
  ])

  assert.match(html, /View all completed tasks/)
  assert.match(html, /2 Done/)
  assert.match(html, /bg-white\/45/)
})
