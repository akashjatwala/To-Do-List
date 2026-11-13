import { useMemo } from 'react'
import type { BootstrapData, Team, UserInvite, View } from '@/types'
import { initials } from '@/lib/date'
import { Avatar } from './ui'
import { Logo } from './Logo'
import {
  ChevronRightIcon,
  InboxIcon,
  LockIcon,
  LogOutIcon,
  SettingsIcon,
  UsersIcon,
  XIcon,
} from './Icons'

const TEAM_TINTS = [
  'from-indigo-500 to-violet-500',
  'from-sky-500 to-cyan-500',
  'from-emerald-500 to-teal-500',
  'from-amber-500 to-orange-500',
  'from-rose-500 to-pink-500',
  'from-fuchsia-500 to-purple-500',
]

function teamTint(id: string): string {
  let hash = 0
  for (let i = 0; i < id.length; i += 1) hash = (hash * 31 + id.charCodeAt(i)) % 997
  return TEAM_TINTS[hash % TEAM_TINTS.length]
}

export default function Sidebar({
  data,
  view,
  onSelectView,
  onNewTeam,
  onManageTeam,
  onAcceptInvite,
  onDeclineInvite,
  onChangePassword,
  onLogout,
  onClose,
}: {
  data: BootstrapData
  view: View
  onSelectView: (view: View) => void
  onNewTeam: () => void
  onManageTeam: (teamId: string) => void
  onAcceptInvite: (invite: UserInvite) => void
  onDeclineInvite: (invite: UserInvite) => void
  onChangePassword: () => void
  onLogout: () => void
  onClose: () => void
}) {
  const openCounts = useMemo(() => {
    const counts: Record<string, number> = { personal: 0 }
    for (const task of data.tasks) {
      if (task.done) continue
      const key = task.teamId ?? 'personal'
      counts[key] = (counts[key] ?? 0) + 1
    }
    return counts
  }, [data.tasks])

  const personalActive = view.kind === 'personal'

  return (
    <aside className="flex h-full w-72 flex-col border-r border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
      <div className="flex h-16 shrink-0 items-center justify-between px-5">
        <Logo />
        <button type="button" onClick={onClose} className="icon-btn lg:hidden" aria-label="Close menu">
          <XIcon className="h-5 w-5" />
        </button>
      </div>

      <nav className="flex-1 overflow-y-auto px-3 pb-4">
        <p className="px-3 pt-3 pb-2 text-[11px] font-bold tracking-wider text-slate-400 uppercase dark:text-slate-500">
          My lists
        </p>

        <button
          type="button"
          onClick={() => onSelectView({ kind: 'personal' })}
          className={`sidebar-item ${personalActive ? 'sidebar-item-active' : ''}`}
        >
          <InboxIcon className="h-4.5 w-4.5 shrink-0" />
          <span className="flex-1 truncate">Personal</span>
          <span
            className={`rounded-md px-1.5 py-0.5 text-[11px] font-semibold ${
              personalActive
                ? 'bg-white/70 text-indigo-600 dark:bg-indigo-400/20 dark:text-indigo-200'
                : 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400'
            }`}
          >
            {openCounts.personal ?? 0}
          </span>
        </button>

        <div className="mt-5 px-3 pb-2">
          <p className="text-[11px] font-bold tracking-wider text-slate-400 uppercase dark:text-slate-500">
            Teams
          </p>
        </div>

        <div className="space-y-1">
          {data.teams.map((team: Team) => {
            const active = view.kind === 'team' && view.teamId === team.id
            return (
              <div key={team.id} className="group relative">
                <button
                  type="button"
                  onClick={() => onSelectView({ kind: 'team', teamId: team.id })}
                  className={`sidebar-item pr-16 ${active ? 'sidebar-item-active' : ''}`}
                >
                  <span
                    className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br text-[10px] font-bold text-white shadow-sm ${teamTint(team.id)}`}
                  >
                    {initials(team.name).slice(0, 1)}
                  </span>
                  <span className="flex-1 truncate">{team.name}</span>
                  <span
                    className={`rounded-md px-1.5 py-0.5 text-[11px] font-semibold ${
                      active
                        ? 'bg-white/70 text-indigo-600 dark:bg-indigo-400/20 dark:text-indigo-200'
                        : 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400'
                    }`}
                  >
                    {openCounts[team.id] ?? 0}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => onManageTeam(team.id)}
                  className={`absolute top-1/2 right-1.5 -translate-y-1/2 rounded-lg p-1.5 transition ${
                    active
                      ? 'text-indigo-400 hover:bg-white/60 hover:text-indigo-600 dark:hover:bg-indigo-400/20'
                      : 'text-slate-300 opacity-0 group-hover:opacity-100 hover:bg-slate-100 hover:text-slate-600 focus:opacity-100 dark:text-slate-600 dark:hover:bg-slate-800 dark:hover:text-slate-300'
                  }`}
                  aria-label={`Manage ${team.name}`}
                  title="Manage team"
                >
                  <SettingsIcon className="h-4 w-4" />
                </button>
              </div>
            )
          })}

          {data.teams.length === 0 && (
            <p className="px-3 py-2 text-xs leading-relaxed text-slate-400 dark:text-slate-500">
              No teams yet. Create one to share lists with the people you work with.
            </p>
          )}
        </div>

        {data.invites.length > 0 && (
          <div className="mt-6">
            <p className="flex items-center gap-2 px-3 pb-2 text-[11px] font-bold tracking-wider text-slate-400 uppercase dark:text-slate-500">
              Invitations
              <span className="rounded-full bg-indigo-500 px-1.5 text-[10px] text-white">
                {data.invites.length}
              </span>
            </p>
            <div className="space-y-2 px-1">
              {data.invites.map((invite) => (
                <div
                  key={invite.teamId}
                  className="rounded-xl border border-indigo-100 bg-indigo-50/60 p-3 dark:border-indigo-500/20 dark:bg-indigo-500/5"
                >
                  <p className="text-xs leading-snug text-slate-600 dark:text-slate-300">
                    <span className="font-semibold text-slate-900 dark:text-white">
                      {invite.invitedByEmail}
                    </span>{' '}
                    invited you to{' '}
                    <span className="font-semibold text-slate-900 dark:text-white">
                      {invite.teamName}
                    </span>
                  </p>
                  <div className="mt-2 flex gap-1.5">
                    <button
                      type="button"
                      onClick={() => onAcceptInvite(invite)}
                      className="rounded-lg bg-indigo-600 px-2.5 py-1 text-[11px] font-semibold text-white transition hover:bg-indigo-500"
                    >
                      Accept
                    </button>
                    <button
                      type="button"
                      onClick={() => onDeclineInvite(invite)}
                      className="rounded-lg px-2.5 py-1 text-[11px] font-medium text-slate-500 transition hover:bg-white/70 hover:text-slate-700 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200"
                    >
                      Decline
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="mt-6 px-1">
          <div className="rounded-2xl border border-slate-200 bg-slate-50/80 p-3 dark:border-slate-800 dark:bg-slate-800/40">
            <div className="flex items-center gap-2 text-xs font-semibold text-slate-600 dark:text-slate-300">
              <UsersIcon className="h-4 w-4 text-indigo-500" />
              Work better together
            </div>
            <p className="mt-1 text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">
              Invite teammates by email and share any list.
            </p>
            <button
              type="button"
              onClick={onNewTeam}
              className="mt-2 inline-flex items-center gap-1 text-[11px] font-semibold text-indigo-600 hover:text-indigo-500 dark:text-indigo-400"
            >
              Create a team <ChevronRightIcon className="h-3 w-3" />
            </button>
          </div>
        </div>
      </nav>

      <div className="shrink-0 border-t border-slate-200 p-3 dark:border-slate-800">
        <div className="flex items-center gap-2.5 rounded-xl px-2 py-2">
          <Avatar email={data.user.email} size="sm" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs font-semibold text-slate-700 dark:text-slate-200">
              {data.user.email.split('@')[0]}
            </p>
            <p className="truncate text-[11px] text-slate-400 dark:text-slate-500">
              {data.user.email}
            </p>
          </div>
          <button
            type="button"
            onClick={onLogout}
            className="icon-btn h-8! w-8! hover:text-rose-500!"
            aria-label="Sign out"
            title="Sign out"
          >
            <LogOutIcon className="h-4 w-4" />
          </button>
        </div>

        <button
          type="button"
          onClick={onChangePassword}
          className="mt-0.5 flex w-full items-center gap-2 rounded-xl px-2 py-2 text-left text-xs font-medium text-slate-500 transition hover:bg-slate-100 hover:text-slate-700 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200"
        >
          <LockIcon className="h-3.5 w-3.5 shrink-0" />
          Change password
        </button>
      </div>
    </aside>
  )
}
