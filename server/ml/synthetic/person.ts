import { CHECKIN_ANSWER_KEYS, type CheckinAnswerKey } from '../../checkins-store'
import { addDays } from './calendar'
import { hashSeed, makeRng } from './rng'
import type { SyntheticConfig } from './config'

/**
 * The single simulated person (Phase 3).
 *
 * Earlier drafts had 20+ named people and a random population. The brief that
 * this file implements is deliberately narrower: **one** person over one year
 * that mixes all 23 catalogue behaviours — some as per-task behaviours, some as
 * scripted episodes in time. The person exists only to check that the pipeline
 * can be built and validated end to end; nothing here is a claim about the real
 * user, and none of it is ever mixed into real data.
 *
 * The hidden rules live here; `hidden-state.ts` turns them into a day-by-day
 * latent state, and `outcomes.ts` turns that into what actually happened.
 */

/** The nine latent dimensions — exactly the nine check-in fields. */
export const DIMENSIONS = CHECKIN_ANSWER_KEYS
export type Dimension = CheckinAnswerKey

/** The activity tags the person's tasks use. */
export const TAGS = ['Exercise', 'Household', 'Relationship', 'Reading', 'Work', 'Health', 'Study'] as const
export type Tag = (typeof TAGS)[number]

export type Priority = 'none' | 'low' | 'medium' | 'high'

/** How each tag reacts to the hidden state (higher dimension => more likely). */
export const TAG_PROFILES: Record<Tag, Partial<Record<Dimension, number>>> = {
  Exercise: { energy: 0.7, body: 0.6, stress: -0.25 },
  Household: { free_time: 0.5, energy: 0.3, workload: -0.1 },
  Relationship: { free_time: 0.4, feeling: 0.4 },
  Reading: { free_time: 0.6, focus: 0.4 },
  Work: { focus: 0.5, workload: 0.3, energy: 0.2, free_time: -0.1 },
  Health: { sleep: 0.3, body: 0.4, stress: -0.3 },
  Study: { focus: 0.6, motivation: 0.4, free_time: 0.3 },
}

export interface TaskBehaviour {
  /** Which catalogue behaviours this task embodies. */
  catalogueIds: string[]
  /** How strongly the tag's hidden-state reactions matter (0 = none). */
  moodSensitivity: number
  /** Outcome noise, in log-odds units. */
  noise: number
  /** How strongly priority shifts completion. */
  prioritySensitivity: number
  /** How strongly a recent streak shifts completion. */
  streakEffect: number
  /** Extra completion at weekends. */
  weekendBoost: number
  /** Slow ramp up or down across the year. */
  trend: 'none' | 'rise' | 'fall'
  /** How much the session exceeds the target when the person overachieves. */
  overachieve: number
  /** When true the target is set higher than the person usually manages. */
  overcommit: boolean
  /** When true the outcome ignores everything (pure noise). */
  nearRandom: boolean
  /** When true the outcome leans on the tag profile more than the state. */
  tagDriven: boolean
}

export interface TaskSpec {
  key: string
  name: string
  tags: Tag[]
  priority: Priority
  targetMinutes: number | null
  recurrence: 'daily' | 'weekly' | 'custom'
  weekdays?: number[]
  weeklyDow?: number
  preferredTime: string | null
  behaviour: TaskBehaviour
  /** Days after the start on which the task first exists (0 = from the start). */
  createdDayOffset: number
  /** Day index on which the task is retired, or null to keep it. */
  retiredDayOffset: number | null
}

export type EpisodeKind = 'sick' | 'busy' | 'bad' | 'burnout' | 'travel' | 'sparse' | 'schedule' | 'deadline'

export interface EpisodeWindow {
  kind: EpisodeKind
  startDay: number
  endDay: number
  label: string
  /** While set, the person logs nothing at all. */
  noLogging?: boolean
  /** Minutes added to the typical start time while the episode lasts. */
  startTimeShift?: number
}

export type OffDayKind = 'sick' | 'travel' | 'holiday' | 'personal'

export interface OffDaySpec {
  kind: OffDayKind
  startDay: number
  endDay: number
  reason: string | null
  /** True when the off day is entered into the log only after the fact. */
  addedLater: boolean
}

