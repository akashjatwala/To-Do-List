import type {
  ActivitySession,
  AppNotification,
  BootstrapData,
  Checkin,
  CheckinAnswers,
  CheckinStatus,
  DailyActivity,
  DailyState,
  DayReview,
  DayReviewAnswer,
  ExplicitDailyStatus,
  OffDay,
  OffDayKind,
  PredictionPlanResponse,
  Priority,
  Recurrence,
  RecurrenceConfig,
  Reminder,
  TaskConfig,
  TaskSkipResult,
  Team,
  User,
  UserTag,
} from './types'

export class ApiError extends Error {
  status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(options.headers ?? {}) },
    ...options,
  })

  let body: unknown = null
  const text = await response.text()
  if (text) {
    try {
      body = JSON.parse(text)
    } catch {
      body = null
    }
  }

  if (!response.ok) {
    const message =
      body && typeof body === 'object' && 'error' in body && typeof body.error === 'string'
        ? body.error
        : `Request failed (${response.status}).`
    throw new ApiError(message, response.status)
  }

  return body as T
}

const post = <T>(path: string, data?: unknown) =>
  request<T>(path, { method: 'POST', body: data === undefined ? undefined : JSON.stringify(data) })

const patch = <T>(path: string, data: unknown) =>
  request<T>(path, { method: 'PATCH', body: JSON.stringify(data) })

const put = <T>(path: string, data: unknown) =>
  request<T>(path, { method: 'PUT', body: JSON.stringify(data) })

const del = <T>(path: string) => request<T>(path, { method: 'DELETE' })

