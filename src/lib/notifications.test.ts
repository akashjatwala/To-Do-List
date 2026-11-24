import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AppNotification } from '@/types'
import { groupNotifications, unreadCount } from './notifications'

function item(id: string, kind: AppNotification['kind'], createdAt: number): AppNotification {
  return {
    id,
    kind,
    createdAt,
    title: id,
    body: id,
    taskId: null,
    teamId: null,
    teamName: null,
    actorName: null,
  }
}

test('groups invitations, reminders, and team activity', () => {
  const items = [
    item('a', 'invite', 6),
    item('b', 'comment', 5),
    item('h', 'mention', 5),
    item('c', 'reminder', 4),
    item('d', 'assignment', 3),
    item('e', 'task-added', 2),
    item('f', 'task-completed', 1),
    item('g', 'team-reminder', 0),
  ]
  const groups = groupNotifications(items)
  assert.deepEqual(groups.invitations.map((entry) => entry.id), ['a'])
  assert.deepEqual(groups.reminders.map((entry) => entry.id), ['c'])
  assert.deepEqual(groups.activity.map((entry) => entry.id), ['b', 'h', 'd', 'e', 'f', 'g'])
})

test('unread count only includes items newer than the local read marker', () => {
  const items = [item('a', 'invite', 10), item('b', 'comment', 20), item('c', 'reminder', 30)]
  assert.equal(unreadCount(items, 0), 3)
  assert.equal(unreadCount(items, 20), 1)
  assert.equal(unreadCount(items, 30), 0)
})
