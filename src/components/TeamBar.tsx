import type { Team } from '@/types'
import { initials } from '@/lib/date'
import { SettingsIcon } from './Icons'

const TEAM_TINTS = [
  'from-indigo-500 to-violet-500',
  'from-sky-500 to-cyan-500',
  'from-emerald-500 to-teal-500',
  'from-amber-500 to-orange-500',
  'from-rose-500 to-pink-500',
  'from-fuchsia-500 to-purple-500',
]

export function teamTint(id: string): string {
  let hash = 0
  for (let i = 0; i < id.length; i += 1) hash = (hash * 31 + id.charCodeAt(i)) % 997
  return TEAM_TINTS[hash % TEAM_TINTS.length]
}

export default function TeamBar({
  teams,
  activeTeamId,
  onSelect,
  onManage,
}: {
  teams: Team[]
  activeTeamId: string | null
  onSelect: (teamId: string) => void
  onManage: (teamId: string) => void
  onNewTeam?: () => void
}) {
  // With no teams the only "New team" action lives beside the progress counter.
  if (teams.length === 0) return null

  return (
    <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
      {teams.map((team) => {
        const active = team.id === activeTeamId
        return (
          <div key={team.id} className="flex shrink-0 items-center">
            <button
              type="button"
              onClick={() => onSelect(team.id)}
              aria-pressed={active}
              className={`flex items-center gap-2 rounded-xl border py-1.5 pr-2 pl-2 text-xs font-semibold transition ${
                active
                  ? 'border-indigo-200 bg-indigo-50 text-indigo-700'
                  : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:bg-slate-50'
              }`}
            >
              <span
                className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-gradient-to-br text-[10px] font-bold text-white shadow-sm ${teamTint(team.id)}`}
              >
                {initials(team.name).slice(0, 1)}
              </span>
              <span className="max-w-[10rem] truncate">{team.name}</span>
            </button>
            <button
              type="button"
              onClick={() => onManage(team.id)}
              className="ml-0.5 rounded-lg p-1.5 text-slate-300 transition hover:bg-slate-100 hover:text-slate-600"
              aria-label={`Manage ${team.name}`}
              title="Manage team"
            >
              <SettingsIcon className="h-3.5 w-3.5" />
            </button>
          </div>
        )
      })}
    </div>
  )
}
