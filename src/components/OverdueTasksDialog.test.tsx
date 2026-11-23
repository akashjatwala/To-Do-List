import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Task } from '@/types'
import OverdueTasksDialog from './OverdueTasksDialog'

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    text: 'Write the brief',
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

function render(tasks: Task[], scopeLabel = 'Your personal tasks') {
  return renderToStaticMarkup(
    <OverdueTasksDialog
      open
      tasks={tasks}
      scopeLabel={scopeLabel}
      currentUserId={1}
      showOwner={false}
      canDelete={() => false}
      onClose={() => undefined}
      onOpenTask={() => undefined}
      onToggleTask={() => undefined}
      onDeleteTask={() => undefined}
      onRemind={() => undefined}
    />,
  )
}

test('the overdue dialog shows the scoped overdue tasks as sticky notes', () => {
  const html = render(
    [
      makeTask({ id: 'overdue-1', text: 'Write the brief' }),
      makeTask({ id: 'done-1', text: 'Already shipped', done: true }),
    ],
    'Launch crew team tasks',
  )
  assert.match(html, /All overdue tasks/)
  assert.match(html, /Launch crew team tasks/)
  assert.match(html, /sticky-note/)
  assert.match(html, /Write the brief/)
  assert.doesNotMatch(html, /Already shipped/)
  assert.match(html, /Click to open/)
  assert.doesNotMatch(html, /Drag to reorder/)
  assert.match(html, /aria-label="Send reminder for Write the brief"/)
})

test('the overdue dialog has a clear empty state', () => {
  const html = render([])
  assert.match(html, /No overdue tasks/)
  assert.match(html, /Nothing is past its due date/)
})
