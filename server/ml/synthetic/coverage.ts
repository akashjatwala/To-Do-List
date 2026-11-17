import type { CoverageMinimums } from './config'

/**
 * Coverage tracking and reporting.
 *
 * The generator increments a counter every time it emits something the coverage
 * matrix cares about (a skipped check-in, a mid-day edit, an off day, a followed
 * recommendation, …). After the run, `buildCoverageReport` compares every count
 * with its minimum and the total row count with the hard cap. The run is only
 * accepted when nothing is short and the cap is respected — so a dataset that
 * quietly thinned out can never be mistaken for a complete one.
 */

export type CoverageKey = keyof CoverageMinimums

export const COVERAGE_LABELS: Record<CoverageKey, string> = {
  skippedCheckins: 'skipped check-ins',
  partialCheckins: 'partial check-ins',
  midDayEdits: 'mid-day check-in edits',
  dayReviews: 'end-of-day reviews',
  multiSessionDays: 'multi-session days',
  targetChanges: 'target changes',
  priorityChanges: 'priority changes',
  tagChanges: 'tag changes',
  tasksCreatedMidway: 'tasks created mid-way',
  tasksRetired: 'tasks retired',
  postponedWithReason: 'postponed with a reason',
  skippedWithReason: 'skipped with a reason',
  lateLoggedCompletions: 'late-logged completions',
  invalidOrDuplicateEntries: 'invalid/duplicate entries rejected',
  offDayPeriods: 'off-day periods',
  recommendationsShown: 'recommendations shown',
  exploratoryRecommendations: 'exploratory recommendations',
  recommendationsFollowed: 'recommendations followed',
  recommendationsIgnored: 'recommendations ignored',
  recommendationsNudged: 'recommendations nudged',
  rescheduleAccepted: 'reschedule suggestions accepted',
  rescheduleIgnored: 'reschedule suggestions ignored',
  dropAccepted: 'drop suggestions accepted',
  dropIgnored: 'drop suggestions ignored',
  openMidPeriodItems: 'items left open mid-period',
  pendingLatestDays: 'pending latest days',
}

export const COVERAGE_KEYS = Object.keys(COVERAGE_LABELS) as CoverageKey[]

/** Extra conditions the brief lists that are not simple counts. */
export const COVERAGE_FLAGS: Record<string, string> = {
  seasonalShift: 'a seasonal shift',
  burnoutDip: 'a burnout dip',
  deadlineCycle: 'a deadline cycle',
  nearRandomTask: 'a near-random task',
  habitBuilderTask: 'a habit-builder task',
  pureNoiseTask: 'a task whose outcome is pure noise',
  pureNoisePriority: 'a priority level that is pure noise',
  moodAffectsSome: 'mood affects some tasks',
  moodAffectsOthersNot: 'mood affects other tasks not at all',
  regimeChange: 'a regime change after the validation period',
  calmStretchBeforeRegime: 'a calm stretch before the regime change',
  offDayRange: 'an off-day range',
  offDaySingle: 'a single off day',
  offDayNoReason: 'an off day with no reason',
  offDayAddedLater: 'an off day added after the fact',
  travelWeekNoLogging: 'a travel week with no logging',
  sickWeek: 'a sick week',
  scheduleChange: 'a sudden schedule change',
  sparseLogging: 'a sparse-logging period',
}

export interface CoverageTracker {
  counts: Record<CoverageKey, number>
  flags: Record<string, boolean>
  bump(key: CoverageKey, by?: number): void
  mark(flag: string): void
}

export function createCoverageTracker(): CoverageTracker {
  const counts = {} as Record<CoverageKey, number>
  for (const key of COVERAGE_KEYS) counts[key] = 0
  const flags: Record<string, boolean> = {}
  return {
    counts,
    flags,
    bump(key, by = 1) {
      counts[key] += by
    },
    mark(flag) {
      flags[flag] = true
    },
  }
}

export interface CoverageRow {
  key: CoverageKey
  label: string
  count: number
  minimum: number
  ok: boolean
}

export interface CoverageFlagRow {
  flag: string
  label: string
  present: boolean
}

export interface CoverageReport {
  rows: CoverageRow[]
  flagRows: CoverageFlagRow[]
  totalRows: number
  maxRows: number
  capOk: boolean
  missing: string[]
  allOk: boolean
}

export function buildCoverageReport(
  tracker: CoverageTracker,
  minimums: CoverageMinimums,
  totalRows: number,
  maxRows: number,
): CoverageReport {
  const rows: CoverageRow[] = COVERAGE_KEYS.map((key) => ({
    key,
    label: COVERAGE_LABELS[key],
    count: tracker.counts[key],
    minimum: minimums[key],
    ok: tracker.counts[key] >= minimums[key],
  }))
  const flagRows: CoverageFlagRow[] = Object.entries(COVERAGE_FLAGS).map(([flag, label]) => ({
    flag,
    label,
    present: tracker.flags[flag] === true,
  }))

  const missing = [
    ...rows.filter((row) => !row.ok).map((row) => `${row.label}: ${row.count} of ${row.minimum}`),
    ...flagRows.filter((row) => !row.present).map((row) => `missing ${row.label}`),
  ]
  const capOk = totalRows <= maxRows
  if (!capOk) missing.push(`row cap exceeded: ${totalRows} of ${maxRows}`)

  return {
    rows,
    flagRows,
    totalRows,
    maxRows,
    capOk,
    missing,
    allOk: missing.length === 0,
  }
}

/** A compact, human-readable report. Never prints the data itself. */
export function formatCoverageReport(report: CoverageReport): string {
  const lines: string[] = []
  lines.push('Coverage report')
  lines.push('---------------')
  for (const row of report.rows) {
    const mark = row.ok ? 'ok ' : 'MISS'
    lines.push(`  [${mark}] ${row.label.padEnd(34)} ${String(row.count).padStart(6)} / ${row.minimum}`)
  }
  lines.push('  Conditions:')
  for (const row of report.flagRows) {
    lines.push(`  [${row.present ? 'ok ' : 'MISS'}] ${row.label}`)
  }
  lines.push('  Rows:')
  lines.push(`  [${report.capOk ? 'ok ' : 'MISS'}] total rows ${report.totalRows} / cap ${report.maxRows}`)
  lines.push(report.allOk ? 'Result: PASS — every minimum met and the cap respected.' : `Result: FAIL — ${report.missing.length} unmet condition(s).`)
  return lines.join('\n')
}
