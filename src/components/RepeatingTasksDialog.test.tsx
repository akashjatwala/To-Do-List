import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Task } from '@/types'
import RepeatingTasksDialog from './RepeatingTasksDialog'

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

function render(tasks: Task[], showOwner = false) {
  return renderToStaticMarkup(
    <RepeatingTasksDialog
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

test('the repeating modal lists recurring notes without a reorder grip', () => {
  const html = render([
    makeTask(),
    makeTask({
      id: 'task-2',
      text: 'Weekly release triage',
      recurrence: 'weekly',
    }),
  ])

  assert.match(html, /aria-label="All repeating tasks"/)
  assert.match(html, /sticky-board/)
  assert.match(html, /Daily launch check/)
  assert.match(html, /Weekly release triage/)
  assert.match(html, /Daily/)
  assert.match(html, /Weekly/)
  assert.doesNotMatch(html, /aria-label="Drag to reorder"/)
})

test('team repeating notes show their owner', () => {
  const html = render([makeTask({ userId: 2, ownerEmail: 'asha@example.com' })], true)

  assert.match(html, />asha</)
})

test('an empty repeating modal explains where recurring notes appear', () => {
  const html = render([])

  assert.match(html, /No repeating tasks/)
  assert.match(html, /Tasks with a daily, weekly, monthly or custom repeat will collect here\./)
})
