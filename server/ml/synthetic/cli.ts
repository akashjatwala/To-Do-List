import { existsSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { resolveConfig, CONFIG, todayLocalDate, type SyntheticConfig } from './config'
import { planGeneration, generateModel } from './generate'
import { countRows } from './model'
import { buildCoverageReport, formatCoverageReport } from './coverage'
import { exportModel, OBSERVED_DIR } from './export-csv'
import { writeModel } from './writer'
import { openSyntheticDb, createSyntheticUser } from './isolation'
import { SYNTHETIC_DB_PATH, reloadDataset } from './reload'
import { purgeSyntheticData } from './purge'
import { exportAsOf } from './as-of'
import { combineReports, formatChecksReport, reportToCsvRows, runModelChecks, runPhase2aChecks, runPhase4Checks } from './checks'
import { runHarness, formatHarnessReport } from './harness'
import { trainUserModels } from '../pipeline'
import { promoteCandidate } from '../registry'
import { toCsv, type Cell } from './csv'

/**
 * Command line for the Phase 3 synthetic dataset.
 *
 * Commands (each also available as an npm script):
 *   generate [--quick] [--seed N] [--end YYYY-MM-DD] [--days N] [--tasks N]
 *   purge
 *   asof --date YYYY-MM-DD
 *   reload
 *   report [--seeds 1,2,3]
 *   train [--promote] [--fresh] [--seed N] [--folds N] [--commit SHA]
 *
 * The command prints the estimated row count before generating, refuses to
 * exceed the hard cap, and only ever shows the manifest, the coverage report and
 * row counts — never the generated data itself.
 */

interface Flags {
  [key: string]: string | boolean
}

function parseFlags(args: string[]): Flags {
  const flags: Flags = {}
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (!arg.startsWith('--')) continue
    const key = arg.slice(2)
    const next = args[i + 1]
    if (next !== undefined && !next.startsWith('--')) {
      flags[key] = next
      i += 1
    } else {
      flags[key] = true
    }
  }
  return flags
}

function configFromFlags(flags: Flags): SyntheticConfig {
  const overrides: Parameters<typeof resolveConfig>[0] = {}
  if (flags.quick === true) overrides.quick = true
  if (typeof flags.seed === 'string') overrides.seed = Number(flags.seed)
  if (typeof flags.end === 'string') overrides.endDate = flags.end
  if (typeof flags.days === 'string') overrides.historyDays = Number(flags.days)
  if (typeof flags.tasks === 'string') overrides.numTasks = Number(flags.tasks)
  if (typeof flags.pending === 'string') overrides.pendingTailDays = Number(flags.pending)
  if (flags['no-layers'] === true) {
    overrides.layers = { offDays: false, recommendations: false, regimeChange: false, liveReplay: false }
  }
  return resolveConfig(overrides)
}

function seedConfig(): SyntheticConfig {
  // The persisted dataset always uses the checked-in config, so `report`,
  // `reload` and `asof` line up with whatever `generate` wrote.
  return CONFIG
}

function resetDb(): void {
  if (existsSync(SYNTHETIC_DB_PATH)) rmSync(SYNTHETIC_DB_PATH, { force: true })
  mkdirSync(OBSERVED_DIR, { recursive: true })
}

function writeQualityReport(personId: string, rows: Cell[][]): string {
  const dir = join(OBSERVED_DIR, personId)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'quality_report.csv')
  writeFileSync(path, toCsv(['person_id', 'section', 'check', 'result', 'detail', 'synthetic'], rows), 'utf8')
  return path
}

