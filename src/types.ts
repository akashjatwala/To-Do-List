import type { CheckinAnswerKey } from './lib/checkin'

export interface User {
  id: number
  email: string
  name: string
}

export interface Subtask {
  id: string
  text: string
  done: boolean
  position: number
  assignee: TaskAssignee | null
}

export interface Comment {
  id: string
  text: string
  createdAt: number
  userId: number
  email: string
}

export type Priority = 'none' | 'low' | 'medium' | 'high'

export type Recurrence = 'none' | 'daily' | 'weekly' | 'monthly' | 'custom'

export type RecurrenceConfig =
  | { mode: 'weekly'; days: number[] }
  | { mode: 'monthly'; nth: number; weekday: number }

export interface TaskAssignee {
  id: number
  email: string
  name: string
}

export interface Task {
  id: string
  text: string
  done: boolean
  createdAt: number
  due: number | null
  progress: number
  priority: Priority
  tags: string[]
  recurrence: Recurrence
  recurrenceConfig: RecurrenceConfig | null
  duration: number | null
  preferredTime: string | null
  teamId: string | null
  teamName: string | null
  userId: number
  ownerEmail: string
  subtasks: Subtask[]
  comments: Comment[]
  assignees: TaskAssignee[]
}

export interface Member {
  id: number
  email: string
  role: 'host' | 'member'
}

export interface TeamInvite {
  email: string
  createdAt: number
}

export interface Team {
  id: string
  name: string
  createdAt: number
  role: 'host' | 'member'
  members: Member[]
  invites?: TeamInvite[]
}

export interface UserInvite {
  teamId: string
  teamName: string
  invitedByEmail: string
  createdAt: number
}

export interface BootstrapData {
  user: User
  teams: Team[]
  invites: UserInvite[]
  tasks: Task[]
}

export type View =
  | { kind: 'my' }
  | { kind: 'collab'; teamId: string | null }

export type ToastTone = 'success' | 'error' | 'info'

export interface Toast {
  id: number
  message: string
  tone: ToastTone
}

/** `not_asked` means there is no check-in record for that day. */
export type CheckinState = 'not_asked' | 'completed' | 'partial' | 'skipped'

export type CheckinAnswers = Record<CheckinAnswerKey, number | null>

export interface Checkin {
  id: number
  date: string
  answers: CheckinAnswers
  skipped: boolean
  context: string | null
  createdAt: number
  updatedAt: number
}

export interface CheckinStatus {
  date: string
  state: CheckinState
  checkin: Checkin | null
}

// ---- Activity sessions and daily records ----

/** One stretch of real activity for a task. Several per day are normal. */
export interface ActivitySession {
  id: string
  taskId: string
  date: string
  startedAt: number
  endedAt: number | null
  durationMinutes: number
  note: string | null
  source: string
  createdAt: number
  updatedAt: number
  /** Present on shared team listings so teammates can see who logged a stretch. */
  userId?: number | null
  authorEmail?: string
  authorName?: string | null
}

/** A status the user can state for a day. */
export type ExplicitDailyStatus = 'completed' | 'partial' | 'skipped' | 'postponed'

/**
 * The derived record for one task on one local day. `unknown` means nothing was
 * recorded; `pending` means the day is not over yet. Missing is never zero.
 */
export type DailyStatus = ExplicitDailyStatus | 'pending' | 'unknown'

export interface DailyActivity {
  date: string
  targetMinutes: number | null
  totalMinutes: number
  sessionCount: number
  performed: boolean | null
  targetAchieved: boolean | null
  status: DailyStatus
  reason: string | null
  configVersionId: number | null
  checkinId: number | null
  /** The day was marked off. Flagged, never rewritten as a failure. */
  offDay: boolean
  offDayKind: OffDayKind | null
}

/** Why a day was marked off. `null` means "off, no reason given". */
export type OffDayKind = 'sick' | 'travel' | 'holiday' | 'other'

/** One off-day record, possibly spanning several days. */
export interface OffDay {
  id: number
  kind: OffDayKind | null
  startDate: string
  endDate: string
  note: string | null
  createdAt: number
  updatedAt: number
}

/** The user's configurable prediction thresholds. */
export interface PredictionSettings {
  reducedConfidenceDays: number
  explorationShare: number
  stage2MinDays: number
}

export type PredictionConfidence = 'low' | 'medium' | 'high'

/** One activity's prediction for one day. A suggestion, never a decision. */
export interface TaskPrediction {
  taskId: string
  date: string
  source: 'baseline' | 'model'
  modelVersion: string
  stage: 1 | 2
  confidence: PredictionConfidence
  dataSufficiencyDays: number
  completionProbability: number
  targetProbability: number | null
  expectedDuration: number | null
  durationLow: number | null
  durationHigh: number | null
  recommendedStart: number | null
  recommendedEnd: number | null
  exploratory: boolean
  explanation: string
  inputs: Record<string, unknown>
}

export interface PlanEntry {
  taskId: string
  text: string
  priority: string | null
  remainingTargetMinutes: number | null
  doneMinutes: number
  prediction: TaskPrediction
  rankScore: number
}

export interface PlanSuggestion {
  taskId: string
  text: string
  kind: 'reschedule' | 'drop'
  message: string
}

export interface PredictionPlan {
  date: string
  offDay: boolean
  offDayKind: OffDayKind | null
  reducedConfidence: boolean
  checkinState: string
  readiness: { score: number | null; line: string; state: string }
  entries: PlanEntry[]
  suggestions: PlanSuggestion[]
  note: string
}

