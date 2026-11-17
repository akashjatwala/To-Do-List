import { toLocalDate } from './calendar'

/**
 * Configuration for the Phase 3 synthetic dataset (one person).
 *
 * The config is a typed TypeScript module rather than JSON so it is checked by
 * `tsc` and so the only JSON-looking data anywhere in the dataset remains the
 * app's own columns. Everything that affects the output — the seed, the date
 * range, the size and the layer switches — lives here, so a run is reproducible
 * from (config, generator version).
 *
 * Sizing rules from the brief, enforced in code:
 * - A run must never exceed `maxRows` rows across every file it writes.
 * - The estimate is printed before anything is generated; if it does not fit,
 *   the number of tasks is reduced until it does, and the run refuses to start
 *   if even the minimum does not fit.
 */

export const GENERATOR_VERSION = 'phase3-1.0.0'

/** Which optional layer files are produced, each with its own stream + flag. */
export interface LayerSwitches {
  /** Off days (sick / travel / holiday / single / no reason / added later). */
  offDays: boolean
  /** Recommendation exposure: shown / exploratory / followed / ignored / nudged. */
  recommendations: boolean
  /** A single regime change after the validation period. */
  regimeChange: boolean
  /** Live replay: feed days one at a time; predictions stored separately. */
  liveReplay: boolean
}

/**
 * Every condition the run must contain at least once (or a stated number of
 * times). The coverage report counts each one and the run fails when any
 * minimum is missed, so a dataset that silently thinned out is never accepted.
 */
export interface CoverageMinimums {
  skippedCheckins: number
  partialCheckins: number
  midDayEdits: number
  dayReviews: number
  multiSessionDays: number
  targetChanges: number
  priorityChanges: number
  tagChanges: number
  tasksCreatedMidway: number
  tasksRetired: number
  postponedWithReason: number
  skippedWithReason: number
  lateLoggedCompletions: number
  invalidOrDuplicateEntries: number
  offDayPeriods: number
  recommendationsShown: number
  exploratoryRecommendations: number
  recommendationsFollowed: number
  recommendationsIgnored: number
  recommendationsNudged: number
  rescheduleAccepted: number
  rescheduleIgnored: number
  dropAccepted: number
  dropIgnored: number
  openMidPeriodItems: number
  pendingLatestDays: number
}

export interface SyntheticConfig {
  generatorVersion: string
  seed: number
  personId: string
  personLabel: string
  /** The last day of the history (inclusive), `YYYY-MM-DD`. */
  endDate: string
  /** How many days of history to generate. */
  historyDays: number
  /** How many recurring tasks the person tracks. */
  numTasks: number
  /** Hard cap on rows across every written file. */
  maxRows: number
  /** Preferred target band for the row count, for the pre-run estimate. */
  targetRows: [number, number]
  /** Most recent days left pending / not yet evaluated. */
  pendingTailDays: number
  layers: LayerSwitches
  coverage: CoverageMinimums
}

/** The full one-year coverage matrix. */
export const FULL_COVERAGE: CoverageMinimums = {
  skippedCheckins: 25,
  partialCheckins: 10,
  midDayEdits: 10,
  dayReviews: 30,
  multiSessionDays: 40,
  targetChanges: 3,
  priorityChanges: 3,
  tagChanges: 2,
  tasksCreatedMidway: 2,
  tasksRetired: 1,
  postponedWithReason: 20,
  skippedWithReason: 20,
  lateLoggedCompletions: 10,
  invalidOrDuplicateEntries: 10,
  offDayPeriods: 5,
  recommendationsShown: 60,
  exploratoryRecommendations: 10,
  recommendationsFollowed: 10,
  recommendationsIgnored: 10,
  recommendationsNudged: 10,
  rescheduleAccepted: 5,
  rescheduleIgnored: 5,
  dropAccepted: 5,
  dropIgnored: 5,
  openMidPeriodItems: 5,
  pendingLatestDays: 1,
}

