import type { DatabaseSync } from 'node:sqlite'
import { generateModel } from './generate'
import { buildCoverageReport, formatCoverageReport, type CoverageReport } from './coverage'
import { countRows } from './model'
import { combineReports, runModelChecks, runPhase2aChecks, runPhase4Checks, type CheckResult, type ChecksReport } from './checks'
import { runPhase5Checks } from './phase5-checks'
import { runPhase6Checks } from './phase6-checks'
import { type SyntheticConfig } from './config'
import type { SyntheticModel } from './model'
/**
 * Evaluation harness (Phase 3, extended in Phase 5).
 *
 * It runs, against the reloaded synthetic database, the checks that can honestly
 * be run: the data-quality and leakage checks, the Phase 2a checks (does the
 * readiness score relate to what got done, per task; do the display estimates
 * hold up against the simple baselines), the Phase 4 pipeline checks, and the
 * Phase 5 model checks — Brier score and calibration against the baselines and
 * the hidden ground-truth probabilities, a learning curve, feature ablations,
 * the mood-zero-effect control, drift, promotion/rollback and shadow mode.
 *
 * Every Phase 5 number is computed on **synthetic data** and is never an accuracy
 * claim about the real user. Where there is not enough data to score something,
 * the check says so instead of inventing a number.
 *
 * Results are always reported per task and per tag, and across at least three
 * seeds with the weakest shown next to the best — never as one blended score.
 */

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
  phase4: CheckResult[]
  phase5: CheckResult[]
  phase6: CheckResult[]
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
  const phase4 = db && userId !== undefined ? runPhase4Checks(db, userId, config) : []
  const phase5 = db && userId !== undefined ? runPhase5Checks(db, userId, config) : []
  const phase6 = db && userId !== undefined ? runPhase6Checks(db, userId, config) : []
  const summary = runs.every((run) => run.failed === 0 && run.coverageOk)
    ? `All available checks pass across ${runs.length} seed(s); ${best.seed} is best and ${weakest.seed} weakest. Phase 5 and Phase 6 model checks run on the reloaded synthetic data only.`
    : `Checks failed: ${runs.reduce((sum, run) => sum + run.failed, 0)} failure(s) across ${runs.length} seed(s); weakest seed ${weakest.seed}.`

  return { personId: config.personId, seeds: runs, best, weakest, phase2a, phase4, phase5, phase6, summary }
}

export function harnessReport(personId: string, report: HarnessReport): ChecksReport {
  const modelChecks = report.seeds.flatMap((run) => run.checks.map((row) => ({ ...row, section: `seed-${run.seed} ${row.section}` })))
  return combineReports(personId, 'harness', modelChecks, report.phase2a, report.phase4, report.phase5, report.phase6)
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
  if (report.phase4.length > 0) {
    lines.push('  Phase 4 (from the reloaded database; pipeline checks only, never accuracy claims):')
    for (const row of report.phase4) lines.push(`    [${row.ok ? 'ok ' : 'FAIL'}] ${row.name} — ${row.detail}`)
  }
  if (report.phase5.length > 0) {
    lines.push('  Phase 5 (SYNTHETIC DATA ONLY — model checks, never accuracy claims about the real user):')
    for (const row of report.phase5) lines.push(`    [${row.ok ? 'ok ' : 'FAIL'}] ${row.name} — ${row.detail}`)
  }
  if (report.phase6.length > 0) {
    lines.push('  Phase 6 (SYNTHETIC DATA ONLY — continuous learning, drift, promotion/rollback and live health; never accuracy claims):')
    for (const row of report.phase6) lines.push(`    [${row.ok ? 'ok ' : 'FAIL'}] ${row.name} — ${row.detail}`)
  }
  lines.push(`  ${report.summary}`)
  return lines.join('\n')
}

export { formatCoverageReport }
