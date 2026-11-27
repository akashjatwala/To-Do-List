import { useCallback, useEffect, useMemo, useState } from 'react'
import { api, errorMessage } from '@/api'
import type { AppNotification, BootstrapData, Task } from '@/types'
import { todayDateValue } from '@/lib/date'
import { localDateString } from '@/lib/checkin'
import { RefreshCoalescer } from '@/lib/refreshCoalescer'
import { canDeleteTaskForUser, offDayDateSet, selectBoardModel } from '@/lib/taskBoard'
import AuthScreen from './components/AuthScreen'
import AppHeader from './components/AppHeader'
import AppSidebar from './components/AppSidebar'
import MyAccountDialog from './components/MyAccountDialog'
import CheckinModal from './components/CheckinModal'
import NewTaskDialog, { type NewTaskDraft } from './components/NewTaskDialog'
import CompletedTasksDialog from './components/CompletedTasksDialog'
import OverdueTasksDialog from './components/OverdueTasksDialog'
import RepeatingTasksDialog from './components/RepeatingTasksDialog'
import SearchDialog from './components/SearchDialog'
import { StickyBoard } from './components/StickyBoard'
import TaskDetail from './components/TaskDetail'
import TeamModal from './components/TeamModal'
import ToastViewport from './components/ToastViewport'
import { Spinner } from './components/ui'
import { Logo } from './components/Logo'
import { UsersIcon } from './components/Icons'
import { useCheckinController } from './hooks/useCheckinController'
import { useTaskMutations } from './hooks/useTaskMutations'
import { useToasts } from './hooks/useToasts'
import { useViewNavigation } from './hooks/useViewNavigation'

