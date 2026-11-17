import type { CoverageTracker } from './coverage'
import type { HiddenState } from './hidden-state'
import type { TaskOutcome } from './outcomes'
import type { Person } from './person'

/**
 * The in-memory shape of one generated dataset.
 *
 * The generator builds every row here first (fast, no I/O), validates it, then
 * `writer.ts` inserts it all inside a single transaction. Ids and timestamps are
 * assigned by the generator itself — never by SQLite's autoincrement and never
 * by `Date.now()` — so the same seed produces byte-identical exports.
 */

export interface TaskRecord {
  id: string
  user_id: number
  text: string
  done: number
  created_at: number
  due: number | null
  position: number
  progress: number
  priority: string
  tags: string
  recurrence: string
  duration: number | null
  recurrence_config: string | null
  preferred_time: string | null
}

export interface TagRecord {
  id: number
  user_id: number
  name: string
  normalized: string
  merged_into_id: number | null
  created_at: number
}

export interface TagHistoryRecord {
  id: number
  tag_id: number
  user_id: number
  name: string
  normalized: string
  action: 'create' | 'rename' | 'merge'
  merged_into_id: number | null
  recorded_at: number
}

export interface TaskTagRecord {
  task_id: string
  tag_id: number
  user_id: number
  created_at: number
}

export interface TaskConfigRecord {
  id: number
  task_id: string
  user_id: number
  version: number
  effective_from: number
  name: string
  category: string | null
  priority: string | null
  frequency: string | null
  frequency_config: string | null
  target_duration: number | null
  preferred_time: string | null
  active: number
  created_at: number
  tag_ids: number[]
}

export interface SessionRecord {
  id: string
  user_id: number
  task_id: string
  local_date: string
  started_at: number
  ended_at: number | null
  duration_minutes: number
  note: string | null
  source: string
  created_at: number
  updated_at: number
}

export interface DailyStatusRecord {
  id: number
  user_id: number
  task_id: string
  local_date: string
  status: 'completed' | 'partial' | 'skipped' | 'postponed'
  reason: string | null
  source: string
  created_at: number
  updated_at: number
}

export interface CheckinRecord {
  id: number
  user_id: number
  date: string
  feeling: number | null
  energy: number | null
  motivation: number | null
  sleep: number | null
  stress: number | null
  free_time: number | null
  focus: number | null
  body: number | null
  workload: number | null
  skipped: number
  context: string | null
  source: string
  created_at: number
  updated_at: number
}

export interface CheckinHistoryRecord {
  id: number
  checkin_id: number
  user_id: number
  date: string
  feeling: number | null
  energy: number | null
  motivation: number | null
  sleep: number | null
  stress: number | null
  free_time: number | null
  focus: number | null
  body: number | null
  workload: number | null
  skipped: number
  context: string | null
  source: string
  recorded_at: number
}

export interface ReviewRecord {
  id: number
  user_id: number
  local_date: string
  answer: string
  created_at: number
  updated_at: number
}

export interface ContextQuestionRecord {
  id: string
  user_id: number
  task_id: string | null
  tag_id: number | null
  key: string
  prompt: string
  kind: 'text' | 'number' | 'scale' | 'boolean'
  options_json: string | null
  position: number
  active: number
  created_at: number
}

export interface SessionContextRecord {
  id: number
  session_id: string
  question_id: string
  value: string
  created_at: number
}

export interface SuggestionChoiceRecord {
  id: number
  user_id: number
  local_date: string
  suggestion_key: string
  choice: 'accepted' | 'dismissed'
  created_at: number
}

// ---------------------------------------------------------------------------
// Layer records (each flagged synthetic and switchable)
// ---------------------------------------------------------------------------

export interface OffDayRecord {
  person_id: string
  kind: 'sick' | 'travel' | 'holiday' | 'personal'
  start_date: string
  end_date: string
  reason: string | null
  added_later: number
  synthetic: number
}

export interface RecommendationRecord {
  id: number
  person_id: string
  local_date: string
  task_id: string
  kind: 'plan' | 'reschedule' | 'drop'
  exploratory: number
  response: 'followed' | 'ignored' | 'nudged' | 'accepted' | 'dismissed' | 'shown'
  synthetic: number
  created_at: number
}