/** The quick matrix: a few months, a handful of tasks, a small row count. */
export const QUICK_COVERAGE: CoverageMinimums = {
  skippedCheckins: 8,
  partialCheckins: 4,
  midDayEdits: 3,
  dayReviews: 8,
  multiSessionDays: 10,
  targetChanges: 2,
  priorityChanges: 2,
  tagChanges: 1,
  tasksCreatedMidway: 1,
  tasksRetired: 1,
  postponedWithReason: 5,
  skippedWithReason: 5,
  lateLoggedCompletions: 3,
  invalidOrDuplicateEntries: 5,
  offDayPeriods: 3,
  recommendationsShown: 15,
  exploratoryRecommendations: 3,
  recommendationsFollowed: 3,
  recommendationsIgnored: 3,
  recommendationsNudged: 3,
  rescheduleAccepted: 2,
  rescheduleIgnored: 2,
  dropAccepted: 2,
  dropIgnored: 2,
  openMidPeriodItems: 3,
  pendingLatestDays: 1,
}

/** A fixed, reproducible end date. Override it to move the window. */
export const DEFAULT_END_DATE = '2026-11-17'

export interface ConfigOverrides {
  seed?: number
  endDate?: string
  historyDays?: number
  numTasks?: number
  personId?: string
  personLabel?: string
  pendingTailDays?: number
  layers?: Partial<LayerSwitches>
  /** When true, the quick preset is the starting point. */
  quick?: boolean
}

/**
 * Build the resolved config. `quick` (from the flag or the preset) swaps in the
 * smaller sizing and coverage matrix; any explicit override still wins.
 */
export function resolveConfig(overrides: ConfigOverrides = {}): SyntheticConfig {
  const quick = overrides.quick === true
  const base: SyntheticConfig = quick
    ? {
        generatorVersion: GENERATOR_VERSION,
        seed: 20261117,
        personId: 'person-001',
        personLabel: 'Sam (synthetic)',
        endDate: DEFAULT_END_DATE,
        historyDays: 90,
        numTasks: 4,
        maxRows: 10_000,
        targetRows: [1_200, 1_500],
        pendingTailDays: 4,
        layers: { offDays: true, recommendations: true, regimeChange: true, liveReplay: true },
        coverage: { ...QUICK_COVERAGE },
      }
    : {
        generatorVersion: GENERATOR_VERSION,
        seed: 20261117,
        personId: 'person-001',
        personLabel: 'Sam (synthetic)',
        endDate: DEFAULT_END_DATE,
        historyDays: 365,
        numTasks: 7,
        maxRows: 10_000,
        targetRows: [5_000, 8_000],
        pendingTailDays: 5,
        layers: { offDays: true, recommendations: true, regimeChange: true, liveReplay: true },
        coverage: { ...FULL_COVERAGE },
      }

  return {
    ...base,
    seed: overrides.seed ?? base.seed,
    endDate: overrides.endDate ?? base.endDate,
    historyDays: overrides.historyDays ?? base.historyDays,
    numTasks: overrides.numTasks ?? base.numTasks,
    personId: overrides.personId ?? base.personId,
    personLabel: overrides.personLabel ?? base.personLabel,
    pendingTailDays: overrides.pendingTailDays ?? base.pendingTailDays,
    layers: { ...base.layers, ...(overrides.layers ?? {}) },
    coverage: { ...base.coverage },
  }
}

/**
 * The checked-in config the `synthetic:generate` command uses when no override
 * is passed. It fixes the seed and the date so the committed dataset is exactly
 * reproducible.
 */
export const CONFIG: SyntheticConfig = resolveConfig()

/** Today's local date, for callers that want "end at today". */
export function todayLocalDate(): string {
  return toLocalDate(new Date())
}

/** Canonical JSON with sorted keys, so the config hash never drifts. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`
}