export interface RegimeSpec {
  /** Day index at which the change lands. */
  atDay: number
  /** Label kept in the ground truth only. */
  label: string
  completionShift: number
  freeTimeShift: number
  energyShift: number
}

export interface PersonParams {
  personId: string
  label: string
  seed: number
  startDate: string
  endDate: string
  historyDays: number
  pendingTailDays: number
  baseline: Record<Dimension, number>
  carry: number
  volatility: number
  seasonality: number
  /** Extra log-odds at weekends. */
  weekendBoost: number
  /** Reporting honesty: how closely reported answers track the hidden state. */
  answerFidelity: number
  answerNoise: number
  answerBias: Partial<Record<Dimension, number>>
  checkinSkipRate: number
  partialAnswerRate: number
  midDayEditRate: number
  reviewRate: number
  lateLogRate: number
  startTimeMean: number
  startTimeSd: number
  durationSpread: number
  tasks: TaskSpec[]
  episodes: EpisodeWindow[]
  offDays: OffDaySpec[]
  regimeChange: RegimeSpec | null
  /** The catalogue id of the pure-noise task. */
  noiseTaskKey: string
}

export interface Person extends PersonParams {
  dates: string[]
}

/**
 * The 23 catalogue behaviours. Each is realised either as a per-task behaviour,
 * a scripted episode in time, a reporting habit, or (for the two history-length
 * ones) through the harness's learning-curve checks. The generator's coverage
 * report lists this table so it is clear all 23 are present.
 */
export interface CatalogueEntry {
  id: string
  label: string
  realisedAs: 'task' | 'episode' | 'reporting' | 'harness'
  note: string
}

export const CATALOGUE: CatalogueEntry[] = [
  { id: 'consistent', label: 'Consistent', realisedAs: 'task', note: 'Read a book: steady, low-noise completion.' },
  { id: 'erratic', label: 'Erratic', realisedAs: 'task', note: 'Inbox triage: high day-to-day noise.' },
  { id: 'seasonal', label: 'Seasonal', realisedAs: 'episode', note: 'Seasonal shift in state and best times.' },
  { id: 'mostly-skipping', label: 'Mostly skipping', realisedAs: 'episode', note: 'A sparse-logging stretch with many skips.' },
  { id: 'sudden-change', label: 'Sudden change', realisedAs: 'episode', note: 'One regime change late in the year.' },
  { id: 'mood-driven', label: 'Mood-driven', realisedAs: 'task', note: 'Morning run: strongly tracks energy and body.' },
  { id: 'mood-independent', label: 'Mood-independent', realisedAs: 'task', note: 'Read a book / journal: completion ignores the state.' },
  { id: 'unreliable-checkin', label: 'Unreliable check-in', realisedAs: 'reporting', note: 'Reporting noise and occasional bias.' },
  { id: 'shift-worker', label: 'Shift worker', realisedAs: 'episode', note: 'A schedule change shifts the typical start time.' },
  { id: 'weekend-heavy', label: 'Weekend-heavy', realisedAs: 'task', note: 'Tidy the kitchen: much more likely at weekends.' },
  { id: 'burnout-recovery', label: 'Burnout and recovery', realisedAs: 'episode', note: 'A gradual burnout dip and partial recovery.' },
  { id: 'habit-builder', label: 'Habit builder', realisedAs: 'task', note: 'Write journal: completion rises across the year.' },
  { id: 'over-committer', label: 'Over-committer', realisedAs: 'task', note: 'Call family: target set above the usual achievement.' },
  { id: 'overachiever', label: 'Overachiever', realisedAs: 'task', note: 'Morning run: sessions often exceed the target.' },
  { id: 'deadline-cycles', label: 'Deadline cycles', realisedAs: 'episode', note: 'A monthly workload and stress cycle.' },
  { id: 'sparse-logger', label: 'Sparse logger', realisedAs: 'episode', note: 'A late-year stretch with little logging.' },
  { id: 'near-random', label: 'Near-random', realisedAs: 'task', note: 'Inbox triage: outcome is pure noise.' },
  { id: 'priority-driven', label: 'Priority-driven', realisedAs: 'task', note: 'Call family: priority strongly shifts completion.' },
  { id: 'priority-irrelevant', label: 'Priority-irrelevant', realisedAs: 'task', note: 'One priority level (low) is pure noise.' },
  { id: 'tag-driven', label: 'Tag-driven', realisedAs: 'task', note: 'Study Spanish: leans on the tag profile.' },
  { id: 'travel-heavy', label: 'Travel-heavy', realisedAs: 'episode', note: 'A travel week with no logging.' },
  { id: 'short-history', label: 'Short history', realisedAs: 'harness', note: 'Learning curve at 1 and 2 weeks.' },
  { id: 'medium-history', label: 'Medium history', realisedAs: 'harness', note: 'Learning curve at 4 and 8 weeks.' },
]

