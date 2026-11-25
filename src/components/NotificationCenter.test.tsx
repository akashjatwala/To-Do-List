import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AppNotification, UserInvite } from '@/types'
import NotificationCenter from './NotificationCenter'

const notifications: AppNotification[] = [
  {
    id: 'invite:crew',
    kind: 'invite',
    createdAt: Date.now() - 60_000,
    title: 'Team invitation',
    body: 'Asha invited you to Launch crew',
    taskId: null,
    teamId: 'crew',
    teamName: 'Launch crew',
    actorName: 'Asha',
  },
  {
    id: 'reminder:1',
    kind: 'reminder',
    createdAt: Date.now() - 120_000,
    title: 'Asha reminded you',
    body: 'Reminder for “Review draft”',
    taskId: 'task-1',
    teamId: null,
    teamName: null,
    actorName: 'Asha',
  },
  {
    id: 'comment:1',
    kind: 'comment',
    createdAt: Date.now() - 180_000,
    title: 'Asha commented',
    body: '“Looks good” on Review draft',
    taskId: 'task-1',
    teamId: 'crew',
    teamName: 'Launch crew',
    actorName: 'Asha',
  },
  {
    id: 'assignment:task-2',
    kind: 'assignment',
    createdAt: Date.now() - 240_000,
    title: 'Asha assigned you',
    body: 'Team task: Prepare notes',
    taskId: 'task-2',
    teamId: 'crew',
    teamName: 'Launch crew',
    actorName: 'Asha',
  },
  {
    id: 'task-added:task-3',
    kind: 'task-added',
    createdAt: Date.now() - 300_000,
    title: 'You added a task',
    body: 'Team task: “Draft agenda”',
    taskId: 'task-3',
    teamId: 'crew',
    teamName: 'Launch crew',
    actorName: 'me',
  },
  {
    id: 'task-completed:task-4',
    kind: 'task-completed',
    createdAt: Date.now() - 360_000,
    title: 'Asha completed a task',
    body: '“Send invites”',
    taskId: 'task-4',
    teamId: 'crew',
    teamName: 'Launch crew',
    actorName: 'Asha',
  },
  {
    id: 'team-reminder:2',
    kind: 'team-reminder',
    createdAt: Date.now() - 420_000,
    title: 'You sent a reminder',
    body: 'Reminder for “Draft agenda”',
    taskId: 'task-3',
    teamId: 'crew',
    teamName: 'Launch crew',
    actorName: null,
  },
  {
    id: 'task-moved:1',
    kind: 'task-moved',
    createdAt: Date.now() - 30_000,
    title: 'You skipped a task for today',
    body: '“Pay bill” moved from Nov 25 to Nov 27.',
    taskId: 'task-9',
    teamId: null,
    teamName: null,
    actorName: null,
    move: {
      eventId: 1,
      reason: 'skip',
      fromDate: '2026-11-25',
      toDate: '2026-11-27',
      canUndo: true,
    },
  },
]

const invites: UserInvite[] = [
  {
    teamId: 'crew',
    teamName: 'Launch crew',
    invitedByEmail: 'asha@example.com',
    createdAt: Date.now() - 60_000,
  },
]

function render(open: boolean) {
  return renderToStaticMarkup(
    <NotificationCenter
      userId={1}
      notifications={notifications}
      invites={invites}
      onAcceptInvite={() => {}}
      onDeclineInvite={() => {}}
      onOpenTask={() => {}}
      onUndoMove={() => {}}
      defaultOpen={open}
    />,
  )
}

test('header bell shows unread state but keeps the panel closed by default', () => {
  const html = render(false)
  assert.match(html, /aria-label="Notifications"/)
  assert.match(html, /aria-expanded="false"/)
  assert.doesNotMatch(html, /role="dialog"/)
  assert.match(html, /bg-\[#4F46E5\]/)
})

test('panel groups invitations, reminders and activity with their actions', () => {
  const html = render(true)
  assert.match(html, /role="dialog"/)
  assert.match(html, /aria-label="Notifications"/)
  assert.match(html, /Invitations/)
  assert.match(html, /Reminders/)
  assert.match(html, /Your moves/)
  assert.match(html, /Team activity/)
  assert.match(html, /Mark all read/)
  assert.match(html, /Team invitation/)
  assert.match(html, /Asha reminded you/)
  assert.match(html, /Asha commented/)
  assert.match(html, /Asha assigned you/)
  assert.match(html, /You added a task/)
  assert.match(html, /Asha completed a task/)
  assert.match(html, /You sent a reminder/)
  assert.match(html, /Undo skip/)
  assert.match(html, /Accept/)
  assert.match(html, /Decline/)
  assert.equal(html.match(/Open task/g)?.length, 7)
  assert.match(html, /Launch crew/)
  assert.doesNotMatch(html, /Invites, reminders and a recent team activity feed/)
  assert.doesNotMatch(html, /In-app only/)
  assert.doesNotMatch(html, /no email, push or webhook/)
})
