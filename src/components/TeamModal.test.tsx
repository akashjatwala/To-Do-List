import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Team, User } from '@/types'
import TeamModal from './TeamModal'

const user: User = { id: 1, email: 'demo@example.com', name: 'demo' }

const team: Team = {
  id: 'team-1',
  name: 'Launch crew',
  createdAt: 0,
  role: 'member',
  members: [
    { id: 1, email: 'demo@example.com', role: 'host' },
    { id: 2, email: 'asha@example.com', role: 'member' },
  ],
  invites: [{ email: 'marco@example.com', createdAt: 0 }],
}

const baseProps = {
  user,
  openTaskCount: 3,
  onClose: () => {},
  onChanged: async () => {},
  notify: () => {},
}

test('team settings say You are the host when the user owns the team', () => {
  const html = renderToStaticMarkup(<TeamModal {...baseProps} team={team} />)

  assert.match(html, /You are the host/)
  assert.doesNotMatch(html, /You are a member/)
  assert.match(html, /aria-label="Edit team"|Edit team/)
  assert.match(html, /Remove asha@example\.com/)
  assert.match(html, /Pending invitations/)
  assert.match(html, /aria-label="Team color"/)
})

test('team settings say You are a member for teams the user does not own', () => {
  const otherTeam: Team = {
    ...team,
    role: 'member',
    members: [
      { id: 2, email: 'asha@example.com', role: 'host' },
      { id: 1, email: 'demo@example.com', role: 'member' },
    ],
  }
  const html = renderToStaticMarkup(<TeamModal {...baseProps} team={otherTeam} />)

  assert.match(html, /You are a member/)
  assert.doesNotMatch(html, /You are the host/)
  assert.doesNotMatch(html, /Remove asha@example\.com/)
  assert.doesNotMatch(html, /aria-label="Team color"/)
})