/** The seven canonical tasks. Quick mode keeps the first four. */
const TASKS: TaskSpec[] = [
  {
    key: 'read',
    name: 'Read a book',
    tags: ['Reading'],
    priority: 'medium',
    targetMinutes: 60,
    recurrence: 'daily',
    preferredTime: null,
    behaviour: { catalogueIds: ['consistent', 'mood-independent'], moodSensitivity: 0, noise: 0.45, prioritySensitivity: 0.3, streakEffect: 0.3, weekendBoost: 0.05, trend: 'none', overachieve: 0.1, overcommit: false, nearRandom: false, tagDriven: false },
    createdDayOffset: 0,
    retiredDayOffset: null,
  },
  {
    key: 'run',
    name: 'Morning run',
    tags: ['Exercise', 'Health'],
    priority: 'high',
    targetMinutes: 30,
    recurrence: 'custom',
    weekdays: [1, 3, 5],
    preferredTime: '07:00',
    behaviour: { catalogueIds: ['mood-driven', 'overachiever'], moodSensitivity: 1.6, noise: 0.6, prioritySensitivity: 0.6, streakEffect: 0.4, weekendBoost: 0.15, trend: 'none', overachieve: 0.45, overcommit: false, nearRandom: false, tagDriven: false },
    createdDayOffset: 0,
    retiredDayOffset: null,
  },
  {
    key: 'kitchen',
    name: 'Tidy the kitchen',
    tags: ['Household'],
    priority: 'low',
    targetMinutes: 15,
    recurrence: 'daily',
    preferredTime: null,
    behaviour: { catalogueIds: ['weekend-heavy'], moodSensitivity: 0.5, noise: 0.7, prioritySensitivity: 0.2, streakEffect: 0.2, weekendBoost: 0.6, trend: 'none', overachieve: 0.1, overcommit: false, nearRandom: false, tagDriven: false },
    createdDayOffset: 0,
    retiredDayOffset: null,
  },
  {
    key: 'family',
    name: 'Call family',
    tags: ['Relationship'],
    priority: 'high',
    targetMinutes: 20,
    recurrence: 'weekly',
    weeklyDow: 0,
    preferredTime: '19:00',
    behaviour: { catalogueIds: ['priority-driven', 'over-committer'], moodSensitivity: 0.7, noise: 0.5, prioritySensitivity: 1.5, streakEffect: 0.2, weekendBoost: 0.1, trend: 'none', overachieve: 0.05, overcommit: true, nearRandom: false, tagDriven: false },
    createdDayOffset: 0,
    retiredDayOffset: null,
  },
  {
    key: 'study',
    name: 'Study Spanish',
    tags: ['Study'],
    priority: 'medium',
    targetMinutes: 25,
    recurrence: 'daily',
    preferredTime: '18:30',
    behaviour: { catalogueIds: ['tag-driven'], moodSensitivity: 1.0, noise: 0.55, prioritySensitivity: 0.4, streakEffect: 0.5, weekendBoost: 0, trend: 'none', overachieve: 0.15, overcommit: false, nearRandom: false, tagDriven: true },
    createdDayOffset: 0,
    retiredDayOffset: null,
  },
  {
    key: 'journal',
    name: 'Write journal',
    tags: ['Reading'],
    priority: 'none',
    targetMinutes: 10,
    recurrence: 'daily',
    preferredTime: '22:30',
    behaviour: { catalogueIds: ['habit-builder', 'mood-independent'], moodSensitivity: 0, noise: 0.5, prioritySensitivity: 0, streakEffect: 0.4, weekendBoost: 0, trend: 'rise', overachieve: 0.05, overcommit: false, nearRandom: false, tagDriven: false },
    createdDayOffset: 0,
    retiredDayOffset: null,
  },
  {
    key: 'inbox',
    name: 'Inbox triage',
    tags: ['Work'],
    priority: 'low',
    targetMinutes: 20,
    recurrence: 'daily',
    preferredTime: null,
    behaviour: { catalogueIds: ['near-random', 'erratic', 'priority-irrelevant'], moodSensitivity: 0, noise: 1.5, prioritySensitivity: 0, streakEffect: 0, weekendBoost: 0, trend: 'none', overachieve: 0.05, overcommit: false, nearRandom: true, tagDriven: false },
    createdDayOffset: 0,
    retiredDayOffset: null,
  },
]

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value
}