function generate(flags: Flags): void {
  const requested = configFromFlags(flags)
  const plan = planGeneration(requested)
  const config = plan.config

  console.log(`Synthetic dataset (SYNTHETIC DATA — never real, never for accuracy claims)`)
  console.log(`  person:        ${config.personId} (${config.personLabel})`)
  console.log(`  window:        ${config.historyDays} days ending ${config.endDate}`)
  console.log(`  tasks:         ${config.numTasks}${plan.reducedTasks ? ' (reduced to fit the row cap)' : ''}`)
  console.log(`  seed:          ${config.seed}`)
  console.log(`  estimated rows: ${plan.estimatedRows} (hard cap ${config.maxRows})`)
  console.log('  generating…')

  resetDb()
  const db = openSyntheticDb(SYNTHETIC_DB_PATH)
  try {
    const user = createSyntheticUser(db, {
      personId: config.personId,
      label: config.personLabel,
      kind: 'named',
      archetype: null,
      heldOut: false,
      seed: config.seed,
    })
    const model = generateModel(config, user.userId)
    const totalRows = countRows(model)
    if (totalRows > config.maxRows) {
      throw new Error(`Refusing to write: ${totalRows} rows exceed the hard cap of ${config.maxRows}.`)
    }
    writeModel(db, model)

    const exportResult = exportModel(model, config, { asOfDate: config.endDate })
    const coverage = buildCoverageReport(model.coverage, config.coverage, exportResult.totalRows, config.maxRows)

    const checks = combineReports(
      config.personId,
      config.endDate,
      runModelChecks(model, config, coverage),
      runPhase2aChecks(db, user.userId, config),
      runPhase4Checks(db, user.userId, config),
    )
    const reportPath = writeQualityReport(config.personId, reportToCsvRows(checks))

    console.log('')
    console.log(`Manifest written to ${join(exportResult.dir, 'manifest.csv')}`)
    console.log(`  total rows:   ${exportResult.totalRows}`)
    console.log(`  files:        ${exportResult.files.length} observed + ground truth`)
    for (const file of exportResult.files) console.log(`    ${file.name.padEnd(28)} ${String(file.rows).padStart(6)}`)
    console.log('')
    console.log(formatCoverageReport(coverage))
    console.log('')
    console.log(formatChecksReport(checks))
    console.log('')
    console.log(`Quality report written to ${reportPath}`)
    console.log(`Checksums written to ${join(OBSERVED_DIR, 'checksums.csv')}`)
    if (!coverage.allOk) {
      console.error('Coverage FAILED — the dataset does not meet every minimum.')
      process.exitCode = 1
    }
  } finally {
    db.close()
  }
}

function purge(): void {
  const result = purgeSyntheticData()
  console.log(result.removed ? `Purged ${result.path}` : `Nothing to purge at ${result.path}`)
}

function asof(flags: Flags): void {
  const date = typeof flags.date === 'string' ? flags.date : null
  if (!date) throw new Error('asof needs --date YYYY-MM-DD')
  const config = seedConfig()
  const model = generateModel(config, 1)
  const result = exportAsOf(model, config, date)
  console.log(`As-of export (SYNTHETIC DATA)`)
  console.log(`  person:  ${config.personId}`)
  console.log(`  as of:   ${date}`)
  console.log(`  folder:  ${result.dir}`)
  console.log(`  rows:    ${result.totalRows}`)
  for (const file of result.files) console.log(`    ${file.name.padEnd(28)} ${String(file.rows).padStart(6)}`)
}

function reload(): void {
  const config = seedConfig()
  const result = reloadDataset(config, SYNTHETIC_DB_PATH)
  console.log(`Reloaded ${result.personId} into ${result.dbPath}`)
  for (const [name, count] of Object.entries(result.counts)) {
    console.log(`    ${name.padEnd(28)} ${String(count).padStart(6)}`)
  }
}

function report(flags: Flags): void {
  const config = seedConfig()
  const seeds =
    typeof flags.seeds === 'string'
      ? flags.seeds.split(',').map((value) => Number(value.trim())).filter((value) => Number.isFinite(value))
      : [config.seed, config.seed + 1, config.seed + 2]

  // Reload first so the Phase 2a checks run against the exported files.
  const reloaded = reloadDataset(config, SYNTHETIC_DB_PATH)
  const db = openSyntheticDb(SYNTHETIC_DB_PATH)
  try {
    const harness = runHarness(config, seeds, db, reloaded.userId)
    console.log(formatHarnessReport(harness))
  } finally {
    db.close()
  }
}

