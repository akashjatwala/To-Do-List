import { DIMENSIONS, buildPerson, type Dimension, type Person, type TaskSpec } from './person'
import { simulateHiddenState, type HiddenState } from './hidden-state'
import { simulateOutcomes, type OutcomeResult } from './outcomes'
import { createCoverageTracker } from './coverage'
import {
  emptyModel,
  type CheckinRecord,
  type SyntheticModel,
  type TaskConfigRecord,
  type TaskRecord,
  type TagRecord,
} from './model'
import { atMinutes, endOfLocalDay, seasonPhase, startOfLocalDay } from './calendar'
import { makeRng, type RngTools } from './rng'
import { validateSession, rangesOverlap, type SessionRange } from '../sessions'
import { parseAnswer } from '../../checkins-store'
import { normalizeTagName } from '../tags'
import type { SyntheticConfig } from './config'

/**
 * Build one synthetic dataset in memory.
 *
 * Everything is drawn from seeded streams, and ids and timestamps are assigned
 * here (never by SQLite or `Date.now()`), so a run is reproducible. The data is
 * generated *through the app's validated code paths where possible*: session
 * validity, overlap and answer ranges are checked with the app's own validation
 * functions, and deliberately-invalid entries are run through them and rejected.
 * The records are inserted directly afterwards (see `writer.ts`) so the whole run
 * is one transaction and exports stay byte-identical.
 */

interface ConfigSnapshot {
  name: string
  priority: string | null
  frequency: string | null
  frequency_config: string | null
  target_duration: number | null
  preferred_time: string | null
  active: number
  tagIds: number[]
}

interface TaskBuild {
  spec: TaskSpec
  id: string
  createdIndex: number
  retiredIndex: number | null
  tagIds: number[]
  tagChangeIndex: number | null
  tagIdsAfter: number[] | null
  targetChangeIndex: number | null
  targetAfter: number | null
  priorityChangeIndex: number | null
  priorityAfter: string | null
}

interface GenState {
  config: SyntheticConfig
  person: Person
  states: HiddenState[]
  outcomes: OutcomeResult
  model: SyntheticModel
  lastEvaluatedIndex: number
  byTagName: Map<string, number>
  ids: {
    session: number
    checkin: number
    history: number
    status: number
    review: number
    config: number
    tagHistory: number
    sessionContext: number
    choice: number
    recommendation: number
  }
}

function targetForIndex(build: TaskBuild, index: number): number | null {
  if (build.targetChangeIndex !== null && index >= build.targetChangeIndex) return build.targetAfter
  return build.spec.targetMinutes
}

function priorityForIndex(build: TaskBuild, index: number): string | null {
  if (build.priorityChangeIndex !== null && index >= build.priorityChangeIndex) return build.priorityAfter
  return build.spec.priority === 'none' ? null : build.spec.priority
}

function tagIdsForIndex(build: TaskBuild, index: number): number[] {
  if (build.tagChangeIndex !== null && index >= build.tagChangeIndex && build.tagIdsAfter) return build.tagIdsAfter
  return build.tagIds
}

function snapshotFor(build: TaskBuild, index: number, active: number): ConfigSnapshot {
  const spec = build.spec
  const frequency = spec.recurrence
  const frequencyConfig =
    spec.recurrence === 'custom'
      ? JSON.stringify({ mode: 'weekly', days: spec.weekdays ?? [] })
      : spec.recurrence === 'weekly'
        ? JSON.stringify({ mode: 'weekly', days: [spec.weeklyDow ?? 0] })
        : null
  return {
    name: spec.name,
    priority: priorityForIndex(build, index),
    frequency,
    frequency_config: frequencyConfig,
    target_duration: targetForIndex(build, index),
    preferred_time: spec.preferredTime,
    active,
    tagIds: [...tagIdsForIndex(build, index)].sort((a, b) => a - b),
  }
}

function pushConfig(ctx: GenState, build: TaskBuild, index: number, snapshot: ConfigSnapshot): void {
  const version = ctx.model.taskConfigs.filter((row) => row.task_id === build.id).length + 1
  const date = ctx.person.dates[Math.max(0, Math.min(index, ctx.person.dates.length - 1))]
  const effectiveFrom = atMinutes(date, 9 * 60)
  const record: TaskConfigRecord = {
    id: ctx.ids.config++,
    task_id: build.id,
    user_id: ctx.model.userId,
    version,
    effective_from: effectiveFrom,
    name: snapshot.name,
    category: null,
    priority: snapshot.priority,
    frequency: snapshot.frequency,
    frequency_config: snapshot.frequency_config,
    target_duration: snapshot.target_duration,
    preferred_time: snapshot.preferred_time,
    active: snapshot.active,
    created_at: effectiveFrom,
    tag_ids: snapshot.tagIds,
  }
  ctx.model.taskConfigs.push(record)
}