export interface RegimeChangeRecord {
  person_id: string
  at_date: string
  label: string
  completion_shift: number
  free_time_shift: number
  energy_shift: number
  calm_stretch_days: number
  synthetic: number
}

export interface LiveReplayRecord {
  person_id: string
  step: number
  local_date: string
  /** The prediction is produced by the system, never the generator; empty now. */
  prediction: string | null
  prediction_source: string
  outcome: string | null
  synthetic: number
}

// ---------------------------------------------------------------------------
// Ground truth (separate folder; read only by the harness)
// ---------------------------------------------------------------------------

export interface GtParamRecord {
  person_id: string
  seed: number
  key: string
  value: string
}

export interface GtDailyRecord {
  person_id: string
  date: string
  task_id: string
  true_probability: number
  true_performed: number
  off_day: number
  episode: string
  regime: number
}

export interface GtHiddenStateRecord {
  person_id: string
  date: string
  feeling: number
  energy: number
  motivation: number
  sleep: number
  stress: number
  free_time: number
  focus: number
  body: number
  workload: number
  off_day: number
  episode: string
  regime: number
  cycle: number
}

export interface GtOffDayRecord {
  person_id: string
  kind: string
  start_date: string
  end_date: string
  reason: string | null
  added_later: number
}

export interface GtRecommendationRecord {
  person_id: string
  local_date: string
  task_id: string
  kind: string
  exploratory: number
  response: string
  /** The true effect the recommendation had on completion, in probability points. */
  true_effect: number
}

export interface SyntheticModel {
  person: Person
  userId: number
  states: HiddenState[]
  outcomes: TaskOutcome[]
  tasks: TaskRecord[]
  tags: TagRecord[]
  tagHistory: TagHistoryRecord[]
  taskTags: TaskTagRecord[]
  taskConfigs: TaskConfigRecord[]
  sessions: SessionRecord[]
  dailyStatus: DailyStatusRecord[]
  checkins: CheckinRecord[]
  checkinHistory: CheckinHistoryRecord[]
  reviews: ReviewRecord[]
  contextQuestions: ContextQuestionRecord[]
  sessionContext: SessionContextRecord[]
  suggestionChoices: SuggestionChoiceRecord[]
  offDays: OffDayRecord[]
  recommendations: RecommendationRecord[]
  regimeChanges: RegimeChangeRecord[]
  liveReplay: LiveReplayRecord[]
  gtParams: GtParamRecord[]
  gtDaily: GtDailyRecord[]
  gtHidden: GtHiddenStateRecord[]
  gtOffDays: GtOffDayRecord[]
  gtRecommendations: GtRecommendationRecord[]
  coverage: CoverageTracker
}

export function emptyModel(person: Person, userId: number, coverage: CoverageTracker): SyntheticModel {
  return {
    person,
    userId,
    states: [],
    outcomes: [],
    tasks: [],
    tags: [],
    tagHistory: [],
    taskTags: [],
    taskConfigs: [],
    sessions: [],
    dailyStatus: [],
    checkins: [],
    checkinHistory: [],
    reviews: [],
    contextQuestions: [],
    sessionContext: [],
    suggestionChoices: [],
    offDays: [],
    recommendations: [],
    regimeChanges: [],
    liveReplay: [],
    gtParams: [],
    gtDaily: [],
    gtHidden: [],
    gtOffDays: [],
    gtRecommendations: [],
    coverage,
  }
}

/** Total rows the model will write, used for the pre-run estimate and the cap. */
export function countRows(model: SyntheticModel): number {
  return (
    model.tasks.length +
    model.tags.length +
    model.tagHistory.length +
    model.taskTags.length +
    model.taskConfigs.length +
    model.sessions.length +
    model.dailyStatus.length +
    model.checkins.length +
    model.checkinHistory.length +
    model.reviews.length +
    model.contextQuestions.length +
    model.sessionContext.length +
    model.suggestionChoices.length +
    model.offDays.length +
    model.recommendations.length +
    model.regimeChanges.length +
    model.liveReplay.length +
    // Ground truth is generated too and counts towards the cap, even though it
    // is written to a separate folder that only the harness reads.
    model.gtParams.length +
    model.gtDaily.length +
    model.gtHidden.length +
    model.gtOffDays.length +
    model.gtRecommendations.length
  )
}
