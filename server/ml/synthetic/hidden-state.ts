import { DIMENSIONS, type Dimension, type EpisodeKind, type Person } from './person'
import { seasonPhase, weekdayOf } from './calendar'
import { clamp01, makeRng } from './rng'

/**
 * The hidden daily state (Phase 3).
 *
 * Every day the person has a latent value for each of the nine dimensions the
 * check-in asks about. The value carries over from yesterday, drifts towards a
 * personal baseline, and is pushed by weekday, season and the scripted episodes
 * (sick, busy, low, burnout, travel, deadline cycle). A regime change shifts the
 * baseline partway through the year.
 *
 * Both the check-ins and the task outcomes are drawn from this state, so the
 * generator's hidden rules are the single source of truth — the ground truth the
 * harness is allowed to read, and nothing the models ever see.
 */

export interface HiddenState {
  date: string
  index: number
  dims: Record<Dimension, number>
  /** True while the person is on an off day (from the off-days layer). */
  offDay: boolean
  /** The episode in force, if any. */
  episode: EpisodeKind | 'none'
  /** True once the regime change has taken effect. */
  regime: boolean
  /** Deadline-cycle intensity, 0–1. */
  cycle: number
}

const WEEKEND_EFFECT: Record<Dimension, number> = {
  energy: 0.03,
  feeling: 0.05,
  motivation: 0.02,
  sleep: 0.05,
  stress: -0.1,
  free_time: 0.12,
  focus: -0.05,
  body: 0.02,
  workload: -0.15,
}

const SEASON_EFFECT: Record<Dimension, number> = {
  energy: 0.08,
  feeling: 0.1,
  motivation: 0.06,
  sleep: 0.02,
  stress: -0.08,
  free_time: 0.05,
  focus: 0.04,
  body: 0.08,
  workload: -0.02,
}

const DEADLINE_CYCLE_DAYS = 30

function episodeAt(person: Person, index: number): EpisodeKind | 'none' {
  let found: EpisodeKind | 'none' = 'none'
  for (const episode of person.episodes) {
    if (index < episode.startDay || index > episode.endDay) continue
    found = episode.kind
  }
  return found
}

function offDayAt(person: Person, index: number): boolean {
  return person.offDays.some((day) => index >= day.startDay && index <= day.endDay)
}

/** Burnout intensity: rises through the window, then recovers over two weeks. */
function burnoutIntensity(person: Person, index: number): number {
  const window = person.episodes.find((episode) => episode.kind === 'burnout')
  if (!window) return 0
  if (index >= window.startDay && index <= window.endDay) {
    const span = Math.max(1, window.endDay - window.startDay)
    return clamp01((index - window.startDay) / span)
  }
  if (index > window.endDay && index <= window.endDay + 14) {
    return clamp01(1 - (index - window.endDay) / 14)
  }
  return 0
}

export function simulateHiddenState(person: Person): HiddenState[] {
  const rng = makeRng(person.seed).fork('hidden-state')
  const state = {} as Record<Dimension, number>
  for (const dim of DIMENSIONS) state[dim] = clamp01(person.baseline[dim])

  const out: HiddenState[] = []
  for (let index = 0; index < person.dates.length; index += 1) {
    const date = person.dates[index]
    const weekend = [0, 6].includes(weekdayOf(date))
    const season = seasonPhase(date) * person.seasonality
    const episode = episodeAt(person, index)
    const offDay = offDayAt(person, index)
    const regime = person.regimeChange !== null && index >= person.regimeChange.atDay
    const burnout = burnoutIntensity(person, index)

    const phase = index % DEADLINE_CYCLE_DAYS
    const cycle = phase >= DEADLINE_CYCLE_DAYS - 7 ? (phase - (DEADLINE_CYCLE_DAYS - 7)) / 7 : 0

    for (const dim of DIMENSIONS) {
      const base = person.baseline[dim]
      let target = base
      if (weekend) target += WEEKEND_EFFECT[dim] + (dim === 'free_time' ? person.weekendBoost * 0.1 : 0)
      target += SEASON_EFFECT[dim] * season

      if (episode === 'bad') {
        if (dim === 'feeling') target -= 0.18
        if (dim === 'motivation') target -= 0.2
        if (dim === 'stress') target += 0.12
      } else if (episode === 'sick') {
        if (dim === 'energy') target -= 0.3
        if (dim === 'body') target -= 0.35
        if (dim === 'feeling') target -= 0.15
        if (dim === 'stress') target += 0.15
        if (dim === 'free_time') target += 0.1
      } else if (episode === 'busy') {
        if (dim === 'free_time') target -= 0.3
        if (dim === 'workload') target += 0.3
        if (dim === 'stress') target += 0.2
        if (dim === 'focus') target -= 0.08
      } else if (episode === 'travel') {
        if (dim === 'free_time') target += 0.2
        if (dim === 'workload') target -= 0.15
      } else if (episode === 'schedule') {
        if (dim === 'stress') target += 0.08
      }

      if (burnout > 0) {
        if (dim === 'energy') target -= 0.22 * burnout
        if (dim === 'motivation') target -= 0.28 * burnout
        if (dim === 'feeling') target -= 0.2 * burnout
      }

      if (cycle > 0) {
        if (dim === 'stress') target += 0.22 * cycle
        if (dim === 'workload') target += 0.2 * cycle
        if (dim === 'free_time') target -= 0.15 * cycle
      }

      if (regime && person.regimeChange) {
        if (dim === 'free_time') target += person.regimeChange.freeTimeShift
        if (dim === 'energy') target += person.regimeChange.energyShift
      }

      if (offDay) {
        if (dim === 'free_time') target += 0.2
        if (dim === 'workload') target -= 0.15
      }

      const noise = rng.gaussian(0, person.volatility)
      state[dim] = clamp01(person.carry * state[dim] + (1 - person.carry) * target + noise)
    }

    out.push({ date, index, dims: { ...state }, offDay, episode, regime, cycle })
  }

  return out
}

export { DEADLINE_CYCLE_DAYS }
