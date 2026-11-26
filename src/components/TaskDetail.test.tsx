import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Task } from '@/types'
import TaskDetail from './TaskDetail'

const task: Task = {
  id: 'task-1',
  text: 'Read 20 pages',
  done: false,
  createdAt: new Date(2026, 10, 9).getTime(),
  due: new Date(2026, 10, 19, 17, 30).getTime(),
  progress: 0,
  priority: 'low',
  tags: ['learning'],
  recurrence: 'daily',
  recurrenceConfig: null,
  duration: 30,
  teamId: null,
  teamName: null,
  userId: 1,
  ownerEmail: 'demo@example.com',
  subtasks: [
    { id: 's1', text: 'Write one idea to remember', done: false, position: 0, assignee: null },
    { id: 's2', text: 'Find a quiet spot', done: true, position: 1, assignee: null },
  ],
  comments: [],
  assignees: [],
}

const props = {
  task,
  currentUserId: 1,
  canModerate: true,
  canDelete: true,
  members: [],
  onClose: () => {},
  onUpdate: async () => true,
  onSetAssignees: async () => true,
  onDelete: async () => {},
  onAddSubtask: async () => true,
  onToggleSubtask: () => {},
  onAssignSubtask: async () => true,
  onDeleteSubtask: () => {},
  onAddComment: async () => true,
  onDeleteComment: () => {},
}

test('task details render as a centered two-column dialog', () => {
  const html = renderToStaticMarkup(<TaskDetail {...props} />)

  assert.match(html, /aria-label="Task details"/)
  assert.match(html, /animate-dialog/)
  assert.match(html, /max-w-5xl/)
  assert.match(html, /bg-\[#CFE3F7\]/)
  assert.match(html, /Repeats daily/)
  assert.match(html, /My tasks/)
  assert.match(html, /private/)
  assert.match(html, /#learning/)
  assert.match(html, /Notes/)
  assert.match(html, /Subtasks/)
  assert.match(html, /1 of 2/)
  assert.match(html, /Details/)
})

test('task details keep the footer actions without the nudge section', () => {
  const html = renderToStaticMarkup(<TaskDetail {...props} />)

  assert.doesNotMatch(html, /Nudge/)
  assert.doesNotMatch(html, /Chance you'll work on it today/)
  assert.doesNotMatch(html, /71%/)
  assert.doesNotMatch(html, /Low confidence\. Sample value\./)
  assert.match(html, /Only you can see this task\./)
  assert.match(html, /Delete task/)
  assert.match(html, /Close/)
  assert.match(html, /Mark done for today/)
})

test('task details right column follows the reference card layout', () => {
  const html = renderToStaticMarkup(<TaskDetail {...props} />)

  assert.match(html, /Details[\s\S]*>List</)
  assert.match(html, /Details[\s\S]*>Due</)
  assert.match(html, /Details[\s\S]*>Duration</)
  assert.match(html, /Details[\s\S]*>Repeats</)
  assert.doesNotMatch(html, /Nudge/)
  assert.doesNotMatch(html, /Chance you'll work on it today/)
  assert.doesNotMatch(html, /Low confidence\. Sample value\./)
  assert.doesNotMatch(html, /Suggested time/)
  assert.doesNotMatch(html, /Last 7 days/)
  assert.doesNotMatch(html, /Time spent/)
  assert.doesNotMatch(html, /Start a session/)
  assert.doesNotMatch(html, /Priority/)
  assert.match(html, /aria-label="Clear due date"/)
  assert.doesNotMatch(html, /aria-label="Clear due date and time"/)
})

test('task details keep every editable control', () => {
  const html = renderToStaticMarkup(<TaskDetail {...props} />)

  assert.match(html, /aria-label="Task title"/)
  assert.match(html, /aria-label="Due date"/)
  assert.doesNotMatch(html, /aria-label="Preferred time of day"/)
  assert.match(html, /aria-label="Ideal duration in minutes"/)
  assert.match(html, /aria-label="Repeat rule"/)
  assert.match(html, /aria-label="New subtask"/)
  assert.match(html, /aria-label="New note"/)
  assert.match(html, /Task time/)
  assert.doesNotMatch(html, /aria-label="Entry date"/)
  assert.match(html, /aria-label="Start time"/)
  assert.match(html, /aria-label="Completion time"/)
  assert.match(html, /Logged for this task/)
  assert.doesNotMatch(html, /aria-label="Task completion percentage"/)
})

test('task details replace progress with multiple start and completion times', () => {
  const html = renderToStaticMarkup(<TaskDetail {...props} />)

  assert.match(html, /Task time/)
  assert.match(html, /Add a time entry/)
  assert.match(html, /No time entries yet/)
  assert.doesNotMatch(html, /Progress/)
  assert.doesNotMatch(html, /aria-label="Task completion percentage"/)
})

test('personal tasks do not show team assignment controls', () => {
  const html = renderToStaticMarkup(<TaskDetail {...props} />)
  assert.doesNotMatch(html, /Assigned to/)
  assert.doesNotMatch(html, /\+ Assign/)
})

test('team tasks let a member assign several teammates', () => {
  const teamTask: Task = {
    ...task,
    teamId: 'team-1',
    teamName: 'Launch crew',
    assignees: [
      { id: 2, email: 'asha@example.com', name: 'asha' },
      { id: 3, email: 'marco@example.com', name: 'marco' },
    ],
    subtasks: [
      {
        id: 's1',
        text: 'Write one idea to remember',
        done: false,
        position: 0,
        assignee: { id: 2, email: 'asha@example.com', name: 'asha' },
      },
    ],
  }
  const html = renderToStaticMarkup(
    <TaskDetail
      {...props}
      task={teamTask}
      members={[
        { id: 2, email: 'asha@example.com', role: 'member' },
        { id: 3, email: 'marco@example.com', role: 'member' },
        { id: 4, email: 'lena@example.com', role: 'host' },
      ]}
    />,
  )

  assert.match(html, /Assigned to/)
  assert.match(html, /\+ Assign/)
  assert.match(html, /Unassign asha/)
  assert.match(html, /Unassign marco/)
  assert.match(html, /Visible to Launch crew\./)
  assert.match(html, /aria-label="Subtask assignee"/)
  assert.match(html, /aria-label="Assignee for Write one idea to remember"/)
  assert.match(html, /value="2"/)
})

test('personal tasks do not show subtask assignee pickers', () => {
  const html = renderToStaticMarkup(<TaskDetail {...props} />)
  assert.doesNotMatch(html, /aria-label="Subtask assignee"/)
  assert.doesNotMatch(html, /aria-label="Assignee for /)
})

test('task details never introduce an Urgent priority', () => {
  const html = renderToStaticMarkup(<TaskDetail {...props} />)

  assert.doesNotMatch(html, /Urgent/)
})
