import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, errorMessage, matchesFilter } from '@/api'
import type {
  BootstrapData,
  Comment,
  Filter,
  Priority,
  Recurrence,
  Subtask,
  Task,
  Team,
  Toast,
  ToastTone,
  UserInvite,
  View,
} from '@/types'
import { PRIORITY_FILTERS, tagTint } from '@/lib/taskmeta'
import AuthScreen from './components/AuthScreen'
import SettingsModal from './components/SettingsModal'
import Sidebar from './components/Sidebar'
import TaskComposer, { type NewTaskInput } from './components/TaskComposer'
import TaskList from './components/TaskList'
import TaskDetail from './components/TaskDetail'
import TeamModal from './components/TeamModal'
import { Avatar, Spinner } from './components/ui'
import { Logo } from './components/Logo'
import {
  CalendarIcon,
  CheckIcon,
  FlagIcon,
  MenuIcon,
  MoonIcon,
  SearchIcon,
  SunIcon,
  UsersIcon,
  XIcon,
} from './components/Icons'

const THEME_KEY = 'todo.theme'
const DAY = 24 * 60 * 60 * 1000

const FILTERS: Array<{ key: Filter; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'open', label: 'Open' },
  { key: 'today', label: 'Today' },
  { key: 'overdue', label: 'Overdue' },
  { key: 'done', label: 'Done' },
]

const TOAST_STYLES: Record<ToastTone, string> = {
  success:
    'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-200',
  error:
    'border-rose-200 bg-rose-50 text-rose-800 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-200',
  info: 'border-slate-200 bg-white text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200',
}

