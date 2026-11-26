import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Task } from '@/types'
import { dateInputValue, dueFromDateInput, todayDateValue } from './date'
import { offDayDateSet, selectBoardModel } from './taskBoard'

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    text: 'Task',
    done: false,
    createdAt: 0,
    due: null,
    progress: 0,
    priority: 'none',
    tags: [],
    recurrence: 'none',
    recurrenceConfig: null,
    duration: null,
      teamId: null,
    teamName: null,
    userId: 1,
    ownerEmail: 'me@example.com',
    subtasks: [],
    comments: [],
    assignees: [],
    ...overrides,
  }
}

test('overdue board lists past-due tasks only, never today’s pending tasks', () => {
  const yesterday = new Date()
  yesterday.setDate(yesterday.getDate() - 1)
  const yesterdayValue = dateInputValue(yesterday.getTime())
  const yesterdayDue = dueFromDateInput(yesterdayValue)
  const todayDue = dueFromDateInput(todayDateValue())

  const tasks = [
    makeTask({ id: 'personal-overdue', text: 'Personal overdue', due: yesterdayDue }),
    makeTask({ id: 'personal-today', text: 'Personal today', due: todayDue }),
    makeTask({
      id: 'personal-done',
      text: 'Done overdue',
      due: yesterdayDue,
      done: true,
    }),
    makeTask({
      id: 'team-overdue',
      text: 'Team overdue',
      due: yesterdayDue,
      teamId: 'crew',
      teamName: 'Launch crew',
    }),
    makeTask({
      id: 'team-today',
      text: 'Team today',
      due: todayDue,
      teamId: 'crew',
      teamName: 'Launch crew',
    }),
  ]

  const personal = selectBoardModel(tasks, { kind: 'my' }, todayDateValue())
  assert.deepEqual(
    personal.overdueTasks.map((task) => task.id),
    ['personal-overdue'],
  )

  const team = selectBoardModel(tasks, { kind: 'collab', teamId: 'crew' }, todayDateValue())
  assert.deepEqual(
    team.teamOverdueTasks.map((task) => task.id),
    ['team-overdue'],
  )
})

test('off days hide repeating tasks but keep ordinary tasks', () => {
  const date = '2026-11-25'
  const due = dueFromDateInput(date)
  const tasks = [
    makeTask({ id: 'repeat', recurrence: 'daily', due }),
    makeTask({ id: 'ordinary', due }),
    makeTask({ id: 'team-repeat', recurrence: 'daily', due, teamId: 'crew', teamName: 'Crew' }),
  ]

  const board = selectBoardModel(tasks, { kind: 'my' }, date, {
    offDayDates: offDayDateSet([{ startDate: date, endDate: date }]),
  })
  assert.deepEqual(
    board.dateTasks.map((task) => task.id),
    ['ordinary'],
  )
  assert.deepEqual(
    board.repeatingTasks.map((task) => task.id),
    ['repeat'],
  )

  const nextDay = selectBoardModel(tasks, { kind: 'my' }, '2026-11-26', {
    offDayDates: offDayDateSet([{ startDate: date, endDate: date }]),
  })
  assert.deepEqual(
    nextDay.dateTasks.map((task) => task.id),
    ['repeat'],
  )

  const teamBoard = selectBoardModel(tasks, { kind: 'collab', teamId: 'crew' }, date, {
    offDayDates: new Set([date]),
  })
  assert.deepEqual(
    teamBoard.dateTasks.map((task) => task.id),
    [],
  )
})
