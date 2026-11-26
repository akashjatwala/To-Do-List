import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import bcrypt from 'bcryptjs'
import { applyOffDayTaskMoves } from '../server/off-day-task-moves'
import { addDays, createOffDay, type OffDayKind } from '../server/ml/off-days'
import { localDateValue, type Recurrence } from '../server/recurrence'
import { skipTaskDate, type SkippableTaskRow } from '../server/task-skip-events'

/** A richer, repeatable team fixture for the isolated demo accounts. */
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
  id?: string
  teamId: string | null
  creator: string
  text: string
  due?: number | null
  priority?: Priority
  tags?: string[]
  duration?: number | null
  position?: number
  done?: boolean
  completedAt?: number | null
  completedBy?: string | null
  assignees?: string[]
  subtasks?: SubtaskSpec[]
  comments?: CommentSpec[]
  recurrence?: Recurrence
  recurrenceConfig?: string | null
}

/** Stable ids let a reseed replace its own schedule examples without touching user notes. */
const personalTaskIds = (prefix: string, person?: string) => {
  const base = person ? `${prefix}-${person}` : prefix
  return {
    skippedNote: `${base}-skipped-note`,
    skippedRepeat: `${base}-skipped-repeat`,
    offDayNote: `${base}-off-day-note`,
    offDayRepeat: `${base}-off-day-repeat`,
    plainNote: `${base}-one-off-note`,
  }
}

