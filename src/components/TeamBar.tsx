import type { Team } from '@/types'
import { initials } from '@/lib/date'
import { PlusIcon, SettingsIcon } from './Icons'

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
  counts,
  onSelect,
  onManage,
  onNewTeam,
}: {
  teams: Team[]
  activeTeamId: string | null
  counts: Record<string, number>
  onSelect: (teamId: string) => void
  onManage: (teamId: string) => void
  onNewTeam: () => void
}) {
  if (teams.length === 0) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-dashed border-slate-200 px-3 py-2 dark:border-slate-700">
        <p className="min-w-0 flex-1 truncate text-xs text-slate-400 dark:text-slate-500">
          No teams yet — create one to share tasks with other people.
        </p>
        <button
          type="button"
          onClick={onNewTeam}
          className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-indigo-600 px-2 py-1 text-[11px] font-semibold text-white transition hover:bg-indigo-500"
        >
          <PlusIcon className="h-3 w-3" />
          New team
        </button>
      </div>
    )
  }

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
                  ? 'border-indigo-200 bg-indigo-50 text-indigo-700 dark:border-indigo-500/30 dark:bg-indigo-500/15 dark:text-indigo-200'
                  : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800'
              }`}
            >
              <span
                className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-gradient-to-br text-[10px] font-bold text-white shadow-sm ${teamTint(team.id)}`}
              >
                {initials(team.name).slice(0, 1)}
              </span>
              <span className="max-w-[10rem] truncate">{team.name}</span>
              <span
                className={`rounded px-1 text-[10px] ${
                  active
                    ? 'bg-white/70 text-indigo-600 dark:bg-indigo-400/20 dark:text-indigo-200'
                    : 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400'
                }`}
              >
                {counts[team.id] ?? 0}
              </span>
            </button>
            <button
              type="button"
              onClick={() => onManage(team.id)}
              className="ml-0.5 rounded-lg p-1.5 text-slate-300 transition hover:bg-slate-100 hover:text-slate-600 dark:text-slate-600 dark:hover:bg-slate-800 dark:hover:text-slate-300"
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
