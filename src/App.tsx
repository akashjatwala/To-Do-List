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
import { dateInputValue, dueFromDateInput, todayDateValue } from '@/lib/date'
import { greetingForHour, localDateString } from '@/lib/checkin'
import { repeatsOnDate } from '@/lib/taskmeta'
import AuthScreen from './components/AuthScreen'
import AccountMenu from './components/AccountMenu'
import InstallButton from './components/InstallButton'
import MyAccountDialog from './components/MyAccountDialog'
import CheckinModal from './components/CheckinModal'
import DailyStateCard from './components/DailyStateCard'
import OffDayCard from './components/OffDayCard'
import PredictionPanel from './components/PredictionPanel'
import OverdueCard from './components/OverdueCard'
import NewTaskDialog, { type NewTaskInput } from './components/NewTaskDialog'
import { CompletedColumn, RepeatingColumn, StickyBoard } from './components/StickyBoard'
import TaskDetail from './components/TaskDetail'
import TeamBar from './components/TeamBar'
import TeamModal from './components/TeamModal'
import { TeamInvitationsCard, TeamMembersCard } from './components/TeamSidebarCards'
import { Spinner } from './components/ui'
import { Logo } from './components/Logo'
import {
  CheckIcon,
  ChevronRightIcon,
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
  const [taskDialogOpen, setTaskDialogOpen] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [teamModal, setTeamModal] = useState<{ teamId: string | null } | null>(null)
  const [accountOpen, setAccountOpen] = useState(false)
  const [toasts, setToasts] = useState<Toast[]>([])
  const [checkinStatus, setCheckinStatus] = useState<CheckinStatus | null>(null)
  const [checkinOpen, setCheckinOpen] = useState(false)
  const [checkinMode, setCheckinMode] = useState<'prompt' | 'edit'>('prompt')
  const [checkinCelebrate, setCheckinCelebrate] = useState(false)
  const [dailyStateData, setDailyStateData] = useState<DailyState | null>(null)
  // The header clock reads from a ticking value, not from render time, so it
  // keeps up with the system clock while the app stays open.
  const [now, setNow] = useState(() => new Date())
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

  // Keep the header clock and greeting in step with the system clock.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 10_000)
    return () => window.clearInterval(timer)
  }, [])

  // A different date or team means the dialog's defaults are no longer valid.
  useEffect(() => {
    setTaskDialogOpen(false)
  }, [view, selectedDate])

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
    if (view.kind !== 'collab' || !view.teamId) return []
    return data.tasks.filter((task) => task.teamId === view.teamId)
  }, [data, view])

  const dateTasks = useMemo(
    () =>
      viewTasks.filter((task) =>
        task.recurrence === 'none'
          ? task.due !== null && dateInputValue(task.due) === selectedDate
          : repeatsOnDate(task.due, task.recurrence, task.recurrenceConfig, selectedDate),
      ),
    [viewTasks, selectedDate],
  )

  // Both boards are date-scoped. A repeat is projected onto every matching
  // future date (it stays in the Repeating card too); completing it is still a
  // single shared task, so a team sees the same note on the same day.
  const boardTasks = dateTasks
  const openTasks = useMemo(() => boardTasks.filter((task) => !task.done), [boardTasks])
  const completedTasks = useMemo(() => boardTasks.filter((task) => task.done), [boardTasks])
  // Repeats are ongoing routines, so they are listed regardless of the chosen day.
  const repeatingTasks = useMemo(
    () => viewTasks.filter((task) => task.recurrence !== 'none'),
    [viewTasks],
  )

  const todayValue = todayDateValue()
  const isToday = selectedDate === todayValue

  // Open personal tasks whose due date has passed, oldest first.
  const overdueTasks = useMemo(
    () =>
      viewTasks
        .filter(
          (task) =>
            task.teamId === null && !task.done && task.due !== null && dateInputValue(task.due) < todayValue,
        )
        .sort((a, b) => a.due! - b.due!),
    [viewTasks, todayValue],
  )

  // The same reminder for a team board, limited to the selected team.
  const teamOverdueTasks = useMemo(
    () =>
      viewTasks
        .filter(
          (task) =>
            task.teamId !== null && !task.done && task.due !== null && dateInputValue(task.due) < todayValue,
        )
        .sort((a, b) => a.due! - b.due!),
    [viewTasks, todayValue],
  )

  const memberOpenCounts = useMemo(() => {
    const counts: Record<number, number> = {}
    for (const task of viewTasks) {
      if (task.done || task.recurrence !== 'none') continue
      counts[task.userId] = (counts[task.userId] ?? 0) + 1
    }
    return counts
  }, [viewTasks])

  const teamStats = useMemo(() => {
    // Match the board: the day's tasks, including repeats due on this date.
    const done = dateTasks.filter((task) => task.done).length
    return {
      total: dateTasks.length,
      done,
      open: dateTasks.length - done,
      percent: dateTasks.length === 0 ? 0 : Math.round((done / dateTasks.length) * 100),
    }
  }, [dateTasks])

  const selectedTask = data?.tasks.find((task) => task.id === selectedId) ?? null

  const canModerate = selectedTask?.teamId
    ? data?.teams.find((team) => team.id === selectedTask.teamId)?.role === 'host'
    : true

  const resetSessionState = () => {
    setData(null)
    setSelectedId(null)
    setTeamModal(null)
    setView({ kind: 'my' })
    setSelectedDate(todayDateValue())
    setTaskDialogOpen(false)
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

  const moveOverdueToToday = async (task: Task) => {
    const moved = await updateTask(task, { due: dueFromDateInput(todayValue) })
    if (moved) notify(`Moved “${task.text}” to today.`, 'success')
  }

  const setAssignees = async (task: Task, userIds: number[]) => {
    try {
      await api.setTaskAssignees(task.id, userIds)
      await refresh()
      return true
    } catch (error) {
      notify(errorMessage(error), 'error')
      return false
    }
  }

  const addSubtask = async (task: Task, text: string, assigneeId: number | null) => {
    try {
      await api.addSubtask(task.id, text, assigneeId)
      await refresh()
      return true
    } catch (error) {
      notify(errorMessage(error), 'error')
      return false
    }
  }

  const assignSubtask = async (task: Task, subtask: Subtask, assigneeId: number | null) => {
    try {
      await api.updateSubtask(task.id, subtask.id, { assigneeId })
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

  const accountName =
    data.user.name.trim() ||
    data.user.email
      .split('@')[0]
      .replace(/^./, (char) => char.toUpperCase())
  const currentHour = now.getHours()
  const clockLabel = `${`${now.getHours()}`.padStart(2, '0')}:${`${now.getMinutes()}`.padStart(2, '0')}`
  const longDateLabel = (() => {
    const timestamp = dueFromDateInput(selectedDate)
    if (timestamp === null) return ''
    return new Date(timestamp).toLocaleDateString(undefined, {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
    })
  })()
  const doneCount = completedTasks.length
  const totalCount = dateTasks.length
  const donePercent = totalCount === 0 ? 0 : Math.round((doneCount / totalCount) * 100)
  const remainingMinutes = openTasks.reduce((total, task) => total + (task.duration ?? 0), 0)
  const remainingLabel =
    remainingMinutes < 60
      ? `${remainingMinutes} min left`
      : `${Math.floor(remainingMinutes / 60)} h ${remainingMinutes % 60} min left`

  // Personal notes belong to the signed-in user. Team notes are host-only:
  // this gates the note's trash icon and the delete button in task detail.
  const canDeleteTask = (task: Task) =>
    task.teamId === null
      ? task.userId === data.user.id
      : data.teams.find((team) => team.id === task.teamId)?.role === 'host'

  const emptyCopy =
    view.kind === 'collab' && viewTasks.length === 0
      ? {
          title: 'No tasks yet',
          text: 'Add a task to get this team started.',
        }
      : view.kind === 'collab'
        ? {
            title: 'Nothing scheduled',
            text: 'Nothing is due for this team on this date. Pick another date, or add a task for it above.',
          }
        : isToday
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
    <div className="min-h-full bg-canvas">
      <main className="min-w-0">
        <header className="bg-white">
          <div className="flex h-[75px] items-center justify-between border-b border-[#E1E2E0] px-4 sm:px-8 lg:px-12">
            <div className="flex items-center gap-8 sm:gap-12">
              <button
                type="button"
                onClick={openMyTasks}
                className="text-[26px] font-extrabold tracking-tight text-[#15181E]"
                aria-label="DUIT home"
              >
                DUIT<span className="text-indigo-500">.</span>
              </button>

              <nav className="flex items-center gap-1 sm:gap-3" aria-label="Main">
                <button
                  type="button"
                  onClick={openMyTasks}
                  aria-pressed={view.kind === 'my'}
                  className={`flex h-[34px] items-center rounded-full px-5 text-sm font-semibold transition ${
                    view.kind === 'my'
                      ? 'bg-[#15181E] text-white'
                      : 'text-[#454B58] hover:bg-slate-50 hover:text-[#15181E]'
                  }`}
                >
                  My tasks
                </button>
                <button
                  type="button"
                  onClick={openCollaborate}
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

            <AccountMenu
              name={data.user.name}
              email={data.user.email}
              onOpenAccount={() => {
                setTaskDialogOpen(false)
                setSelectedId(null)
                setAccountOpen(true)
              }}
              onLogout={handleLogout}
            />
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
                      setSelectedDate(dateInputValue(date.getTime()))
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
                        if (event.target.value) setSelectedDate(event.target.value)
                      }}
                      onClick={(event) => event.currentTarget.showPicker?.()}
                      aria-label="View tasks for a date"
                      className="sr-only"
                    />
                  </label>

                  <button
                    type="button"
                    onClick={() => setSelectedDate(todayValue)}
                    disabled={isToday}
                    aria-label="Go to today"
                    className="ml-1 rounded-full border border-[#E3E1DC] bg-white/70 px-2.5 py-0.5 text-[11px] font-semibold text-[#5C4B22] transition hover:bg-white focus-visible:ring-2 focus-visible:ring-[#4A2C8A]/30 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-white/70"
                  >
                    Today
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      const date = new Date(dueFromDateInput(selectedDate) ?? Date.now())
                      date.setDate(date.getDate() + 1)
                      setSelectedDate(dateInputValue(date.getTime()))
                    }}
                    aria-label="Next day"
                    className="rounded-md p-1 text-[#92969C] opacity-0 transition hover:bg-black/5 hover:text-[#454B58] focus-visible:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100"
                  >
                    <ChevronRightIcon className="h-3.5 w-3.5" />
                  </button>
                </div>
                </div>

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
                            onClick={() => setTeamModal({ teamId: null })}
                            className="w-full rounded-[12px] bg-[#D9480F] px-4 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-[#C23E0C] active:scale-[0.98]"
                          >
                            New team
                          </button>
                          {currentTeam && (
                            <button
                              type="button"
                              onClick={() => setTaskDialogOpen(true)}
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

                        <InstallButton />

                        <button
                          type="button"
                          onClick={() => setTaskDialogOpen(true)}
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
                      teams={data.teams}
                      activeTeamId={currentTeam?.id ?? null}
                      onSelect={openTeam}
                      onManage={(teamId) => setTeamModal({ teamId })}
                    />
                  </div>
                )}
            </div>
          </div>
        </header>

        <div>
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
              </div>
            ) : (
              <>
                <div className="mt-4 grid grid-cols-1 items-start gap-5 md:grid-cols-[minmax(0,1fr)_19rem] xl:grid-cols-[minmax(0,1fr)_21rem]">
                  <div className="min-w-0">
                    <div className="mb-4">
                      <h2 className="text-xl font-extrabold tracking-tight text-[#15181E]">
                        Tasks and plan
                      </h2>
                    </div>

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
                  </div>

                  <div className="flex min-w-0 flex-col gap-3">
                    {!isCollab && (
                      <>
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

                        <OverdueCard
                          tasks={overdueTasks}
                          today={todayValue}
                          onOpen={(task) => setSelectedId(task.id)}
                          onDone={(task) => void toggleTask(task)}
                          onMoveToToday={(task) => void moveOverdueToToday(task)}
                        />

                        <OffDayCard date={selectedDate} notify={notify} onChanged={refresh} />

                        {isToday && (
                          <PredictionPanel
                            date={selectedDate}
                            today={todayDateValue()}
                            notify={notify}
                            refreshKey={`${checkinStatus?.checkin?.updatedAt ?? 0}:${data?.tasks.length ?? 0}`}
                          />
                        )}
                      </>
                    )}

                    {isCollab && currentTeam && (
                      <>
                        <TeamMembersCard
                          team={currentTeam}
                          currentUserId={data.user.id}
                          openCounts={memberOpenCounts}
                          notify={notify}
                          onChanged={refresh}
                        />
                        <TeamInvitationsCard
                          team={currentTeam}
                          invites={data.invites}
                          onAccept={acceptInvite}
                          onDecline={declineInvite}
                          notify={notify}
                          onChanged={refresh}
                        />
                        <OverdueCard
                          tasks={teamOverdueTasks}
                          today={todayValue}
                          showAssignees
                          onOpen={(task) => setSelectedId(task.id)}
                          onDone={(task) => void toggleTask(task)}
                          onMoveToToday={(task) => void moveOverdueToToday(task)}
                        />
                      </>
                    )}

                    <CompletedColumn
                      tasks={completedTasks}
                      currentUserId={data.user.id}
                      showOwner={isCollab}
                      canDelete={canDeleteTask}
                      onOpen={(task) => setSelectedId(task.id)}
                      onToggle={toggleTask}
                      onDelete={deleteTask}
                    />

                    <RepeatingColumn
                      tasks={repeatingTasks}
                      currentUserId={data.user.id}
                      showOwner={isCollab}
                      canDelete={() => false}
                      onOpen={(task) => setSelectedId(task.id)}
                      onToggle={toggleTask}
                      onDelete={deleteTask}
                    />
                  </div>
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

      <NewTaskDialog
        open={taskDialogOpen}
        onClose={() => setTaskDialogOpen(false)}
        teams={data.teams}
        historyTasks={data.tasks}
        defaultTeamId={currentTeam?.id ?? null}
        defaultDue={selectedDate}
        onAdd={addTask}
      />

      <MyAccountDialog
        open={accountOpen}
        onClose={() => setAccountOpen(false)}
        user={data.user}
        teams={data.teams}
        onUserChanged={(nextUser) =>
          setData((current) => (current ? { ...current, user: nextUser } : current))
        }
        onPasswordChanged={async () => {
          await refresh()
          notify('Password updated. Other devices were signed out.', 'success')
        }}
        onDeleted={handleAccountDeleted}
        notify={notify}
      />

      {selectedTask && (
        <TaskDetail
          task={selectedTask}
          currentUserId={data.user.id}
          canModerate={canModerate}
          canDelete={canDeleteTask(selectedTask)}
          members={
            selectedTask.teamId
              ? (data.teams.find((team) => team.id === selectedTask.teamId)?.members ?? [])
              : []
          }
          onClose={closeDetail}
          onUpdate={(patch) => updateTask(selectedTask, patch)}
          onSetAssignees={(userIds) => setAssignees(selectedTask, userIds)}
          onDelete={() => deleteTask(selectedTask)}
          onAddSubtask={(text, assigneeId) => addSubtask(selectedTask, text, assigneeId)}
          onToggleSubtask={(subtask) => toggleSubtask(selectedTask, subtask)}
          onAssignSubtask={(subtask, assigneeId) => assignSubtask(selectedTask, subtask, assigneeId)}
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
          user={data.user}
          openTaskCount={
            teamModal.teamId
              ? data.tasks.filter(
                  (task) =>
                    task.teamId === teamModal.teamId &&
                    !task.done &&
                    task.recurrence === 'none',
                ).length
              : 0
          }
          onClose={() => setTeamModal(null)}
          onChanged={refresh}
          notify={notify}
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