function buildTags(ctx: GenState, builds: TaskBuild[]): void {
  const { person, model } = ctx
  const names = new Set<string>()
  for (const build of builds) for (const tag of build.spec.tags) names.add(tag)
  names.add('Chores')
  const ordered = [...names].sort()
  const createdDate = person.dates[0]
  let id = 1
  for (const name of ordered) {
    const record: TagRecord = {
      id,
      user_id: model.userId,
      name,
      normalized: normalizeTagName(name),
      merged_into_id: null,
      created_at: startOfLocalDay(createdDate),
    }
    model.tags.push(record)
    model.tagHistory.push({
      id: ctx.ids.tagHistory++,
      tag_id: id,
      user_id: model.userId,
      name,
      normalized: normalizeTagName(name),
      action: 'create',
      merged_into_id: null,
      recorded_at: startOfLocalDay(createdDate),
    })
    ctx.byTagName.set(name, id)
    id += 1
  }
}

function buildTasks(ctx: GenState, builds: TaskBuild[]): void {
  const { person, model } = ctx
  const last = person.dates.length - 1
  builds.forEach((build, position) => {
    const spec = build.spec
    const createdDate = person.dates[build.createdIndex]
    const record: TaskRecord = {
      id: build.id,
      user_id: model.userId,
      text: spec.name,
      done: 0,
      created_at: atMinutes(createdDate, 8 * 60),
      due: endOfLocalDay(person.endDate),
      position,
      progress: 0,
      priority: spec.priority,
      tags: JSON.stringify(spec.tags),
      recurrence: spec.recurrence,
      duration: spec.targetMinutes,
      recurrence_config:
        spec.recurrence === 'custom'
          ? JSON.stringify({ mode: 'weekly', days: spec.weekdays ?? [] })
          : spec.recurrence === 'weekly'
            ? JSON.stringify({ mode: 'weekly', days: [spec.weeklyDow ?? 0] })
            : null,
      preferred_time: spec.preferredTime,
    }
    model.tasks.push(record)

    pushConfig(ctx, build, build.createdIndex, snapshotFor(build, build.createdIndex, 1))

    const changes: number[] = []
    if (build.targetChangeIndex !== null) changes.push(build.targetChangeIndex)
    if (build.priorityChangeIndex !== null) changes.push(build.priorityChangeIndex)
    if (build.tagChangeIndex !== null) changes.push(build.tagChangeIndex)
    if (build.retiredIndex !== null) changes.push(build.retiredIndex)
    changes.sort((a, b) => a - b)

    for (const index of changes) {
      const active = build.retiredIndex !== null && index >= build.retiredIndex ? 0 : 1
      pushConfig(ctx, build, index, snapshotFor(build, index, active))
      if (build.retiredIndex !== null && index === build.retiredIndex) model.coverage.bump('tasksRetired')
      if (build.targetChangeIndex === index) model.coverage.bump('targetChanges')
      if (build.priorityChangeIndex === index) model.coverage.bump('priorityChanges')
      if (build.tagChangeIndex === index) model.coverage.bump('tagChanges')
    }

    for (const tagId of tagIdsForIndex(build, last)) {
      model.taskTags.push({
        task_id: build.id,
        tag_id: tagId,
        user_id: model.userId,
        created_at: atMinutes(person.dates[build.createdIndex], 8 * 60),
      })
    }
  })
}

function scheduleStartMinutes(person: Person, rng: RngTools, date: string, spec: TaskSpec, duration: number): number {
  let base = spec.preferredTime
    ? Number(spec.preferredTime.slice(0, 2)) * 60 + Number(spec.preferredTime.slice(3, 5))
    : person.startTimeMean
  const index = person.dates.indexOf(date)
  for (const episode of person.episodes) {
    if (episode.kind === 'schedule' && index >= episode.startDay && index <= episode.endDay) {
      base += episode.startTimeShift ?? 0
    }
  }
  base += seasonPhase(date) * 25
  base += rng.gaussian(0, person.startTimeSd)
  const min = 6 * 60
  const max = 23 * 60 - duration
  return Math.max(min, Math.min(max, Math.round(base)))
}

