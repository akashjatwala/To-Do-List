import type { AppNotification } from '@/types'

export interface NotificationGroups {
  invitations: AppNotification[]
  reminders: AppNotification[]
  moves: AppNotification[]
  activity: AppNotification[]
}

/** Split the flat server list into the sections shown in the panel. */
export function groupNotifications(items: AppNotification[]): NotificationGroups {
  return {
    invitations: items.filter((item) => item.kind === 'invite'),
    reminders: items.filter(
      (item) => item.kind === 'reminder' || item.kind === 'team-reminder',
    ),
    moves: items.filter((item) => item.kind === 'task-moved'),
    activity: items.filter((item) =>
      [
        'comment',
        'mention',
        'assignment',
        'task-added',
        'task-completed',
        'task-skipped',
        'off-day',
      ].includes(item.kind),
    ),
  }
}

/** Read state is a browser-local timestamp; anything newer is still unread. */
export function unreadCount(items: AppNotification[], lastRead: number): number {
  return items.reduce((count, item) => count + (item.createdAt > lastRead ? 1 : 0), 0)
}