/** Stable ids for ordinary, non-repeating team tasks in each demo team. */
const teamOneOffIds = (prefix: string) => ({
  launch: `${prefix}-launch-one-off`,
  product: `${prefix}-product-one-off`,
  ops: `${prefix}-ops-one-off`,
  design: `${prefix}-design-one-off`,
})

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
  const leadTaskIds = personalTaskIds(prefix)
  const mateTaskIds = personalTaskIds(prefix, 'mate')
  const priyaTaskIds = personalTaskIds(prefix, 'priya')
  const oneOffTeamTaskIds = teamOneOffIds(prefix)
  const fixtureTaskIds = [leadTaskIds, mateTaskIds, priyaTaskIds].flatMap((ids) =>
    Object.values(ids),
  )
  let leadId = 0
  let mateId: number
  let priyaId: number
  let launchTaskId: string

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
        'DELETE FROM task_skip_events WHERE task_id IN (SELECT id FROM tasks WHERE team_id = ?)',
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
    leadId = upsertUser(lead)
    mateId = upsertUser(mate)
    priyaId = upsertUser(priya)
    const idFor = (email: string) => userIds.get(email) ?? leadId

    for (const userId of [leadId, mateId, priyaId]) {
      db.prepare("DELETE FROM off_days WHERE user_id = ? AND source = 'demo-fixture'").run(userId)
    }
    for (const id of Object.values(fixtureTaskIds)) {
      db.prepare('DELETE FROM task_skip_events WHERE task_id = ?').run(id)
      db.prepare('DELETE FROM tasks WHERE id = ?').run(id)
    }

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

    const addTask = (spec: TaskSpec): string => {
      const id = spec.id ?? randomUUID()
      const subtasks = spec.subtasks ?? []
      const doneCount = subtasks.filter((subtask) => subtask.done).length
      const progress = spec.done
        ? 100
        : subtasks.length > 0
          ? Math.round((doneCount / subtasks.length) * 100)
          : 0
      db.prepare(
        `INSERT INTO tasks (id, user_id, team_id, text, done, created_at, completed_at, completed_by,
                            due, position, progress, priority, tags, recurrence, recurrence_config,
                            duration)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        spec.recurrence ?? 'none',
        spec.recurrenceConfig ?? null,
        spec.duration ?? null,
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
      return id
    }

    // Launch Crew: active work, a completed history and two pending sends.
    launchTaskId = addTask({
      teamId: teamIds.launch,
      creator: lead.email,
      text: 'Ship onboarding refresh',
      due: atOffset(0, 15),
      priority: 'high',
      tags: ['launch', 'design'],
      duration: 90,
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
      id: oneOffTeamTaskIds.launch,
      teamId: teamIds.launch,
      creator: lead.email,
      text: 'Send launch status update',
      due: atOffset(0, 12),
      priority: 'medium',
      tags: ['launch', 'update'],
      duration: 20,
      position: 32,
      assignees: [lead.email, mate.email],
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
    addTask({
      teamId: teamIds.launch,
      creator: lead.email,
      text: 'Daily launch check',
      due: atOffset(1, 9),
      priority: 'low',
      tags: ['launch', 'habit'],
      duration: 15,
      position: 35,
      recurrence: 'daily',
      assignees: [lead.email],
    })
    addTask({
      id: `${prefix}-mate-off-day-team-note`,
      teamId: teamIds.launch,
      creator: mate.email,
      text: 'Draft launch FAQ',
      due: atOffset(4, 11),
      priority: 'medium',
      tags: ['launch'],
      duration: 45,
      position: 34,
      assignees: [mate.email, lead.email],
    })
    addTask({
      id: `${prefix}-mate-skipped-team-note`,
      teamId: teamIds.launch,
      creator: mate.email,
      text: 'Confirm launch assets',
      due: atOffset(3, 10),
      priority: 'medium',
      tags: ['launch'],
      duration: 30,
      position: 33,
      assignees: [mate.email, lead.email],
    })

    // Product Release: a heavier task with several assignees and a longer history.
    addTask({
      teamId: teamIds.product,
      creator: lead.email,
      text: 'Cut release 2.4',
      due: atOffset(1, 10),
      priority: 'high',
      tags: ['release', 'backend'],
      duration: 120,
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
      position: 50,
      assignees: [priya.email],
      subtasks: [
        { text: 'Document task routes', done: true, assignee: priya.email },
        { text: 'Add notification examples', assignee: lead.email },
      ],
    })
    addTask({
      id: oneOffTeamTaskIds.product,
      teamId: teamIds.product,
      creator: priya.email,
      text: 'Review release notes draft',
      due: atOffset(0, 14),
      priority: 'medium',
      tags: ['release', 'docs'],
      duration: 30,
      position: 44,
      assignees: [priya.email, lead.email],
    })
    addTask({
      id: `${prefix}-priya-off-day-team-note`,
      teamId: teamIds.product,
      creator: priya.email,
      text: 'Review localization notes',
      due: atOffset(8, 13),
      priority: 'medium',
      tags: ['release', 'docs'],
      duration: 45,
      position: 45,
      assignees: [priya.email, lead.email],
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
      id: oneOffTeamTaskIds.ops,
      teamId: teamIds.ops,
      creator: mate.email,
      text: 'Archive last week’s incident log',
      due: atOffset(3, 10),
      priority: 'low',
      tags: ['ops', 'handover'],
      duration: 25,
      position: 44,
      assignees: [mate.email, lead.email],
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
      position: 50,
      assignees: [priya.email],
      subtasks: [
        { text: 'Collect examples', done: true, assignee: priya.email },
        { text: 'Sketch three variants', assignee: mate.email },
      ],
    })
    addTask({
      id: oneOffTeamTaskIds.design,
      teamId: teamIds.design,
      creator: mate.email,
      text: 'Collect onboarding screenshots',
      due: atOffset(3, 11),
      priority: 'low',
      tags: ['design'],
      duration: 30,
      position: 44,
      assignees: [mate.email, priya.email],
    })
    db.prepare('INSERT INTO team_invites (team_id, email, invited_by, created_at) VALUES (?, ?, ?, ?)').run(
      teamIds.design,
      lead.email,
      mateId,
      atOffset(-1, 11),
    )

    const personalExamples: Array<{
      id: string
      creator: string
      text: string
      due: number
      recurrence: Recurrence
    }> = [
      { id: leadTaskIds.plainNote, creator: lead.email, text: 'Pay electricity bill', due: atOffset(0, 18), recurrence: 'none' },
      { id: leadTaskIds.skippedNote, creator: lead.email, text: 'Skipped personal note', due: atOffset(0, 9, 30), recurrence: 'none' },
      { id: leadTaskIds.skippedRepeat, creator: lead.email, text: 'Skipped daily habit', due: atOffset(0, 8), recurrence: 'daily' },
      { id: leadTaskIds.offDayNote, creator: lead.email, text: 'Off-day moved note', due: atOffset(1, 14), recurrence: 'none' },
      { id: leadTaskIds.offDayRepeat, creator: lead.email, text: 'Off-day daily check', due: atOffset(1, 7, 30), recurrence: 'daily' },
      { id: mateTaskIds.plainNote, creator: mate.email, text: 'Book dentist follow-up', due: atOffset(0, 16), recurrence: 'none' },
      { id: mateTaskIds.skippedNote, creator: mate.email, text: 'Mate skipped note', due: atOffset(3, 9, 30), recurrence: 'none' },
      { id: mateTaskIds.skippedRepeat, creator: mate.email, text: 'Mate skipped habit', due: atOffset(3, 8), recurrence: 'daily' },
      { id: mateTaskIds.offDayNote, creator: mate.email, text: 'Mate off-day note', due: atOffset(4, 14), recurrence: 'none' },
      { id: mateTaskIds.offDayRepeat, creator: mate.email, text: 'Mate off-day check', due: atOffset(4, 7, 30), recurrence: 'daily' },
      { id: priyaTaskIds.plainNote, creator: priya.email, text: 'Renew design licence', due: atOffset(0, 15), recurrence: 'none' },
      { id: priyaTaskIds.skippedNote, creator: priya.email, text: 'Priya skipped note', due: atOffset(7, 9, 30), recurrence: 'none' },
      { id: priyaTaskIds.skippedRepeat, creator: priya.email, text: 'Priya skipped habit', due: atOffset(7, 8), recurrence: 'daily' },
      { id: priyaTaskIds.offDayNote, creator: priya.email, text: 'Priya off-day note', due: atOffset(8, 14), recurrence: 'none' },
      { id: priyaTaskIds.offDayRepeat, creator: priya.email, text: 'Priya off-day check', due: atOffset(8, 7, 30), recurrence: 'daily' },
    ]
    for (const example of personalExamples) {
      addTask({
        id: example.id,
        teamId: null,
        creator: example.creator,
        text: example.text,
        due: example.due,
        recurrence: example.recurrence,
        priority: 'medium',
        tags: ['demo'],
        duration: 30,
        position: 10,
      })
    }

    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }

  seedScheduleExamples(db, {
    lead: { id: leadId, taskIds: leadTaskIds, launchTaskId },
    mate: { id: mateId, taskIds: mateTaskIds, skippedTeamTaskId: `${prefix}-mate-skipped-team-note` },
    priya: { id: priyaId, taskIds: priyaTaskIds },
  })
}

/**
 * Off-day and skip rows that make the new behaviour visible in demo accounts.
 *
 * Each demo member gets a separate off period so signing in as any of them shows
 * their own moved notes and the teammates' off-day notices. This runs after the
 * main fixture transaction because the skip store writes its own transaction.
 */
interface SchedulePerson {
  id: number
  taskIds: ReturnType<typeof personalTaskIds>
}

function seedScheduleExamples(
  db: DatabaseSync,
  people: {
    lead: SchedulePerson & { launchTaskId: string }
    mate: SchedulePerson & { skippedTeamTaskId: string }
    priya: SchedulePerson
  },
): void {
  const today = localDateValue(Date.now())
  const periods = [
    {
      userId: people.lead.id,
      startDate: addDays(today, 1),
      endDate: addDays(today, 2),
      kind: 'travel' as OffDayKind,
      note: null,
    },
    {
      userId: people.mate.id,
      startDate: addDays(today, 4),
      endDate: addDays(today, 5),
      kind: 'sick' as OffDayKind,
      note: null,
    },
    {
      userId: people.priya.id,
      startDate: addDays(today, 8),
      endDate: addDays(today, 9),
      kind: 'holiday' as OffDayKind,
      note: null,
    },
  ]

  for (const period of periods) {
    const existing = db
      .prepare('SELECT id FROM off_days WHERE user_id = ? AND start_date = ? AND end_date = ? ORDER BY id LIMIT 1')
      .get(period.userId, period.startDate, period.endDate) as { id: number } | undefined
    if (!existing) {
      createOffDay(db, period.userId, period, 'demo-fixture')
    } else {
      // Reseeding must also clear the old explanatory note from existing demo rows.
      db.prepare('UPDATE off_days SET note = ? WHERE id = ?').run(period.note, existing.id)
    }
  }
  for (const period of periods) {
    applyOffDayTaskMoves(db, period.userId)
  }

  const load = (id: string) =>
    db
      .prepare('SELECT id, done, due, recurrence, recurrence_config FROM tasks WHERE id = ?')
      .get(id) as SkippableTaskRow | undefined
  const skip = (id: string, userId: number, date: string) => {
    const task = load(id)
    if (task) skipTaskDate(db, task, userId, date)
  }

  skip(people.lead.launchTaskId, people.lead.id, today)
  skip(people.lead.taskIds.skippedNote, people.lead.id, today)
  skip(people.lead.taskIds.skippedRepeat, people.lead.id, today)

  const mateSkipDate = addDays(today, 3)
  skip(people.mate.skippedTeamTaskId, people.mate.id, mateSkipDate)
  skip(people.mate.taskIds.skippedNote, people.mate.id, mateSkipDate)
  skip(people.mate.taskIds.skippedRepeat, people.mate.id, mateSkipDate)

  const priyaSkipDate = addDays(today, 7)
  skip(people.priya.taskIds.skippedNote, people.priya.id, priyaSkipDate)
  skip(people.priya.taskIds.skippedRepeat, people.priya.id, priyaSkipDate)
}