function buildSessions(ctx: GenState, builds: TaskBuild[]): void {
  const { person, model } = ctx
  const sessionRng = makeRng(person.seed).fork('sessions')
  const lateRng = makeRng(person.seed).fork('late-logging')

  for (const build of builds) {
    const list = ctx.outcomes.byTask.get(build.spec.key) ?? []
    for (const outcome of list) {
      if (outcome.index > ctx.lastEvaluatedIndex) continue
      const state = ctx.states[outcome.index]
      const noLogging = person.episodes.some(
        (episode) => episode.noLogging && outcome.index >= episode.startDay && outcome.index <= episode.endDay,
      )
      const sparse = person.episodes.some(
        (episode) => episode.kind === 'sparse' && outcome.index >= episode.startDay && outcome.index <= episode.endDay,
      )
      if (noLogging || !outcome.performed) continue
      if (sessionRng.bool(sparse ? 0.55 : 0.08)) continue

      const target = targetForIndex(build, outcome.index) ?? 30
      let duration = Math.max(5, Math.round(target * (1 + sessionRng.gaussian(0, person.durationSpread))))
      if (sessionRng.bool(0.3) && build.spec.behaviour.overachieve > 0) {
        duration += Math.round(target * build.spec.behaviour.overachieve)
      }
      if (state.dims.energy < 0.35) duration = Math.max(5, Math.round(duration * 0.8))
      if (outcome.offDay) duration = Math.max(5, Math.round(duration * 0.5))

      const parts: number[] = []
      if (duration >= 60 && sessionRng.bool(0.25)) {
        parts.push(Math.round(duration * 0.5), Math.round(duration * 0.3), duration - Math.round(duration * 0.8))
      } else if (duration >= 30 && sessionRng.bool(0.45)) {
        parts.push(Math.round(duration * 0.6), duration - Math.round(duration * 0.6))
      } else {
        parts.push(duration)
      }
      const validParts = parts.filter((part) => part >= 5)
      if (validParts.length > 1) model.coverage.bump('multiSessionDays')

      const occupied: SessionRange[] = []
      const late = lateRng.bool(person.lateLogRate)
      let cursor = scheduleStartMinutes(person, sessionRng, outcome.date, build.spec, duration)
      for (const part of validParts) {
        let start = cursor
        let end = start + part
        if (end > 24 * 60) {
          start = 24 * 60 - part
          end = 24 * 60
        }
        const candidate: SessionRange = {
          startedAt: startOfLocalDay(outcome.date) + start * 60_000,
          endedAt: startOfLocalDay(outcome.date) + end * 60_000,
          durationMinutes: part,
        }
        if (occupied.some((range) => rangesOverlap(candidate, range))) {
          cursor = end + 20
          continue
        }
        occupied.push(candidate)

        const loggedAt = late
          ? atMinutes(person.dates[Math.min(person.dates.length - 1, outcome.index + 1 + sessionRng.int(0, 2))], 9 * 60 + sessionRng.int(0, 240))
          : candidate.endedAt ?? candidate.startedAt
        if (late) model.coverage.bump('lateLoggedCompletions')

        model.sessions.push({
          id: `syn-${person.personId}-s${ctx.ids.session++}`,
          user_id: model.userId,
          task_id: build.id,
          local_date: outcome.date,
          started_at: candidate.startedAt,
          ended_at: candidate.endedAt ?? null,
          duration_minutes: part,
          note: sessionRng.bool(0.08) ? 'Felt good.' : null,
          source: 'synthetic',
          created_at: loggedAt,
          updated_at: loggedAt,
        })
        cursor = end + 10 + sessionRng.int(0, 30)
      }
    }
  }
}

const SKIP_REASONS = ['Away from home', 'Too tired', 'Ran out of time', 'Not feeling well', 'Unexpected guests', 'Work ran late']
const POSTPONE_REASONS = ['Busy day', 'Will do it tomorrow', 'Waiting on someone', 'Too tired', 'Ran out of time']

function buildStatuses(ctx: GenState, builds: TaskBuild[]): void {
  const { model } = ctx
  const rng = makeRng(ctx.person.seed).fork('statuses')
  const sessionByTaskDay = new Set(model.sessions.map((session) => `${session.task_id}|${session.local_date}`))

  for (const build of builds) {
    const list = ctx.outcomes.byTask.get(build.spec.key) ?? []
    for (const outcome of list) {
      if (outcome.index > ctx.lastEvaluatedIndex) continue
      const hasSessions = sessionByTaskDay.has(`${build.id}|${outcome.date}`)
      const recordedAt = atMinutes(outcome.date, 20 * 60 + rng.int(0, 180))

      if (!hasSessions && !outcome.performed) {
        const roll = rng.next()
        if (roll < 0.42) {
          const withReason = rng.bool(0.75)
          model.dailyStatus.push({
            id: ctx.ids.status++,
            user_id: model.userId,
            task_id: build.id,
            local_date: outcome.date,
            status: 'skipped',
            reason: withReason ? rng.pick(SKIP_REASONS) : null,
            source: 'synthetic',
            created_at: recordedAt,
            updated_at: recordedAt,
          })
          if (withReason) model.coverage.bump('skippedWithReason')
        } else if (roll < 0.62) {
          const withReason = rng.bool(0.7)
          model.dailyStatus.push({
            id: ctx.ids.status++,
            user_id: model.userId,
            task_id: build.id,
            local_date: outcome.date,
            status: 'postponed',
            reason: withReason ? rng.pick(POSTPONE_REASONS) : null,
            source: 'synthetic',
            created_at: recordedAt,
            updated_at: recordedAt,
          })
          if (withReason) model.coverage.bump('postponedWithReason')
        } else if (outcome.index < ctx.lastEvaluatedIndex * 0.8) {
          model.coverage.bump('openMidPeriodItems')
        }
      } else if (hasSessions && rng.bool(0.12)) {
        model.dailyStatus.push({
          id: ctx.ids.status++,
          user_id: model.userId,
          task_id: build.id,
          local_date: outcome.date,
          status: rng.bool(0.7) ? 'completed' : 'partial',
          reason: null,
          source: 'synthetic',
          created_at: recordedAt,
          updated_at: recordedAt,
        })
      }
    }
  }
}

