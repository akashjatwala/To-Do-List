import type { AppNotification, Team, User, UserInvite } from '@/types'
import { dateInputValue, dueFromDateInput } from '@/lib/date'
import { greetingForHour } from '@/lib/checkin'
import { useHeaderClock } from '@/hooks/useHeaderClock'
import AccountMenu from './AccountMenu'
import NotificationCenter from './NotificationCenter'
import TeamBar from './TeamBar'
import { ChevronRightIcon, SearchIcon } from './Icons'

interface AppHeaderProps {
  user: User
  teams: Team[]
  viewKind: 'my' | 'collab'
  isCollab: boolean
  currentTeam: Team | undefined
  selectedDate: string
  doneCount: number
  totalCount: number
  donePercent: number
  remainingLabel: string
  teamStats: { total: number; done: number; open: number; percent: number }
  onOpenMyTasks: () => void
  onOpenCollaborate: () => void
  onSelectTeam: (teamId: string) => void
  onManageTeam: (teamId: string) => void
  notifications: AppNotification[]
  invites: UserInvite[]
  onAcceptInvite: (invite: UserInvite) => void | Promise<void>
  onDeclineInvite: (invite: UserInvite) => void | Promise<void>
  onOpenNotificationTask: (taskId: string) => void
  onUndoMove: (taskId: string, eventId: number) => void | Promise<void>
  onOpenSearch: () => void
  onOpenAccount: () => void
  onLogout: () => void
  onSetSelectedDate: (value: string) => void
  onNewTeam: () => void
  onAddTask: () => void
}

