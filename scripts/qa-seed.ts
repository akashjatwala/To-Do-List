import { randomUUID } from 'node:crypto'
import bcrypt from 'bcryptjs'
import { db } from '../server/db'

/**
 * Small, repeatable QA fixture for browser and API checks. It writes only to a
 * dedicated QA database (see the npm script) so the live app data is untouched.
 */
const LEAD = 'qa-lead@example.com'
const MATE = 'qa-mate@example.com'
const PASSWORD = 'qa12345'
const TEAM_ID = 'qa-crew'

function todayAt(hour: number, minute = 0): number {
  const date = new Date()
  date.setHours(hour, minute, 0, 0)
  return date.getTime()
}

function upsertUser(email: string, name: string, hash: string): number {
  db.prepare('DELETE FROM users WHERE email = ?').run(email)
  const result = db
    .prepare(
      'INSERT INTO users (email, name, password_hash, created_at) VALUES (?, ?, ?, ?)',
    )
    .run(email, name, hash, Date.now())
  return Number(result.lastInsertRowid)
}

function main() {
  const hash = bcrypt.hashSync(PASSWORD, 10)
  const now = Date.now()

  db.exec('BEGIN')
  try {
    db.prepare('DELETE FROM teams WHERE id = ?').run(TEAM_ID)
    const leadId = upsertUser(LEAD, 'QA Lead', hash)
    const mateId = upsertUser(MATE, 'QA Mate', hash)

    db.prepare(
      'INSERT INTO teams (id, name, created_by, created_at) VALUES (?, ?, ?, ?)',
    ).run(TEAM_ID, 'QA Crew', leadId, now)
    for (const [userId, role] of [
      [leadId, 'host'],
      [mateId, 'member'],
    ] as const) {
      db.prepare(
        'INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)',
      ).run(TEAM_ID, userId, role, now)
    }

    const personal = randomUUID()
    db.prepare(
      `INSERT INTO tasks (id, user_id, team_id, text, created_at, due, priority, tags, duration, preferred_time)
       VALUES (?, ?, NULL, ?, ?, ?, 'high', ?, 30, '09:00')`,
    ).run(personal, leadId, 'Write the QA checklist', now, todayAt(9), JSON.stringify(['qa']))

    const sharedTasks = [
      ['Review the release notes', 'high', 15, 0, 60, '15:00', ['release'], true],
      ['Draft launch checklist', 'medium', 11, 30, 45, '11:30', ['launch'], false],
      ['Update API docs', 'low', 16, 30, 30, '16:30', ['docs'], false],
    ] as const
    let shared = ''
    for (const [text, priority, hour, minute, duration, preferred, tags, assignMate] of sharedTasks) {
      const id = randomUUID()
      db.prepare(
        `INSERT INTO tasks (id, user_id, team_id, text, created_at, due, priority, tags, duration, preferred_time)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        leadId,
        TEAM_ID,
        text,
        now,
        todayAt(hour, minute),
        priority,
        JSON.stringify(tags),
        duration,
        preferred,
      )
      if (assignMate) {
        db.prepare(
          'INSERT INTO task_assignees (task_id, user_id, assigned_at, assigned_by) VALUES (?, ?, ?, ?)',
        ).run(id, mateId, now, leadId)
      }
      if (text === 'Review the release notes') shared = id
    }
    db.prepare(
      'INSERT INTO comments (id, task_id, user_id, text, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run(randomUUID(), shared, leadId, '@QA Mate please check the examples.', now + 1000)

    const done = randomUUID()
    db.prepare(
      `INSERT INTO tasks (id, user_id, team_id, text, created_at, done, completed_at, completed_by)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
    ).run(done, mateId, TEAM_ID, 'Set up the QA board', now, now + 2000, mateId)

    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }

  console.log('QA database seeded.')
  console.log(`  ${LEAD} / ${PASSWORD} (host)`)
  console.log(`  ${MATE} / ${PASSWORD} (member)`)
  console.log('  Team: QA Crew')
}

main()