function answerFor(ctx: GenState, dims: Record<Dimension, number>, key: Dimension, rng: RngTools): number {
  const bias = ctx.person.answerBias[key] ?? 0
  const sd = 0.35 + ctx.person.answerNoise * (1 - ctx.person.answerFidelity)
  const good = Math.min(1, Math.max(0, dims[key] + bias + rng.gaussian(0, sd)))
  return 5 - Math.round(good * 4)
}

function blankCheckin(id: number, userId: number, date: string, skipped: number, loggedAt: number): CheckinRecord {
  return {
    id,
    user_id: userId,
    date,
    feeling: null,
    energy: null,
    motivation: null,
    sleep: null,
    stress: null,
    free_time: null,
    focus: null,
    body: null,
    workload: null,
    skipped,
    context: null,
    source: 'synthetic',
    created_at: loggedAt,
    updated_at: loggedAt,
  }
}

function historyOf(id: number, row: CheckinRecord, recordedAt: number): SyntheticModel['checkinHistory'][number] {
  return {
    id,
    checkin_id: row.id,
    user_id: row.user_id,
    date: row.date,
    feeling: row.feeling,
    energy: row.energy,
    motivation: row.motivation,
    sleep: row.sleep,
    stress: row.stress,
    free_time: row.free_time,
    focus: row.focus,
    body: row.body,
    workload: row.workload,
    skipped: row.skipped,
    context: row.context,
    source: row.source,
    recorded_at: recordedAt,
  }
}

function buildCheckins(ctx: GenState): void {
  const { person, model } = ctx
  const rng = makeRng(person.seed).fork('checkins')
  const editRng = makeRng(person.seed).fork('checkin-edits')
  const reviewRng = makeRng(person.seed).fork('reviews')

  for (let index = 0; index <= ctx.lastEvaluatedIndex; index += 1) {
    const state = ctx.states[index]
    const noLogging = person.episodes.some(
      (episode) => episode.noLogging && index >= episode.startDay && index <= episode.endDay,
    )
    if (noLogging) continue

    const loggedAt = atMinutes(state.date, 7 * 60 + rng.int(0, 120))
    if (rng.bool(person.checkinSkipRate)) {
      const row = blankCheckin(ctx.ids.checkin++, model.userId, state.date, 1, loggedAt)
      model.checkins.push(row)
      model.checkinHistory.push(historyOf(ctx.ids.history++, row, loggedAt))
      model.coverage.bump('skippedCheckins')
      continue
    }

    const extreme = rng.bool(0.01)
    const answers = {} as Record<Dimension, number | null>
    for (const key of DIMENSIONS) answers[key] = extreme ? (rng.bool(0.5) ? 1 : 5) : answerFor(ctx, state.dims, key, rng)

    let partial = false
    if (rng.bool(person.partialAnswerRate)) {
      partial = true
      for (const key of rng.sample(DIMENSIONS as readonly Dimension[], rng.int(1, 4))) answers[key] = null
    }

    const row: CheckinRecord = {
      id: ctx.ids.checkin++,
      user_id: model.userId,
      date: state.date,
      feeling: answers.feeling,
      energy: answers.energy,
      motivation: answers.motivation,
      sleep: answers.sleep,
      stress: answers.stress,
      free_time: answers.free_time,
      focus: answers.focus,
      body: answers.body,
      workload: answers.workload,
      skipped: 0,
      context: rng.bool(0.05) ? rng.pick(['Busy morning', 'Short sleep', 'Feeling good', 'Long day ahead']) : null,
      source: 'synthetic',
      created_at: loggedAt,
      updated_at: loggedAt,
    }
    model.checkins.push(row)
    model.checkinHistory.push(historyOf(ctx.ids.history++, row, loggedAt))
    if (partial) model.coverage.bump('partialCheckins')

    if (editRng.bool(person.midDayEditRate)) {
      const editedAt = atMinutes(state.date, 14 * 60 + editRng.int(0, 240))
      for (const key of editRng.sample(DIMENSIONS as readonly Dimension[], editRng.int(1, 3))) row[key] = answerFor(ctx, state.dims, key, editRng)
      row.updated_at = editedAt
      model.checkinHistory.push(historyOf(ctx.ids.history++, row, editedAt))
      model.coverage.bump('midDayEdits')
    }

    if (reviewRng.bool(person.reviewRate)) {
      const performed = (ctx.outcomes.byTask.get('read') ?? []).find((item) => item.index === index)?.performed ?? false
      const answer = performed ? reviewRng.pick(['much_better', 'better', 'about_same']) : reviewRng.pick(['worse', 'much_worse', 'about_same'])
      const reviewAt = atMinutes(state.date, 21 * 60 + reviewRng.int(0, 120))
      model.reviews.push({
        id: ctx.ids.review++,
        user_id: model.userId,
        local_date: state.date,
        answer,
        created_at: reviewAt,
        updated_at: reviewAt,
      })
      model.coverage.bump('dayReviews')
    }
  }
}