function baseBaseline(): Record<Dimension, number> {
  return {
    energy: 0.6,
    feeling: 0.62,
    motivation: 0.6,
    sleep: 0.6,
    stress: 0.45,
    free_time: 0.55,
    focus: 0.6,
    body: 0.6,
    workload: 0.45,
  }
}

/**
 * Build the person and their timeline. The task list is trimmed to fit
 * `config.numTasks`; extra tasks created mid-way and one retired task are always
 * appended so the coverage matrix's "created mid-way" and "retired" conditions
 * are met without inflating the core task count.
 */
export function buildPerson(config: SyntheticConfig): Person {
  const rng = makeRng(config.seed).fork('person')
  const startDate = addDays(config.endDate, -(config.historyDays - 1))
  const dates: string[] = []
  for (let index = 0; index < config.historyDays; index += 1) dates.push(addDays(startDate, index))
  const last = config.historyDays - 1

  const core = TASKS.slice(0, Math.max(3, Math.min(config.numTasks, TASKS.length)))

  // Two tasks appear part-way through the year; one older task is retired.
  const midwayA: TaskSpec = {
    key: 'meditate',
    name: 'Meditate',
    tags: ['Health'],
    priority: 'medium',
    targetMinutes: 10,
    recurrence: 'daily',
    preferredTime: '07:30',
    behaviour: { catalogueIds: ['habit-builder'], moodSensitivity: 0.4, noise: 0.5, prioritySensitivity: 0.4, streakEffect: 0.5, weekendBoost: 0, trend: 'rise', overachieve: 0.05, overcommit: false, nearRandom: false, tagDriven: false },
    createdDayOffset: Math.round(config.historyDays * 0.4),
    retiredDayOffset: null,
  }
  // A second mid-way task only when the year is long enough to give its weekly
  // schedule enough opportunities; in quick mode it would be too sparse.
  const midwayB: TaskSpec | null =
    config.historyDays >= 200
      ? {
          key: 'language-exchange',
          name: 'Language exchange',
          tags: ['Study', 'Relationship'],
          priority: 'low',
          targetMinutes: 30,
          recurrence: 'weekly',
          weeklyDow: 3,
          preferredTime: '20:00',
          behaviour: { catalogueIds: ['tag-driven'], moodSensitivity: 0.8, noise: 0.6, prioritySensitivity: 0.3, streakEffect: 0.3, weekendBoost: 0, trend: 'none', overachieve: 0.1, overcommit: false, nearRandom: false, tagDriven: true },
          createdDayOffset: Math.round(config.historyDays * 0.55),
          retiredDayOffset: null,
        }
      : null
  const retired: TaskSpec = {
    key: 'old-project',
    name: 'Old side project',
    tags: ['Work'],
    priority: 'low',
    targetMinutes: 45,
    recurrence: 'daily',
    preferredTime: null,
    behaviour: { catalogueIds: ['erratic'], moodSensitivity: 0.3, noise: 1.0, prioritySensitivity: 0.2, streakEffect: 0.1, weekendBoost: 0, trend: 'fall', overachieve: 0.05, overcommit: false, nearRandom: false, tagDriven: false },
    createdDayOffset: 0,
    retiredDayOffset: Math.round(config.historyDays * 0.35),
  }

  const tasks = [...core, midwayA, ...(midwayB ? [midwayB] : []), retired]

  const episodes: EpisodeWindow[] = [
    { kind: 'busy', startDay: Math.round(last * 0.16), endDay: Math.round(last * 0.22), label: 'busy period' },
    { kind: 'sick', startDay: Math.round(last * 0.3), endDay: Math.round(last * 0.3) + 6, label: 'sick week' },
    { kind: 'travel', startDay: Math.round(last * 0.42), endDay: Math.round(last * 0.42) + 6, label: 'travel week', noLogging: true },
    { kind: 'bad', startDay: Math.round(last * 0.5), endDay: Math.round(last * 0.5) + 6, label: 'low week' },
    { kind: 'burnout', startDay: Math.round(last * 0.62), endDay: Math.round(last * 0.62) + 20, label: 'burnout dip' },
    { kind: 'deadline', startDay: 0, endDay: last, label: 'monthly deadline cycle' },
    { kind: 'schedule', startDay: Math.round(last * 0.86), endDay: last, label: 'schedule change', startTimeShift: -150 },
    { kind: 'sparse', startDay: Math.round(last * 0.9), endDay: last, label: 'sparse logging' },
  ]

  const offDays: OffDaySpec[] = [
    { kind: 'sick', startDay: Math.round(last * 0.08), endDay: Math.round(last * 0.08) + 2, reason: 'Unwell', addedLater: false },
    { kind: 'travel', startDay: Math.round(last * 0.42), endDay: Math.round(last * 0.42) + 6, reason: 'Away from home', addedLater: false },
    { kind: 'holiday', startDay: Math.round(last * 0.67), endDay: Math.round(last * 0.67), reason: 'Public holiday', addedLater: false },
    { kind: 'personal', startDay: Math.round(last * 0.78), endDay: Math.round(last * 0.78), reason: null, addedLater: false },
    { kind: 'personal', startDay: Math.round(last * 0.55), endDay: Math.round(last * 0.55), reason: null, addedLater: true },
  ]

  // A regime change lands after the validation period, with a calm stretch just
  // before it (no episode covers the two weeks leading up to it).
  const regimeDay = Math.round(last * 0.73)
  const regimeChange: RegimeSpec = {
    atDay: regimeDay,
    label: 'new job and earlier schedule',
    completionShift: -0.22,
    freeTimeShift: -0.18,
    energyShift: -0.05,
  }
  // Clear a calm window before the regime change.
  for (const episode of episodes) {
    if (episode.startDay >= regimeDay - 14 && episode.startDay <= regimeDay) {
      episode.startDay = Math.max(0, episode.startDay - 21)
      episode.endDay = Math.max(episode.startDay, episode.endDay - 21)
    }
  }

  const params: PersonParams = {
    personId: config.personId,
    label: config.personLabel,
    seed: config.seed,
    startDate,
    endDate: config.endDate,
    historyDays: config.historyDays,
    pendingTailDays: config.pendingTailDays,
    baseline: baseBaseline(),
    carry: 0.55,
    volatility: 0.17,
    seasonality: 0.5,
    weekendBoost: 0.2,
    answerFidelity: 0.72,
    answerNoise: 0.55,
    answerBias: { stress: 0.15 },
    checkinSkipRate: 0.13,
    partialAnswerRate: 0.2,
    midDayEditRate: 0.05,
    reviewRate: 0.3,
    lateLogRate: 0.12,
    startTimeMean: 10 * 60,
    startTimeSd: 150,
    durationSpread: 0.35,
    tasks,
    episodes,
    offDays,
    regimeChange,
    noiseTaskKey: 'inbox',
  }

  // A tiny amount of per-person jitter so the seed genuinely changes the person.
  for (const dim of DIMENSIONS) params.baseline[dim] = clamp01(params.baseline[dim] + rng.float(-0.03, 0.03))

  return { ...params, dates }
}

/** The tags a task carries, resolved to names. */
export function taskTags(spec: TaskSpec): string[] {
  return [...spec.tags]
}

/** Blend the tag profiles of the tags a task carries. */
export function blendedTagProfile(tags: Tag[]): Partial<Record<Dimension, number>> {
  const out: Partial<Record<Dimension, number>> = {}
  let count = 0
  for (const tag of tags) {
    const profile = TAG_PROFILES[tag]
    for (const key of Object.keys(profile) as Dimension[]) {
      out[key] = (out[key] ?? 0) + (profile[key] ?? 0)
    }
    count += 1
  }
  if (count === 0) return out
  for (const key of Object.keys(out) as Dimension[]) out[key] = (out[key] ?? 0) / count
  return out
}

export { hashSeed }
