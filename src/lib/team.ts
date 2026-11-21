import type { Team, User } from '@/types'

export interface TeamColor {
  name: string
  bg: string
  ink: string
  border: string
}

/** Soft paper colors sampled from the new-team reference, plus related tints. */
export const TEAM_COLORS: TeamColor[] = [
  { name: 'Sand', bg: '#F8E7C4', ink: '#6B4F1D', border: '#D9A520' },
  { name: 'Lilac', bg: '#E7E1F5', ink: '#4C3E74', border: '#8B7BC8' },
  { name: 'Sky', bg: '#CFE3F7', ink: '#27557D', border: '#6EA8DC' },
  { name: 'Rose', bg: '#FBD0CA', ink: '#7F1D1D', border: '#E0716A' },
  { name: 'Mint', bg: '#D9F0E3', ink: '#14532D', border: '#4AA96C' },
  { name: 'Peach', bg: '#FBE2C8', ink: '#7C3F13', border: '#E7A66B' },
  { name: 'Butter', bg: '#FFF3C4', ink: '#6B5400', border: '#D9C23A' },
  { name: 'Aqua', bg: '#D6F0F2', ink: '#155E63', border: '#57B5C2' },
]

export const DEFAULT_TEAM_COLOR = TEAM_COLORS[1]

/**
 * A team is owned by the current user when either the membership role says so
 * or the user is listed as the host in the member list. The second check keeps
 * older/stale role values from mislabelling the host as a member.
 */
export function isTeamOwner(
  team: Team | null | undefined,
  user: Pick<User, 'email'> | null | undefined,
): boolean {
  if (!team || !user) return false
  if (team.role === 'host') return true
  return team.members.some(
    (member) =>
      member.role === 'host' && member.email.toLowerCase() === user.email.toLowerCase(),
  )
}