export default function App() {
  const [data, setData] = useState<BootstrapData | null>(null)
  const [loading, setLoading] = useState(true)
  const [taskDialogOpen, setTaskDialogOpen] = useState(false)
  const [taskDraft, setTaskDraft] = useState<NewTaskDraft | null>(null)
  const [overdueOpen, setOverdueOpen] = useState(false)
  const [completedOpen, setCompletedOpen] = useState(false)
  const [repeatingOpen, setRepeatingOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [notifications, setNotifications] = useState<AppNotification[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [teamModal, setTeamModal] = useState<{ teamId: string | null } | null>(null)
  const [accountOpen, setAccountOpen] = useState(false)
  const { toasts, notify, dismiss: dismissToast } = useToasts()
  const {
    view,
    setView,
    selectedDate,
    setSelectedDate,
    currentTeam,
    isToday,
    openMyTasks,
    openCollaborate,
    openTeam,
    resetViewState,
  } = useViewNavigation(data, setTaskDialogOpen)

  const refreshCoalescer = useMemo(
    () =>
      new RefreshCoalescer<BootstrapData>(
        () => api.bootstrap(),
        (next) => setData(next),
      ),
    [setData],
  )
  const loadNotifications = useCallback(async () => {
    try {
      const result = await api.listNotifications()
      setNotifications(result.items)
    } catch {
      // Keep the last known list; the next successful refresh will retry.
    }
  }, [])

  const refresh = useCallback(async (): Promise<void> => {
    await refreshCoalescer.refresh()
    await loadNotifications()
  }, [refreshCoalescer, loadNotifications])

  useEffect(() => {
    let cancelled = false
    api
      .bootstrap()
      .then((next) => {
        if (!cancelled) {
          setData(next)
          void loadNotifications()
        }
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
  }, [loadNotifications, notify])

  const currentUserId = data?.user.id ?? null
  const {
    checkinStatus,
    setCheckinStatus,
    checkinOpen,
    setCheckinOpen,
    checkinMode,
    checkinCelebrate,
    setCheckinCelebrate,
    dailyStateData,
    refreshDailyState,
    openCheckin,
    resetCheckinState,
  } = useCheckinController({
    currentUserId,
    selectedDate,
    viewKind: view.kind,
    notify,
  })

  // Close the detail panel if its task is gone.
  useEffect(() => {
    if (selectedId && data && !data.tasks.some((task) => task.id === selectedId)) {
      setSelectedId(null)
    }
  }, [data, selectedId])

  const todayValue = todayDateValue()
  const offDayDates = useMemo(() => offDayDateSet(data?.offDays ?? []), [data?.offDays])
  const {
    viewTasks,
    dateTasks,
    openTasks,
    completedTasks,
    repeatingTasks,
    overdueTasks,
    teamOverdueTasks,
    teamStats,
  } = useMemo(
    () =>
      selectBoardModel(data?.tasks ?? [], view, selectedDate, { offDayDates }),
    [data?.tasks, offDayDates, view, selectedDate],
  )

  const selectedTask = data?.tasks.find((task) => task.id === selectedId) ?? null

  const overdueTasksForScope =
    view.kind === 'collab' ? teamOverdueTasks : overdueTasks
  const scopedReminders = useMemo(() => {
    const visibleIds = new Set(viewTasks.map((task) => task.id))
    return (data?.reminders ?? []).filter((reminder) => visibleIds.has(reminder.taskId)).slice(0, 3)
  }, [data?.reminders, viewTasks])

  const sendReminder = async (task: Task) => {
    try {
      await api.sendReminder(task.id)
      await refresh()
      notify('Reminder sent.', 'success')
    } catch {
      notify('Could not send the reminder.', 'error')
    }
  }

  const canModerate = selectedTask?.teamId
    ? data?.teams.find((team) => team.id === selectedTask.teamId)?.role === 'host'
    : true

  const resetSessionState = () => {
    refreshCoalescer.invalidate()
    setData(null)
    setNotifications([])
    setSelectedId(null)
    setTeamModal(null)
    setTaskDialogOpen(false)
    setTaskDraft(null)
    setOverdueOpen(false)
    setSearchOpen(false)
    resetViewState()
    resetCheckinState()
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

  const {
    addTask,
    toggleTask,
    deleteTask,
    skipTaskDay,
    reorderTasks,
    updateTask,
    setAssignees,
    addSubtask,
    assignSubtask,
    toggleSubtask,
    deleteSubtask,
    addComment,
    deleteComment,
    acceptInvite,
    declineInvite,
  } = useTaskMutations({ refresh, notify, todayValue, selectedDate, setData, setSelectedId, setView })

  // Stable identities let the memoized sticky board skip renders caused by
  // unrelated dialog, check-in or toast state.
  const openTask = useCallback((task: Task) => setSelectedId(task.id), [])
  const openNotificationTask = useCallback((taskId: string) => setSelectedId(taskId), [setSelectedId])
  const undoMove = useCallback(
    async (taskId: string, eventId: number) => {
      try {
        const result = await api.undoTaskSkip(taskId, eventId)
        await refresh()
        setSelectedDate(result.item.fromDate)
        notify('Skip undone. The task is back on its earlier date.', 'success')
      } catch (error) {
        notify(errorMessage(error), 'error')
      }
    },
    [refresh, setSelectedDate, notify],
  )
  const canDeleteTask = useCallback(
    (task: Task) => (data ? canDeleteTaskForUser(task, data.user.id, data.teams) : false),
    [data],
  )
  const openSearchTask = useCallback(
    (task: Task) => {
      setSearchOpen(false)
      setSelectedId(task.id)
    },
    [setSelectedId],
  )
  const openNewTask = useCallback(() => {
    setTaskDraft(null)
    setTaskDialogOpen(true)
  }, [])

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

  const doneCount = completedTasks.length
  const totalCount = dateTasks.length
  const donePercent = totalCount === 0 ? 0 : Math.round((doneCount / totalCount) * 100)
  const remainingMinutes = openTasks.reduce((total, task) => total + (task.duration ?? 0), 0)
  const remainingLabel =
    remainingMinutes < 60
      ? `${remainingMinutes} min left`
      : `${Math.floor(remainingMinutes / 60)} h ${remainingMinutes % 60} min left`

  const hasTeamTasks =
    view.kind === 'collab' && view.teamId
      ? (data.tasks.some((task) => task.teamId === view.teamId) ?? false)
      : false
  const emptyCopy =
    view.kind === 'collab' && !hasTeamTasks
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
        <AppHeader
          user={data.user}
          teams={data.teams}
          viewKind={view.kind}
          isCollab={isCollab}
          currentTeam={currentTeam}
          selectedDate={selectedDate}
          doneCount={doneCount}
          totalCount={totalCount}
          donePercent={donePercent}
          remainingLabel={remainingLabel}
          teamStats={teamStats}
          onOpenMyTasks={openMyTasks}
          onOpenCollaborate={openCollaborate}
          onSelectTeam={openTeam}
          onManageTeam={(teamId) => setTeamModal({ teamId })}
          notifications={notifications}
          invites={data.invites}
          onAcceptInvite={acceptInvite}
          onDeclineInvite={declineInvite}
          onOpenNotificationTask={openNotificationTask}
          onUndoMove={undoMove}
          onOpenSearch={() => setSearchOpen(true)}
          onOpenAccount={() => {
            setTaskDialogOpen(false)
            setSelectedId(null)
            setAccountOpen(true)
          }}
          onLogout={handleLogout}
          onSetSelectedDate={setSelectedDate}
          onNewTeam={() => setTeamModal({ teamId: null })}
          onAddTask={openNewTask}
        />

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
                    <h2 className="mb-4 text-xl font-extrabold tracking-tight text-[#15181E]">
                      Tasks and plan
                    </h2>

                    <StickyBoard
                      tasks={openTasks}
                      emptyTitle={emptyCopy.title}
                      emptyText={emptyCopy.text}
                      currentUserId={data.user.id}
                      showOwner={isCollab}
                      canDelete={canDeleteTask}
                      onOpen={openTask}
                      onToggle={toggleTask}
                      onDelete={deleteTask}
                      onReorder={reorderTasks}
                    />
                  </div>

                  <AppSidebar
                    isCollab={isCollab}
                    isToday={isToday}
                    todayValue={todayValue}
                    selectedDate={selectedDate}
                    data={data}
                    currentTeam={currentTeam}
                    dailyStateData={dailyStateData}
                    checkinStatus={checkinStatus}
                    checkinCelebrate={checkinCelebrate}
                    overdueTasks={overdueTasks}
                    teamOverdueTasks={teamOverdueTasks}
                    reminders={scopedReminders}
                    completedTasks={completedTasks}
                    repeatingTasks={repeatingTasks}
                    notify={notify}
                    refresh={refresh}
                    onCelebrated={() => setCheckinCelebrate(false)}
                    onEditCheckin={openCheckin}
                    onRefreshDailyState={refreshDailyState}
                    onAcceptInvite={acceptInvite}
                    onDeclineInvite={declineInvite}
                    onViewAllOverdue={() => setOverdueOpen(true)}
                    onViewAllCompleted={() => setCompletedOpen(true)}
                    onViewAllRepeating={() => setRepeatingOpen(true)}
                  />
                </div>
              </>
            )}
          </div>
        </div>
      </main>

      <NewTaskDialog
        open={taskDialogOpen}
        onClose={() => {
          setTaskDialogOpen(false)
          setTaskDraft(null)
        }}
        teams={data.teams}
        historyTasks={data.tasks}
        userId={data.user.id}
        userEmail={data.user.email}
        defaultTeamId={currentTeam?.id ?? null}
        defaultDue={selectedDate}
        initialDraft={taskDraft}
        onAdd={addTask}
      />

      <SearchDialog
        open={searchOpen}
        tasks={data.tasks}
        teams={data.teams}
        currentUserId={data.user.id}
        todayValue={todayValue}
        canDelete={canDeleteTask}
        onClose={() => setSearchOpen(false)}
        onOpenTask={openSearchTask}
        onToggleTask={(task) => void toggleTask(task)}
        onDeleteTask={(task) => void deleteTask(task)}
      />

      <OverdueTasksDialog
        open={overdueOpen}
        tasks={overdueTasksForScope}
        currentUserId={data.user.id}
        showOwner={isCollab}
        canDelete={canDeleteTask}
        onClose={() => setOverdueOpen(false)}
        onOpenTask={(task) => {
          setOverdueOpen(false)
          setSelectedId(task.id)
        }}
        onToggleTask={(task) => void toggleTask(task)}
        onDeleteTask={(task) => void deleteTask(task)}
        onRemind={(task) => void sendReminder(task)}
      />

      <CompletedTasksDialog
        open={completedOpen}
        tasks={completedTasks}
        currentUserId={data.user.id}
        showOwner={isCollab}
        canDelete={canDeleteTask}
        onClose={() => setCompletedOpen(false)}
        onOpenTask={(task) => {
          setCompletedOpen(false)
          setSelectedId(task.id)
        }}
        onToggleTask={(task) => void toggleTask(task)}
        onDeleteTask={(task) => void deleteTask(task)}
      />

      <RepeatingTasksDialog
        open={repeatingOpen}
        tasks={repeatingTasks}
        currentUserId={data.user.id}
        showOwner={isCollab}
        canDelete={canDeleteTask}
        onClose={() => setRepeatingOpen(false)}
        onOpenTask={(task) => {
          setRepeatingOpen(false)
          setSelectedId(task.id)
        }}
        onToggleTask={(task) => void toggleTask(task)}
        onDeleteTask={(task) => void deleteTask(task)}
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
        onTagsChanged={refresh}
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
          selectedDate={selectedDate}
          onSkipDay={() => skipTaskDay(selectedTask, selectedDate)}
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

      <ToastViewport toasts={toasts} onDismiss={dismissToast} />
    </div>
  )
}
