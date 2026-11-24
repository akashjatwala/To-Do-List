import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import bcrypt from 'bcryptjs'

/** A richer, repeatable team fixture shared by the demo seed and screenshots. */
export interface FixtureOptions {
  db: DatabaseSync
  prefix: string
  password: string
  lead: { email: string; name: string }
  mate: { email: string; name: string }
  priya: { email: string; name: string }
  legacyTeamIds?: string[]
}

type Priority = 'none' | 'low' | 'medium' | 'high'

interface SubtaskSpec {
  text: string
  done?: boolean
  assignee?: string
}

interface CommentSpec {
  author: string
  text: string
  at: number
}

interface TaskSpec {
  teamId: string
  creator: string
  text: string
  due?: number | null
  priority?: Priority
  tags?: string[]
  duration?: number | null
  preferredTime?: string | null
  position?: number
  done?: boolean
  completedAt?: number | null
  completedBy?: string | null
  assignees?: string[]
  subtasks?: SubtaskSpec[]
  comments?: CommentSpec[]
}

function atOffset(days: number, hour = 9, minute = 0): number {
  const date = new Date()
  date.setDate(date.getDate() + days)
  date.setHours(hour, minute, 0, 0)
  return date.getTime()
}

export function seedRichTeams({
  db,
  prefix,
  password,
  lead,
  mate,
  priya,
  legacyTeamIds = [],
}: FixtureOptions): void {
  const teamIds = {
    launch: `${prefix}-launch-crew`,
    product: `${prefix}-product-release`,
    ops: `${prefix}-ops-hub`,
    design: `${prefix}-design-guild`,
  }
  const allTeamIds = [...Object.values(teamIds), ...legacyTeamIds]
  const hash = bcrypt.hashSync(password, 10)
  const now = Date.now()
  const userIds = new Map<string, number>()

  db.exec('BEGIN')
  try {
    for (const teamId of allTeamIds) {
      db.prepare(
        'DELETE FROM task_reminder_recipients WHERE reminder_id IN (SELECT id FROM task_reminders WHERE task_id IN (SELECT id FROM tasks WHERE team_id = ?))',
      ).run(teamId)
      db.prepare(
        'DELETE FROM task_reminders WHERE task_id IN (SELECT id FROM tasks WHERE team_id = ?)',
      ).run(teamId)
      db.prepare(
        'DELETE FROM comments WHERE task_id IN (SELECT id FROM tasks WHERE team_id = ?)',
      ).run(teamId)
      db.prepare(
        'DELETE FROM task_assignees WHERE task_id IN (SELECT id FROM tasks WHERE team_id = ?)',
      ).run(teamId)
      db.prepare(
        'DELETE FROM subtasks WHERE task_id IN (SELECT id FROM tasks WHERE team_id = ?)',
      ).run(teamId)
      db.prepare('DELETE FROM tasks WHERE team_id = ?').run(teamId)
      db.prepare('DELETE FROM team_invites WHERE team_id = ?').run(teamId)
      db.prepare('DELETE FROM team_members WHERE team_id = ?').run(teamId)
      db.prepare('DELETE FROM teams WHERE id = ?').run(teamId)
    }

    const upsertUser = (person: { email: string; name: string }) => {
      const row = db.prepare('SELECT id FROM users WHERE email = ?').get(person.email) as
        | { id: number }
        | undefined
      const id = row
        ? (db
            .prepare('UPDATE users SET name = ?, password_hash = ? WHERE id = ?')
            .run(person.name, hash, row.id),
          row.id)
        : Number(
            db
              .prepare(
                'INSERT INTO users (email, name, password_hash, created_at) VALUES (?, ?, ?, ?)',
              )
              .run(person.email, person.name, hash, now).lastInsertRowid,
          )
      userIds.set(person.email, id)
      return id
    }
    const leadId = upsertUser(lead)
    const mateId = upsertUser(mate)
    const priyaId = upsertUser(priya)
    const idFor = (email: string) => userIds.get(email) ?? leadId

    const addTeam = (
      id: string,
      name: string,
      hostId: number,
      members: Array<[number, 'host' | 'member']>,
      createdAt: number,
    ) => {
      db.prepare('INSERT INTO teams (id, name, created_by, created_at) VALUES (?, ?, ?, ?)').run(
        id,
        name,
        hostId,
        createdAt,
      )
      for (const [userId, role] of members) {
        db.prepare(
          'INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)',
        ).run(id, userId, role, createdAt)
      }
    }

    addTeam(
      teamIds.launch,
      'Launch Crew',
      leadId,
      [
        [leadId, 'host'],
        [mateId, 'member'],
        [priyaId, 'member'],
      ],
      atOffset(-21),
    )
    addTeam(
      teamIds.product,
      'Product Release',
      leadId,
      [
        [leadId, 'host'],
        [priyaId, 'member'],
      ],
      atOffset(-14),
    )
    addTeam(
      teamIds.ops,
      'Ops Hub',
      priyaId,
      [
        [priyaId, 'host'],
        [leadId, 'member'],
        [mateId, 'member'],
      ],
      atOffset(-9),
    )
    addTeam(
      teamIds.design,
      'Design Guild',
      mateId,
      [
        [mateId, 'host'],
        [priyaId, 'member'],
      ],
      atOffset(-6),
    )

    const addTask = (spec: TaskSpec) => {
      const id = randomUUID()
      const subtasks = spec.subtasks ?? []
      const doneCount = subtasks.filter((subtask) => subtask.done).length
      const progress = spec.done
        ? 100
        : subtasks.length > 0
          ? Math.round((doneCount / subtasks.length) * 100)
          : 0
      db.prepare(
        `INSERT INTO tasks (id, user_id, team_id, text, done, created_at, completed_at, completed_by,
                            due, position, progress, priority, tags, recurrence, duration, preferred_time)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'none', ?, ?)`,
      ).run(
        id,
        idFor(spec.creator),
        spec.teamId,
        spec.text,
        spec.done ? 1 : 0,
        atOffset(-7),
        spec.completedAt ?? null,
        spec.completedBy ? idFor(spec.completedBy) : null,
        spec.due ?? null,
        spec.position ?? 0,
        progress,
        spec.priority ?? 'none',
        JSON.stringify(spec.tags ?? []),
        spec.duration ?? null,
        spec.preferredTime ?? null,
      )

      for (const [index, subtask] of subtasks.entries()) {
        db.prepare(
          'INSERT INTO subtasks (id, task_id, text, done, position, assignee_id) VALUES (?, ?, ?, ?, ?, ?)',
        ).run(
          randomUUID(),
          id,
          subtask.text,
          subtask.done ? 1 : 0,
          index,
          subtask.assignee ? idFor(subtask.assignee) : null,
        )
      }
      for (const assignee of spec.assignees ?? []) {
        db.prepare(
          'INSERT INTO task_assignees (task_id, user_id, assigned_at, assigned_by) VALUES (?, ?, ?, ?)',
        ).run(id, idFor(assignee), atOffset(-5, 10), idFor(spec.creator))
      }
      for (const comment of spec.comments ?? []) {
        db.prepare(
          'INSERT INTO comments (id, task_id, user_id, text, created_at) VALUES (?, ?, ?, ?, ?)',
        ).run(randomUUID(), id, idFor(comment.author), comment.text, comment.at)
      }
    }

    // Launch Crew: active work, a completed history and two pending sends.
    addTask({
      teamId: teamIds.launch,
      creator: lead.email,
      text: 'Ship onboarding refresh',
      due: atOffset(0, 15),
      priority: 'high',
      tags: ['launch', 'design'],
      duration: 90,
      preferredTime: '15:00',
      position: 50,
      assignees: [lead.email, mate.email],
      subtasks: [
        { text: 'Approve final copy', done: true, assignee: lead.email },
        { text: 'Build release checklist', done: true, assignee: priya.email },
        { text: 'QA mobile layout', assignee: mate.email },
        { text: 'Publish launch note', assignee: lead.email },
      ],
      comments: [
        { author: priya.email, text: 'Added the latest copy to the shared doc.', at: atOffset(-2, 11) },
        { author: lead.email, text: 'Mobile layout is the last real blocker.', at: atOffset(-1, 16) },
        {
          author: mate.email,
          text: `@${lead.name} I can take the QA pass today.`,
          at: atOffset(0, 9, 30),
        },
      ],
    })
    addTask({
      teamId: teamIds.launch,
      creator: lead.email,
      text: 'Finalise launch checklist',
      due: atOffset(0, 11, 30),
      priority: 'medium',
      tags: ['launch'],
      duration: 45,
      preferredTime: '11:30',
      position: 40,
      assignees: [priya.email],
      subtasks: [
        { text: 'Draft checklist', done: true, assignee: priya.email },
        { text: 'Review with support', assignee: mate.email },
        { text: 'Sign off', assignee: lead.email },
      ],
      comments: [
        {
          author: lead.email,
          text: `@${priya.name} can you confirm the sign-off owner?`,
          at: atOffset(-1, 14),
        },
      ],
    })
    addTask({
      teamId: teamIds.launch,
      creator: mate.email,
      text: 'Book launch retro',
      due: atOffset(-3, 16),
      priority: 'low',
      tags: ['retro'],
      position: 30,
      done: true,
      completedAt: atOffset(-3, 16, 30),
      completedBy: mate.email,
      assignees: [mate.email],
      comments: [
        { author: mate.email, text: 'Retro notes are in the shared doc.', at: atOffset(-3, 16, 10) },
      ],
    })
    addTask({
      teamId: teamIds.launch,
      creator: lead.email,
      text: 'Share kickoff recap',
      due: atOffset(-6, 10),
      priority: 'none',
      tags: ['launch'],
      position: 20,
      done: true,
      completedAt: atOffset(-6, 10, 20),
      completedBy: lead.email,
    })
    db.prepare('INSERT INTO team_invites (team_id, email, invited_by, created_at) VALUES (?, ?, ?, ?)').run(
      teamIds.launch,
      'sam.lee@example.com',
      leadId,
      atOffset(-2, 12),
    )
    db.prepare('INSERT INTO team_invites (team_id, email, invited_by, created_at) VALUES (?, ?, ?, ?)').run(
      teamIds.launch,
      'contractor@example.com',
      leadId,
      atOffset(-5, 9),
    )

    // Product Release: a heavier task with several assignees and a longer history.
    addTask({
      teamId: teamIds.product,
      creator: lead.email,
      text: 'Cut release 2.4',
      due: atOffset(1, 10),
      priority: 'high',
      tags: ['release', 'backend'],
      duration: 120,
      preferredTime: '10:00',
      position: 60,
      assignees: [lead.email, priya.email],
      subtasks: [
        { text: 'Freeze scope', done: true, assignee: lead.email },
        { text: 'Run migration', done: true, assignee: priya.email },
        { text: 'Smoke test staging', assignee: lead.email },
        { text: 'Tag the release', assignee: priya.email },
      ],
      comments: [
        { author: priya.email, text: 'Migration is green on staging.', at: atOffset(-1, 15) },
        { author: lead.email, text: 'Smoke test is booked for tomorrow.', at: atOffset(0, 8, 45) },
      ],
    })
    addTask({
      teamId: teamIds.product,
      creator: priya.email,
      text: 'Update API docs',
      due: atOffset(0, 16, 30),
      priority: 'medium',
      tags: ['docs'],
      duration: 30,
      preferredTime: '16:30',
      position: 50,
      assignees: [priya.email],
      subtasks: [
        { text: 'Document task routes', done: true, assignee: priya.email },
        { text: 'Add notification examples', assignee: lead.email },
      ],
    })
    addTask({
      teamId: teamIds.product,
      creator: lead.email,
      text: 'Freeze scope for 2.4',
      due: atOffset(-4, 12),
      priority: 'medium',
      tags: ['release'],
      position: 40,
      done: true,
      completedAt: atOffset(-4, 12, 30),
      completedBy: lead.email,
      comments: [
        { author: lead.email, text: 'Scope is locked; new requests go to 2.5.', at: atOffset(-4, 12, 10) },
      ],
    })
    db.prepare('INSERT INTO team_invites (team_id, email, invited_by, created_at) VALUES (?, ?, ?, ?)').run(
      teamIds.product,
      'release-qa@example.com',
      leadId,
      atOffset(-3, 13),
    )

    // Ops Hub: hosted by a teammate, so the lead sees membership without sent invites.
    addTask({
      teamId: teamIds.ops,
      creator: priya.email,
      text: 'Rotate on-call notes',
      due: atOffset(0, 17),
      priority: 'medium',
      tags: ['ops', 'handover'],
      duration: 30,
      preferredTime: '17:00',
      position: 50,
      assignees: [lead.email, mate.email],
      subtasks: [
        { text: 'Summarise incidents', done: true, assignee: mate.email },
        { text: 'Update runbook', assignee: lead.email },
        { text: 'Share handover', assignee: mate.email },
      ],
      comments: [
        {
          author: priya.email,
          text: `@${lead.name} please review the runbook before handover.`,
          at: atOffset(-1, 10),
        },
        {
          author: lead.email,
          text: `@${mate.name} can you own the handover notes?`,
          at: atOffset(0, 9, 15),
        },
      ],
    })
    addTask({
      teamId: teamIds.ops,
      creator: mate.email,
      text: 'Patch staging alerts',
      due: atOffset(-2, 9),
      priority: 'high',
      tags: ['ops'],
      position: 40,
      done: true,
      completedAt: atOffset(-2, 11),
      completedBy: mate.email,
      assignees: [mate.email],
    })

    // Design Guild: not joined yet, but an incoming invitation is waiting for the lead.
    addTask({
      teamId: teamIds.design,
      creator: mate.email,
      text: 'Refresh empty states',
      due: atOffset(2, 14),
      priority: 'low',
      tags: ['design'],
      duration: 60,
      preferredTime: '14:00',
      position: 50,
      assignees: [priya.email],
      subtasks: [
        { text: 'Collect examples', done: true, assignee: priya.email },
        { text: 'Sketch three variants', assignee: mate.email },
      ],
    })
    db.prepare('INSERT INTO team_invites (team_id, email, invited_by, created_at) VALUES (?, ?, ?, ?)').run(
      teamIds.design,
      lead.email,
      mateId,
      atOffset(-1, 11),
    )

    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
