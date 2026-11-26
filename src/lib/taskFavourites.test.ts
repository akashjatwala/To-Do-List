import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Task } from '@/types'
import { demoFavouritesForEmail, readTaskFavourites, taskFieldsFromTask } from './taskFavourites'

const task: Task = {
  id: 'task-1',
  text: 'Submit status update',
  done: true,
  createdAt: 0,
  due: new Date(2026, 10, 25, 21, 0).getTime(),
  progress: 100,
  priority: 'high',
  tags: ['work', 'weekly'],
  recurrence: 'weekly',
  recurrenceConfig: null,
  duration: 20,
  teamId: 'crew',
  teamName: 'Launch crew',
  userId: 1,
  ownerEmail: 'me@example.com',
  subtasks: [],
  comments: [],
  assignees: [],
}

function withLocalStorage(seed: Map<string, string>, run: () => void) {
  const globals = globalThis as unknown as { window?: unknown }
  const previous = globals.window
  globals.window = {
    localStorage: {
      getItem: (key: string) => seed.get(key) ?? null,
      setItem: (key: string, value: string) => void seed.set(key, value),
    },
  }
  try {
    run()
  } finally {
    if (previous === undefined) delete globals.window
    else globals.window = previous
  }
}

test('create-similar fields keep reusable choices but not dates or time hints', () => {
  const fields = taskFieldsFromTask(task)
  assert.deepEqual(fields, {
    text: 'Submit status update',
    priority: 'high',
    tags: ['work', 'weekly'],
    recurrence: 'weekly',
    duration: 20,
    teamId: 'crew',
  })
  assert.doesNotMatch(JSON.stringify(fields), /21:00/)
  assert.doesNotMatch(JSON.stringify(fields), /due/)
})

test('favourite fields do not alias the source task tags', () => {
  const fields = taskFieldsFromTask(task)
  fields.tags.push('extra')
  assert.deepEqual(task.tags, ['work', 'weekly'])
})

test('demo favourites are stable, demo-only and carry no date or time hint', () => {
  const favourites = demoFavouritesForEmail(' ML-DEMO@example.com ')
  assert.equal(favourites.length, 4)
  assert.deepEqual(
    favourites.map((favourite) => favourite.id),
    [
      'demo-favourite-weekly-review',
      'demo-favourite-launch-check',
      'demo-favourite-deep-work',
      'demo-favourite-bill',
    ],
  )
  assert.doesNotMatch(JSON.stringify(favourites), /\d{1,2}:\d{2}/)
  assert.doesNotMatch(JSON.stringify(favourites), /due/)
  assert.deepEqual(demoFavouritesForEmail('akash@example.com'), [])
})

test('reading demo favourites seeds them once without duplicating on reload', () => {
  const store = new Map<string, string>()
  withLocalStorage(store, () => {
    const first = readTaskFavourites(7, 'ml-demo@example.com')
    const second = readTaskFavourites(7, 'ml-demo@example.com')
    assert.equal(first.length, 4)
    assert.deepEqual(second, first)
    assert.equal(JSON.parse(store.get('duit.task-favourites.7') ?? '[]').length, 4)
  })
})

test('a saved favourite keeps its own name instead of being replaced by a demo built-in', () => {
  const store = new Map<string, string>([
    [
      'duit.task-favourites.8',
      JSON.stringify([
        {
          id: 'saved-review',
          name: 'Weekly review',
          text: 'My own review',
          priority: 'high',
          tags: ['personal'],
          recurrence: 'none',
          duration: 20,
          teamId: null,
        },
      ]),
    ],
  ])
  withLocalStorage(store, () => {
    const favourites = readTaskFavourites(8, 'ml-demo-mate@example.com')
    assert.equal(favourites.length, 4)
    assert.equal(
      favourites.find((favourite) => favourite.name === 'Weekly review')?.text,
      'My own review',
    )
  })
})

test('saved entries migrate from the old Templates storage key once', () => {
  const store = new Map<string, string>([
    [
      'duit.task-templates.9',
      JSON.stringify([
        {
          id: 'old-review',
          name: 'Old review',
          text: 'Review the old list',
          priority: 'low',
          tags: ['work'],
          recurrence: 'none',
          duration: 10,
          teamId: null,
        },
      ]),
    ],
  ])
  withLocalStorage(store, () => {
    const favourites = readTaskFavourites(9, 'ml-demo@example.com')
    assert.equal(favourites.length, 5)
    assert.equal(
      favourites.find((favourite) => favourite.name === 'Old review')?.text,
      'Review the old list',
    )
    assert.equal(JSON.parse(store.get('duit.task-favourites.9') ?? '[]').length, 5)
  })
})
