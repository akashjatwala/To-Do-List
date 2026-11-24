import type { DatabaseSync } from 'node:sqlite'
import { db } from './db'

/**
 * In-app notification centre.
 *
 * This only reads data the app already stores. It never sends email, push
 * messages or webhooks, and it does not add a delivery queue. Read state lives
 * in the browser, so the server has no notification table of its own.
 */
export type NotificationKind =
  | 'invite'
  | 'reminder'
  | 'team-reminder'
  | 'comment'
  | 'assignment'
  | 'task-added'
  | 'task-completed'

export interface AppNotification {
  id: string
  kind: NotificationKind
  createdAt: number
  title: string
  body: string
  taskId: string | null
  teamId: string | null
  teamName: string | null
  actorName: string | null
}

interface InviteRow {
  team_id: string
  team_name: string
  created_at: number
  actor_name: string | null
  actor_email: string | null
}

interface ReminderRow {
  id: number
  task_id: string
  team_id: string | null
  team_name: string | null
  task_text: string
  sender_id: number
  created_at: number
  actor_name: string | null
  actor_email: string | null
}

interface CommentRow {
  id: string
  task_id: string
  team_id: string
  team_name: string
  text: string
  task_text: string
  created_at: number
  actor_id: number
  actor_name: string | null
  actor_email: string | null
}

interface AssignmentRow {
  task_id: string
  team_id: string
  team_name: string
  task_text: string
  created_at: number
  actor_id: number | null
  actor_name: string | null
  actor_email: string | null
  target_id: number
  target_name: string | null
  target_email: string | null
}

interface TaskEventRow {
  id: string
  team_id: string
  team_name: string
  task_text: string
  created_at: number
  actor_id: number | null
  actor_name: string | null
  actor_email: string | null
}

function displayName(name: string | null | undefined, email: string | null | undefined): string {
  if (name?.trim()) return name.trim()
  return email?.trim() ? email.split('@')[0] : 'a teammate'
}

function actorLabel(
  id: number | null,
  name: string | null,
  email: string | null,
  userId: number,
): string {
  return id === userId ? 'You' : displayName(name, email)
}

function targetLabel(
  id: number,
  name: string | null,
  email: string | null,
  userId: number,
  actorId: number | null,
): string {
  if (id === userId) return actorId === userId ? 'yourself' : 'you'
  return displayName(name, email)
}

function shorten(value: string, max: number): string {
  const clean = value.trim().replace(/\s+/g, ' ')
  if (clean.length <= max) return clean
  return `${clean.slice(0, Math.max(1, max - 1)).trimEnd()}…`
}

