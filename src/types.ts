export interface User {
  id: number
  email: string
}

export interface Subtask {
  id: string
  text: string
  done: boolean
  position: number
}

export interface Comment {
  id: string
  text: string
  createdAt: number
  userId: number
  email: string
}

export type Priority = 'none' | 'low' | 'medium' | 'high' | 'urgent'

export type Recurrence = 'none' | 'daily' | 'weekly' | 'monthly' | 'custom'

export type RecurrenceConfig =
  | { mode: 'weekly'; days: number[] }
  | { mode: 'monthly'; nth: number; weekday: number }

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
  teamId: string | null
  teamName: string | null
  userId: number
  ownerEmail: string
  subtasks: Subtask[]
  comments: Comment[]
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

export type View = { kind: 'my' } | { kind: 'collab'; teamId: string | null }

export type ToastTone = 'success' | 'error' | 'info'

export interface Toast {
  id: number
  message: string
  tone: ToastTone
}
