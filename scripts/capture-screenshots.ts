import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, unlinkSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { chromium } from '@playwright/test'
import { seedRichTeams } from './fixture-data'

/**
 * Regenerates the README screenshots from a disposable seeded database.
 * Run `npm run docs:screenshots`; it never touches server/data/todo.db.
 */
const PORT = 3102
const BASE_URL = `http://127.0.0.1:${PORT}`
const OUTPUT_DIR = resolve('docs/screenshots')

const LEAD = 'qa-lead@example.com'
const MATE = 'qa-mate@example.com'
const PASSWORD = 'qa12345'

function resetDatabase() {
  const target = resolve(process.cwd(), process.env.DUIT_DB_PATH ?? '')
  const name = basename(target)
  if (!/\.(qa|perf|test)\.db$/.test(name)) {
    throw new Error(`Refusing to reset ${name || 'an empty path'} for screenshots.`)
  }
  for (const file of [target, `${target}-wal`, `${target}-shm`]) {
    if (existsSync(file)) unlinkSync(file)
  }
}

function localDate(): string {
  const now = new Date()
  const month = `${now.getMonth() + 1}`.padStart(2, '0')
  const day = `${now.getDate()}`.padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

resetDatabase()

const { db } = await import('../server/db')

seedRichTeams({
  db,
  prefix: 'shot',
  password: PASSWORD,
  lead: { email: LEAD, name: 'QA Lead' },
  mate: { email: MATE, name: 'QA Mate' },
  priya: { email: 'qa-priya@example.com', name: 'QA Priya' },
})
mkdirSync(OUTPUT_DIR, { recursive: true })

const server: ChildProcess = spawn(
  process.execPath,
  ['--import', 'tsx', 'server/start.ts'],
  {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(PORT),
      NODE_ENV: 'development',
      ML_DISABLE_SCHEDULER: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
)
server.stdout?.on('data', (chunk: Buffer) => process.stdout.write(`[server] ${chunk}`))
server.stderr?.on('data', (chunk: Buffer) => process.stderr.write(`[server] ${chunk}`))

async function waitForHealth() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`${BASE_URL}/api/health`)
      if (response.ok) return
    } catch {
      // Server is still starting.
    }
    await new Promise((done) => setTimeout(done, 250))
  }
  throw new Error('Screenshot server did not become healthy.')
}

let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined

try {
  await waitForHealth()
  browser = await chromium.launch({ channel: 'chrome', headless: true })

  async function login(email: string) {
    const context = await browser!.newContext({
      viewport: { width: 1440, height: 1000 },
      deviceScaleFactor: 2,
    })
    const page = await context.newPage()
    await page.goto(BASE_URL)
    await page.getByLabel('Email').fill(email)
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD)
    await page.getByRole('button', { name: 'Log in' }).click()
    await page.getByText('Tasks and plan').waitFor()

    const skipped = await page.request.post(`${BASE_URL}/api/checkins/skip`, {
      data: { date: localDate() },
    })
    if (!skipped.ok()) throw new Error(`Could not skip check-in for ${email}.`)
    await page.reload()
    await page.getByText('Tasks and plan').waitFor()
    return { context, page }
  }

  const lead = await login(LEAD)
  await lead.page.screenshot({ path: resolve(OUTPUT_DIR, 'board.png') })

  await lead.page.getByRole('button', { name: 'Teams' }).click()
  await lead.page.getByRole('button', { name: /Launch Crew/ }).first().waitFor()
  await lead.page.screenshot({ path: resolve(OUTPUT_DIR, 'teams.png') })

  await lead.page.getByText('Ship onboarding refresh', { exact: true }).click()
  const details = lead.page.getByRole('dialog', { name: 'Task details' })
  await details.waitFor()
  await lead.page.screenshot({ path: resolve(OUTPUT_DIR, 'task-details.png') })

  const mate = await login(MATE)
  await mate.page.getByRole('button', { name: 'Notifications' }).first().click()
  const notifications = mate.page.getByRole('dialog', { name: 'Notifications' })
  await notifications.waitFor()
  await notifications.getByText(/mentioned you/).waitFor()
  await mate.page.screenshot({ path: resolve(OUTPUT_DIR, 'notifications.png') })

  await mate.context.close()
  await lead.context.close()
  console.log(`Screenshots written to ${OUTPUT_DIR}`)
} finally {
  await browser?.close()
  server.kill('SIGTERM')
}