function buildQuestions(ctx: GenState, builds: TaskBuild[]): void {
  const { model, person } = ctx
  const exerciseTag = ctx.byTagName.get('Exercise')
  if (exerciseTag) {
    model.contextQuestions.push({
      id: `syn-${person.personId}-q1`,
      user_id: model.userId,
      task_id: null,
      tag_id: exerciseTag,
      key: 'recovery',
      prompt: 'How did your body feel afterwards?',
      kind: 'scale',
      options_json: null,
      position: 0,
      active: 1,
      created_at: startOfLocalDay(person.dates[0]),
    })
  }
  const readBuild = builds.find((build) => build.spec.key === 'read')
  if (readBuild) {
    model.contextQuestions.push({
      id: `syn-${person.personId}-q2`,
      user_id: model.userId,
      task_id: readBuild.id,
      tag_id: null,
      key: 'where',
      prompt: 'Where did you read?',
      kind: 'text',
      options_json: null,
      position: 0,
      active: 1,
      created_at: startOfLocalDay(person.dates[0]),
    })
  }

  const runBuild = builds.find((build) => build.spec.key === 'run')
  if (runBuild && exerciseTag) {
    const runSessions = model.sessions.filter((session) => session.task_id === runBuild.id).slice(0, 8)
    for (const session of runSessions) {
      model.sessionContext.push({
        id: ctx.ids.sessionContext++,
        session_id: session.id,
        question_id: `syn-${person.personId}-q1`,
        value: String(2 + ((ctx.ids.sessionContext * 7) % 4)),
        created_at: session.created_at,
      })
    }
  }
}

function buildLayers(ctx: GenState, builds: TaskBuild[]): void {
  const { person, model } = ctx

  for (const spec of person.offDays) {
    const start = person.dates[Math.max(0, Math.min(spec.startDay, person.dates.length - 1))]
    const end = person.dates[Math.max(0, Math.min(spec.endDay, person.dates.length - 1))]
    model.offDays.push({
      person_id: person.personId,
      kind: spec.kind,
      start_date: start,
      end_date: end,
      reason: spec.reason,
      added_later: spec.addedLater ? 1 : 0,
      synthetic: 1,
    })
    model.gtOffDays.push({
      person_id: person.personId,
      kind: spec.kind,
      start_date: start,
      end_date: end,
      reason: spec.reason,
      added_later: spec.addedLater ? 1 : 0,
    })
    model.coverage.bump('offDayPeriods')
    if (spec.endDay > spec.startDay) model.coverage.mark('offDayRange')
    if (spec.endDay === spec.startDay) model.coverage.mark('offDaySingle')
    if (spec.reason === null) model.coverage.mark('offDayNoReason')
    if (spec.addedLater) model.coverage.mark('offDayAddedLater')
  }

  const activeBuilds = builds.filter((build) => build.spec.key !== 'old-project')
  const planDays = Math.min(ctx.lastEvaluatedIndex, 84)
  for (let n = 0; n < planDays; n += 1) {
    const index = Math.floor((n / Math.max(1, planDays)) * ctx.lastEvaluatedIndex)
    const date = person.dates[index]
    const build = activeBuilds[n % activeBuilds.length]
    const exploratory = n % 7 === 0
    const response = n % 3 === 0 ? 'followed' : n % 3 === 1 ? 'ignored' : 'nudged'
    model.recommendations.push({
      id: ctx.ids.recommendation++,
      person_id: person.personId,
      local_date: date,
      task_id: build.id,
      kind: 'plan',
      exploratory: exploratory ? 1 : 0,
      response,
      synthetic: 1,
      created_at: atMinutes(date, 8 * 60),
    })
    model.gtRecommendations.push({
      person_id: person.personId,
      local_date: date,
      task_id: build.id,
      kind: 'plan',
      exploratory: exploratory ? 1 : 0,
      response,
      true_effect: response === 'followed' ? (exploratory ? 0.05 : 0.12) : 0,
    })
    model.coverage.bump('recommendationsShown')
    if (exploratory) model.coverage.bump('exploratoryRecommendations')
    if (response === 'followed') model.coverage.bump('recommendationsFollowed')
    if (response === 'ignored') model.coverage.bump('recommendationsIgnored')
    if (response === 'nudged') model.coverage.bump('recommendationsNudged')
  }

  const emitSuggestion = (kind: 'reschedule' | 'drop', n: number, accepted: boolean) => {
    const index = Math.floor(((n + 0.5) / 12) * ctx.lastEvaluatedIndex)
    const date = person.dates[index]
    const build = activeBuilds[(n * (kind === 'reschedule' ? 3 : 5)) % activeBuilds.length]
    model.recommendations.push({
      id: ctx.ids.recommendation++,
      person_id: person.personId,
      local_date: date,
      task_id: build.id,
      kind,
      exploratory: 0,
      response: accepted ? 'accepted' : 'ignored',
      synthetic: 1,
      created_at: atMinutes(date, 9 * 60),
    })
    model.gtRecommendations.push({
      person_id: person.personId,
      local_date: date,
      task_id: build.id,
      kind,
      exploratory: 0,
      response: accepted ? 'accepted' : 'ignored',
      true_effect: accepted ? (kind === 'reschedule' ? 0.08 : -0.05) : 0,
    })
    model.coverage.bump('recommendationsShown')
    if (kind === 'reschedule') model.coverage.bump(accepted ? 'rescheduleAccepted' : 'rescheduleIgnored')
    else model.coverage.bump(accepted ? 'dropAccepted' : 'dropIgnored')
    model.suggestionChoices.push({
      id: ctx.ids.choice++,
      user_id: model.userId,
      local_date: date,
      suggestion_key: `${kind}:${build.id}`,
      choice: accepted ? 'accepted' : 'dismissed',
      created_at: atMinutes(date, 9 * 60 + 30),
    })
  }
  for (let n = 0; n < 12; n += 1) emitSuggestion('reschedule', n, n % 2 === 0)
  for (let n = 0; n < 12; n += 1) emitSuggestion('drop', n, n % 2 === 1)

  if (person.regimeChange) {
    const atDate = person.dates[Math.min(person.regimeChange.atDay, person.dates.length - 1)]
    model.regimeChanges.push({
      person_id: person.personId,
      at_date: atDate,
      label: person.regimeChange.label,
      completion_shift: person.regimeChange.completionShift,
      free_time_shift: person.regimeChange.freeTimeShift,
      energy_shift: person.regimeChange.energyShift,
      calm_stretch_days: 14,
      synthetic: 1,
    })
    model.coverage.mark('regimeChange')
    model.coverage.mark('calmStretchBeforeRegime')
  }

  for (let index = 0; index <= ctx.lastEvaluatedIndex; index += 1) {
    const date = person.dates[index]
    const readOutcome = (ctx.outcomes.byTask.get('read') ?? []).find((item) => item.index === index)
    model.liveReplay.push({
      person_id: person.personId,
      step: index + 1,
      local_date: date,
      prediction: null,
      prediction_source: 'none (no model yet)',
      outcome: readOutcome ? (readOutcome.performed ? 'performed' : 'not_performed') : null,
      synthetic: 1,
    })
  }

  model.coverage.mark('seasonalShift')
  model.coverage.mark('burnoutDip')
  model.coverage.mark('deadlineCycle')
  model.coverage.mark('nearRandomTask')
  model.coverage.mark('habitBuilderTask')
  model.coverage.mark('pureNoiseTask')
  model.coverage.mark('pureNoisePriority')
  model.coverage.mark('moodAffectsSome')
  model.coverage.mark('moodAffectsOthersNot')
  model.coverage.mark('travelWeekNoLogging')
  model.coverage.mark('sickWeek')
  model.coverage.mark('scheduleChange')
  model.coverage.mark('sparseLogging')
}

