import type { Task, Team, View } from '@/types'
import { dateInputValue, todayDateValue } from './date'
import { repeatsOnDate } from './taskmeta'

export interface TeamStats {
  total: number
  done: number
  open: number
  percent: number
}

export interface BoardModel {
  viewTasks: Task[]
  dateTasks: Task[]
  openTasks: Task[]
  completedTasks: Task[]
  repeatingTasks: Task[]
  overdueTasks: Task[]
  teamOverdueTasks: Task[]
  memberOpenCounts: Record<number, number>
  teamStats: TeamStats
}

export function selectBoardModel(tasks: Task[], view: View, selectedDate: string): BoardModel {
  const viewTasks =
    view.kind === 'my'
      ? tasks.filter((task) => task.teamId === null)
      : view.kind === 'collab' && view.teamId
        ? tasks.filter((task) => task.teamId === view.teamId)
        : []

  const dateTasks = viewTasks.filter((task) =>
    task.recurrence === 'none'
      ? task.due !== null && dateInputValue(task.due) === selectedDate
      : repeatsOnDate(task.due, task.recurrence, task.recurrenceConfig, selectedDate),
  )

  const openTasks = dateTasks.filter((task) => !task.done)
  const completedTasks = dateTasks.filter((task) => task.done)
  const repeatingTasks = viewTasks.filter((task) => task.recurrence !== 'none')

  const todayValue = todayDateValue()
  const overdueTasks = viewTasks
    .filter(
      (task) =>
        task.teamId === null && !task.done && task.due !== null && dateInputValue(task.due) < todayValue,
    )
    .sort((a, b) => a.due! - b.due!)

  const teamOverdueTasks = viewTasks
    .filter(
      (task) =>
        task.teamId !== null && !task.done && task.due !== null && dateInputValue(task.due) < todayValue,
    )
    .sort((a, b) => a.due! - b.due!)

  const memberOpenCounts: Record<number, number> = {}
  for (const task of viewTasks) {
    if (task.done || task.recurrence !== 'none') continue
    memberOpenCounts[task.userId] = (memberOpenCounts[task.userId] ?? 0) + 1
  }

  const done = dateTasks.filter((task) => task.done).length
  return {
    viewTasks,
    dateTasks,
    openTasks,
    completedTasks,
    repeatingTasks,
    overdueTasks,
    teamOverdueTasks,
    memberOpenCounts,
    teamStats: {
      total: dateTasks.length,
      done,
      open: dateTasks.length - done,
      percent: dateTasks.length === 0 ? 0 : Math.round((done / dateTasks.length) * 100),
    },
  }
}

export function canDeleteTaskForUser(task: Task, userId: number, teams: Team[]): boolean {
  return task.teamId === null
    ? task.userId === userId
    : teams.find((team) => team.id === task.teamId)?.role === 'host'
}
