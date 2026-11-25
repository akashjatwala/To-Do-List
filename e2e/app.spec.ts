import { expect, test } from '@playwright/test'
import { addTaskViaDialog, loginViaUi, PASSWORD, signupViaUi, unique } from './helpers'

test('signs up, adds a task, completes it, then signs back in', async ({ page }) => {
  const name = 'E2E Owner'
  const email = `${unique('e2e-owner')}@example.com`
  const title = 'E2E quick task'

  await signupViaUi(page, name, email)

  await addTaskViaDialog(page, title)

  await page.getByRole('checkbox', { name: 'Mark as done' }).first().click()
  await expect(page.getByRole('region', { name: 'Completed' }).getByText(title)).toBeVisible()

  await page.getByRole('button', { name: new RegExp(name) }).click()
  await page.getByRole('menuitem', { name: 'Sign out' }).click()
  await expect(page.getByRole('button', { name: 'Log in' })).toBeVisible()

  await loginViaUi(page, email, PASSWORD)
  await expect(page.getByRole('region', { name: 'Completed' }).getByText(title)).toBeVisible()
})

test('moves repeating and ordinary notes off an off day and skips to the next non-off date', async ({
  page,
}) => {
  const email = `${unique('e2e-repeat')}@example.com`
  const dailyTitle = 'E2E daily run'
  const plainTitle = 'E2E plain note'

  await signupViaUi(page, 'E2E Repeat', email)

  await addTaskViaDialog(page, dailyTitle, { repeatDaily: true })
  const dailyNote = page.locator('[data-note-id]').filter({ hasText: dailyTitle })
  await expect(dailyNote).toBeVisible()

  const offDay = page.getByRole('region', { name: 'Off Day' })
  await offDay.getByRole('button', { name: 'Mark today off' }).click()
  await page.getByRole('button', { name: 'Save off day' }).click()
  await expect(dailyNote).toHaveCount(0)

  await page.getByRole('button', { name: 'Next day' }).click()
  await expect(dailyNote).toBeVisible()
  await page.getByRole('button', { name: 'Previous day' }).click()
  await offDay.getByRole('button', { name: 'Remove off-day record' }).click()
  await expect(dailyNote).toHaveCount(0)

  await addTaskViaDialog(page, plainTitle)
  const plainNote = page.locator('[data-note-id]').filter({ hasText: plainTitle })
  await expect(plainNote).toBeVisible()
  await plainNote.click()
  await page.getByRole('button', { name: 'Skip for today' }).click()
  await expect(plainNote).toHaveCount(0)

  await page.getByRole('button', { name: 'Next day' }).click()
  await expect(plainNote).toBeVisible()
  await expect(dailyNote).toBeVisible()

  await dailyNote.click()
  await page.getByRole('button', { name: 'Skip for today' }).click()
  await expect(dailyNote).toHaveCount(0)
  await expect(plainNote).toBeVisible()

  await page.getByRole('button', { name: 'Next day' }).click()
  await expect(dailyNote).toBeVisible()
  await expect(plainNote).toHaveCount(0)
})

test('creates a team, accepts an invite, and shares a task with notifications', async ({
  browser,
  page,
}) => {
  const hostName = 'E2E Host'
  const hostEmail = `${unique('e2e-host')}@example.com`
  const mateName = 'E2E Mate'
  const mateEmail = `${unique('e2e-mate')}@example.com`
  const teamName = `Team ${Date.now()}`
  const title = 'Shared review task'

  const mateContext = await browser.newContext()
  const matePage = await mateContext.newPage()

  await signupViaUi(page, hostName, hostEmail)
  await signupViaUi(matePage, mateName, mateEmail)

  await page.getByRole('button', { name: 'Teams' }).click()
  await page.getByRole('button', { name: 'New team' }).click()
  await page.getByLabel('Team name').fill(teamName)
  await page.getByRole('button', { name: 'Create team' }).click()
  await expect(page.getByRole('button', { name: new RegExp(teamName) }).first()).toBeVisible()

  await page.getByRole('button', { name: `Manage ${teamName}` }).click()
  await page.getByLabel('Invite by email').fill(mateEmail)
  const manageDialog = page.getByRole('dialog', { name: 'Edit team' })
  await manageDialog.getByRole('button', { name: 'Invite' }).click()
  await expect(manageDialog.getByText('Pending', { exact: true })).toBeVisible()
  await manageDialog.getByRole('button', { name: 'Close' }).click()

  await matePage.reload()
  await matePage.getByRole('button', { name: 'Notifications' }).first().click()
  const mateNotifications = matePage.getByRole('dialog', { name: 'Notifications' })
  await mateNotifications.getByRole('button', { name: 'Accept' }).click()
  await expect(matePage.getByRole('button', { name: new RegExp(teamName) }).first()).toBeVisible()

  await page.reload()
  await page.getByRole('button', { name: 'Teams' }).click()
  await addTaskViaDialog(page, title)

  await page.locator('[data-note-id]').filter({ hasText: title }).click()
  await expect(page.getByRole('dialog', { name: 'Task details' })).toBeVisible()
  await page.getByRole('button', { name: '+ Assign' }).click()
  await page.getByRole('button', { name: new RegExp(mateEmail.split('@')[0]) }).click()
  await page.getByRole('textbox', { name: 'New note' }).fill(
    `@${mateEmail.split('@')[0]} please review the release notes`,
  )
  await page.getByRole('textbox', { name: 'New note' }).press('Enter')
  await expect(page.getByText(`@${mateEmail.split('@')[0]} please review the release notes`)).toBeVisible()
  await page.getByRole('dialog', { name: 'Task details' }).getByLabel('Close', { exact: true }).click()

  await matePage.reload()
  await matePage.getByRole('button', { name: 'Notifications' }).first().click()
  await expect(matePage.getByRole('dialog', { name: 'Notifications' }).getByText(/assigned you/)).toBeVisible()
  await expect(matePage.getByRole('dialog', { name: 'Notifications' }).getByText(/mentioned you/)).toBeVisible()

  await page.locator('[data-note-id]').filter({ hasText: title }).click()
  await page.getByRole('button', { name: 'Skip for today' }).click()

  await matePage.reload()
  await matePage.getByRole('button', { name: 'Notifications' }).first().click()
  await expect(
    matePage.getByRole('dialog', { name: 'Notifications' }).getByText(/skipped a task/),
  ).toBeVisible()

  await page.getByRole('button', { name: 'My tasks' }).click()
  const hostOffDay = page.getByRole('region', { name: 'Off Day' })
  await hostOffDay.getByRole('button', { name: 'Mark today off' }).click()
  await page.getByRole('button', { name: 'Save off day' }).click()

  await matePage.reload()
  await matePage.getByRole('button', { name: 'Notifications' }).first().click()
  await expect(
    matePage.getByRole('dialog', { name: 'Notifications' }).getByText(new RegExp(`${hostName} is off`)),
  ).toBeVisible()

  await mateContext.close()
})
