import type { DatabaseSync } from 'node:sqlite'
import { db } from './db'

export interface ReminderRecipientDTO {
  id: number
  email: string
  name: string
}

export interface ReminderDTO {
  id: number
  taskId: string
  taskText: string
  senderId: number
  createdAt: number
  recipients: ReminderRecipientDTO[]
}

interface ReminderRow {
  id: number
  task_id: string
  task_text: string
  sender_id: number
  created_at: number
}

interface RecipientRow {
  reminder_id: number
  id: number
  email: string
  name: string
}

function displayName(row: { email: string; name: string }): string {
  return row.name.trim() || row.email.split('@')[0]
}

/**
 * Who gets a team reminder. Assigned teammates take priority; an unassigned
 * team task broadcasts to every current member of that team. Personal tasks
 * keep an empty recipient list — the reminder is only a local card entry.
 */
export function reminderRecipients(taskId: string, database: DatabaseSync = db): number[] {
  const task = database.prepare('SELECT team_id FROM tasks WHERE id = ?').get(taskId) as unknown as
    | { team_id: string | null }
    | undefined
  if (!task || task.team_id === null) return []

  const assigned = (
    database
      .prepare('SELECT user_id FROM task_assignees WHERE task_id = ? ORDER BY user_id')
      .all(taskId) as unknown as Array<{ user_id: number }>
  ).map((row) => row.user_id)
  const source = assigned.length
    ? assigned
    : (
        database
          .prepare('SELECT user_id FROM team_members WHERE team_id = ? ORDER BY user_id')
          .all(task.team_id) as unknown as Array<{ user_id: number }>
      ).map((row) => row.user_id)

  return [...new Set(source)].sort((a, b) => a - b)
}

export function reminderFor(id: number, database: DatabaseSync = db): ReminderDTO | null {
  const row = database
    .prepare(
      `SELECT r.id, r.task_id, t.text AS task_text, r.sender_id, r.created_at
       FROM task_reminders r JOIN tasks t ON t.id = r.task_id
       WHERE r.id = ?`,
    )
    .get(id) as unknown as ReminderRow | undefined
  if (!row) return null

  const recipients = database
    .prepare(
      `SELECT rr.reminder_id, u.id, u.email, u.name
       FROM task_reminder_recipients rr
       JOIN users u ON u.id = rr.user_id
       WHERE rr.reminder_id = ?
       ORDER BY u.name ASC, u.email ASC`,
    )
    .all(id) as unknown as RecipientRow[]
  const byReminder = new Map<number, ReminderRecipientDTO[]>()
  for (const recipient of recipients) {
    const list = byReminder.get(recipient.reminder_id) ?? []
    list.push({
      id: recipient.id,
      email: recipient.email,
      name: displayName(recipient),
    })
    byReminder.set(recipient.reminder_id, list)
  }

  return {
    id: row.id,
    taskId: row.task_id,
    taskText: row.task_text,
    senderId: row.sender_id,
    createdAt: row.created_at,
    recipients: byReminder.get(row.id) ?? [],
  }
}

/** Persist one reminder and return the full DTO for the Overdue card. */
export function createReminder(
  taskId: string,
  senderId: number,
  database: DatabaseSync = db,
): ReminderDTO | null {
  const task = database.prepare('SELECT done FROM tasks WHERE id = ?').get(taskId) as unknown as
    | { done: number }
    | undefined
  if (!task || task.done === 1) return null

  const recipients = reminderRecipients(taskId, database)
  const add = database.prepare(
    'INSERT OR IGNORE INTO task_reminder_recipients (reminder_id, user_id) VALUES (?, ?)',
  )
  let reminderId: number
  database.exec('BEGIN')
  try {
    const result = database
      .prepare('INSERT INTO task_reminders (task_id, sender_id, created_at) VALUES (?, ?, ?)')
      .run(taskId, senderId, Date.now())
    reminderId = Number(result.lastInsertRowid)
    for (const recipient of recipients) add.run(reminderId, recipient)
    database.exec('COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }

  return reminderFor(reminderId, database)
}

/** Reminders for tasks the signed-in user can see, newest first. */
export function remindersFor(userId: number, database: DatabaseSync = db): ReminderDTO[] {
  const rows = database
    .prepare(
      `SELECT r.id, r.task_id, t.text AS task_text, r.sender_id, r.created_at
       FROM task_reminders r
       JOIN tasks t ON t.id = r.task_id
       WHERE (t.team_id IS NULL AND t.user_id = ?)
          OR t.team_id IN (SELECT team_id FROM team_members WHERE user_id = ?)
       ORDER BY r.created_at DESC, r.id DESC
       LIMIT 100`,
    )
    .all(userId, userId) as unknown as ReminderRow[]
  if (rows.length === 0) return []

  const ids = rows.map((row) => row.id)
  const placeholders = ids.map(() => '?').join(', ')
  const recipientRows = database
    .prepare(
      `SELECT rr.reminder_id, u.id, u.email, u.name
       FROM task_reminder_recipients rr
       JOIN users u ON u.id = rr.user_id
       WHERE rr.reminder_id IN (${placeholders})
       ORDER BY u.name ASC, u.email ASC`,
    )
    .all(...ids) as unknown as RecipientRow[]

  const byReminder = new Map<number, ReminderRecipientDTO[]>()
  for (const recipient of recipientRows) {
    const list = byReminder.get(recipient.reminder_id) ?? []
    list.push({
      id: recipient.id,
      email: recipient.email,
      name: displayName(recipient),
    })
    byReminder.set(recipient.reminder_id, list)
  }

  return rows.map((row) => ({
    id: row.id,
    taskId: row.task_id,
    taskText: row.task_text,
    senderId: row.sender_id,
    createdAt: row.created_at,
    recipients: byReminder.get(row.id) ?? [],
  }))
}