/** A proposed, non-binding slot in the day. Nothing is written to the task. */
export interface ScheduleSlot {
  taskId: string
  text: string
  start: number
  end: number
  duration: number
  shifted: boolean
}

export interface DaySchedule {
  available: boolean
  reason: string
  capacityMinutes: number | null
  plannedMinutes: number
  slots: ScheduleSlot[]
  unplaced: Array<{ taskId: string; text: string; duration: number }>
  overloaded: boolean
  warning: string | null
}

/** A concrete better day for a task the user just skipped or postponed. */
export interface RescheduleSuggestion {
  taskId: string
  text: string
  skippedDate: string
  skippedKind: 'skipped' | 'postponed'
  suggestedDate: string
  suggestedStart: number | null
  suggestedEnd: number | null
  reason: string
}

export interface RescheduleResult {
  available: boolean
  reason: string
  suggestions: RescheduleSuggestion[]
}

export interface PredictionPlanResponse {
  gate: boolean
  checkinState: string
  offDay: boolean
  plan: PredictionPlan | null
  schedule: DaySchedule
  reschedules: RescheduleResult
  predictions: unknown[]
}

/** One version of a task's configuration; old versions are kept. */
export interface TaskConfig {
  id: number
  taskId: string
  version: number
  effectiveFrom: number
  name: string
  category: string | null
  priority: string | null
  frequency: string | null
  frequencyConfig: string | null
  targetDuration: number | null
  preferredTime: string | null
  active: boolean
  tagIds: number[]
}

export interface TagSummary {
  id: number
  name: string
  taskCount: number
}

// ---- Daily state summary and display-only estimates ----

export type SubScoreName = 'physical' | 'mental' | 'capacity'

export interface SubScore {
  name: SubScoreName
  score: number | null
  answered: number
  total: number
}

export interface ReadinessScore {
  score: number | null
  answered: number
  total: number
  state: 'ready' | 'partial' | 'none'
  phrases: string[]
  line: string
  subScores: SubScore[]
}

export interface BaselineComparison {
  weekdayAverage: number | null
  weekdaySample: number
  delta: number | null
  line: string | null
}

export interface FieldEstimate {
  key: CheckinAnswerKey
  value: number
  range: [number, number]
  basis: string
  sample: number
}

export interface FieldEvaluation {
  key: CheckinAnswerKey
  sample: number
  mae: number | null
  coverage: number | null
  baselines: { sameAsYesterday: number | null; personalAverage: number | null; sameWeekday: number | null }
  beatsBaseline: boolean
}

export interface EstimatesResult {
  available: boolean
  reason: string | null
  estimates: FieldEstimate[]
  evaluation: FieldEvaluation[]
  beatsBaseline: boolean | null
  evaluationNote: string
  shown: boolean
}

export interface SimilarOutcome {
  id: string
  name: string
  performedDays: number
  consideredDays: number
}

export interface SimilarDay {
  date: string
  distance: number
  overlap: number
  score: number
}

export interface SimilarDaysResult {
  available: boolean
  reason: string | null
  dayCount: number
  days: SimilarDay[]
  tasks: SimilarOutcome[]
  tags: SimilarOutcome[]
  line: string | null
}

export interface SubScoreTrend {
  name: SubScoreName
  direction: 'rising' | 'falling' | 'steady'
  recentAverage: number
  previousAverage: number
  delta: number
  line: string | null
}

export interface FieldStreak {
  key: CheckinAnswerKey
  days: number
  direction: 'low' | 'high'
  line: string
}

export interface RecentContextResult {
  available: boolean
  trends: SubScoreTrend[]
  streaks: FieldStreak[]
  lines: string[]
}

export interface AssociationResult {
  correlation: number | null
  sample: number
  useful: boolean
  note: string
}

export type DayReviewAnswer = 'much_better' | 'better' | 'about_same' | 'worse' | 'much_worse'

export interface DayReview {
  date: string
  answer: DayReviewAnswer
  createdAt: number
  updatedAt: number
}

export interface ReviewAlignment {
  sample: number
  correlation: number | null
  changeRate: number | null
  note: string
}

export interface LowCapacitySuggestion {
  key: string
  taskId: string | null
  label: string
}

export interface LowCapacitySuggestions {
  enabled: boolean
  reason: string
  capacityScore: number | null
  suggestions: LowCapacitySuggestion[]
  choices: Array<{ key: string; choice: 'accepted' | 'dismissed' }>
}

export interface LearnedWeights {
  enabled: boolean
  weights: Partial<Record<CheckinAnswerKey, number>>
  reason: string
}

export interface StatePrefs {
  showSummary: boolean
  showEstimates: boolean
}

export interface DailyState {
  date: string
  today: string
  prefs: StatePrefs
  summary: { shown: boolean; readiness: ReadinessScore; baseline: BaselineComparison }
  estimates: EstimatesResult
  similarDays: SimilarDaysResult
  recentContext: RecentContextResult
  association: AssociationResult
  review: { date: string; answer: DayReviewAnswer } | null
  reviewAlignment: ReviewAlignment
  advanced: {
    perTagWeights: LearnedWeights
    smarterEstimates: { enabled: boolean; reason: string }
    lowCapacity: LowCapacitySuggestions
  }
}