export default function AppHeader({
  user,
  teams,
  viewKind,
  isCollab,
  currentTeam,
  selectedDate,
  doneCount,
  totalCount,
  donePercent,
  remainingLabel,
  teamStats,
  onOpenMyTasks,
  onOpenCollaborate,
  onSelectTeam,
  onManageTeam,
  notifications,
  invites,
  onAcceptInvite,
  onDeclineInvite,
  onOpenNotificationTask,
  onUndoMove,
  onOpenSearch,
  onOpenAccount,
  onLogout,
  onSetSelectedDate,
  onNewTeam,
  onAddTask,
}: AppHeaderProps) {
  const { currentHour, clockLabel } = useHeaderClock()
  const accountName =
    user.name.trim() ||
    user.email
      .split('@')[0]
      .replace(/^./, (char) => char.toUpperCase())
  const longDateLabel = (() => {
    const timestamp = dueFromDateInput(selectedDate)
    if (timestamp === null) return ''
    return new Date(timestamp).toLocaleDateString(undefined, {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
    })
  })()

  return (
    <header className="bg-white">
      <div className="flex h-[75px] items-center justify-between border-b border-[#E1E2E0] px-4 sm:px-8 lg:px-12">
        <div className="flex items-center gap-8 sm:gap-12">
          <button
            type="button"
            onClick={onOpenMyTasks}
            className="text-[26px] font-extrabold tracking-tight text-[#15181E]"
            aria-label="DUIT home"
          >
            DUIT<span className="text-indigo-500">.</span>
          </button>

          <nav className="flex items-center gap-1 sm:gap-3" aria-label="Main">
            <button
              type="button"
              onClick={onOpenMyTasks}
              aria-pressed={viewKind === 'my'}
              className={`flex h-[34px] items-center rounded-full px-5 text-sm font-semibold transition ${
                viewKind === 'my'
                  ? 'bg-[#15181E] text-white'
                  : 'text-[#454B58] hover:bg-slate-50 hover:text-[#15181E]'
              }`}
            >
              My tasks
            </button>
            <button
              type="button"
              onClick={onOpenCollaborate}
              aria-pressed={isCollab}
              className={`flex h-[34px] items-center rounded-full px-4 text-sm font-semibold transition ${
                isCollab
                  ? 'bg-[#15181E] text-white'
                  : 'text-[#454B58] hover:bg-slate-50 hover:text-[#15181E]'
              }`}
            >
              Teams
            </button>
          </nav>
        </div>

        <div className="flex items-center gap-2">
          <NotificationCenter
            userId={user.id}
            notifications={notifications}
            invites={invites}
            onAcceptInvite={onAcceptInvite}
            onDeclineInvite={onDeclineInvite}
            onOpenTask={onOpenNotificationTask}
            onUndoMove={onUndoMove}
          />
          <AccountMenu
            name={user.name}
            email={user.email}
            onOpenAccount={onOpenAccount}
            onLogout={onLogout}
          />
        </div>
      </div>

      <div className="bg-[#F6F6F4]">
        <div className="mx-auto w-full max-w-6xl px-4 py-7 sm:px-8 sm:py-8">
          <div className="flex flex-col gap-4 sm:flex-row sm:flex-nowrap sm:items-center sm:justify-between sm:gap-x-3">
            <div className="min-w-0">
              <h1 className="text-[30px] leading-[1.08] font-extrabold tracking-tight text-[#15181E] sm:text-[34px] lg:text-[38px]">
                {greetingForHour(currentHour)}, <span>{accountName}</span>
              </h1>

              <div className="group mt-3 inline-flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => {
                    const date = new Date(dueFromDateInput(selectedDate) ?? Date.now())
                    date.setDate(date.getDate() - 1)
                    onSetSelectedDate(dateInputValue(date.getTime()))
                  }}
                  aria-label="Previous day"
                  className="rounded-md p-1 text-[#92969C] opacity-0 transition hover:bg-black/5 hover:text-[#454B58] focus-visible:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100"
                >
                  <ChevronRightIcon className="h-3.5 w-3.5 rotate-180" />
                </button>

                <label className="group cursor-pointer text-sm font-medium text-[#454B58]">
                  {longDateLabel}
                  <input
                    type="date"
                    value={selectedDate}
                    onChange={(event) => {
                      if (event.target.value) onSetSelectedDate(event.target.value)
                    }}
                    onClick={(event) => event.currentTarget.showPicker?.()}
                    aria-label="View tasks for a date"
                    className="sr-only"
                  />
                </label>

                <button
                  type="button"
                  onClick={() => {
                    const date = new Date(dueFromDateInput(selectedDate) ?? Date.now())
                    date.setDate(date.getDate() + 1)
                    onSetSelectedDate(dateInputValue(date.getTime()))
                  }}
                  aria-label="Next day"
                  className="rounded-md p-1 text-[#92969C] opacity-0 transition hover:bg-black/5 hover:text-[#454B58] focus-visible:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100"
                >
                  <ChevronRightIcon className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>

            <button
              type="button"
              onClick={onOpenSearch}
              aria-label="Search tasks"
              className="flex w-full items-center gap-2 rounded-xl border border-[#E3E1DC] bg-white/80 px-3 py-2 text-left text-sm font-medium text-[#92969C] shadow-sm transition hover:bg-white hover:text-[#454B58] focus-visible:ring-4 focus-visible:ring-[#4A2C8A]/15 focus-visible:outline-none sm:w-auto sm:min-w-[13rem] sm:max-w-[18rem]"
            >
              <SearchIcon className="h-4 w-4 shrink-0" />
              <span className="min-w-0 flex-1 truncate">Search tasks</span>
            </button>

            <div className="flex min-w-0 flex-wrap items-center justify-end gap-x-3 gap-y-4 sm:shrink">
              {isCollab ? (
                <>
                  <div className="hidden sm:block">
                    <p className="flex items-center gap-1.5 text-2xl font-extrabold tracking-tight text-[#15181E]">
                      <span aria-hidden="true">🕒</span>
                      {clockLabel}
                    </p>
                  </div>

                  <div className="min-w-[8.75rem]">
                    <p className="flex items-center gap-2 text-sm font-semibold text-[#15181E]">
                      <span className="inline-block h-2 w-2 rounded-full bg-[#2E7D32]" />
                      {teamStats.done} of {teamStats.total} done
                    </p>
                    <p className="mt-1 text-xs font-medium text-[#454B58]">
                      {teamStats.open} open · {currentTeam?.members.length ?? 0} members
                    </p>
                    <div className="mt-2 h-2 w-[8.6875rem] overflow-hidden rounded-full bg-[#DDDFE3]">
                      <div
                        className="h-full rounded-full bg-[#1F7A4D] transition-[width]"
                        style={{ width: `${teamStats.percent}%` }}
                      />
                    </div>
                  </div>
                  <div className="flex w-[6.5rem] flex-col gap-2">
                    <button
                      type="button"
                      onClick={onNewTeam}
                      className="w-full rounded-[12px] bg-[#D9480F] px-4 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-[#C23E0C] active:scale-[0.98]"
                    >
                      New team
                    </button>
                    {currentTeam && (
                      <button
                        type="button"
                        onClick={onAddTask}
                        aria-haspopup="dialog"
                        className="w-full rounded-[12px] border border-[#D9480F]/30 bg-white px-4 py-3 text-sm font-semibold text-[#D9480F] shadow-sm transition hover:bg-[#FDEDE6] active:scale-[0.98]"
                      >
                        Add task
                      </button>
                    )}
                  </div>
                </>
              ) : (
                <>
                  <div className="hidden sm:block">
                    <p className="flex items-center gap-1.5 text-2xl font-extrabold tracking-tight text-[#15181E]">
                      <span aria-hidden="true">🕒</span>
                      {clockLabel}
                    </p>
                  </div>

                  <div className="min-w-[8.75rem]">
                    <p className="text-sm font-semibold text-[#15181E]">
                      {doneCount} of {totalCount} done
                    </p>
                    <p className="mt-1 text-xs font-medium text-[#454B58]">{remainingLabel}</p>
                    <div className="mt-2 h-2 w-[8.6875rem] overflow-hidden rounded-full bg-[#DDDFE3]">
                      <div
                        className="h-full rounded-full bg-[#1F7A4D] transition-[width]"
                        style={{ width: `${donePercent}%` }}
                      />
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={onAddTask}
                    aria-haspopup="dialog"
                    className="rounded-[12px] bg-[#D9480F] px-6 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-[#C23E0C] active:scale-[0.98]"
                  >
                    Add task
                  </button>
                </>
              )}
            </div>
          </div>

          {isCollab && (
            <div className="mt-5">
              <TeamBar
                teams={teams}
                activeTeamId={currentTeam?.id ?? null}
                onSelect={onSelectTeam}
                onManage={onManageTeam}
              />
            </div>
          )}
        </div>
      </div>
    </header>
  )
}
