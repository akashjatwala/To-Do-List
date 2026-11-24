import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import bcrypt from 'bcryptjs'
import { db } from '../server/db'
import { bootstrap } from '../server/data'
import { notificationsFor } from '../server/notifications'

/**
 * Standalone performance smoke test. It seeds a disposable database with a
 * realistic number of tasks and reports bootstrap/notification timings without
 * asserting hard thresholds, which would be flaky across machines.
 */
const EMAIL = 'perf@example.com'
const count = Number(process.env.PERF_TASKS ?? 5000)
if (!Number.isInteger(count) || count < 1) throw new Error('PERF_TASKS must be a positive integer.')

function timed<T>(label: string, run: () => T): T {
  const start = performance.now()
  const result = run()
  const ms = performance.now() - start
  console.log(`  ${label}: ${ms.toFixed(1)} ms`)
  return result
}

function main() {
  const now = Date.now()
  const hash = bcrypt.hashSync('perf12345', 10)

  db.exec('BEGIN')
  let userId = 0
  try {
    db.prepare('DELETE FROM users WHERE email = ?').run(EMAIL)
    const user = db
      .prepare('INSERT INTO users (email, name, password_hash, created_at) VALUES (?, ?, ?, ?)')
      .run(EMAIL, 'Perf User', hash, now)
    userId = Number(user.lastInsertRowid)

    const insertTask = db.prepare(
      `INSERT INTO tasks (id, user_id, team_id, text, created_at, due, position, priority, tags)
       VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
    )
    const insertSubtask = db.prepare(
      'INSERT INTO subtasks (id, task_id, text, done, position) VALUES (?, ?, ?, 0, 0)',
    )
    for (let index = 0; index < count; index += 1) {
      const id = randomUUID()
      const due = index % 3 === 0 ? now + (index % 28) * 86_400_000 : null
      insertTask.run(
        id,
        userId,
        `Perf task ${index + 1}`,
        now - (count - index) * 60_000,
        due,
        index,
        index % 7 === 0 ? 'high' : 'none',
        JSON.stringify(index % 5 === 0 ? ['perf'] : []),
      )
      if (index % 10 === 0) insertSubtask.run(randomUUID(), id, 'Check the details')
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }

  console.log(`Performance check with ${count} tasks:`)
  const data = timed('bootstrap', () => bootstrap(userId))
  const notifications = timed('notificationsFor', () => notificationsFor(userId))
  console.log(`  tasks returned: ${data?.tasks.length ?? 0}`)
  console.log(`  notifications returned: ${notifications.length}`)
  db.close()
}

main()