/** Notifications relevant to one user, newest first. */
export function notificationsFor(userId: number, database: DatabaseSync = db): AppNotification[] {
  const user = database.prepare('SELECT email FROM users WHERE id = ?').get(userId) as
    | { email: string }
    | undefined
  if (!user) return []

  const items: AppNotification[] = []
  const inMyTeams = 't.team_id IN (SELECT team_id FROM team_members WHERE user_id = ?)'

  const invites = database
    .prepare(
      `SELECT i.team_id, t.name AS team_name, i.created_at,
              u.name AS actor_name, u.email AS actor_email
       FROM team_invites i
       JOIN teams t ON t.id = i.team_id
       LEFT JOIN users u ON u.id = i.invited_by
       WHERE i.email = ?
       ORDER BY i.created_at DESC
       LIMIT 50`,
    )
    .all(user.email) as unknown as InviteRow[]
  for (const row of invites) {
    const actor = displayName(row.actor_name, row.actor_email)
    items.push({
      id: `invite:${row.team_id}`,
      kind: 'invite',
      createdAt: row.created_at,
      title: 'Team invitation',
      body: `${actor} invited you to ${row.team_name}`,
      taskId: null,
      teamId: row.team_id,
      teamName: row.team_name,
      actorName: actor,
    })
  }

  const reminders = database
    .prepare(
      `SELECT r.id, r.task_id, t.team_id, tm.name AS team_name,
              t.text AS task_text, r.sender_id, r.created_at,
              u.name AS actor_name, u.email AS actor_email
       FROM task_reminders r
       JOIN tasks t ON t.id = r.task_id
       LEFT JOIN teams tm ON tm.id = t.team_id
       JOIN users u ON u.id = r.sender_id
       WHERE (t.team_id IS NULL AND t.user_id = ?)
          OR EXISTS (
            SELECT 1 FROM task_reminder_recipients rr
            WHERE rr.reminder_id = r.id AND rr.user_id = ?
          )
       ORDER BY r.created_at DESC, r.id DESC
       LIMIT 50`,
    )
    .all(userId, userId) as unknown as ReminderRow[]
  for (const row of reminders) {
    const actor = displayName(row.actor_name, row.actor_email)
    const mine = row.sender_id === userId
    items.push({
      id: `reminder:${row.id}`,
      kind: 'reminder',
      createdAt: row.created_at,
      title: mine ? 'Reminder set' : `${actor} reminded you`,
      body: `Reminder for “${shorten(row.task_text, 90)}”`,
      taskId: row.task_id,
      teamId: row.team_id,
      teamName: row.team_name,
      actorName: mine ? null : actor,
    })
  }

  const taskAdds = database
    .prepare(
      `SELECT t.id, t.team_id, tm.name AS team_name, t.text AS task_text, t.created_at,
              t.user_id AS actor_id, u.name AS actor_name, u.email AS actor_email
       FROM tasks t
       JOIN teams tm ON tm.id = t.team_id
       JOIN users u ON u.id = t.user_id
       WHERE ${inMyTeams}
       ORDER BY t.created_at DESC, t.id DESC
       LIMIT 25`,
    )
    .all(userId) as unknown as TaskEventRow[]
  for (const row of taskAdds) {
    items.push({
      id: `task-added:${row.id}`,
      kind: 'task-added',
      createdAt: row.created_at,
      title: `${actorLabel(row.actor_id, row.actor_name, row.actor_email, userId)} added a task`,
      body: `Team task: “${shorten(row.task_text, 90)}”`,
      taskId: row.id,
      teamId: row.team_id,
      teamName: row.team_name,
      actorName: displayName(row.actor_name, row.actor_email),
    })
  }

  const completions = database
    .prepare(
      `SELECT t.id, t.team_id, tm.name AS team_name, t.text AS task_text, t.completed_at AS created_at,
              COALESCE(t.completed_by, t.user_id) AS actor_id,
              u.name AS actor_name, u.email AS actor_email
       FROM tasks t
       JOIN teams tm ON tm.id = t.team_id
       LEFT JOIN users u ON u.id = COALESCE(t.completed_by, t.user_id)
       WHERE ${inMyTeams} AND t.completed_at IS NOT NULL
       ORDER BY t.completed_at DESC, t.id DESC
       LIMIT 25`,
    )
    .all(userId) as unknown as TaskEventRow[]
  for (const row of completions) {
    items.push({
      id: `task-completed:${row.id}`,
      kind: 'task-completed',
      createdAt: row.created_at,
      title: `${actorLabel(row.actor_id, row.actor_name, row.actor_email, userId)} completed a task`,
      body: `“${shorten(row.task_text, 90)}”`,
      taskId: row.id,
      teamId: row.team_id,
      teamName: row.team_name,
      actorName: displayName(row.actor_name, row.actor_email),
    })
  }

  const comments = database
    .prepare(
      `SELECT c.id, c.task_id, t.team_id, tm.name AS team_name,
              c.text, t.text AS task_text, c.created_at,
              c.user_id AS actor_id, u.name AS actor_name, u.email AS actor_email
       FROM comments c
       JOIN tasks t ON t.id = c.task_id
       JOIN teams tm ON tm.id = t.team_id
       JOIN users u ON u.id = c.user_id
       WHERE ${inMyTeams}
       ORDER BY c.created_at DESC, c.id DESC
       LIMIT 25`,
    )
    .all(userId) as unknown as CommentRow[]
  for (const row of comments) {
    items.push({
      id: `comment:${row.id}`,
      kind: 'comment',
      createdAt: row.created_at,
      title: `${actorLabel(row.actor_id, row.actor_name, row.actor_email, userId)} commented`,
      body: `“${shorten(row.text, 110)}” on ${shorten(row.task_text, 60)}`,
      taskId: row.task_id,
      teamId: row.team_id,
      teamName: row.team_name,
      actorName: displayName(row.actor_name, row.actor_email),
    })
  }

  const assignments = database
    .prepare(
      `SELECT ta.task_id, t.team_id, tm.name AS team_name, t.text AS task_text,
              COALESCE(ta.assigned_at, t.created_at) AS created_at,
              COALESCE(ta.assigned_by, t.user_id) AS actor_id,
              actor.name AS actor_name, actor.email AS actor_email,
              target.id AS target_id, target.name AS target_name, target.email AS target_email
       FROM task_assignees ta
       JOIN tasks t ON t.id = ta.task_id
       JOIN teams tm ON tm.id = t.team_id
       LEFT JOIN users actor ON actor.id = COALESCE(ta.assigned_by, t.user_id)
       JOIN users target ON target.id = ta.user_id
       WHERE ${inMyTeams}
       ORDER BY created_at DESC, ta.task_id DESC
       LIMIT 25`,
    )
    .all(userId) as unknown as AssignmentRow[]
  for (const row of assignments) {
    const actor = actorLabel(row.actor_id, row.actor_name, row.actor_email, userId)
    const target = targetLabel(
      row.target_id,
      row.target_name,
      row.target_email,
      userId,
      row.actor_id,
    )
    items.push({
      id: `assignment:${row.task_id}`,
      kind: 'assignment',
      createdAt: row.created_at,
      title: `${actor} assigned ${target}`,
      body: `Team task: “${shorten(row.task_text, 80)}”`,
      taskId: row.task_id,
      teamId: row.team_id,
      teamName: row.team_name,
      actorName: displayName(row.actor_name, row.actor_email),
    })
  }

  const teamReminders = database
    .prepare(
      `SELECT r.id, r.task_id, t.team_id, tm.name AS team_name,
              t.text AS task_text, r.created_at,
              r.sender_id AS actor_id, u.name AS actor_name, u.email AS actor_email
       FROM task_reminders r
       JOIN tasks t ON t.id = r.task_id
       LEFT JOIN teams tm ON tm.id = t.team_id
       JOIN users u ON u.id = r.sender_id
       WHERE ${inMyTeams}
         AND NOT EXISTS (
           SELECT 1 FROM task_reminder_recipients rr
           WHERE rr.reminder_id = r.id AND rr.user_id = ?
         )
       ORDER BY r.created_at DESC, r.id DESC
       LIMIT 25`,
    )
    .all(userId, userId) as unknown as Array<ReminderRow & { team_id: string; actor_id: number }>
  for (const row of teamReminders) {
    const mine = row.actor_id === userId
    items.push({
      id: `team-reminder:${row.id}`,
      kind: 'team-reminder',
      createdAt: row.created_at,
      title: mine
        ? 'You sent a reminder'
        : `${actorLabel(row.actor_id, row.actor_name, row.actor_email, userId)} sent a reminder`,
      body: `Reminder for “${shorten(row.task_text, 90)}”`,
      taskId: row.task_id,
      teamId: row.team_id,
      teamName: row.team_name,
      actorName: mine ? null : displayName(row.actor_name, row.actor_email),
    })
  }

  return items
    .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))
    .slice(0, 100)
}