export default function App() {
  const [data, setData] = useState<BootstrapData | null>(null)
  const [loading, setLoading] = useState(true)
  const [view, setView] = useState<View>({ kind: 'all' })
  const [filter, setFilter] = useState<Filter>('all')
  const [priorityFilter, setPriorityFilter] = useState<Priority | 'all'>('all')
  const [tagFilter, setTagFilter] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [teamModal, setTeamModal] = useState<{ teamId: string | null } | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [toasts, setToasts] = useState<Toast[]>([])
  const [navOpen, setNavOpen] = useState(false)
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'))
  const toastId = useRef(0)

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

  const toggleTheme = useCallback(() => {
    setDark((previous) => {
      const next = !previous
      document.documentElement.classList.toggle('dark', next)
      try {
        localStorage.setItem(THEME_KEY, next ? 'dark' : 'light')
      } catch {
        /* storage can be unavailable; the class still applies */
      }
      return next
    })
  }, [])

  // Keep the current view valid if a team disappears.
  useEffect(() => {
    if (!data) return
    if (view.kind === 'team' && !data.teams.some((team) => team.id === view.teamId)) {
      setView({ kind: 'personal' })
    }
  }, [data, view])

  // Close the detail panel if its task is gone.
  useEffect(() => {
    if (selectedId && data && !data.tasks.some((task) => task.id === selectedId)) {
      setSelectedId(null)
    }
  }, [data, selectedId])

  const currentTeam: Team | undefined =
    view.kind === 'team' ? data?.teams.find((team) => team.id === view.teamId) : undefined

  const viewTasks = useMemo(() => {
    if (!data) return []
    const tasks = data.tasks
    if (view.kind === 'all') return tasks
    if (view.kind === 'personal') {
      return tasks.filter((task) => task.teamId === null && task.userId === data.user.id)
    }
    if (view.kind === 'team') {
      return tasks.filter((task) => task.teamId === view.teamId)
    }
    // "Upcoming" and "This week": open tasks with a due date from today onward.
    const now = new Date()
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
    const weekEnd = today + 7 * DAY
    return tasks.filter((task) => {
      if (task.done || task.due === null || task.due < today) return false
      return view.kind === 'week' ? task.due < weekEnd : true
    })
  }, [data, view])

  const filteredTasks = useMemo(() => {
    const query = search.trim().toLowerCase()
    return viewTasks
      .filter((task) => matchesFilter(task, filter))
      .filter((task) => priorityFilter === 'all' || task.priority === priorityFilter)
      .filter((task) => tagFilter === null || task.tags.includes(tagFilter))
      .filter((task) => {
        if (!query) return true
        return (
          task.text.toLowerCase().includes(query) ||
          task.ownerEmail.toLowerCase().includes(query) ||
          task.tags.some((tag) => tag.toLowerCase().includes(query)) ||
          task.subtasks.some((subtask) => subtask.text.toLowerCase().includes(query))
        )
      })
  }, [viewTasks, filter, search, priorityFilter, tagFilter])

  const availableTags = useMemo(() => {
    const set = new Set<string>()
    for (const task of viewTasks) for (const tag of task.tags) set.add(tag)
    return Array.from(set).sort((a, b) => a.localeCompare(b))
  }, [viewTasks])

  const filterCounts = useMemo(() => {
    const counts: Record<Filter, number> = { all: 0, open: 0, done: 0, today: 0, overdue: 0 }
    for (const task of viewTasks) {
      counts.all += 1
      for (const key of FILTERS) {
        if (key.key !== 'all' && matchesFilter(task, key.key)) counts[key.key] += 1
      }
    }
    return counts
  }, [viewTasks])

  const selectedTask = data?.tasks.find((task) => task.id === selectedId) ?? null

  const canModerate = selectedTask?.teamId
    ? data?.teams.find((team) => team.id === selectedTask.teamId)?.role === 'host'
    : true

  const resetSessionState = () => {
    setData(null)
    setSelectedId(null)
    setTeamModal(null)
    setSettingsOpen(false)
    setView({ kind: 'all' })
    setFilter('all')
    setPriorityFilter('all')
    setTagFilter(null)
    setSearch('')
    setNavOpen(false)
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

  const addTask = async (input: NewTaskInput) => {
    try {
      await api.createTask({
        text: input.text,
        teamId: view.kind === 'team' ? view.teamId : null,
        due: input.due,
        priority: input.priority,
        tags: input.tags,
        recurrence: input.recurrence,
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
      setView({ kind: 'team', teamId: invite.teamId })
      setNavOpen(false)
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
      <div className="flex h-full flex-col items-center justify-center gap-4 bg-slate-50 dark:bg-slate-950">
        <Logo />
        <Spinner className="h-5 w-5 text-indigo-500" />
        <p className="text-xs text-slate-400">Loading your lists…</p>
      </div>
    )
  }

  if (!data) {
    return (
      <AuthScreen
        dark={dark}
        onToggleTheme={toggleTheme}
        onAuthed={async () => {
          await refresh()
        }}
      />
    )
  }

  const smartTitle =
    view.kind === 'all'
      ? 'All tasks'
      : view.kind === 'upcoming'
        ? 'Upcoming'
        : view.kind === 'week'
          ? 'This week'
          : 'Personal'

  const title = currentTeam ? currentTeam.name : smartTitle
  const subtitle = currentTeam
    ? `${currentTeam.members.length} ${currentTeam.members.length === 1 ? 'member' : 'members'} · shared list`
    : view.kind === 'personal'
      ? 'Your private list'
      : 'Everything across your personal list and teams'

  const emptyCopy = search.trim()
    ? {
        title: 'No matches',
        text: 'Try a different word, or clear the search to see everything.',
      }
    : filter === 'today'
      ? { title: 'Nothing due today', text: 'Enjoy the breathing room — or add something for today.' }
      : filter === 'overdue'
        ? { title: 'Nothing overdue', text: 'You are on top of everything. Nicely done.' }
        : filter === 'done'
          ? { title: 'No completed tasks', text: 'Finished tasks will collect here.' }
          : filter === 'open'
            ? { title: 'All caught up', text: 'There is nothing open in this list right now.' }
            : {
                title: 'A fresh start',
                text: 'Add your first task above — small steps add up.',
              }

  const closeDetail = () => setSelectedId(null)

  return (
    <div className="flex h-full overflow-hidden bg-slate-50 dark:bg-slate-950">
      <div className="hidden h-full shrink-0 lg:block">
        <Sidebar
          data={data}
          view={view}
          onSelectView={(next) => {
            setView(next)
            setFilter('all')
            setPriorityFilter('all')
            setTagFilter(null)
            setSearch('')
            setNavOpen(false)
          }}
          onNewTeam={() => {
            setTeamModal({ teamId: null })
            setNavOpen(false)
          }}
          onManageTeam={(teamId) => {
            setTeamModal({ teamId })
            setNavOpen(false)
          }}
          onAcceptInvite={acceptInvite}
          onDeclineInvite={declineInvite}
          onOpenSettings={() => {
            setSettingsOpen(true)
            setNavOpen(false)
          }}
          onLogout={handleLogout}
          onClose={() => setNavOpen(false)}
        />
      </div>

      {navOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div
            className="animate-fade absolute inset-0 bg-slate-950/50 backdrop-blur-sm"
            onClick={() => setNavOpen(false)}
          />
          <div className="animate-in absolute inset-y-0 left-0 shadow-2xl">
            <Sidebar
              data={data}
              view={view}
              onSelectView={(next) => {
                setView(next)
                setFilter('all')
                setPriorityFilter('all')
                setTagFilter(null)
                setSearch('')
                setNavOpen(false)
              }}
              onNewTeam={() => {
                setTeamModal({ teamId: null })
                setNavOpen(false)
              }}
              onManageTeam={(teamId) => {
                setTeamModal({ teamId })
                setNavOpen(false)
              }}
              onAcceptInvite={acceptInvite}
              onDeclineInvite={declineInvite}
              onOpenSettings={() => {
                setSettingsOpen(true)
                setNavOpen(false)
              }}
              onLogout={handleLogout}
              onClose={() => setNavOpen(false)}
            />
          </div>
        </div>
      )}

      <main className="flex min-w-0 flex-1 flex-col">
        <header className="shrink-0 border-b border-slate-200 bg-white/85 backdrop-blur dark:border-slate-800 dark:bg-slate-900/80">
          <div className="mx-auto w-full max-w-3xl px-4 pt-4 pb-3 sm:px-8">
            <div className="flex items-center gap-3">
              <button
                type="button"
                className="icon-btn lg:hidden"
                onClick={() => setNavOpen(true)}
                aria-label="Open menu"
              >
                <MenuIcon className="h-5 w-5" />
              </button>

              {currentTeam ? (
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 text-sm font-bold text-white shadow-sm">
                  {currentTeam.name.slice(0, 1).toUpperCase()}
                </span>
              ) : (
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-indigo-50 text-indigo-500 dark:bg-indigo-500/10 dark:text-indigo-400">
                  <CheckIcon className="h-5 w-5" strokeWidth={2.5} />
                </span>
              )}

              <div className="min-w-0 flex-1">
                <h1 className="truncate text-xl font-bold tracking-tight">{title}</h1>
                <p className="truncate text-xs text-slate-500 dark:text-slate-400">
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

              <div className="relative hidden sm:block">
                <SearchIcon className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search tasks…"
                  className="w-44 rounded-xl border border-slate-200 bg-slate-50 py-2 pr-8 pl-9 text-sm outline-none transition focus:w-56 focus:border-indigo-400 focus:bg-white focus:ring-4 focus:ring-indigo-500/10 dark:border-slate-700 dark:bg-slate-800/60 dark:focus:bg-slate-900"
                />
                {search && (
                  <button
                    type="button"
                    onClick={() => setSearch('')}
                    className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-0.5 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
                    aria-label="Clear search"
                  >
                    <XIcon className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>

              {currentTeam ? (
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
              ) : (
                <button
                  type="button"
                  onClick={toggleTheme}
                  className="icon-btn hidden lg:inline-flex"
                  aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'}
                  title={dark ? 'Light mode' : 'Dark mode'}
                >
                  {dark ? <SunIcon className="h-4.5 w-4.5" /> : <MoonIcon className="h-4.5 w-4.5" />}
                </button>
              )}
            </div>

            <div className="mt-3 flex items-center gap-1 overflow-x-auto pb-0.5">
              {FILTERS.map(({ key, label }) => {
                const active = filter === key
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setFilter(key)}
                    className={`flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold transition ${
                      active
                        ? 'bg-slate-900 text-white shadow-sm dark:bg-white dark:text-slate-900'
                        : key === 'overdue' && filterCounts.overdue > 0
                          ? 'text-rose-600 hover:bg-rose-50 dark:text-rose-400 dark:hover:bg-rose-500/10'
                          : 'text-slate-500 hover:bg-slate-100 hover:text-slate-800 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200'
                    }`}
                  >
                    {key === 'today' && <CalendarIcon className="h-3.5 w-3.5" />}
                    {label}
                    <span
                      className={`rounded px-1 text-[10px] ${
                        active
                          ? 'bg-white/20 text-white dark:bg-slate-900/10 dark:text-slate-900'
                          : 'bg-slate-100 text-slate-400 dark:bg-slate-800 dark:text-slate-500'
                      }`}
                    >
                      {filterCounts[key]}
                    </span>
                  </button>
                )
              })}
            </div>

            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <label className="relative flex items-center">
                <FlagIcon className="pointer-events-none absolute left-2 h-3.5 w-3.5 text-slate-400" />
                <select
                  value={priorityFilter}
                  onChange={(event) => setPriorityFilter(event.target.value as Priority | 'all')}
                  className="cursor-pointer appearance-none rounded-lg border border-slate-200 bg-white py-1.5 pr-2.5 pl-7 text-xs font-medium text-slate-600 outline-none transition hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800"
                  aria-label="Filter by priority"
                >
                  {PRIORITY_FILTERS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>

              {availableTags.map((tag) => {
                const active = tagFilter === tag
                return (
                  <button
                    key={tag}
                    type="button"
                    onClick={() => setTagFilter(active ? null : tag)}
                    className={`rounded-lg px-2 py-1.5 text-xs font-medium transition ${
                      active
                        ? tagTint(tag)
                        : 'text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800'
                    }`}
                  >
                    #{tag}
                  </button>
                )
              })}

              {(priorityFilter !== 'all' || tagFilter !== null) && (
                <button
                  type="button"
                  onClick={() => {
                    setPriorityFilter('all')
                    setTagFilter(null)
                  }}
                  className="rounded-lg px-2 py-1.5 text-xs font-semibold text-indigo-600 transition hover:bg-indigo-50 dark:text-indigo-400 dark:hover:bg-indigo-500/10"
                >
                  Clear filters
                </button>
              )}
            </div>

            <div className="relative mt-3 sm:hidden">
              <SearchIcon className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search tasks…"
                className="field py-2 pl-9 text-sm"
              />
            </div>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-8">
            <TaskComposer
              contextLabel={currentTeam ? currentTeam.name : 'Personal'}
              onAdd={addTask}
            />

            <TaskList
              tasks={filteredTasks}
              currentUserId={data.user.id}
              showOwner={view.kind !== 'personal'}
              emptyTitle={emptyCopy.title}
              emptyText={emptyCopy.text}
              canDelete={(task) =>
                task.userId === data.user.id ||
                (task.teamId !== null &&
                  data.teams.find((team) => team.id === task.teamId)?.role === 'host')
              }
              onOpen={(task) => setSelectedId(task.id)}
              onToggle={toggleTask}
              onDelete={deleteTask}
            />

            <p className="mt-10 flex items-center justify-center gap-1.5 text-[11px] text-slate-300 dark:text-slate-600">
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