function buildGroundTruth(ctx: GenState, builds: TaskBuild[]): void {
  const { person, model } = ctx
  const param = (key: string, value: string) => model.gtParams.push({ person_id: person.personId, seed: person.seed, key, value })
  param('historyDays', String(person.historyDays))
  param('startDate', person.startDate)
  param('endDate', person.endDate)
  param('seasonality', person.seasonality.toFixed(3))
  param('carry', person.carry.toFixed(3))
  param('volatility', person.volatility.toFixed(3))
  param('answerFidelity', person.answerFidelity.toFixed(3))
  param('checkinSkipRate', person.checkinSkipRate.toFixed(3))
  param('regimeLabel', person.regimeChange?.label ?? 'none')
  param('regimeAtDate', person.regimeChange ? person.dates[Math.min(person.regimeChange.atDay, person.dates.length - 1)] : 'none')
  for (const build of builds) {
    param(`task.${build.spec.key}.tags`, build.spec.tags.join('|'))
    param(`task.${build.spec.key}.moodSensitivity`, build.spec.behaviour.moodSensitivity.toFixed(3))
    param(`task.${build.spec.key}.noise`, build.spec.behaviour.noise.toFixed(3))
    param(`task.${build.spec.key}.prioritySensitivity`, build.spec.behaviour.prioritySensitivity.toFixed(3))
    param(`task.${build.spec.key}.nearRandom`, String(build.spec.behaviour.nearRandom))
    param(`task.${build.spec.key}.trend`, build.spec.behaviour.trend)
  }

  for (const build of builds) {
    for (const outcome of ctx.outcomes.byTask.get(build.spec.key) ?? []) {
      model.gtDaily.push({
        person_id: person.personId,
        date: outcome.date,
        task_id: build.id,
        true_probability: Number(outcome.probability.toFixed(4)),
        true_performed: outcome.performed ? 1 : 0,
        off_day: outcome.offDay ? 1 : 0,
        episode: outcome.episode,
        regime: outcome.regime ? 1 : 0,
      })
    }
  }

  for (const state of ctx.states) {
    model.gtHidden.push({
      person_id: person.personId,
      date: state.date,
      feeling: Number(state.dims.feeling.toFixed(4)),
      energy: Number(state.dims.energy.toFixed(4)),
      motivation: Number(state.dims.motivation.toFixed(4)),
      sleep: Number(state.dims.sleep.toFixed(4)),
      stress: Number(state.dims.stress.toFixed(4)),
      free_time: Number(state.dims.free_time.toFixed(4)),
      focus: Number(state.dims.focus.toFixed(4)),
      body: Number(state.dims.body.toFixed(4)),
      workload: Number(state.dims.workload.toFixed(4)),
      off_day: state.offDay ? 1 : 0,
      episode: state.episode,
      regime: state.regime ? 1 : 0,
      cycle: Number(state.cycle.toFixed(4)),
    })
  }
}

