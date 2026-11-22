import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import { dueFromDateInput } from '@/lib/date'
import type { Task } from '@/types'
import OverdueCard from './OverdueCard'

const TODAY = '2026-11-22'

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    text: 'Write quarterly report',
    done: false,
    createdAt: 0,
    due: dueFromDateInput('2026-11-19'),
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

function render(tasks: Task[], showAssignees = false) {
  return renderToStaticMarkup(
    <OverdueCard
      tasks={tasks}
      today={TODAY}
      showAssignees={showAssignees}
      onOpen={() => undefined}
      onDone={() => undefined}
      onMoveToToday={() => undefined}
    />,
  )
}

test('overdue card lists each task with its due label and actions', () => {
  const html = render([
    makeTask(),
    makeTask({ id: 'task-2', text: 'Read product notes', due: dueFromDateInput('2026-11-21') }),
  ])
  assert.match(html, /Overdue tasks/)
  assert.match(html, /aria-label="Overdue tasks"/)
  assert.match(html, /Write quarterly report/)
  assert.match(html, /Read product notes/)
  assert.match(html, /3 days ago/)
  assert.match(html, /1 day ago/)
  assert.match(html, /Move to today/)
  assert.match(html, />Done</)
  assert.match(html, />Open</)
  assert.match(html, /snap-y snap-mandatory overflow-y-auto/)
  assert.match(html, /h-\[7\.75rem\]/)
})

test('overdue card has a clear empty state', () => {
  const html = render([])
  assert.match(html, /Nothing overdue — you(?:&#x27;|')re all caught up\./)
  assert.doesNotMatch(html, /Move to today/)
})

test('team overdue card shows assignees and marks unassigned tasks', () => {
  const assigned = makeTask({
    id: 'team-1',
    text: 'Confirm speaker slots',
    teamId: 'team-1',
    assignees: [
      { id: 2, email: 'asha@example.com', name: 'Asha' },
      { id: 3, email: 'marco@example.com', name: 'Marco' },
    ],
  })
  const unassigned = makeTask({
    id: 'team-2',
    text: 'Review pricing page',
    teamId: 'team-1',
  })

  const personal = render([assigned])
  assert.doesNotMatch(personal, /Assigned to:/)

  const team = render([assigned, unassigned], true)
  assert.match(team, /Assigned to: Asha, Marco/)
  assert.match(team, /Assigned to: Unassigned/)
})
