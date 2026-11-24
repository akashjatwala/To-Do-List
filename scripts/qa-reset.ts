import { existsSync, unlinkSync } from 'node:fs'
import { basename, resolve } from 'node:path'

/**
 * Deletes only disposable QA/performance/test databases. Never pass it a live
 * database path unless you also set QA_ALLOW_RESET=1 deliberately.
 */
function main() {
  const target = resolve(process.cwd(), process.env.DUIT_DB_PATH ?? './server/data/todo.qa.db')
  const name = basename(target)
  const disposable = /\.(qa|perf|test)\.db$/.test(name)
  if (!disposable && process.env.QA_ALLOW_RESET !== '1') {
    throw new Error(
      `Refusing to reset ${name}. Use a .qa.db, .perf.db or .test.db path, or set QA_ALLOW_RESET=1.`,
    )
  }

  const files = [target, `${target}-wal`, `${target}-shm`]
  let removed = 0
  for (const file of files) {
    if (!existsSync(file)) continue
    unlinkSync(file)
    removed += 1
  }
  console.log(`Removed ${removed} file(s) for ${name}.`)
}

main()