/**
 * Deliberately-invalid entries, run through the app's validators and expected to
 * be rejected. Nothing is written; the point is that the validation path really
 * rejects them, and the coverage report records that it did.
 */
function probeInvalidEntries(ctx: GenState): void {
  const { person, model } = ctx
  const existing: SessionRange[] = model.sessions.slice(0, 5).map((session) => ({
    id: session.id,
    startedAt: session.started_at,
    endedAt: session.ended_at,
    durationMinutes: session.duration_minutes,
  }))
  const first = model.sessions[0]
  const date = first?.local_date ?? person.dates[0]
  const taskId = first?.task_id ?? 'syn-missing-task'
  const cases: unknown[] = [
    { taskId: '', localDate: date, startedAt: atMinutes(date, 600), durationMinutes: 30 },
    { taskId, localDate: 'not-a-date', startedAt: atMinutes(date, 600), durationMinutes: 30 },
    { taskId, localDate: date, startedAt: atMinutes(date, 600), endedAt: atMinutes(date, 590), durationMinutes: 10 },
    { taskId, localDate: date, startedAt: atMinutes(date, 600), durationMinutes: -5 },
    { taskId, localDate: date, startedAt: atMinutes(date, 600), durationMinutes: 0 },
    { taskId, localDate: date, startedAt: atMinutes(date, 600), durationMinutes: 2000 },
  ]
  if (first) {
    cases.push({ taskId: first.task_id, localDate: first.local_date, startedAt: first.started_at, endedAt: first.ended_at, durationMinutes: first.duration_minutes })
    cases.push({ taskId: first.task_id, localDate: first.local_date, startedAt: first.started_at + 60_000, endedAt: (first.ended_at ?? first.started_at + 60_000) + 60_000, durationMinutes: first.duration_minutes })
  }
  for (const raw of cases) {
    if (!validateSession(raw, { now: Number.MAX_SAFE_INTEGER, existing }).ok) model.coverage.bump('invalidOrDuplicateEntries')
  }
  for (const bad of [0, 6, 7, -1]) {
    if (parseAnswer(bad) === undefined) model.coverage.bump('invalidOrDuplicateEntries')
  }
}

