import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Team, UserInvite } from '@/types'
import { TeamInvitationsCard, TeamMembersCard } from './TeamSidebarCards'

const team: Team = {
  id: 'crew',
  name: 'Launch crew',
  createdAt: 0,
  role: 'host',
  members: [
    { id: 1, email: 'me@example.com', role: 'host' },
    { id: 2, email: 'asha@example.com', role: 'member' },
  ],
  invites: [{ email: 'marco@example.com', createdAt: 0 }],
}

const incoming: UserInvite[] = [
  {
    teamId: 'other',
    teamName: 'Book club',
    invitedByEmail: 'host@example.com',
    createdAt: 0,
  },
]

test('Members uses soft slate and drops the header count', () => {
  const html = renderToStaticMarkup(
    <TeamMembersCard
      team={team}
      currentUserId={1}
      openCounts={{ 1: 2, 2: 1 }}
      notify={() => undefined}
      onChanged={async () => undefined}
    />,
  )
  assert.match(html, /bg-\[#EDF0F4\]/)
  assert.match(html, /Members<\/h2>/)
  assert.doesNotMatch(html, /Members<\/h2><span/)
  assert.match(html, /rounded-2xl bg-white\/55/)
})

test('Invitations uses blush pink and drops the header count', () => {
  const html = renderToStaticMarkup(
    <TeamInvitationsCard
      team={team}
      invites={incoming}
      onAccept={() => undefined}
      onDecline={() => undefined}
      notify={() => undefined}
      onChanged={async () => undefined}
    />,
  )
  assert.match(html, /bg-\[#FBE4EC\]/)
  assert.match(html, /Invitations<\/h2>/)
  assert.doesNotMatch(html, /Invitations<\/h2><span/)
})