function train(flags: Flags): void {
  const config = seedConfig()
  const reloaded = reloadDataset(config, SYNTHETIC_DB_PATH)
  const db = openSyntheticDb(SYNTHETIC_DB_PATH)
  try {
    const seed = typeof flags.seed === 'string' ? Number(flags.seed) : config.seed
    const folds = typeof flags.folds === 'string' ? Number(flags.folds) : undefined
    if (flags.fresh === true) {
      db.prepare('DELETE FROM ml_shadow WHERE user_id = ?').run(reloaded.userId)
      db.prepare('DELETE FROM ml_models WHERE user_id = ?').run(reloaded.userId)
      console.log('  (--fresh: cleared the existing model registry for this person)')
    }
    const result = trainUserModels(db, reloaded.userId, {
      synthetic: true,
      register: true,
      seed,
      folds,
      gitCommit: typeof flags.commit === 'string' ? flags.commit : null,
    })

    console.log('Model training (SYNTHETIC DATA — never an accuracy claim about the real user)')
    console.log(`  person:   ${config.personId}`)
    console.log(`  window:   ${result.from} .. ${result.to} (${result.monthsOfData} month(s) of data)`)
    console.log(
      `  rows:     ${result.rows} (completion ${result.labelledCount}, target ${result.targetCount}, duration ${result.durationCount}); ${result.featureNames.length} features`,
    )
    console.log('  candidates (chronological validation, versus the baseline):')
    for (const candidate of result.candidates) {
      const m = candidate.metrics
      const score =
        candidate.kind === 'duration'
          ? `MAE ${fmt(m.mae, 1)} vs median ${fmt(m.baselineMae, 1)}`
          : `Brier ${fmt(m.brier)} vs baseline ${fmt(m.baselineBrier)}; ECE ${fmt(m.ece)}`
      console.log(`    ${candidate.kind.padEnd(10)} ${candidate.chosenType.padEnd(9)} ${candidate.version}  ${score}${candidate.smallData ? '  [small data — baseline used]' : ''}`)
    }
    if (result.timing.length > 0) {
      console.log('  timing (learned peak vs the simple baselines):')
      for (const t of result.timing) {
        console.log(
          `    ${t.taskId.padEnd(24)} sessions ${String(t.sessions).padStart(3)}  adherence ${fmt(t.adherence)} vs preferred ${fmt(t.preferredTimeBaseline)} vs busiest-bin ${fmt(t.historicalFrequencyBaseline)}`,
        )
      }
    }
    for (const note of result.notes) console.log(`  note: ${note}`)

    if (flags.promote === true) {
      console.log('  promotion gate:')
      for (const candidate of result.candidates) {
        if (candidate.id === null) continue
        const decision = promoteCandidate(db, reloaded.userId, candidate.id)
        console.log(`    ${candidate.kind.padEnd(10)} ${decision.ok ? 'PROMOTED' : 'kept as candidate'} — ${decision.reason}`)
      }
    } else {
      console.log('  (candidates registered; pass --promote to run the promotion gate)')
    }
  } finally {
    db.close()
  }
}

function fmt(value: number | null | undefined, digits = 3): string {
  return value === null || value === undefined || !Number.isFinite(value) ? 'n/a' : value.toFixed(digits)
}

function main(): void {
  const [sub, ...rest] = process.argv.slice(2)
  const flags = parseFlags(rest)
  try {
    switch (sub) {
      case 'generate':
        generate(flags)
        break
      case 'purge':
        purge()
        break
      case 'asof':
        asof(flags)
        break
      case 'reload':
        reload()
        break
      case 'report':
        report(flags)
        break
      case 'train':
        train(flags)
        break
      default:
        console.log('Usage: cli.ts generate|purge|asof|reload|report|train')
        console.log(`Today is ${todayLocalDate()}; the checked-in dataset ends ${CONFIG.endDate}.`)
        process.exitCode = 1
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}

main()
