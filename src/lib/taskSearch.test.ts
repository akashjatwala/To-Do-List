import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Task, Team } from '@/types'
import { dateInputValue, dueFromDateInput, todayDateValue } from './date'
import {
  defaultTaskSearchFilters,
  searchAssigneeOptions,
  searchScopeOptions,
  searchTagOptions,
  searchTasks,
  suggestSearchTitles,
} from './taskSearch'

function dayOffset(offset: number): string {
  const date = new Date()
  date.setDate(date.getDate() + offset)
  return dateInputValue(date.getTime())
}

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

const richTask = makeTask({
  id: 'rich',
  text: 'Write quarterly report',
  tags: ['Work'],
  assignees: [{ id: 2, email: 'asha@example.com', name: 'Asha' }],
  subtasks: [
    { id: 'sub-1', text: 'Check figures', done: false, position: 0, assignee: null },
  ],
  comments: [
    {
      id: 'comment-1',
      text: 'Needs legal review',
      createdAt: 0,
      userId: 3,
      email: 'marco@example.com',
    },
  ],
})

test('tokenized search matches titles, tags, people, subtasks and comments', () => {
  const tasks = [richTask, makeTask({ id: 'other', text: 'Plan picnic', tags: ['personal'] })]
  const ids = (query: string) =>
    searchTasks(tasks, query, defaultTaskSearchFilters, 1, todayValue()).map((task) => task.id)

  assert.deepEqual(ids('REPORT asha'), ['rich'])
  assert.deepEqual(ids('legal review'), ['rich'])
  assert.deepEqual(ids('figures'), ['rich'])
  assert.deepEqual(ids('WORK'), ['rich'])
  assert.deepEqual(ids('quarterly picnic'), [])
})

test('exact and title matches rank above weaker field matches', () => {
  const tasks = [
    makeTask({ id: 'contains', text: 'Monthly report' }),
    makeTask({ id: 'starts', text: 'Report card' }),
    makeTask({ id: 'exact', text: 'Report' }),
    richTask,
  ]
  const result = searchTasks(tasks, 'report', defaultTaskSearchFilters, 1, todayValue())
  assert.equal(result[0].id, 'exact')
  assert.equal(result[1].id, 'starts')
  assert.ok(result.some((task) => task.id === 'contains'))
})

test('filters scope, status, priority, tag and assignee without altering the task list', () => {
  const tasks = [
    makeTask({ id: 'personal-open', text: 'Personal open', priority: 'high', tags: ['Work'] }),
    makeTask({ id: 'personal-done', text: 'Personal done', done: true, priority: 'high' }),
    makeTask({
      id: 'team-open',
      text: 'Team open',
      teamId: 'crew',
      teamName: 'Crew',
      priority: 'high',
      assignees: [{ id: 2, email: 'asha@example.com', name: 'Asha' }],
    }),
    makeTask({ id: 'repeating', text: 'Repeating', recurrence: 'daily' }),
  ]
  const find = (filters: Partial<typeof defaultTaskSearchFilters>) =>
    searchTasks(tasks, '', { ...defaultTaskSearchFilters, ...filters }, 1, todayValue()).map(
      (task) => task.id,
    )

  assert.deepEqual(find({ scope: 'personal' }), ['personal-done', 'personal-open', 'repeating'])
  assert.deepEqual(find({ scope: 'crew' }), ['team-open'])
  assert.deepEqual(find({ status: 'open' }), ['personal-open', 'team-open'])
  assert.deepEqual(find({ status: 'completed' }), ['personal-done'])
  assert.deepEqual(find({ status: 'repeating' }), ['repeating'])
  assert.deepEqual(find({ priority: 'high' }), ['personal-done', 'personal-open', 'team-open'])
  assert.deepEqual(find({ tag: 'work' }), ['personal-open'])
  assert.deepEqual(find({ assignee: 'me' }), ['personal-done', 'personal-open', 'repeating'])
  assert.deepEqual(find({ assignee: 'unassigned' }), ['personal-done', 'personal-open', 'repeating'])
  assert.deepEqual(find({ assignee: '2' }), ['team-open'])
  assert.equal(tasks.length, 4)
})

