import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RefreshCoalescer } from './refreshCoalescer'

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const flush = () => new Promise<void>((done) => setImmediate(done))

test('concurrent callers share one refresh and trigger one follow-up', async () => {
  const queue: Array<Deferred<string>> = []
  const applied: string[] = []
  const coalescer = new RefreshCoalescer(
    () => {
      const item = deferred<string>()
      queue.push(item)
      return item.promise
    },
    (value) => applied.push(value),
  )

  const first = coalescer.refresh()
  const second = coalescer.refresh()
  assert.equal(queue.length, 1)

  queue[0].resolve('first')
  await flush()
  assert.equal(queue.length, 2)

  queue[1].resolve('second')
  await Promise.all([first, second])
  assert.deepEqual(applied, ['first', 'second'])
})

test('invalidation drops a result that was already in flight', async () => {
  const item = deferred<string>()
  const applied: string[] = []
  const coalescer = new RefreshCoalescer(() => item.promise, (value) => applied.push(value))

  const run = coalescer.refresh()
  coalescer.invalidate()
  item.resolve('stale')
  await run
  assert.deepEqual(applied, [])
  assert.equal(coalescer.isCurrent(0), false)
})

test('a completed refresh allows the next call to load again', async () => {
  let loads = 0
  const applied: string[] = []
  const coalescer = new RefreshCoalescer(
    async () => {
      loads += 1
      return `load-${loads}`
    },
    (value) => applied.push(value),
  )

  await coalescer.refresh()
  await coalescer.refresh()
  assert.equal(loads, 2)
  assert.deepEqual(applied, ['load-1', 'load-2'])
})
