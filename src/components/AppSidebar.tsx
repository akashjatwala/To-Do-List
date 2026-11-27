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
import CompletedCard from './CompletedCard'
import RepeatingCard from './RepeatingCard'
import type { OffDayCalendarEntry } from './OffDayCalendar'
import { offKindLabel } from './off-day-display'
import {
  TeamInvitationsCard,
  TeamMembersCard,
  TeamOffDaysCard,
} from './TeamSidebarCards'

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
  notify: (message: string, tone?: ToastTone) => void
  refresh: () => Promise<void>
  onCelebrated: () => void
  onEditCheckin: () => void
  onRefreshDailyState: () => Promise<void>
  onAcceptInvite: (invite: UserInvite) => Promise<void>
  onDeclineInvite: (invite: UserInvite) => Promise<void>
  onViewAllOverdue: () => void
  onViewAllCompleted: () => void
  onViewAllRepeating: () => void
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
  notify,
  refresh,
  onCelebrated,
  onEditCheckin,
  onRefreshDailyState,
  onAcceptInvite,
  onDeclineInvite,
  onViewAllOverdue,
  onViewAllCompleted,
  onViewAllRepeating,
}: AppSidebarProps) {
  const ownOffDays: OffDayCalendarEntry[] = data.offDays.map((offDay) => ({
    id: offDay.id,
    startDate: offDay.startDate,
    endDate: offDay.endDate,
    kind: offDay.kind,
    label: offKindLabel(offDay.kind),
    note: offDay.note,
    person: 'You',
  }))
  const teammateIds = new Set(
    (currentTeam?.members ?? [])
      .filter((member) => member.id !== data.user.id)
      .map((member) => member.id),
  )
  const teammateOffDays: OffDayCalendarEntry[] = data.teammateOffDays
    .filter((offDay) => teammateIds.has(offDay.userId))
    .map((offDay) => ({
      id: offDay.id,
      startDate: offDay.startDate,
      endDate: offDay.endDate,
      kind: offDay.kind,
      label: `${offDay.name} · ${offKindLabel(offDay.kind)}`,
      note: offDay.note,
      person: offDay.name,
    }))

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

          <OffDayCard
            date={selectedDate}
            notify={notify}
            onChanged={refresh}
            calendarEntries={ownOffDays}
            calendarToday={todayValue}
          />

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
            notify={notify}
            onChanged={refresh}
          />
          <TeamOffDaysCard
            team={currentTeam}
            offDays={data.teammateOffDays}
            currentUserId={data.user.id}
            today={todayValue}
            calendarEntries={teammateOffDays}
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

      <CompletedCard tasks={completedTasks} onViewAll={onViewAllCompleted} />

      <RepeatingCard tasks={repeatingTasks} onViewAll={onViewAllRepeating} />
    </div>
  )
}
