import { blendedTagProfile, type Dimension, type Person, type Priority, type TaskSpec } from './person'
import type { HiddenState } from './hidden-state'
import { clamp01, makeRng, sigmoid, type RngTools } from './rng'
import { isWeekend } from './calendar'

/**
 * Hidden outcomes (ground truth).
 *
 * For every task-day the person *could* have done, this computes the true
 * probability of completion from the hidden state and the task's behaviour, then
 * draws whether it actually happened. The probability is written to the separate
 * ground-truth folder and read only by the evaluation harness — it is the oracle
 * a calibrated model should match (Brier score, reliability curves).
 *
 * The observed data is produced from `performed` afterwards, with separate
 * logging noise, so "did it happen" and "did they log it" stay distinct.
 */

export interface TaskOutcome {
  taskKey: string
  date: string
  index: number
  /** True probability of completion, from the hidden rules. */
  probability: number
  /** Whether it actually happened (the latent draw). */
  performed: boolean
  dims: Record<Dimension, number>
  offDay: boolean
  episode: HiddenState['episode']
  regime: boolean
}

const PRIORITY_VALUE: Record<Priority, number> = { none: 0, low: 0.3, medium: 0.62, high: 1 }

const BASE_LOGIT = 0.5

function tagContribution(spec: TaskSpec, dims: Record<Dimension, number>): number {
  const profile = blendedTagProfile(spec.tags)
  let sum = 0
  for (const key of Object.keys(profile) as Dimension[]) {
    sum += (profile[key] ?? 0) * (dims[key] - 0.5)
  }
  return sum
}

function isScheduled(spec: TaskSpec, date: string, index: number): boolean {
  if (index < spec.createdDayOffset) return false
  if (spec.retiredDayOffset !== null && index >= spec.retiredDayOffset) return false
  if (spec.recurrence === 'daily') return true
  const dow = new Date(`${date}T00:00:00`).getDay()
  if (spec.recurrence === 'weekly') return dow === (spec.weeklyDow ?? 0)
  return (spec.weekdays ?? []).includes(dow)
}

export interface OutcomeResult {
  outcomes: TaskOutcome[]
  byTask: Map<string, TaskOutcome[]>
}

export function simulateOutcomes(person: Person, states: HiddenState[]): OutcomeResult {
  const rng = makeRng(person.seed).fork('outcomes')
  const outcomes: TaskOutcome[] = []
  const byTask = new Map<string, TaskOutcome[]>()

  for (const spec of person.tasks) {
    const list: TaskOutcome[] = []
    let streak = 0
    for (let index = 0; index < states.length; index += 1) {
      const state = states[index]
      if (!isScheduled(spec, state.date, index)) continue
      const behaviour = spec.behaviour

      let logit = BASE_LOGIT
      if (!behaviour.nearRandom) {
        logit += 2 * behaviour.moodSensitivity * tagContribution(spec, state.dims)
        logit += behaviour.prioritySensitivity * PRIORITY_VALUE[spec.priority]
        logit += behaviour.streakEffect * Math.min(streak, 5) * 0.15
        if (isWeekend(state.date)) logit += behaviour.weekendBoost
        if (behaviour.trend === 'rise') logit += 1.3 * (index / Math.max(1, person.historyDays - 1))
        if (behaviour.trend === 'fall') logit -= 1.3 * (index / Math.max(1, person.historyDays - 1))
        if (state.regime && person.regimeChange) logit += person.regimeChange.completionShift * 2
        if (state.offDay) logit -= 1.4
      }
      logit += rng.gaussian(0, behaviour.noise)

      const probability = clamp01(sigmoid(logit))
      const performed = rng.bool(probability)
      streak = performed ? streak + 1 : 0

      const outcome: TaskOutcome = {
        taskKey: spec.key,
        date: state.date,
        index,
        probability,
        performed,
        dims: state.dims,
        offDay: state.offDay,
        episode: state.episode,
        regime: state.regime,
      }
      outcomes.push(outcome)
      list.push(outcome)
    }
    byTask.set(spec.key, list)
  }

  return { outcomes, byTask }
}

/** The answer scale the check-in uses: 1 is best, 5 is worst. */
export function dimToAnswer(dim: number): number {
  return Math.min(5, Math.max(1, 5 - Math.round(dim * 4)))
}

/** Reporting noise helper, shared with the check-in generator. */
export function jitterAnswer(rng: RngTools, value: number, sd: number): number {
  return Math.min(5, Math.max(1, Math.round(value + rng.gaussian(0, sd))))
}
