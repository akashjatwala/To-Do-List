import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Task } from '@/types'
import RepeatingCard from './RepeatingCard'

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    text: 'Daily launch check',
    done: false,
    createdAt: 0,
    due: null,
    progress: 0,
    priority: 'medium',
    tags: [],
    recurrence: 'daily',
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

test('repeating card mirrors completed and overdue: compact header and no inline list', () => {
  const html = renderToStaticMarkup(
    <RepeatingCard
      tasks={[
        makeTask(),
        makeTask({ id: 'task-2', text: 'Weekly release triage', recurrence: 'weekly' }),
      ]}
      onViewAll={() => undefined}
    />,
  )

  assert.match(html, /aria-label="Repeating"/)
  assert.match(html, /bg-\[#E7F0F9\]/)
  assert.match(html, /Repeating<\/h2>/)
  assert.doesNotMatch(html, /Repeating<\/h2><span/)
  assert.doesNotMatch(html, /Daily launch check/)
  assert.doesNotMatch(html, /Weekly release triage/)
})

test('repeating card always links to the repeating-only modal with a count', () => {
  const html = renderToStaticMarkup(
    <RepeatingCard tasks={[makeTask(), makeTask({ id: 'task-2' })]} onViewAll={() => undefined} />,
  )

  assert.match(html, /View all repeating tasks/)
  assert.match(html, /2 Repeats/)
  assert.match(html, /bg-white\/45/)
})