test('due filters use local date values and keep today out of overdue', () => {
  const tasks = [
    makeTask({ id: 'past', text: 'Past', due: dueFromDateInput(dayOffset(-1)) }),
    makeTask({ id: 'today', text: 'Today', due: dueFromDateInput(todayDateValue()) }),
    makeTask({ id: 'future', text: 'Future', due: dueFromDateInput(dayOffset(1)) }),
    makeTask({ id: 'none', text: 'No date' }),
    makeTask({ id: 'done-past', text: 'Done past', done: true, due: dueFromDateInput(dayOffset(-1)) }),
  ]
  const find = (due: Parameters<typeof searchTasks>[2]['due']) =>
    searchTasks(tasks, '', { ...defaultTaskSearchFilters, due }, 1, todayValue()).map(
      (task) => task.id,
    )

  assert.deepEqual(find('overdue'), ['past'])
  assert.deepEqual(find('today'), ['today'])
  assert.deepEqual(find('future'), ['future'])
  assert.deepEqual(find('none'), ['none'])
  assert.deepEqual(find('any'), ['done-past', 'past', 'today', 'future', 'none'])
})

test('option helpers expose only scopes and people present in bootstrap', () => {
  const tasks = [
    richTask,
    makeTask({
      id: 'team',
      text: 'Team task',
      teamId: 'crew',
      assignees: [{ id: 2, email: 'asha@example.com', name: '' }],
    }),
  ]
  const teams: Team[] = [
    {
      id: 'crew',
      name: 'Launch crew',
      createdAt: 0,
      role: 'host',
      members: [
        { id: 1, email: 'me@example.com', role: 'host' },
        { id: 2, email: 'asha@example.com', role: 'member' },
        { id: 3, email: 'marco@example.com', role: 'member' },
      ],
    },
  ]

  assert.deepEqual(searchScopeOptions(tasks, teams), [
    { value: 'all', label: 'All tasks' },
    { value: 'personal', label: 'Personal' },
    { value: 'crew', label: 'Launch crew' },
  ])
  assert.deepEqual(searchTagOptions(tasks), ['Work'])
  const assignees = searchAssigneeOptions(tasks, teams, 1)
  assert.deepEqual(
    assignees.slice(0, 3),
    [
      { value: 'any', label: 'Anyone' },
      { value: 'me', label: 'Me' },
      { value: 'unassigned', label: 'Unassigned' },
    ],
  )
  assert.deepEqual(assignees.slice(3), [{ value: '2', label: 'asha' }, { value: '3', label: 'marco' }])
})

test('title suggestions match tokens anywhere and exclude an exact full match', () => {
  const tasks = [
    makeTask({ id: 'a', text: 'Write quarterly report', createdAt: 100 }),
    makeTask({ id: 'b', text: 'Review quarterly figures', createdAt: 200 }),
    makeTask({ id: 'c', text: 'quarterly', createdAt: 300 }),
    makeTask({ id: 'd', text: 'Plan picnic', createdAt: 400 }),
  ]
  assert.deepEqual(suggestSearchTitles(tasks, 'quarterly', 'all'), [
    'Review quarterly figures',
    'Write quarterly report',
  ])
  assert.deepEqual(suggestSearchTitles(tasks, '', 'all'), [])
  assert.deepEqual(suggestSearchTitles(tasks, '  QUARTERLY  ', 'all'), [
    'Review quarterly figures',
    'Write quarterly report',
  ])
})

test('title suggestions rank frequency then recency and follow the selected scope', () => {
  const tasks = [
    makeTask({ id: 'a', text: 'Submit report', createdAt: 100 }),
    makeTask({ id: 'b', text: 'Submit report', createdAt: 300, teamId: 'crew' }),
    makeTask({ id: 'c', text: 'Submit report', createdAt: 200, teamId: 'crew' }),
    makeTask({ id: 'd', text: 'Submit expenses', createdAt: 400, teamId: 'crew' }),
  ]
  assert.deepEqual(suggestSearchTitles(tasks, 'submit', 'all'), [
    'Submit report',
    'Submit expenses',
  ])
  assert.deepEqual(suggestSearchTitles(tasks, 'submit', 'crew'), [
    'Submit report',
    'Submit expenses',
  ])
  assert.deepEqual(suggestSearchTitles(tasks, 'submit', 'personal'), ['Submit report'])
})

function todayValue(): string {
  return todayDateValue()
}
