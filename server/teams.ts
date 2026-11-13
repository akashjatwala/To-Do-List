import { randomUUID } from 'node:crypto'
import { Router } from 'express'
import { db, type TeamRow } from './db'
import { teamsFor, invitesFor, type MemberDTO } from './data'
import { getUserByEmail, getUserById, validEmail } from './auth'
import {
  badRequest,
  forbidden,
  notFound,
  param,
  text,
  type AuthedRequest,
} from './http'

const router = Router()

interface MembershipRow {
  team_id: string
  user_id: number
  role: 'host' | 'member'
}

function membership(teamId: string, userId: number): MembershipRow | undefined {
  return db
    .prepare('SELECT * FROM team_members WHERE team_id = ? AND user_id = ?')
    .get(teamId, userId) as unknown as MembershipRow | undefined
}

function team(teamId: string): TeamRow | undefined {
  return db.prepare('SELECT * FROM teams WHERE id = ?').get(teamId) as unknown as
    | TeamRow
    | undefined
}

const isHost = (teamId: string, userId: number) => membership(teamId, userId)?.role === 'host'

router.post('/', (req: AuthedRequest, res) => {
  const userId = req.userId!
  const name = text(req.body?.name, 60)
  if (!name) return badRequest(res, 'Give your team a name (1–60 characters).')

  const id = randomUUID()
  const now = Date.now()
  db.prepare('INSERT INTO teams (id, name, created_by, created_at) VALUES (?, ?, ?, ?)').run(
    id,
    name,
    userId,
    now,
  )
  db.prepare(
    "INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES (?, ?, 'host', ?)",
  ).run(id, userId, now)

  res.status(201).json({ team: teamsFor(userId).find((t) => t.id === id) })
})

router.patch('/:teamId', (req: AuthedRequest, res) => {
  const userId = req.userId!
  const teamId = param(req, 'teamId')
  if (!team(teamId)) return notFound(res, 'Team not found.')
  if (!isHost(teamId, userId)) return forbidden(res, 'Only the team host can rename the team.')

  const name = text(req.body?.name, 60)
  if (!name) return badRequest(res, 'Give your team a name (1–60 characters).')
  db.prepare('UPDATE teams SET name = ? WHERE id = ?').run(name, teamId)
  res.json({ ok: true })
})

router.delete('/:teamId', (req: AuthedRequest, res) => {
  const userId = req.userId!
  const teamId = param(req, 'teamId')
  if (!team(teamId)) return notFound(res, 'Team not found.')
  if (!isHost(teamId, userId)) return forbidden(res, 'Only the team host can delete the team.')
  db.prepare('DELETE FROM teams WHERE id = ?').run(teamId)
  res.json({ ok: true })
})

router.delete('/:teamId/leave', (req: AuthedRequest, res) => {
  const userId = req.userId!
  const teamId = param(req, 'teamId')
  const row = membership(teamId, userId)
  if (!row) return notFound(res, 'You are not a member of that team.')
  if (row.role === 'host') {
    return badRequest(res, 'Hosts cannot leave their own team. Delete it instead.')
  }
  db.prepare('DELETE FROM team_members WHERE team_id = ? AND user_id = ?').run(teamId, userId)
  res.json({ ok: true })
})

router.delete('/:teamId/members/:memberId', (req: AuthedRequest, res) => {
  const userId = req.userId!
  const teamId = param(req, 'teamId')
  const memberId = Number(param(req, 'memberId'))
  if (!team(teamId)) return notFound(res, 'Team not found.')
  if (!isHost(teamId, userId)) return forbidden(res, 'Only the team host can remove members.')
  if (memberId === userId) return badRequest(res, 'You cannot remove yourself.')
  if (!membership(teamId, memberId)) return notFound(res, 'That person is not on the team.')
  db.prepare('DELETE FROM team_members WHERE team_id = ? AND user_id = ?').run(teamId, memberId)
  res.json({ ok: true })
})

router.post('/:teamId/invites', (req: AuthedRequest, res) => {
  const userId = req.userId!
  const teamId = param(req, 'teamId')
  if (!team(teamId)) return notFound(res, 'Team not found.')
  if (!isHost(teamId, userId)) return forbidden(res, 'Only the team host can invite people.')

  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : ''
  if (!validEmail(email)) return badRequest(res, 'Enter a valid email address.')

  const me = getUserById(userId)!
  if (email === me.email) return badRequest(res, 'You are already on this team.')
  const existing = getUserByEmail(email)
  if (existing && membership(teamId, existing.id)) {
    return badRequest(res, `${email} is already on this team.`)
  }

  const already = db
    .prepare('SELECT 1 FROM team_invites WHERE team_id = ? AND email = ?')
    .get(teamId, email)
  if (already) return badRequest(res, `${email} already has a pending invite.`)

  db.prepare(
    'INSERT INTO team_invites (team_id, email, invited_by, created_at) VALUES (?, ?, ?, ?)',
  ).run(teamId, email, userId, Date.now())

  res.status(201).json({ ok: true })
})

router.delete('/:teamId/invites/:email', (req: AuthedRequest, res) => {
  const userId = req.userId!
  const teamId = param(req, 'teamId')
  if (!isHost(teamId, userId)) return forbidden(res, 'Only the team host can cancel invites.')
  db.prepare('DELETE FROM team_invites WHERE team_id = ? AND email = ?').run(
    teamId,
    decodeURIComponent(param(req, 'email')).toLowerCase(),
  )
  res.json({ ok: true })
})

router.get('/:teamId/members', (req: AuthedRequest, res) => {
  const userId = req.userId!
  const teamId = param(req, 'teamId')
  if (!membership(teamId, userId)) return forbidden(res)
  const members = db
    .prepare(
      `SELECT u.id, u.email, tm.role FROM team_members tm
       JOIN users u ON u.id = tm.user_id
       WHERE tm.team_id = ? ORDER BY tm.role DESC, u.email ASC`,
    )
    .all(teamId) as unknown as MemberDTO[]
  res.json({ members })
})

// ---- Invitations for the signed-in user ----

export const invitesRouter = Router()

invitesRouter.get('/', (req: AuthedRequest, res) => {
  const user = getUserById(req.userId!)!
  res.json({ invites: invitesFor(user.email) })
})

invitesRouter.post('/:teamId/accept', (req: AuthedRequest, res) => {
  const userId = req.userId!
  const user = getUserById(userId)!
  const teamId = param(req, 'teamId')

  const invite = db
    .prepare('SELECT 1 FROM team_invites WHERE team_id = ? AND email = ?')
    .get(teamId, user.email)
  if (!invite) return notFound(res, 'That invitation is no longer available.')
  if (!team(teamId)) return notFound(res, 'That team no longer exists.')

  if (!membership(teamId, userId)) {
    db.prepare(
      "INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)",
    ).run(teamId, userId, Date.now())
  }
  db.prepare('DELETE FROM team_invites WHERE team_id = ? AND email = ?').run(teamId, user.email)
  res.json({ ok: true })
})

invitesRouter.delete('/:teamId', (req: AuthedRequest, res) => {
  const user = getUserById(req.userId!)!
  db.prepare('DELETE FROM team_invites WHERE team_id = ? AND email = ?').run(
    param(req, 'teamId'),
    user.email,
  )
  res.json({ ok: true })
})

export default router
