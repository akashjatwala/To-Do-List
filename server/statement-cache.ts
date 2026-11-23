import type { DatabaseSync } from 'node:sqlite'

type Statement = ReturnType<DatabaseSync['prepare']>

// ML helpers receive a database argument so tests can pass an isolated file.
// Cache statements per connection, not globally, and key by the exact SQL so
// prepared statements are reused without changing their bindings or results.
const caches = new WeakMap<DatabaseSync, Map<string, Statement>>()

export function prepare(db: DatabaseSync, sql: string): Statement {
  let cache = caches.get(db)
  if (!cache) {
    cache = new Map<string, Statement>()
    caches.set(db, cache)
  }
  let statement = cache.get(sql)
  if (!statement) {
    statement = db.prepare(sql)
    cache.set(sql, statement)
  }
  return statement
}
