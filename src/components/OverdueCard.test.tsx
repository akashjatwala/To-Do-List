import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import { dueFromDateInput } from '@/lib/date'
import type { Reminder, Task } from '@/types'
import OverdueCard from './OverdueCard'

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

function render(tasks: Task[] = [], reminders: Reminder[] = []) {
  return renderToStaticMarkup(
    <OverdueCard tasks={tasks} reminders={reminders} onViewAll={() => undefined} />,
  )
}

test('overdue card keeps a count-free header and no inline task list', () => {
  const html = render([
    makeTask(),
    makeTask({ id: 'task-2', text: 'Read product notes', due: dueFromDateInput('2026-11-21') }),
  ])
  assert.match(html, /aria-label="Overdue tasks"/)
  assert.match(html, /bg-\[#EEE7F7\]/)
  assert.match(html, /Overdue tasks<\/h2>/)
  assert.doesNotMatch(html, /Overdue tasks<\/h2><span/)
  assert.doesNotMatch(html, /snap-y snap-mandatory overflow-y-auto/)
  assert.doesNotMatch(html, /Write quarterly report/)
  assert.doesNotMatch(html, /Read product notes/)
  assert.doesNotMatch(html, /Move to today/)
  assert.doesNotMatch(html, />Done</)
  assert.doesNotMatch(html, />Open</)
})

test('overdue card always links to the overdue-only modal', () => {
  const html = render([
    makeTask(),
    makeTask({ id: 'task-2', text: 'Read product notes', due: dueFromDateInput('2026-11-21') }),
  ])
  assert.match(html, /View all overdue tasks/)
  assert.match(html, /2 Overdue/)
  assert.doesNotMatch(html, /View all pending tasks/)
  assert.match(html, /bg-white\/45/)
})

test('sent reminders appear as compact rows above the link', () => {
  const html = render([], [
    {
      id: 7,
      taskId: 'team-1',
      taskText: 'Confirm speaker slots',
      senderId: 1,
      createdAt: Date.now() - 60_000,
      recipients: [
        { id: 2, email: 'asha@example.com', name: 'Asha' },
        { id: 3, email: 'marco@example.com', name: 'Marco' },
      ],
    },
    {
      id: 8,
      taskId: 'personal',
      taskText: 'Personal task',
      senderId: 1,
      createdAt: Date.now(),
      recipients: [],
    },
  ])
  assert.match(html, /aria-label="Sent reminders"/)
  assert.match(html, /Confirm speaker slots/)
  assert.match(html, /Sent to Asha, Marco\./)
  assert.match(html, /Reminder saved locally\./)
})