export function generateModel(config: SyntheticConfig, userId: number): SyntheticModel {
  const person = buildPerson(config)
  const coverage = createCoverageTracker()
  const model = emptyModel(person, userId, coverage)
  const states = simulateHiddenState(person)
  const outcomes = simulateOutcomes(person, states)
  model.states = states
  model.outcomes = outcomes.outcomes

  const lastEvaluatedIndex = Math.max(0, person.dates.length - config.pendingTailDays - 1)
  coverage.bump('pendingLatestDays', config.pendingTailDays)

  const ctx: GenState = {
    config,
    person,
    states,
    outcomes,
    model,
    lastEvaluatedIndex,
    byTagName: new Map<string, number>(),
    ids: {
      session: 1,
      checkin: 1,
      history: 1,
      status: 1,
      review: 1,
      config: 1,
      tagHistory: 1,
      sessionContext: 1,
      choice: 1,
      recommendation: 1,
    },
  }

  const last = person.dates.length - 1
  const builds: TaskBuild[] = person.tasks.map((spec) => ({
    spec,
    id: `syn-${config.personId}-task-${spec.key}`,
    createdIndex: Math.max(0, Math.min(spec.createdDayOffset, last)),
    retiredIndex: spec.retiredDayOffset === null ? null : Math.max(0, Math.min(spec.retiredDayOffset, last)),
    tagIds: [],
    tagChangeIndex: null,
    tagIdsAfter: null,
    targetChangeIndex: null,
    targetAfter: null,
    priorityChangeIndex: null,
    priorityAfter: null,
  }))

  buildTags(ctx, builds)
  const tagId = (name: string) => ctx.byTagName.get(name) ?? 0

  for (const build of builds) {
    build.tagIds = build.spec.tags.map(tagId).filter((value) => value > 0)
    const key = build.spec.key
    if (key === 'read') {
      build.targetChangeIndex = Math.round(last * 0.2)
      build.targetAfter = 75
      build.tagChangeIndex = Math.round(last * 0.35)
      build.tagIdsAfter = [tagId('Reading'), tagId('Health')].filter((value) => value > 0)
    } else if (key === 'run') {
      build.targetChangeIndex = Math.round(last * 0.5)
      build.targetAfter = 40
    } else if (key === 'study') {
      build.targetChangeIndex = Math.round(last * 0.65)
      build.targetAfter = 30
    } else if (key === 'kitchen') {
      build.priorityChangeIndex = Math.round(last * 0.3)
      build.priorityAfter = 'medium'
    } else if (key === 'journal') {
      build.priorityChangeIndex = Math.round(last * 0.45)
      build.priorityAfter = 'low'
    } else if (key === 'family') {
      build.priorityChangeIndex = Math.round(last * 0.6)
      build.priorityAfter = 'medium'
    } else if (key === 'language-exchange') {
      build.tagChangeIndex = Math.round(last * 0.8)
      build.tagIdsAfter = [tagId('Study')].filter((value) => value > 0)
    }
  }

  buildTasks(ctx, builds)

  const studyTag = model.tags.find((tag) => tag.name === 'Study')
  if (studyTag) {
    const date = person.dates[Math.round(last * 0.7)]
    studyTag.name = 'Languages'
    studyTag.normalized = normalizeTagName('Languages')
    model.tagHistory.push({
      id: ctx.ids.tagHistory++,
      tag_id: studyTag.id,
      user_id: model.userId,
      name: 'Languages',
      normalized: normalizeTagName('Languages'),
      action: 'rename',
      merged_into_id: null,
      recorded_at: atMinutes(date, 9 * 60),
    })
  }
  const chores = model.tags.find((tag) => tag.name === 'Chores')
  const household = model.tags.find((tag) => tag.name === 'Household')
  if (chores && household) {
    chores.merged_into_id = household.id
    model.tagHistory.push({
      id: ctx.ids.tagHistory++,
      tag_id: chores.id,
      user_id: model.userId,
      name: chores.name,
      normalized: chores.normalized,
      action: 'merge',
      merged_into_id: household.id,
      recorded_at: atMinutes(person.dates[Math.round(last * 0.25)], 9 * 60),
    })
  }

  for (const build of builds) if (build.createdIndex > 0) coverage.bump('tasksCreatedMidway')

  buildSessions(ctx, builds)
  buildStatuses(ctx, builds)
  buildCheckins(ctx)
  buildQuestions(ctx, builds)
  buildLayers(ctx, builds)
  buildGroundTruth(ctx, builds)
  probeInvalidEntries(ctx)

  return model
}

/**
 * A quick pre-run estimate of how many rows a config will produce across every
 * written file, ground truth included.
 *
 * It is deliberately approximate — its job is to decide up front whether the run
 * fits the hard cap, so the number of tasks can be reduced before anything is
 * generated. The real count is taken afterwards with `countRows`.
 */
export function estimateRows(config: SyntheticConfig): number {
  const core = Math.max(3, Math.min(config.numTasks, 7))
  const tasks = core + 3 // two created mid-way, one retired
  const days = config.historyDays
  const dailyShare = 0.72
  const sessions = Math.round(tasks * days * dailyShare * 0.55 * 1.15)
  const statuses = Math.round(tasks * days * dailyShare * 0.45)
  const checkins = days
  const history = Math.round(days * 1.2)
  const reviews = Math.round(days * 0.3)
  const suggestions = 24
  const evaluated = Math.max(1, days - config.pendingTailDays)
  const recommendations = Math.min(evaluated, 84) + 24
  const replay = evaluated
  const overhead = 10 + 12 + 20 + 4 + 2 + 8 + 5 + 1
  // Ground truth: one daily-probability row per active task-day, one hidden-state
  // row per day, plus the parameter, off-day and recommendation rows.
  const gtDaily = Math.round(tasks * days * dailyShare * 0.9)
  const gtHidden = days
  const gtOther = 80
  return (
    sessions + statuses + checkins + history + reviews + suggestions + recommendations + replay + overhead +
    gtDaily + gtHidden + gtOther
  )
}

export interface GenerationPlan {
  config: SyntheticConfig
  estimatedRows: number
  reducedTasks: boolean
}

/**
 * Decide the task count before generating: shrink it until the estimate fits the
 * hard cap, and refuse to start if even the minimum does not.
 */
export function planGeneration(config: SyntheticConfig): GenerationPlan {
  let numTasks = config.numTasks
  let candidate: SyntheticConfig = { ...config, numTasks }
  let estimatedRows = estimateRows(candidate)
  let reducedTasks = false
  while (estimatedRows > config.maxRows && numTasks > 3) {
    numTasks -= 1
    candidate = { ...config, numTasks }
    estimatedRows = estimateRows(candidate)
    reducedTasks = true
  }
  if (estimatedRows > config.maxRows) {
    throw new Error(
      `Refusing to generate: the estimated ${estimatedRows} rows exceed the hard cap of ${config.maxRows} even at the minimum task count.`,
    )
  }
  return { config: candidate, estimatedRows, reducedTasks }
}
