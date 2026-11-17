import type { DatabaseSync } from 'node:sqlite'
import { generateModel } from './generate'
import { buildCoverageReport, formatCoverageReport, type CoverageReport } from './coverage'
import { countRows } from './model'
import { combineReports, runModelChecks, runPhase2aChecks, type CheckResult, type ChecksReport } from './checks'
import { type SyntheticConfig } from './config'
import type { SyntheticModel } from './model'
/**
 * Evaluation harness scaffold (Phase 3).
 *
 * This is the structure the later phases plug into. It runs, right now, the
 * checks that can honestly be run before any model exists: the data-quality and
 * leakage checks, and the Phase 2a checks (does the readiness score relate to
 * what got done, per task; do the display estimates hold up against the simple
 * baselines).
 *
 * Every Phase 5 metric — Brier score, calibration, learning curves, ablations,
 * drift, promotion/rollback and the mood-zero-effect control — is present as a
 * clearly-labelled stub. A stub **refuses to report a number**: calling it
 * throws with the reason, so there is no way to accidentally print a fabricated
 * accuracy figure before real predictions exist.
 *
 * Results are always reported per task and per tag, and across at least three
 * seeds with the weakest shown next to the best — never as one blended score.
 */

export interface Phase5Metric {
  key: string
  label: string
  implemented: false
  /** Why it cannot run yet, in plain language. */
  reason: string
  /** Calling this always throws; it never returns a number. */
  report: () => never
}

const PHASE5_REASON =
  'No model exists yet, so this metric has no predictions to score. It stays a stub and will not report a number.'

export const PHASE5_METRICS: Phase5Metric[] = [
  'Brier score',
  'Calibration / reliability curve',
  'Learning curve (1, 2, 4, 8, 12+ weeks)',
  'Feature ablation',
  'Drift detection',
  'Model promotion and rollback',
  'Mood-zero-effect control',
].map((label) => ({
  key: label.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
  label,
  implemented: false as const,
  reason: PHASE5_REASON,
  report: () => {
    throw new Error(`${label}: ${PHASE5_REASON}`)
  },
}))

export interface SeedRun {
  seed: number
  rows: number
  coverageOk: boolean
  checks: CheckResult[]
  failed: number
  coverage: CoverageReport
}

export interface HarnessReport {
  personId: string
  seeds: SeedRun[]
  best: SeedRun
  weakest: SeedRun
  phase2a: CheckResult[]
  /** A short, honest summary line. */
  summary: string
}

function runSeed(config: SyntheticConfig): { run: SeedRun; model: SyntheticModel } {
  const model = generateModel(config, 1)
  const coverage = buildCoverageReport(model.coverage, config.coverage, countRows(model), config.maxRows)
  const checks = runModelChecks(model, config, coverage)
  return {
    run: {
      seed: config.seed,
      rows: coverage.totalRows,
      coverageOk: coverage.allOk,
      checks,
      failed: checks.filter((row) => !row.ok).length,
      coverage,
    },
    model,
  }
}

/**
 * Run the available checks across seeds. The primary seed's data is also
 * checked against the reloaded database for the Phase 2a layer; the other seeds
 * are checked in memory only (a documented limitation: the isolated database
 * holds one person at a time).
 */
export function runHarness(config: SyntheticConfig, seeds: number[], db?: DatabaseSync, userId?: number): HarnessReport {
  const runs: SeedRun[] = []
  for (const seed of seeds) {
    const resolved: SyntheticConfig = { ...config, seed }
    runs.push(runSeed(resolved).run)
  }
  const sorted = [...runs].sort((a, b) => a.failed - b.failed || a.rows - b.rows)
  const best = sorted[0]
  const weakest = sorted[sorted.length - 1]

  const phase2a = db && userId !== undefined ? runPhase2aChecks(db, userId, config) : []
  const summary = runs.every((run) => run.failed === 0 && run.coverageOk)
    ? `All available checks pass across ${runs.length} seed(s); ${best.seed} is best and ${weakest.seed} weakest. Phase 5 metrics are stubs and report nothing.`
    : `Checks failed: ${runs.reduce((sum, run) => sum + run.failed, 0)} failure(s) across ${runs.length} seed(s); weakest seed ${weakest.seed}.`

  return { personId: config.personId, seeds: runs, best, weakest, phase2a, summary }
}

export function harnessReport(personId: string, report: HarnessReport): ChecksReport {
  const modelChecks = report.seeds.flatMap((run) => run.checks.map((row) => ({ ...row, section: `seed-${run.seed} ${row.section}` })))
  return combineReports(personId, 'harness', modelChecks, report.phase2a)
}

export function formatHarnessReport(report: HarnessReport): string {
  const lines: string[] = []
  lines.push('Evaluation harness (available checks only)')
  lines.push('-----------------------------------------')
  lines.push(`  person: ${report.personId}`)
  lines.push(`  seeds:  ${report.seeds.map((run) => run.seed).join(', ')}`)
  lines.push('  per seed:')
  for (const run of report.seeds) {
    lines.push(`    seed ${run.seed}: rows ${run.rows}, coverage ${run.coverageOk ? 'ok' : 'MISS'}, checks failed ${run.failed}`)
  }
  lines.push(`  best:    seed ${report.best.seed} (${report.best.failed} failed)`)
  lines.push(`  weakest: seed ${report.weakest.seed} (${report.weakest.failed} failed)`)
  if (report.phase2a.length > 0) {
    lines.push('  Phase 2a (from the reloaded database):')
    for (const row of report.phase2a) lines.push(`    [${row.ok ? 'ok ' : 'FAIL'}] ${row.name} — ${row.detail}`)
  }
  lines.push('  Phase 5 metrics (not run):')
  for (const metric of PHASE5_METRICS) lines.push(`    [stub] ${metric.label}`)
  lines.push(`  ${report.summary}`)
  return lines.join('\n')
}

export { formatCoverageReport }
