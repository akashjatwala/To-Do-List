import { expect, type Page } from '@playwright/test'

export const PASSWORD = 'e2e-pass-123'

let sequence = 0
export function unique(prefix: string): string {
  sequence += 1
  return `${prefix}-${Date.now()}-${sequence}`
}

function localDate(): string {
  const now = new Date()
  const month = `${now.getMonth() + 1}`.padStart(2, '0')
  const day = `${now.getDate()}`.padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

/** New accounts are prompted for a check-in; skipping keeps tests focused. */
export async function skipCheckin(page: Page, expected = false): Promise<void> {
  const skip = page.getByRole('button', { name: 'Skip check-in' })
  let visible = false
  try {
    await skip.waitFor({ state: 'visible', timeout: expected ? 15_000 : 2_000 })
    visible = true
  } catch {
    if (expected) throw new Error('Expected the first check-in prompt but it did not appear.')
  }
  if (visible) {
    const response = await page.request.post('/api/checkins/skip', {
      data: { date: localDate() },
    })
    expect(await response.text(), 'check-in skip response').toBeTruthy()
    expect(response.ok(), 'check-in skip status').toBeTruthy()
    await page.reload()
  }
  await expect(page.getByText('Tasks and plan')).toBeVisible()
  await expect(skip).toHaveCount(0)
}

export async function signupViaUi(
  page: Page,
  name: string,
  email: string,
  password = PASSWORD,
): Promise<void> {
  await page.goto('/')
  await page.getByRole('button', { name: 'Create account' }).first().click()
  await page.getByLabel('Your name').fill(name)
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password', { exact: true }).fill(password)
  await page.getByLabel('Confirm password').fill(password)
  await page.getByRole('button', { name: 'Create account' }).last().click()
  await expect(page.getByText('Tasks and plan')).toBeVisible()
  await skipCheckin(page, true)
}

export async function loginViaUi(
  page: Page,
  email: string,
  password = PASSWORD,
): Promise<void> {
  await page.goto('/')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'Log in' }).click()
  await expect(page.getByText('Tasks and plan')).toBeVisible()
  await skipCheckin(page)
}

export async function addTaskViaDialog(page: Page, title: string): Promise<void> {
  await page.getByRole('button', { name: 'Add task' }).first().click()
  const dialog = page.getByRole('dialog', { name: 'New task' })
  await dialog.getByLabel('New task', { exact: true }).fill(title)
  await dialog.getByRole('button', { name: 'Add task' }).click()
  await expect(page.getByText(title, { exact: true })).toBeVisible()
}
