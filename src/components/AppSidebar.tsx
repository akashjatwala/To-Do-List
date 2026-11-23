import type {
  BootstrapData,
  CheckinStatus,
  DailyState,
  Reminder,
  Task,
  Team,
  UserInvite,
} from '@/types'
import type { ToastTone } from '@/types'
import DailyStateCard from './DailyStateCard'
import OffDayCard from './OffDayCard'
import PredictionPanel from './PredictionPanel'
import OverdueCard from './OverdueCard'
import { CompletedColumn, RepeatingColumn } from './StickyBoard'
import { TeamInvitationsCard, TeamMembersCard } from './TeamSidebarCards'

interface AppSidebarProps {
  isCollab: boolean
  isToday: boolean
  todayValue: string
  selectedDate: string
  data: BootstrapData
  currentTeam: Team | undefined
  dailyStateData: DailyState | null
  checkinStatus: CheckinStatus | null
  checkinCelebrate: boolean
  overdueTasks: Task[]
  teamOverdueTasks: Task[]
  reminders: Reminder[]
  completedTasks: Task[]
  repeatingTasks: Task[]
  memberOpenCounts: Record<number, number>
  notify: (message: string, tone?: ToastTone) => void
  refresh: () => Promise<void>
  onCelebrated: () => void
  onEditCheckin: () => void
  onRefreshDailyState: () => Promise<void>
  onOpenTask: (task: Task) => void
  onToggleTask: (task: Task) => void
  onDeleteTask: (task: Task) => void
  onAcceptInvite: (invite: UserInvite) => Promise<void>
  onDeclineInvite: (invite: UserInvite) => Promise<void>
  onViewAllOverdue: () => void
  canDeleteTask: (task: Task) => boolean
}

export default function AppSidebar({
  isCollab,
  isToday,
  todayValue,
  selectedDate,
  data,
  currentTeam,
  dailyStateData,
  checkinStatus,
  checkinCelebrate,
  overdueTasks,
  teamOverdueTasks,
  reminders,
  completedTasks,
  repeatingTasks,
  memberOpenCounts,
  notify,
  refresh,
  onCelebrated,
  onEditCheckin,
  onRefreshDailyState,
  onOpenTask,
  onToggleTask,
  onDeleteTask,
  onAcceptInvite,
  onDeclineInvite,
  onViewAllOverdue,
  canDeleteTask,
}: AppSidebarProps) {
  return (
    <div className="flex min-w-0 flex-col gap-3">
      {!isCollab && (
        <>
          {isToday && dailyStateData && (
            <DailyStateCard
              state={dailyStateData}
              checkin={checkinStatus?.checkin ?? null}
              checkinState={checkinStatus?.state ?? 'not_asked'}
              celebrate={checkinCelebrate}
              onCelebrated={onCelebrated}
              onEditCheckin={onEditCheckin}
              onRefreshState={onRefreshDailyState}
              notify={notify}
            />
          )}

          <OverdueCard
            tasks={overdueTasks}
            reminders={reminders}
            onViewAll={onViewAllOverdue}
          />

          <OffDayCard date={selectedDate} notify={notify} onChanged={refresh} />

          {isToday && (
            <PredictionPanel
              date={selectedDate}
              today={todayValue}
              notify={notify}
              refreshKey={`${checkinStatus?.checkin?.updatedAt ?? 0}:${data.tasks.length}`}
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
            onAccept={onAcceptInvite}
            onDecline={onDeclineInvite}
            notify={notify}
            onChanged={refresh}
          />
          <OverdueCard
            tasks={teamOverdueTasks}
            reminders={reminders}
            onViewAll={onViewAllOverdue}
          />
        </>
      )}

      <CompletedColumn
        tasks={completedTasks}
        currentUserId={data.user.id}
        showOwner={isCollab}
        canDelete={canDeleteTask}
        onOpen={onOpenTask}
        onToggle={onToggleTask}
        onDelete={onDeleteTask}
      />

      <RepeatingColumn
        tasks={repeatingTasks}
        currentUserId={data.user.id}
        showOwner={isCollab}
        canDelete={() => false}
        onOpen={onOpenTask}
        onToggle={onToggleTask}
        onDelete={onDeleteTask}
      />
    </div>
  )
}
