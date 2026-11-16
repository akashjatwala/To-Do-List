import type {
  ActivitySession,
  BootstrapData,
  Checkin,
  CheckinAnswers,
  CheckinStatus,
  DailyActivity,
  DailyState,
  DayReview,
  DayReviewAnswer,
  ExplicitDailyStatus,
  Priority,
  Recurrence,
  RecurrenceConfig,
  StatePrefs,
  TagSummary,
  TaskConfig,
  Team,
  User,
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

  signup: (email: string, password: string, remember: boolean) =>
    post<{ user: User }>('/api/auth/signup', { email, password, remember }),
  login: (email: string, password: string, remember: boolean) =>
    post<{ user: User }>('/api/auth/login', { email, password, remember }),
  logout: () => post<{ ok: true }>('/api/auth/logout'),
  forgot: (email: string) => post<{ ok: true; resetCode?: string }>('/api/auth/forgot', { email }),
  reset: (token: string, password: string) =>
    post<{ ok: true }>('/api/auth/reset', { token, password }),
  changePassword: (currentPassword: string, newPassword: string) =>
    post<{ ok: true }>('/api/auth/password', { currentPassword, newPassword }),
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
    preferredTime?: string | null
  }) => post<{ id: string }>('/api/tasks', input),
  updateTask: (
    id: string,
    patchBody: {
      text?: string
      done?: boolean
      due?: number | null
      position?: number
      progress?: number
      priority?: Priority
      tags?: string[]
      recurrence?: Recurrence
      recurrenceConfig?: RecurrenceConfig | null
      duration?: number | null
      preferredTime?: string | null
    },
  ) => patch<{ ok: true; spawnedId: string | null }>(`/api/tasks/${id}`, patchBody),
  deleteTask: (id: string) => del<{ ok: true }>(`/api/tasks/${id}`),
  reorderTasks: (ids: string[]) => post<{ ok: true }>('/api/tasks/reorder', { ids }),

  addSubtask: (taskId: string, text: string) =>
    post<{ id: string }>(`/api/tasks/${taskId}/subtasks`, { text }),
  updateSubtask: (taskId: string, subtaskId: string, patchBody: { text?: string; done?: boolean }) =>
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
  deleteCheckins: () => del<{ ok: true }>('/api/checkins'),

  // ---- Phase 2: sessions, daily records, tags and config history ----

  listSessions: (taskId: string, limit = 50) =>
    request<{ items: ActivitySession[] }>(
      `/api/activity/sessions?taskId=${encodeURIComponent(taskId)}&limit=${limit}`,
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

  listTags: () => request<{ items: TagSummary[] }>('/api/tags'),
  renameTag: (id: number, name: string) => patch<{ tag: { id: number; name: string } }>(`/api/tags/${id}`, { name }),
  mergeTags: (sourceId: number, targetId: number) =>
    post<{ tag: { id: number; name: string } }>('/api/tags/merge', { sourceId, targetId }),

  listTaskConfigs: (taskId: string) =>
    request<{ items: TaskConfig[] }>(`/api/task-configs/${encodeURIComponent(taskId)}`),

  // ---- Phase 2a: daily state summary, estimates and the evening review ----

  getState: (date: string, today: string) =>
    request<DailyState>(`/api/state?date=${encodeURIComponent(date)}&today=${encodeURIComponent(today)}`),
  getStatePrefs: () => request<StatePrefs>('/api/state/prefs'),
  saveStatePrefs: (input: Partial<StatePrefs>) => put<StatePrefs>('/api/state/prefs', input),
  getDayReview: (date: string) =>
    request<DayReview | null>(`/api/state/review?date=${encodeURIComponent(date)}`),
  saveDayReview: (date: string, answer: DayReviewAnswer) =>
    put<DayReview>('/api/state/review', { date, answer }),
  saveSuggestionChoice: (date: string, key: string, choice: 'accepted' | 'dismissed') =>
    put<{ ok: true }>('/api/state/suggestions', { date, key, choice }),
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message
  if (error instanceof TypeError) return 'Cannot reach the server. Is it running?'
  if (error instanceof Error) return error.message
  return 'Something went wrong.'
}

export function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
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
