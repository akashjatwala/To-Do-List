import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, errorMessage } from '@/api'
import type {
  BootstrapData,
  CheckinStatus,
  Comment,
  DailyState,
  Priority,
  Recurrence,
  RecurrenceConfig,
  Subtask,
  Task,
  Team,
  Toast,
  ToastTone,
  UserInvite,
  View,
} from '@/types'
import { dateInputValue, dueFromDateInput, formatDateValue, todayDateValue } from '@/lib/date'
import { localDateString } from '@/lib/checkin'
import AuthScreen from './components/AuthScreen'
import AccountMenu from './components/AccountMenu'
import InstallButton from './components/InstallButton'
import SettingsModal from './components/SettingsModal'
import CheckinModal from './components/CheckinModal'
import DailyStateCard from './components/DailyStateCard'
import OffDayCard from './components/OffDayCard'
import PredictionPanel from './components/PredictionPanel'
import TaskComposer, { type NewTaskInput } from './components/TaskComposer'
import { CompletedColumn, StickyBoard } from './components/StickyBoard'
import TaskDetail from './components/TaskDetail'
import TeamBar from './components/TeamBar'
import TeamModal from './components/TeamModal'
import { Avatar, Spinner } from './components/ui'
import { Logo } from './components/Logo'
import {
  CalendarIcon,
  CheckIcon,
  ChevronRightIcon,
  InboxIcon,
  PlusIcon,
  UsersIcon,
  XIcon,
} from './components/Icons'

const TOAST_STYLES: Record<ToastTone, string> = {
  success:
    'border-emerald-200 bg-emerald-50 text-emerald-800',
  error:
    'border-rose-200 bg-rose-50 text-rose-800',
  info: 'border-slate-200 bg-white text-slate-700',
}

