import { db, type TaskRow } from './db'
import { getUserById } from './auth'
import { readRecurrenceConfig, type RecurrenceConfig } from './recurrence'

export interface SubtaskDTO {
  id: string
  text: string
  done: boolean
  position: number
}

export interface CommentDTO {
  id: string
  text: string
  createdAt: number
  userId: number
  email: string
}

export interface TaskDTO {
  id: string
  text: string
  done: boolean
  createdAt: number
  due: number | null
  progress: number
  priority: string
  tags: string[]
  recurrence: string
  recurrenceConfig: RecurrenceConfig | null
  duration: number | null
  preferredTime: string | null
  teamId: string | null
  teamName: string | null
  userId: number
  ownerEmail: string
  subtasks: SubtaskDTO[]
  comments: CommentDTO[]
}

export interface MemberDTO {
  id: number
  email: string
  role: 'host' | 'member'
}

export interface TeamDTO {
  id: string
  name: string
  createdAt: number
  role: 'host' | 'member'
  members: MemberDTO[]
  /** Only present for the host. */
  invites?: Array<{ email: string; createdAt: number }>
}

export interface InviteDTO {
  teamId: string
  teamName: string
  invitedByEmail: string
  createdAt: number
}

export interface UserDTO {
  id: number
  email: string
}

interface SubtaskRow {
  id: string
  task_id: string
  text: string
  done: number
  position: number
}

interface CommentRow {
  id: string
  task_id: string
  user_id: number
  text: string
  created_at: number
  email: string
}

interface TeamJoinRow {
  id: string
  name: string
  created_at: number
  role: 'host' | 'member'
}

interface MemberRow {
  id: number
  email: string
  role: 'host' | 'member'
}

interface InviteJoinRow {
  team_id: string
  team_name: string
  created_at: number
  invited_by_email: string
}

export function publicUser(userId: number): UserDTO | null {
  const user = getUserById(userId)
  return user ? { id: user.id, email: user.email } : null
}

export function teamsFor(userId: number): TeamDTO[] {
  const teams = db
    .prepare(
      `SELECT t.id, t.name, t.created_at, tm.role
       FROM teams t
       JOIN team_members tm ON tm.team_id = t.id
       WHERE tm.user_id = ?
       ORDER BY t.created_at ASC`,
    )
    .all(userId) as unknown as TeamJoinRow[]

  const membersStmt = db.prepare(
    `SELECT u.id, u.email, tm.role
     FROM team_members tm
     JOIN users u ON u.id = tm.user_id
     WHERE tm.team_id = ?
     ORDER BY tm.role DESC, u.email ASC`,
  )

  const invitesStmt = db.prepare(
    'SELECT email, created_at FROM team_invites WHERE team_id = ? ORDER BY created_at ASC',
  )

  return teams.map((team) => {
    const dto: TeamDTO = {
      id: team.id,
      name: team.name,
      createdAt: team.created_at,
      role: team.role,
      members: membersStmt.all(team.id) as unknown as MemberRow[],
    }
    if (team.role === 'host') {
      const rows = invitesStmt.all(team.id) as unknown as Array<{
        email: string
        created_at: number
      }>
      dto.invites = rows.map((row) => ({ email: row.email, createdAt: row.created_at }))
    }
    return dto
  })
}

export function invitesFor(email: string): InviteDTO[] {
  const rows = db
    .prepare(
      `SELECT i.team_id, t.name AS team_name, i.created_at, u.email AS invited_by_email
       FROM team_invites i
       JOIN teams t ON t.id = i.team_id
       LEFT JOIN users u ON u.id = i.invited_by
       WHERE i.email = ?
       ORDER BY i.created_at DESC`,
    )
    .all(email) as unknown as InviteJoinRow[]

  return rows.map((row) => ({
    teamId: row.team_id,
    teamName: row.team_name,
    createdAt: row.created_at,
    invitedByEmail: row.invited_by_email ?? 'a teammate',
  }))
}

export function tasksFor(userId: number): TaskDTO[] {
  const rows = db
    .prepare(
      `SELECT t.*, u.email AS owner_email, tm.name AS team_name
       FROM tasks t
       JOIN users u ON u.id = t.user_id
       LEFT JOIN teams tm ON tm.id = t.team_id
       WHERE (t.team_id IS NULL AND t.user_id = ?)
          OR t.team_id IN (SELECT team_id FROM team_members WHERE user_id = ?)
       ORDER BY t.done ASC, t.position DESC, t.created_at DESC`,
    )
    .all(userId, userId) as unknown as Array<TaskRow & { owner_email: string; team_name: string | null }>

  if (rows.length === 0) return []

  const ids = rows.map((row) => row.id)
  const placeholders = ids.map(() => '?').join(', ')

  const subtaskRows = db
    .prepare(
      `SELECT * FROM subtasks WHERE task_id IN (${placeholders}) ORDER BY position ASC, rowid ASC`,
    )
    .all(...ids) as unknown as SubtaskRow[]

  const commentRows = db
    .prepare(
      `SELECT c.*, u.email FROM comments c
       JOIN users u ON u.id = c.user_id
       WHERE c.task_id IN (${placeholders})
       ORDER BY c.created_at ASC`,
    )
    .all(...ids) as unknown as CommentRow[]

  const subtasks = new Map<string, SubtaskDTO[]>()
  for (const row of subtaskRows) {
    const list = subtasks.get(row.task_id) ?? []
    list.push({ id: row.id, text: row.text, done: row.done === 1, position: row.position })
    subtasks.set(row.task_id, list)
  }

  const comments = new Map<string, CommentDTO[]>()
  for (const row of commentRows) {
    const list = comments.get(row.task_id) ?? []
    list.push({
      id: row.id,
      text: row.text,
      createdAt: row.created_at,
      userId: row.user_id,
      email: row.email,
    })
    comments.set(row.task_id, list)
  }

  return rows.map((row) => ({
    id: row.id,
    text: row.text,
    done: row.done === 1,
    createdAt: row.created_at,
    due: row.due,
    progress: row.progress ?? 0,
    priority: row.priority ?? 'none',
    tags: parseTagList(row.tags),
    recurrence: row.recurrence ?? 'none',
    recurrenceConfig: readRecurrenceConfig(row.recurrence_config),
    duration: row.duration ?? null,
    preferredTime: row.preferred_time ?? null,
    teamId: row.team_id,
    teamName: row.team_name,
    userId: row.user_id,
    ownerEmail: row.owner_email,
    subtasks: subtasks.get(row.id) ?? [],
    comments: comments.get(row.id) ?? [],
  }))
}

/** Tags are stored as a JSON array; tolerate older/blank values. */
function parseTagList(value: string | null | undefined): string[] {
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter((tag): tag is string => typeof tag === 'string') : []
  } catch {
    return []
  }
}

export function bootstrap(userId: number) {
  const user = publicUser(userId)
  if (!user) return null
  return {
    user,
    teams: teamsFor(userId),
    invites: invitesFor(user.email),
    tasks: tasksFor(userId),
  }
}

export type { TaskRow }
