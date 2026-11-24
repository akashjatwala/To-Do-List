import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import NewTaskDialog, { suggestTaskTitles } from './NewTaskDialog'
import type { Task } from '@/types'

const props = {
  open: true,
  onClose: () => {},
  teams: [{ id: 'team-1', name: 'Launch crew', createdAt: 0, role: 'host' as const, members: [] }],
  defaultTeamId: 'team-1',
  defaultDue: '2026-11-21',
  onAdd: async () => true,
}

test('the new task dialog shows the reference sections and live preview', () => {
  const html = renderToStaticMarkup(<NewTaskDialog {...props} />)

  assert.match(html, /aria-label="New task"/)
  assert.match(html, /Priority/)
  assert.match(html, /Due date/)
  assert.doesNotMatch(html, /Time \(optional\)/)
  assert.match(html, /How long will it take\?/)
  assert.match(html, /Repeats/)
  assert.match(html, /Add to/)
  assert.match(html, /Launch crew/)
  assert.match(html, /Tags/)
  assert.match(html, /Preview/)
  assert.doesNotMatch(html, /Suggested time/)
  assert.doesNotMatch(html, /Low confidence until it has more of your history/)
  assert.match(html, /Add and create another/)
  assert.match(html, /Add task/)
  assert.match(html, /normal-case/)
  assert.doesNotMatch(html, /uppercase/)
})

test('the priority chips use the sticky-note palette', () => {
  const html = renderToStaticMarkup(<NewTaskDialog {...props} />)

  assert.match(html, /bg-\[#E6E8EB\]/)
  assert.match(html, /bg-\[#4aa96c\]\/30/)
  assert.match(html, /bg-\[#F5E9A8\]/)
  assert.match(html, /bg-\[#e0716a\]\/30/)
})

test('the new task dialog keeps the no-Urgent priority rule', () => {
  const html = renderToStaticMarkup(<NewTaskDialog {...props} />)
  assert.doesNotMatch(html, /Urgent/)
})

test('a closed new task dialog renders nothing', () => {
  const html = renderToStaticMarkup(<NewTaskDialog {...props} open={false} />)
  assert.equal(html, '')
})

function historicalTask(text: string, due: number, teamId: string | null = null): Task {
  return {
    id: text,
    text,
    done: true,
    createdAt: due - 86_400_000,
    due,
    progress: 100,
    priority: 'none',
    tags: [],
    recurrence: 'none',
    recurrenceConfig: null,
    duration: null,
    preferredTime: null,
    teamId,
    teamName: null,
    userId: 1,
    ownerEmail: 'me@example.com',
    subtasks: [],
    comments: [],
    assignees: [],
  }
}

test('title suggestions come from the selected list and match the typed text', () => {
  const history = [
    historicalTask('Review pricing page', 1795000000000),
    historicalTask('Review pricing page', 1795200000000),
    historicalTask('Refresh design tokens', 1795100000000),
    historicalTask('Go for a run', 1795150000000),
    historicalTask('Team-only review', 1795300000000, 'team-1'),
  ]

  assert.deepEqual(suggestTaskTitles(history, 'go for', null), ['Go for a run'])
  assert.deepEqual(suggestTaskTitles(history, 'run', null), ['Go for a run'])
  assert.deepEqual(suggestTaskTitles(history, 'for run', null), ['Go for a run'])
  assert.deepEqual(suggestTaskTitles(history, 'review', null), ['Review pricing page'])
  assert.deepEqual(suggestTaskTitles(history, '', null), [
    'Review pricing page',
    'Go for a run',
    'Refresh design tokens',
  ])
  assert.deepEqual(suggestTaskTitles(history, 'review', 'team-1'), ['Team-only review'])
  assert.deepEqual(suggestTaskTitles(history, 'Review pricing page', null), [])
})

test('quick fill sits beside the task field without changing the autocomplete rules', () => {
  const html = renderToStaticMarkup(
    <NewTaskDialog
      {...props}
      historyTasks={[historicalTask('Review pricing page', 1795000000000, 'team-1')]}
    />,
  )
  assert.match(html, /aria-label="Quick fill task fields"/)
  assert.match(html, /Quick fill/)
  assert.match(html, /role="tooltip"/)
  assert.match(html, /id="quick-fill-hint"/)
  assert.match(html, /aria-describedby="quick-fill-hint"/)
  assert.match(html, /Try “Submit report tomorrow 3pm #work”/)
  assert.doesNotMatch(html, /Ctrl\/⌘ \+ Enter/)
  assert.match(html, /role="combobox"/)
  assert.match(html, /aria-autocomplete="list"/)
  assert.match(html, /aria-controls="new-task-suggestions"/)
  assert.doesNotMatch(html, /aria-label="Task suggestions"/)
  assert.match(html, /aria-expanded="false"/)
})

test('new task title suggestions stay hidden until text is typed', () => {
  const html = renderToStaticMarkup(
    <NewTaskDialog
      {...props}
      historyTasks={[historicalTask('Review pricing page', 1795000000000, 'team-1')]}
    />,
  )
  assert.doesNotMatch(html, /aria-label="Task suggestions"/)
  assert.doesNotMatch(html, /From your history/)
  assert.match(html, /aria-expanded="false"/)
  assert.doesNotMatch(html, /Time \(optional\)/)
})