export default function App() {
  const [data, setData] = useState<BootstrapData | null>(null)
  const [loading, setLoading] = useState(true)
  const [view, setView] = useState<View>({ kind: 'my' })
  const [selectedDate, setSelectedDate] = useState(() => todayDateValue())
  const [composerOpen, setComposerOpen] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [teamModal, setTeamModal] = useState<{ teamId: string | null } | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [toasts, setToasts] = useState<Toast[]>([])
  const [checkinStatus, setCheckinStatus] = useState<CheckinStatus | null>(null)
  const [checkinOpen, setCheckinOpen] = useState(false)
  const [checkinMode, setCheckinMode] = useState<'prompt' | 'edit'>('prompt')
  const [checkinCelebrate, setCheckinCelebrate] = useState(false)
  const [dailyStateData, setDailyStateData] = useState<DailyState | null>(null)
  const toastId = useRef(0)
  const lastTeamId = useRef<string | null>(null)
  const checkinCheckedFor = useRef<number | null>(null)

  const notify = useCallback((message: string, tone: ToastTone = 'info') => {
    const id = (toastId.current += 1)
    setToasts((current) => [...current, { id, message, tone }])
    window.setTimeout(() => {
      setToasts((current) => current.filter((toast) => toast.id !== id))
    }, 4200)
  }, [])

  const refresh = useCallback(async (): Promise<void> => {
    const next = await api.bootstrap()
    setData(next)
  }, [])

  useEffect(() => {
    let cancelled = false
    api
      .bootstrap()
      .then((next) => {
        if (!cancelled) setData(next)
      })
      .catch((error: unknown) => {
        if (error instanceof Error && 'status' in error && error.status === 401) return
        if (!cancelled) notify('Could not connect to the server.', 'error')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [notify])

  const currentUserId = data?.user.id ?? null

  // Show the check-in first after login, or when the app opens on a new local
  // day, but only while today's check-in is neither completed nor skipped.
  // Runs once per signed-in user per app session.
  useEffect(() => {
    if (currentUserId === null) return
    if (checkinCheckedFor.current === currentUserId) return
    checkinCheckedFor.current = currentUserId
    let cancelled = false
    api
      .getCheckin(localDateString())
      .then((status) => {
        if (cancelled) return
        setCheckinStatus(status)
        if (status.state === 'not_asked' || status.state === 'partial') {
          setCheckinMode('prompt')
          setCheckinOpen(true)
        }
      })
      .catch(() => {
        /* never block the app because the check-in lookup failed */
      })
    return () => {
      cancelled = true
    }
  }, [currentUserId])

  // Keep the current view valid if teams change (including the very first team).
  useEffect(() => {
    if (!data || view.kind !== 'collab') return
    if (view.teamId && data.teams.some((team) => team.id === view.teamId)) {
      lastTeamId.current = view.teamId
      return
    }
    const fallback = data.teams[0]?.id ?? null
    lastTeamId.current = fallback
    if (fallback !== view.teamId) setView({ kind: 'collab', teamId: fallback })
  }, [data, view])

  // Close the detail panel if its task is gone.
  useEffect(() => {
    if (selectedId && data && !data.tasks.some((task) => task.id === selectedId)) {
      setSelectedId(null)
    }
  }, [data, selectedId])

  // Load the read-only daily state for today (personal view only). It reloads
  // whenever the check-in changes, so a mid-day edit updates the summary.
  useEffect(() => {
    if (currentUserId === null || view.kind !== 'my' || selectedDate !== todayDateValue()) {
      setDailyStateData(null)
      return
    }
    let cancelled = false
    api
      .getState(selectedDate, todayDateValue())
      .then((next) => {
        if (!cancelled) setDailyStateData(next)
      })
      .catch(() => {
        if (!cancelled) setDailyStateData(null)
      })
    return () => {
      cancelled = true
    }
  }, [currentUserId, selectedDate, view.kind, checkinStatus?.checkin?.updatedAt, checkinStatus?.state])

  const currentTeam: Team | undefined =
    view.kind === 'collab' && view.teamId
      ? data?.teams.find((team) => team.id === view.teamId)
      : undefined

  const viewTasks = useMemo(() => {
    if (!data) return []
    // "My task" is the personal list only; shared tasks live behind Collaborate.
    if (view.kind === 'my') return data.tasks.filter((task) => task.teamId === null)
    if (!view.teamId) return []
    return data.tasks.filter((task) => task.teamId === view.teamId)
  }, [data, view])

  const dateTasks = useMemo(
    () =>
      viewTasks.filter(
        (task) => task.due !== null && dateInputValue(task.due) === selectedDate,
      ),
    [viewTasks, selectedDate],
  )

  const openTasks = useMemo(() => dateTasks.filter((task) => !task.done), [dateTasks])
  const completedTasks = useMemo(() => dateTasks.filter((task) => task.done), [dateTasks])

  const isToday = selectedDate === todayDateValue()

  const openCounts = useMemo(() => {
    const perTeam: Record<string, number> = {}
    let personal = 0
    for (const task of data?.tasks ?? []) {
      if (task.done) continue
      if (task.teamId) perTeam[task.teamId] = (perTeam[task.teamId] ?? 0) + 1
      else personal += 1
    }
    return { personal, perTeam }
  }, [data])

  const selectedTask = data?.tasks.find((task) => task.id === selectedId) ?? null

  const canModerate = selectedTask?.teamId
    ? data?.teams.find((team) => team.id === selectedTask.teamId)?.role === 'host'
    : true

  const resetSessionState = () => {
    setData(null)
    setSelectedId(null)
    setTeamModal(null)
    setSettingsOpen(false)
    setView({ kind: 'my' })
    setSelectedDate(todayDateValue())
    setComposerOpen(false)
    checkinCheckedFor.current = null
    setCheckinStatus(null)
    setCheckinOpen(false)
    setCheckinCelebrate(false)
  }

  const handleLogout = async () => {
    try {
      await api.logout()
    } catch {
      /* sign out locally regardless */
    }
    resetSessionState()
  }

  const handleAccountDeleted = () => {
    resetSessionState()
  }

  const resetDateView = () => {
    setSelectedDate(todayDateValue())
  }

  const openCheckin = async () => {
    const date = localDateString()
    try {
      const status = await api.getCheckin(date)
      setCheckinStatus(status)
    } catch {
      /* fall back to whatever state we already hold */
    }
    setCheckinMode('edit')
    setCheckinOpen(true)
  }

  const openMyTasks = () => {
    setView({ kind: 'my' })
    resetDateView()
  }

  const openCollaborate = () => {
    const remembered =
      lastTeamId.current && data?.teams.some((team) => team.id === lastTeamId.current)
        ? lastTeamId.current
        : (data?.teams[0]?.id ?? null)
    setView({ kind: 'collab', teamId: remembered })
    resetDateView()
  }

  const openTeam = (teamId: string) => {
    setView({ kind: 'collab', teamId })
    resetDateView()
  }

  const addTask = async (input: NewTaskInput) => {
    try {
      await api.createTask({
        text: input.text,
        teamId: input.teamId,
        due: input.due,
        priority: input.priority,
        tags: input.tags,
        recurrence: input.recurrence,
        recurrenceConfig: input.recurrenceConfig,
        duration: input.duration,
        preferredTime: input.preferredTime,
      })
      await refresh()
      return true
    } catch (error) {
      notify(errorMessage(error), 'error')
      return false
    }
  }

  const toggleTask = async (task: Task) => {
    const wasRecurring = !task.done && task.recurrence !== 'none'
    setData((current) =>
      current
        ? {
            ...current,
            tasks: current.tasks.map((item) =>
              item.id === task.id
                ? {
                    ...item,
                    done: !item.done,
                    // Mirror the API: completing sets 100%, and un-completing a
                    // fully finished task clears progress back to 0%.
                    progress: !item.done ? 100 : item.progress === 100 ? 0 : item.progress,
                  }
                : item,
            ),
          }
        : current,
    )
    try {
      await api.updateTask(task.id, { done: !task.done })
      if (wasRecurring) {
        // Completing a recurring task spawns its next occurrence server-side.
        await refresh()
        notify('Done — the next occurrence was added.', 'success')
      }
    } catch (error) {
      notify(errorMessage(error), 'error')
      await refresh().catch(() => undefined)
    }
  }

  const deleteTask = async (task: Task) => {
    try {
      await api.deleteTask(task.id)
      if (selectedId === task.id) setSelectedId(null)
      await refresh()
      notify('Task deleted.', 'info')
    } catch (error) {
      notify(errorMessage(error), 'error')
    }
  }

  const reorderTasks = async (orderedIds: string[]) => {
    try {
      await api.reorderTasks(orderedIds)
      await refresh()
    } catch (error) {
      notify(errorMessage(error), 'error')
      // Put the notes back in the order the server still has.
      await refresh().catch(() => undefined)
    }
  }

  const updateTask = async (
    task: Task,
    patch: {
      text?: string
      done?: boolean
      due?: number | null
      progress?: number
      priority?: Priority
      tags?: string[]
      recurrence?: Recurrence
      recurrenceConfig?: RecurrenceConfig | null
      duration?: number | null
      preferredTime?: string | null
    },
  ) => {
    try {
      await api.updateTask(task.id, patch)
      await refresh()
      return true
    } catch (error) {
      notify(errorMessage(error), 'error')
      return false
    }
  }

  const addSubtask = async (task: Task, text: string) => {
    try {
      await api.addSubtask(task.id, text)
      await refresh()
      return true
    } catch (error) {
      notify(errorMessage(error), 'error')
      return false
    }
  }

  const toggleSubtask = async (task: Task, subtask: Subtask) => {
    try {
      await api.updateSubtask(task.id, subtask.id, { done: !subtask.done })
      await refresh()
    } catch (error) {
      notify(errorMessage(error), 'error')
    }
  }

  const deleteSubtask = async (task: Task, subtask: Subtask) => {
    try {
      await api.deleteSubtask(task.id, subtask.id)
      await refresh()
    } catch (error) {
      notify(errorMessage(error), 'error')
    }
  }

  const addComment = async (task: Task, text: string) => {
    try {
      await api.addComment(task.id, text)
      await refresh()
      return true
    } catch (error) {
      notify(errorMessage(error), 'error')
      return false
    }
  }

  const deleteComment = async (task: Task, comment: Comment) => {
    try {
      await api.deleteComment(task.id, comment.id)
      await refresh()
    } catch (error) {
      notify(errorMessage(error), 'error')
    }
  }

  const acceptInvite = async (invite: UserInvite) => {
    try {
      await api.acceptInvite(invite.teamId)
      await refresh()
      setView({ kind: 'collab', teamId: invite.teamId })
      notify(`You joined ${invite.teamName}.`, 'success')
    } catch (error) {
      notify(errorMessage(error), 'error')
    }
  }

  const declineInvite = async (invite: UserInvite) => {
    try {
      await api.declineInvite(invite.teamId)
      await refresh()
      notify('Invitation declined.', 'info')
    } catch (error) {
      notify(errorMessage(error), 'error')
    }
  }

  if (loading) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 bg-canvas">
        <Logo />
        <Spinner className="h-5 w-5 text-indigo-500" />
        <p className="text-xs text-slate-400">Loading your lists…</p>
      </div>
    )
  }

  if (!data) {
    return (
      <AuthScreen
        onAuthed={async () => {
          await refresh()
        }}
      />
    )
  }

  const isCollab = view.kind === 'collab'

  const canDeleteTask = (task: Task) =>
    task.userId === data.user.id ||
    (task.teamId !== null &&
      data.teams.find((team) => team.id === task.teamId)?.role === 'host')

  const title = currentTeam ? currentTeam.name : isCollab ? 'Collaborate' : 'My task'
  const subtitle = currentTeam
    ? `${currentTeam.members.length} ${currentTeam.members.length === 1 ? 'member' : 'members'} · shared list`
    : isCollab
      ? 'Pick a team to open its shared tasks'
      : 'Only your personal tasks'

  const emptyCopy = isToday
    ? {
        title: 'Nothing due today',
        text: 'Enjoy the breathing room — or add something for today.',
      }
    : {
        title: 'Nothing scheduled',
        text: 'This day is clear. Pick another date, or add a task for it above.',
      }

  const closeDetail = () => setSelectedId(null)

  return (
    <div className="flex h-full flex-col overflow-hidden bg-canvas">
      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="shrink-0 bg-canvas">
          <div className="mx-auto w-full max-w-6xl px-4 pt-3 pb-2 sm:px-8">
            <div className="insight-card px-4 py-4">
              <div className="flex items-center gap-2 sm:gap-3">
                <Logo className="hidden shrink-0 md:inline-flex" />

                <div className="flex min-w-0 items-center gap-1 rounded-xl bg-white/80 p-1 ring-1 ring-slate-200/70">
                  <button
                    type="button"
                    onClick={openMyTasks}
                    aria-pressed={!isCollab}
                    className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm font-semibold transition sm:px-3 ${
                      !isCollab
                        ? 'bg-white text-slate-900 shadow-sm'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    <InboxIcon className="h-4 w-4 shrink-0" />
                    <span className="truncate">My task</span>
                  </button>

                  <div
                    className={`flex items-center rounded-lg transition ${
                      isCollab ? 'bg-white shadow-sm' : ''
                    }`}
                  >
                    <button
                      type="button"
                      onClick={openCollaborate}
                      aria-pressed={isCollab}
                      className={`flex items-center gap-1.5 rounded-lg py-1.5 pr-1 pl-2.5 text-sm font-semibold transition sm:pl-3 ${
                        isCollab
                          ? 'text-slate-900'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      <UsersIcon className="h-4 w-4 shrink-0" />
                      <span className="truncate">Collaborate</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setTeamModal({ teamId: null })}
                      className={`mr-1 rounded-md p-1 transition ${
                        isCollab
                          ? 'text-indigo-600 hover:bg-white'
                          : 'text-slate-500 hover:bg-white hover:text-slate-800'
                      }`}
                      aria-label="Create a team"
                      title="Create a team"
                    >
                      <PlusIcon className="h-4 w-4" />
                    </button>
                  </div>
                </div>

                <div className="ml-auto flex shrink-0 items-center gap-1">
                  <InstallButton />
                  <AccountMenu
                    email={data.user.email}
                    onOpenSettings={() => setSettingsOpen(true)}
                    onLogout={handleLogout}
                  />
                </div>
              </div>

              {isCollab && (
                <div className="mt-2.5">
                  <TeamBar
                    teams={data.teams}
                    activeTeamId={currentTeam?.id ?? null}
                    counts={openCounts.perTeam}
                    onSelect={openTeam}
                    onManage={(teamId) => setTeamModal({ teamId })}
                    onNewTeam={() => setTeamModal({ teamId: null })}
                  />
                </div>
              )}

              <div className="mt-3 flex items-center gap-3">
                {currentTeam ? (
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 text-sm font-bold text-white shadow-sm">
                    {currentTeam.name.slice(0, 1).toUpperCase()}
                  </span>
                ) : (
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-indigo-50 text-indigo-500">
                    {isCollab ? (
                      <UsersIcon className="h-5 w-5" />
                    ) : (
                      <CheckIcon className="h-5 w-5" strokeWidth={2.5} />
                    )}
                  </span>
                )}

                <div className="min-w-0 flex-1">
                  <h1 className="truncate text-xl font-bold tracking-tight">{title}</h1>
                  <p className="truncate text-xs text-slate-500">
                    {subtitle}
                    <span className="hidden sm:inline">
                      {' '}
                      ·{' '}
                      {new Date().toLocaleDateString(undefined, {
                        weekday: 'long',
                        month: 'long',
                        day: 'numeric',
                      })}
                    </span>
                  </p>
                </div>

                {currentTeam && (
                  <div className="hidden items-center md:flex">
                    <div className="flex -space-x-2">
                      {currentTeam.members.slice(0, 3).map((member) => (
                        <Avatar key={member.id} email={member.email} size="sm" />
                      ))}
                    </div>
                    {currentTeam.members.length > 3 && (
                      <span className="ml-1.5 text-[11px] font-medium text-slate-400">
                        +{currentTeam.members.length - 3}
                      </span>
                    )}
                  </div>
                )}
              </div>

              <div className="mt-3 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => setSelectedDate(todayDateValue())}
                  aria-pressed={isToday}
                  className={`inline-flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-semibold transition ${
                    isToday
                      ? 'bg-slate-900 text-white shadow-sm'
                      : 'bg-white text-slate-600 hover:bg-slate-100'
                  }`}
                >
                  <CalendarIcon className="h-3.5 w-3.5" />
                  Today
                </button>

                <div className="flex items-center gap-1 rounded-xl border border-slate-200 bg-white/90 px-1 py-0.5 shadow-sm">
                  <button
                    type="button"
                    onClick={() => {
                      const date = new Date(dueFromDateInput(selectedDate) ?? Date.now())
                      date.setDate(date.getDate() - 1)
                      setSelectedDate(dateInputValue(date.getTime()))
                    }}
                    className="rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
                    aria-label="Previous day"
                  >
                    <ChevronRightIcon className="h-3.5 w-3.5 rotate-180" />
                  </button>
                  <input
                    type="date"
                    value={selectedDate}
                    onChange={(event) => {
                      if (event.target.value) setSelectedDate(event.target.value)
                    }}
                    aria-label="View tasks for a date"
                    className="w-[9.5rem] max-w-full cursor-pointer border-0 bg-transparent px-1 py-1 text-center text-base font-semibold text-slate-700 outline-none sm:w-[8.5rem] sm:text-xs"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      const date = new Date(dueFromDateInput(selectedDate) ?? Date.now())
                      date.setDate(date.getDate() + 1)
                      setSelectedDate(dateInputValue(date.getTime()))
                    }}
                    className="rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
                    aria-label="Next day"
                  >
                    <ChevronRightIcon className="h-3.5 w-3.5" />
                  </button>
                </div>

                <button
                  type="button"
                  onClick={() => setComposerOpen((open) => !open)}
                  aria-expanded={composerOpen}
                  className={`inline-flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-semibold transition ${
                    composerOpen
                      ? 'bg-indigo-50 text-indigo-700 hover:bg-indigo-100'
                      : 'bg-indigo-600 text-white shadow-sm hover:bg-indigo-500 active:scale-[0.98]'
                  }`}
                >
                  {composerOpen ? (
                    <XIcon className="h-3.5 w-3.5" />
                  ) : (
                    <PlusIcon className="h-3.5 w-3.5" />
                  )}
                  {composerOpen ? 'Close' : 'Add task'}
                </button>

                <span className="ml-auto flex items-center gap-1.5 text-[11px] font-medium text-slate-400">
                  {formatDateValue(selectedDate)}
                </span>
              </div>
            </div>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-8">
            {data.invites.length > 0 && (
              <div className="mb-4 space-y-2">
                {data.invites.map((invite) => (
                  <div
                    key={invite.teamId}
                    className="flex flex-wrap items-center gap-3 rounded-xl border border-indigo-100 bg-indigo-50/60 px-3.5 py-2.5"
                  >
                    <p className="min-w-0 flex-1 text-xs leading-snug text-slate-600">
                      <span className="font-semibold text-slate-900">
                        {invite.invitedByEmail}
                      </span>{' '}
                      invited you to{' '}
                      <span className="font-semibold text-slate-900">
                        {invite.teamName}
                      </span>
                    </p>
                    <div className="flex shrink-0 gap-1.5">
                      <button
                        type="button"
                        onClick={() => acceptInvite(invite)}
                        className="rounded-lg bg-indigo-600 px-2.5 py-1 text-[11px] font-semibold text-white transition hover:bg-indigo-500"
                      >
                        Accept
                      </button>
                      <button
                        type="button"
                        onClick={() => declineInvite(invite)}
                        className="rounded-lg px-2.5 py-1 text-[11px] font-medium text-slate-500 transition hover:bg-white/70 hover:text-slate-700"
                      >
                        Decline
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {composerOpen && !(view.kind === 'collab' && !currentTeam) && (
              <div className="animate-in mb-4">
                <TaskComposer
                  contextLabel={currentTeam ? currentTeam.name : 'My task'}
                  teams={data.teams}
                  showTeamSelect={false}
                  defaultTeamId={currentTeam?.id ?? null}
                  defaultDue={selectedDate}
                  onAdd={async (input) => {
                    const ok = await addTask(input)
                    if (ok) setComposerOpen(false)
                    return ok
                  }}
                />
              </div>
            )}

            {!isCollab && (
              <div className="mb-5 min-w-0 space-y-4">
                <OffDayCard date={selectedDate} notify={notify} onChanged={refresh} />

                {isToday && dailyStateData && (
                  <DailyStateCard
                    state={dailyStateData}
                    checkin={checkinStatus?.checkin ?? null}
                    checkinState={checkinStatus?.state ?? 'not_asked'}
                    celebrate={checkinCelebrate}
                    onCelebrated={() => setCheckinCelebrate(false)}
                    onEditCheckin={openCheckin}
                    notify={notify}
                    onState={setDailyStateData}
                  />
                )}

                {isToday && (
                  <PredictionPanel
                    date={selectedDate}
                    today={todayDateValue()}
                    notify={notify}
                    onOpenCheckin={openCheckin}
                    refreshKey={`${checkinStatus?.checkin?.updatedAt ?? 0}:${data?.tasks.length ?? 0}`}
                  />
                )}
              </div>
            )}

            {view.kind === 'collab' && !currentTeam ? (
              <div className="animate-in flex flex-col items-center justify-center rounded-2xl border border-dashed border-slate-200 px-6 py-14 text-center">
                <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-indigo-50 text-indigo-500">
                  <UsersIcon className="h-6 w-6" />
                </div>
                <h3 className="mt-4 text-sm font-semibold text-slate-700">
                  No teams yet
                </h3>
                <p className="mt-1 max-w-xs text-sm text-slate-500">
                  Create a team to share tasks, assign work, and comment with other people.
                </p>
                <button
                  type="button"
                  onClick={() => setTeamModal({ teamId: null })}
                  className="btn-primary mt-4"
                >
                  <PlusIcon className="h-4 w-4" />
                  Create a team
                </button>
              </div>
            ) : (
              <>
                <div className="mt-4 grid grid-cols-1 items-start gap-5 md:grid-cols-[minmax(0,1fr)_16rem] xl:grid-cols-[minmax(0,1fr)_18rem]">
                  <StickyBoard
                    tasks={openTasks}
                    emptyTitle={emptyCopy.title}
                    emptyText={emptyCopy.text}
                    currentUserId={data.user.id}
                    showOwner={isCollab}
                    canDelete={canDeleteTask}
                    onOpen={(task) => setSelectedId(task.id)}
                    onToggle={toggleTask}
                    onDelete={deleteTask}
                    onReorder={reorderTasks}
                  />

                  <CompletedColumn
                    tasks={completedTasks}
                    currentUserId={data.user.id}
                    showOwner={isCollab}
                    canDelete={canDeleteTask}
                    onOpen={(task) => setSelectedId(task.id)}
                    onToggle={toggleTask}
                    onDelete={deleteTask}
                  />
                </div>
              </>
            )}

            <p className="mt-10 flex items-center justify-center gap-1.5 text-[11px] text-slate-300">
              <UsersIcon className="h-3.5 w-3.5" />
              Your personal list is private. Team lists are shared with members only.
            </p>
          </div>
        </div>
      </main>

      {selectedTask && (
        <TaskDetail
          task={selectedTask}
          currentUserId={data.user.id}
          canModerate={canModerate}
          canDelete={
            selectedTask.userId === data.user.id ||
            (selectedTask.teamId !== null &&
              data.teams.find((team) => team.id === selectedTask.teamId)?.role === 'host')
          }
          onClose={closeDetail}
          onUpdate={(patch) => updateTask(selectedTask, patch)}
          onDelete={() => deleteTask(selectedTask)}
          onAddSubtask={(text) => addSubtask(selectedTask, text)}
          onToggleSubtask={(subtask) => toggleSubtask(selectedTask, subtask)}
          onDeleteSubtask={(subtask) => deleteSubtask(selectedTask, subtask)}
          onAddComment={(text) => addComment(selectedTask, text)}
          onDeleteComment={(comment) => deleteComment(selectedTask, comment)}
        />
      )}

      {teamModal && (
        <TeamModal
          team={
            teamModal.teamId
              ? (data.teams.find((team) => team.id === teamModal.teamId) ?? null)
              : null
          }
          onClose={() => setTeamModal(null)}
          onChanged={refresh}
          notify={notify}
        />
      )}

      {settingsOpen && (
        <SettingsModal
          onClose={() => setSettingsOpen(false)}
          onPasswordChanged={() => {
            setSettingsOpen(false)
            notify('Password updated. Other devices were signed out.', 'success')
          }}
          onDeleted={handleAccountDeleted}
        />
      )}

      {checkinOpen && (
        <CheckinModal
          mode={checkinMode}
          date={checkinStatus?.date ?? localDateString()}
          initial={checkinStatus?.checkin ?? null}
          onClose={() => setCheckinOpen(false)}
          onChanged={setCheckinStatus}
          onFinished={() => setCheckinCelebrate(true)}
          notify={notify}
        />
      )}

      <div className="pointer-events-none fixed right-4 bottom-4 z-[60] flex w-[min(22rem,calc(100vw-2rem))] flex-col gap-2">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            role="status"
            className={`animate-in pointer-events-auto flex items-start gap-2.5 rounded-xl border px-3.5 py-2.5 text-sm shadow-lg backdrop-blur ${TOAST_STYLES[toast.tone]}`}
          >
            <span className="mt-0.5 shrink-0">
              {toast.tone === 'success' ? (
                <CheckIcon className="h-4 w-4" />
              ) : toast.tone === 'error' ? (
                <XIcon className="h-4 w-4" />
              ) : (
                <span className="block h-4 w-4 rounded-full border-2 border-current opacity-60" />
              )}
            </span>
            <span className="flex-1 leading-snug">{toast.message}</span>
            <button
              type="button"
              onClick={() => setToasts((current) => current.filter((item) => item.id !== toast.id))}
              className="mt-0.5 rounded p-0.5 opacity-50 transition hover:opacity-100"
              aria-label="Dismiss"
            >
              <XIcon className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