export const api = {
  bootstrap: () => request<BootstrapData>('/api/bootstrap'),
  listNotifications: () => request<{ items: AppNotification[] }>('/api/notifications'),

  signup: (email: string, name: string, password: string, remember: boolean) =>
    post<{ user: User }>('/api/auth/signup', { email, name, password, remember }),
  login: (email: string, password: string, remember: boolean) =>
    post<{ user: User }>('/api/auth/login', { email, password, remember }),
  logout: () => post<{ ok: true }>('/api/auth/logout'),
  reset: (email: string, password: string) =>
    post<{ ok: true }>('/api/auth/reset', { email, password }),
  changePassword: (currentPassword: string, newPassword: string) =>
    post<{ ok: true }>('/api/auth/password', { currentPassword, newPassword }),
  updateName: (name: string) => patch<{ user: User }>('/api/auth/me', { name }),
  signOutOthers: () => post<{ ok: true }>('/api/auth/sessions/others'),
  deleteAccount: (password: string) =>
    request<{ ok: true }>('/api/auth/account', {
      method: 'DELETE',
      body: JSON.stringify({ password }),
    }),

  createTask: (input: {
    text: string
    teamId: string | null
    due: number | null
    priority?: Priority
    tags?: string[]
    recurrence?: Recurrence
    recurrenceConfig?: RecurrenceConfig | null
    duration?: number | null
  }) => post<{ id: string }>('/api/tasks', input),
  updateTask: (
    id: string,
    patchBody: {
      text?: string
      done?: boolean
      /** Dated occurrence being completed, for recurring tasks. */
      completedFor?: string
      due?: number | null
      position?: number
      progress?: number
      priority?: Priority
      tags?: string[]
      recurrence?: Recurrence
      recurrenceConfig?: RecurrenceConfig | null
      duration?: number | null
    },
  ) => patch<{ ok: true; spawnedId: string | null }>(`/api/tasks/${id}`, patchBody),
  deleteTask: (id: string) => del<{ ok: true }>(`/api/tasks/${id}`),
  skipTaskDay: (taskId: string, date: string) =>
    post<{ item: TaskSkipResult }>(`/api/tasks/${encodeURIComponent(taskId)}/skip`, { date }),
  undoTaskSkip: (taskId: string, eventId: number) =>
    post<{ ok: true; item: TaskSkipResult }>(
      `/api/tasks/${encodeURIComponent(taskId)}/undo-skip`,
      { eventId },
    ),
  reorderTasks: (ids: string[]) => post<{ ok: true }>('/api/tasks/reorder', { ids }),
  setTaskAssignees: (id: string, userIds: number[]) =>
    put<{ ok: true }>(`/api/tasks/${id}/assignees`, { userIds }),
  sendReminder: (id: string) => post<Reminder>(`/api/tasks/${id}/remind`),

  addSubtask: (taskId: string, text: string, assigneeId?: number | null) =>
    post<{ id: string }>(`/api/tasks/${taskId}/subtasks`, { text, assigneeId: assigneeId ?? null }),
  updateSubtask: (
    taskId: string,
    subtaskId: string,
    patchBody: { text?: string; done?: boolean; assigneeId?: number | null },
  ) =>
    patch<{ ok: true }>(`/api/tasks/${taskId}/subtasks/${subtaskId}`, patchBody),
  deleteSubtask: (taskId: string, subtaskId: string) =>
    del<{ ok: true }>(`/api/tasks/${taskId}/subtasks/${subtaskId}`),

  addComment: (taskId: string, text: string) =>
    post<{ ok: true }>(`/api/tasks/${taskId}/comments`, { text }),
  deleteComment: (taskId: string, commentId: string) =>
    del<{ ok: true }>(`/api/tasks/${taskId}/comments/${commentId}`),

  createTeam: (name: string) => post<{ team: Team }>('/api/teams', { name }),
  renameTeam: (teamId: string, name: string) =>
    patch<{ ok: true }>(`/api/teams/${teamId}`, { name }),
  transferHost: (teamId: string, memberId: number) =>
    put<{ ok: true }>(`/api/teams/${teamId}/host`, { memberId }),
  deleteTeam: (teamId: string) => del<{ ok: true }>(`/api/teams/${teamId}`),
  leaveTeam: (teamId: string) => del<{ ok: true }>(`/api/teams/${teamId}/leave`),
  removeMember: (teamId: string, memberId: number) =>
    del<{ ok: true }>(`/api/teams/${teamId}/members/${memberId}`),
  invite: (teamId: string, email: string) =>
    post<{ ok: true }>(`/api/teams/${teamId}/invites`, { email }),
  cancelInvite: (teamId: string, email: string) =>
    del<{ ok: true }>(`/api/teams/${teamId}/invites/${encodeURIComponent(email)}`),

  acceptInvite: (teamId: string) => post<{ ok: true }>(`/api/invites/${teamId}/accept`),
  declineInvite: (teamId: string) => del<{ ok: true }>(`/api/invites/${teamId}`),

  getCheckin: (date: string) =>
    request<CheckinStatus>(`/api/checkins?date=${encodeURIComponent(date)}`),
  saveCheckin: (input: {
    date: string
    answers: Partial<CheckinAnswers>
    context: string | null
  }) => put<CheckinStatus>('/api/checkins', input),
  skipCheckin: (date: string) => post<CheckinStatus>('/api/checkins/skip', { date }),
  getCheckinHistory: (limit = 30) =>
    request<{ items: Checkin[] }>(`/api/checkins/history?limit=${limit}`),

  // ---- Activity sessions, daily records, tags and config history ----

  listSessions: (taskId: string, limit = 50, shared = false) =>
    request<{ items: ActivitySession[] }>(
      `/api/activity/sessions?taskId=${encodeURIComponent(taskId)}&limit=${limit}${
        shared ? '&shared=true' : ''
      }`,
    ),
  createSession: (input: {
    taskId: string
    localDate: string
    startedAt: number
    endedAt?: number | null
    durationMinutes?: number
    note?: string | null
  }) => post<{ session: ActivitySession }>('/api/activity/sessions', input),
  deleteSession: (id: string) => del<{ ok: true }>(`/api/activity/sessions/${id}`),

  getDay: (taskId: string, date: string, today: string) =>
    request<{ day: DailyActivity }>(
      `/api/activity/day?taskId=${encodeURIComponent(taskId)}&date=${date}&today=${today}`,
    ),
  getRange: (taskId: string, from: string, to: string, today: string) =>
    request<{ items: DailyActivity[] }>(
      `/api/activity/range?taskId=${encodeURIComponent(taskId)}&from=${from}&to=${to}&today=${today}`,
    ),
  setDayStatus: (input: {
    taskId: string
    date: string
    status: ExplicitDailyStatus
    reason?: string | null
    today: string
  }) => put<{ day: DailyActivity }>('/api/activity/day', input),
  clearDayStatus: (taskId: string, date: string, today: string) =>
    request<{ day: DailyActivity }>(
      `/api/activity/day?taskId=${encodeURIComponent(taskId)}&date=${date}&today=${today}`,
      { method: 'DELETE' },
    ),

  listTaskConfigs: (taskId: string) =>
    request<{ items: TaskConfig[] }>(`/api/task-configs/${encodeURIComponent(taskId)}`),

  listTags: () => request<{ items: UserTag[] }>('/api/tags'),
  createTag: (name: string) => post<{ tag: UserTag }>('/api/tags', { name }),
  renameTag: (id: number, name: string) =>
    patch<{ tag: UserTag }>(`/api/tags/${id}`, { name }),
  deleteTag: (id: number) => del<{ ok: true }>(`/api/tags/${id}`),

  // ---- Daily state summary, estimates and the evening review ----

  getState: (date: string, today: string) =>
    request<DailyState>(`/api/state?date=${encodeURIComponent(date)}&today=${encodeURIComponent(today)}`),
  saveDayReview: (date: string, answer: DayReviewAnswer) =>
    put<DayReview>('/api/state/review', { date, answer }),
  saveSuggestionChoice: (date: string, key: string, choice: 'accepted' | 'dismissed') =>
    put<{ ok: true }>('/api/state/suggestions', { date, key, choice }),

  // ---- Off days and prediction settings ----

  listOffDays: () => request<{ items: OffDay[] }>('/api/off-days'),
  getOffDayDay: (date: string) =>
    request<{
      date: string
      offDay: OffDay | null
      onOffDay: boolean
      daysSinceOff: number | null
      reducedConfidence: boolean
    }>(`/api/off-days/day?date=${encodeURIComponent(date)}`),
  createOffDay: (input: { kind: OffDayKind | null; startDate: string; endDate: string; note?: string | null }) =>
    post<{ offDay: OffDay }>('/api/off-days', input),
  updateOffDay: (
    id: number,
    input: { kind: OffDayKind | null; startDate: string; endDate: string; note?: string | null },
  ) => patch<{ offDay: OffDay }>(`/api/off-days/${id}`, input),
  deleteOffDay: (id: number) => del<{ ok: true }>(`/api/off-days/${id}`),

  // ---- Predictions and feedback ----

  getPlan: (date: string, today: string) =>
    request<PredictionPlanResponse>(
      `/api/predictions/plan?date=${encodeURIComponent(date)}&today=${encodeURIComponent(today)}`,
    ),
  savePredictionFeedback: (input: {
    date: string
    taskId: string
    kind: 'time' | 'plan' | 'reschedule' | 'drop'
    exploratory?: boolean
    shown?: boolean
    followed?: boolean | null
  }) => post<{ ok: true }>('/api/predictions/feedback', input),
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message
  if (error instanceof TypeError) return 'Cannot reach the server. Is it running?'
  if (error instanceof Error) return error.message
  return 'Something went wrong.'
}

export function endOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999).getTime()
}

export function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}
