import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { AppNotification, UserInvite } from '@/types'
import { timeAgo } from '@/lib/date'
import { groupNotifications, unreadCount } from '@/lib/notifications'
import { BellIcon, CheckIcon, MessageIcon, PlusIcon, UsersIcon } from './Icons'

const storageKey = (userId: number) => `duit.notifications.read.${userId}`

function readMarker(userId: number): number {
  if (typeof window === 'undefined') return 0
  const value = Number(window.localStorage.getItem(storageKey(userId)))
  return Number.isFinite(value) ? value : 0
}

function Section({
  title,
  count,
  children,
}: {
  title: string
  count: number
  children: ReactNode
}) {
  if (count === 0) return null
  return (
    <section className="mb-1 last:mb-0">
      <h3 className="px-2.5 py-1.5 text-[10px] font-bold tracking-wide text-[#6B7280] uppercase">
        {title}
      </h3>
      <div className="space-y-0.5">{children}</div>
    </section>
  )
}

interface NotificationCenterProps {
  userId: number
  notifications: AppNotification[]
  invites: UserInvite[]
  onAcceptInvite: (invite: UserInvite) => void | Promise<void>
  onDeclineInvite: (invite: UserInvite) => void | Promise<void>
  onOpenTask: (taskId: string) => void
  /** Used by static rendering tests; the app leaves this closed. */
  defaultOpen?: boolean
}

/** Header popover that keeps in-app activity in one place. */
export default function NotificationCenter({
  userId,
  notifications,
  invites,
  onAcceptInvite,
  onDeclineInvite,
  onOpenTask,
  defaultOpen = false,
}: NotificationCenterProps) {
  const [open, setOpen] = useState(defaultOpen)
  const [lastRead, setLastRead] = useState(() => readMarker(userId))
  const ref = useRef<HTMLDivElement>(null)
  const groups = groupNotifications(notifications)
  const unread = unreadCount(notifications, lastRead)

  useEffect(() => {
    setLastRead(readMarker(userId))
  }, [userId])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const markAllRead = () => {
    const now = Date.now()
    setLastRead(now)
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(storageKey(userId), String(now))
    }
  }

  const openTask = (taskId: string) => {
    setOpen(false)
    onOpenTask(taskId)
  }

  const inviteFor = (teamId: string | null) =>
    teamId ? invites.find((invite) => invite.teamId === teamId) : undefined

  const renderItem = (item: AppNotification) => {
    const Icon =
      item.kind === 'task-added'
        ? PlusIcon
        : item.kind === 'task-completed'
          ? CheckIcon
          : item.kind === 'comment' || item.kind === 'mention'
            ? MessageIcon
            : item.kind === 'reminder' || item.kind === 'team-reminder'
              ? BellIcon
              : UsersIcon
    const unreadItem = item.createdAt > lastRead
    const invite = item.kind === 'invite' ? inviteFor(item.teamId) : undefined

    return (
      <div
        key={item.id}
        className={`rounded-xl px-2.5 py-2 transition ${
          unreadItem
            ? 'bg-[#F5F7FF] ring-1 ring-inset ring-[#7C8CF8]/25'
            : 'hover:bg-slate-50'
        }`}
      >
        <div className="flex items-start gap-2.5">
          <span
            className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ring-1 ${
              unreadItem
                ? 'bg-[#EEF2FF] text-[#4F46E5] ring-[#DDE5FF]'
                : 'bg-slate-50 text-slate-500 ring-slate-200/80'
            }`}
          >
            <Icon className="h-3.5 w-3.5" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <p className="min-w-0 truncate text-xs font-semibold text-[#15181E]">{item.title}</p>
              {unreadItem && (
                <>
                  <span
                    aria-hidden="true"
                    className="h-1.5 w-1.5 shrink-0 rounded-full bg-[#4F46E5]"
                  />
                  <span className="sr-only">Unread</span>
                </>
              )}
            </div>
            <p className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-[#7C818A]">
              {item.body}
            </p>
            <p className="mt-1 flex flex-wrap items-center gap-1.5 text-[10px] font-medium text-[#8A94A6]">
              {item.teamName && (
                <span className="rounded bg-[#F1F5F9] px-1.5 py-0.5 font-semibold text-[#475569]">
                  {item.teamName}
                </span>
              )}
              <span>{timeAgo(item.createdAt)}</span>
            </p>

            {invite && (
              <div className="mt-2 flex gap-1.5">
                <button
                  type="button"
                  onClick={() => void onAcceptInvite(invite)}
                  className="rounded-lg bg-indigo-600 px-2.5 py-1 text-[11px] font-semibold text-white transition hover:bg-indigo-500"
                >
                  Accept
                </button>
                <button
                  type="button"
                  onClick={() => void onDeclineInvite(invite)}
                  className="rounded-lg px-2.5 py-1 text-[11px] font-medium text-slate-500 transition hover:bg-white hover:text-slate-700"
                >
                  Decline
                </button>
              </div>
            )}

            {!invite && item.taskId && (
              <button
                type="button"
                onClick={() => openTask(item.taskId!)}
                className="mt-2 rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-semibold text-slate-600 transition hover:bg-slate-50 hover:text-slate-900"
              >
                Open task
              </button>
            )}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-label="Notifications"
        aria-haspopup="dialog"
        aria-expanded={open}
        className={`relative flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-full border border-slate-200 text-[#454B58] transition hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-[#4A2C8A]/30 focus-visible:outline-none ${
          open ? 'bg-slate-50' : 'bg-white'
        }`}
      >
        <BellIcon className="h-[18px] w-[18px]" />
        {unread > 0 && (
          <span
            aria-hidden="true"
            className="absolute -top-0.5 -right-0.5 h-2.5 w-2.5 rounded-full bg-[#4F46E5] ring-2 ring-white"
          />
        )}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Notifications"
          className="animate-in absolute top-full right-0 z-50 mt-2 w-[min(22rem,calc(100vw-2rem))] overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xl"
        >
          <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-4 py-3">
            <h2 className="text-sm font-bold tracking-tight text-[#15181E]">Notifications</h2>
            {unread > 0 && (
              <button
                type="button"
                onClick={markAllRead}
                className="shrink-0 rounded-lg px-2 py-1 text-[11px] font-semibold text-[#4F46E5] transition hover:bg-[#EEF2FF]"
              >
                Mark all read
              </button>
            )}
          </div>

          <div className="max-h-[min(28rem,70vh)] overflow-y-auto p-2">
            {notifications.length === 0 ? (
              <div className="px-4 py-8 text-center">
                <p className="text-sm font-semibold text-[#15181E]">You’re all caught up</p>
                <p className="mt-1 text-xs text-[#7C818A]">New activity will show up here.</p>
              </div>
            ) : (
              <>
                <Section title="Invitations" count={groups.invitations.length}>
                  {groups.invitations.map(renderItem)}
                </Section>
                <Section title="Reminders" count={groups.reminders.length}>
                  {groups.reminders.map(renderItem)}
                </Section>
                <Section title="Team activity" count={groups.activity.length}>
                  {groups.activity.map(renderItem)}
                </Section>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
