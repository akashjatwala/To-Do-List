import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Team, TeammateOffDay, UserInvite } from '@/types'
import {
  TeamInvitationsCard,
  TeamMembersCard,
  TeamOffDaysCard,
} from './TeamSidebarCards'

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

test('Members uses soft slate and shows no task counts', () => {
  const html = renderToStaticMarkup(
    <TeamMembersCard
      team={team}
      currentUserId={1}
      notify={() => undefined}
      onChanged={async () => undefined}
    />,
  )
  assert.match(html, /bg-\[#EDF0F4\]/)
  assert.match(html, /Members<\/h2>/)
  assert.doesNotMatch(html, /Members<\/h2><span/)
  assert.doesNotMatch(html, /\d+ open/)
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

test('Off days shows only teammates who are off today, in this team only', () => {
  const scopedTeam: Team = {
    ...team,
    members: [
      { id: 1, email: 'me@example.com', role: 'host' },
      { id: 2, email: 'asha@example.com', role: 'member' },
      { id: 3, email: 'marco@example.com', role: 'member' },
    ],
  }
  const offDays: TeammateOffDay[] = [
    {
      id: 1,
      userId: 2,
      name: 'Asha',
      email: 'asha@example.com',
      kind: 'sick',
      startDate: '2026-11-24',
      endDate: '2026-11-26',
      note: 'Recovering',
    },
    {
      id: 2,
      userId: 3,
      name: 'Marco',
      email: 'marco@example.com',
      kind: 'travel',
      startDate: '2026-11-26',
      endDate: '2026-11-27',
      note: null,
    },
    {
      id: 3,
      userId: 4,
      name: 'Outsider',
      email: 'outsider@example.com',
      kind: null,
      startDate: '2026-11-25',
      endDate: '2026-11-25',
      note: null,
    },
    {
      id: 4,
      userId: 1,
      name: 'Me',
      email: 'me@example.com',
      kind: null,
      startDate: '2026-11-25',
      endDate: '2026-11-25',
      note: null,
    },
  ]

  const html = renderToStaticMarkup(
    <TeamOffDaysCard
      team={scopedTeam}
      offDays={offDays}
      currentUserId={1}
      today="2026-11-25"
    />,
  )

  assert.match(html, /aria-label="Teammate off days today"/)
  assert.match(html, /bg-\[#EEF5F8\]/)
  assert.match(html, /Off today<\/h2>/)
  assert.match(html, /aria-label="View team off day calendar"/)
  assert.match(html, /Asha/)
  assert.match(html, /Sick/)
  assert.match(html, /🤒/)
  assert.match(html, /Today · Nov 24 – Nov 26/)
  assert.match(html, /Recovering/)
  assert.doesNotMatch(html, /Marco/)
  assert.doesNotMatch(html, /From Nov 26 to Nov 27/)
  assert.doesNotMatch(html, /Outsider/)
  assert.doesNotMatch(html, /Me</)
})

test('Off days has a clear empty state', () => {
  const html = renderToStaticMarkup(
    <TeamOffDaysCard
      team={team}
      offDays={[]}
      currentUserId={1}
      today="2026-11-25"
    />,
  )
  assert.match(html, /Nobody is off today/)
  assert.match(html, /🌤️/)
})
