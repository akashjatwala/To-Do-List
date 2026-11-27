import { useState } from 'react'
import { api, errorMessage } from '@/api'
import type { OffDayKind, Team, TeammateOffDay, ToastTone, UserInvite } from '@/types'
import { Avatar } from './ui'
import OffDayCalendarButton, { type OffDayCalendarEntry } from './OffDayCalendar'
import { NO_OFF_DAY_EMOJI, offDayEmoji } from './off-day-display'
import { CheckIcon, MailIcon, TrashIcon, UserPlusIcon, XIcon } from './Icons'

type Notify = (message: string, tone?: ToastTone) => void

const OFF_KIND_LABELS: Record<OffDayKind, string> = {
  sick: 'Sick',
  travel: 'Travelling',
  holiday: 'Holiday',
  other: 'Off',
}

const MONTH_LABELS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
]

function shortDate(value: string): string {
  const [, month, day] = value.split('-').map(Number)
  return `${MONTH_LABELS[month - 1]} ${day}`
}

function offWindow(offDay: TeammateOffDay, today: string): string {
  const active = offDay.startDate <= today && today <= offDay.endDate
  if (active) {
    return offDay.startDate === offDay.endDate
      ? 'Today'
      : `Today · ${shortDate(offDay.startDate)} – ${shortDate(offDay.endDate)}`
  }
  return offDay.startDate === offDay.endDate
    ? `On ${shortDate(offDay.startDate)}`
    : `From ${shortDate(offDay.startDate)} to ${shortDate(offDay.endDate)}`
}

/** Compact members card used on the right side of the Teams page. */
export function TeamMembersCard({
  team,
  currentUserId,
  notify,
  onChanged,
}: {
  team: Team
  currentUserId: number
  notify: Notify
  onChanged: () => Promise<void>
}) {
  const [inviteOpen, setInviteOpen] = useState(false)
  const [email, setEmail] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const isHost = team.role === 'host'

  const submitInvite = async () => {
    const value = email.trim().toLowerCase()
    if (!value) return
    setBusy(true)
    setError(null)
    try {
      await api.invite(team.id, value)
      await onChanged()
      setEmail('')
      setInviteOpen(false)
      notify(`Invitation sent to ${value}.`, 'success')
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="rounded-[24px] border border-[#DDE3EA] bg-[#EDF0F4] p-5" aria-label="Members">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-xl font-extrabold tracking-tight text-[#15181E]">Members</h2>
        {isHost && (
          <button
            type="button"
            onClick={() => {
              setInviteOpen((open) => !open)
              setError(null)
            }}
            className="text-xs font-bold tracking-wide text-[#D9480F] transition hover:underline"
          >
            {inviteOpen ? 'Cancel' : 'Invite'}
          </button>
        )}
      </div>

      {inviteOpen && (
        <form
          className="mb-3 flex gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            void submitInvite()
          }}
        >
          <input
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="teammate@example.com"
            aria-label="Invite by email"
            className="field min-w-0 flex-1 py-1.5 text-xs"
            autoFocus
            required
          />
          <button
            type="submit"
            disabled={busy || !email.trim()}
            className="rounded-xl bg-[#D9480F] px-3 py-1.5 text-xs font-bold text-white transition hover:bg-[#C23E0C] disabled:opacity-50"
          >
            Send
          </button>
        </form>
      )}
      {error && <p className="mb-2 text-xs font-medium text-rose-600">{error}</p>}

      <div className="rounded-2xl bg-white/55 px-2 py-1.5 shadow-sm ring-1 ring-[#5B6675]/10">
        <ul className="space-y-0.5">
          {team.members.map((member) => {
            const you = member.id === currentUserId
            return (
              <li key={member.id} className="flex items-center gap-3 rounded-xl px-1 py-2">
                <Avatar email={member.email} size="sm" />
                <span className="min-w-0 flex-1 truncate text-sm font-semibold text-[#15181E]">
                  {member.email.split('@')[0]}
                  {you && <span className="ml-1 font-medium text-[#6B7684]">(you)</span>}
                </span>
                <span className="shrink-0 text-[10px] font-bold tracking-wide text-[#5B6675]">
                  {member.role === 'host' ? 'Host' : 'Member'}
                </span>
              </li>
            )
          })}
        </ul>
      </div>
    </section>
  )
}

/** Teammates in this team who are off today. Other periods live in the header calendar. */
export function TeamOffDaysCard({
  team,
  offDays,
  currentUserId,
  today,
  calendarEntries = [],
}: {
  team: Team
  offDays: TeammateOffDay[]
  currentUserId: number
  today: string
  calendarEntries?: OffDayCalendarEntry[]
}) {
  const teammateIds = new Set(
    team.members.filter((member) => member.id !== currentUserId).map((member) => member.id),
  )
  const visibleOffDays = offDays
    .filter(
      (offDay) =>
        teammateIds.has(offDay.userId) &&
        offDay.startDate <= today &&
        today <= offDay.endDate,
    )
    .sort((a, b) => a.name.localeCompare(b.name))

  return (
    <section
      className="overflow-hidden rounded-[24px] border border-[#DCE9EE] bg-[#EEF5F8] p-5"
      aria-label="Teammate off days today"
    >
      <div className="mb-3 flex items-start justify-between gap-2">
        <h2 className="text-xl font-extrabold tracking-tight text-[#15181E]">Off today</h2>
        <OffDayCalendarButton
          entries={calendarEntries}
          today={today}
          title="Team off day calendar"
          buttonLabel="View team off day calendar"
          tone="teammate"
        />
      </div>

      {visibleOffDays.length === 0 ? (
        <div className="rounded-2xl bg-white/70 px-4 py-5 text-center shadow-sm ring-1 ring-white/80">
          <span className="text-3xl" aria-hidden="true">
            {NO_OFF_DAY_EMOJI}
          </span>
          <p className="mt-2 text-sm font-semibold text-slate-700">Nobody is off today</p>
        </div>
      ) : (
        <ul className="space-y-1 divide-y divide-slate-200/70 rounded-2xl bg-white/70 px-4 shadow-sm ring-1 ring-white/80 [&>li:first-child]:pt-3 [&>li:last-child]:pb-3">
          {visibleOffDays.map((offDay) => (
            <li key={offDay.id} className="flex items-start gap-3 py-2">
              <span className="text-2xl" aria-hidden="true">
                {offDayEmoji(offDay.kind)}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-baseline gap-x-1.5">
                  <span className="text-sm font-semibold text-slate-700">{offDay.name}</span>
                  <span className="text-[11px] font-medium text-slate-500">
                    · {offDay.kind ? OFF_KIND_LABELS[offDay.kind] : 'Off'}
                  </span>
                </span>
                <span className="mt-0.5 block text-xs leading-relaxed text-slate-500">
                  {offWindow(offDay, today)}
                  {offDay.note ? ` · ${offDay.note}` : ''}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/** Compact invitations card: incoming invitations plus the host's pending sends. */
export function TeamInvitationsCard({
  team,
  invites,
  onAccept,
  onDecline,
  notify,
  onChanged,
}: {
  team: Team
  invites: UserInvite[]
  onAccept: (invite: UserInvite) => void
  onDecline: (invite: UserInvite) => void
  notify: Notify
  onChanged: () => Promise<void>
}) {
  const [busyEmail, setBusyEmail] = useState<string | null>(null)

  const cancel = async (email: string) => {
    setBusyEmail(email)
    try {
      await api.cancelInvite(team.id, email)
      await onChanged()
      notify(`Invitation to ${email} cancelled.`, 'info')
    } catch (cause) {
      notify(errorMessage(cause), 'error')
    } finally {
      setBusyEmail(null)
    }
  }

  const sent = team.invites ?? []

  return (
    <section className="rounded-[24px] bg-[#FBE4EC] p-5" aria-label="Invitations">
      <div className="mb-3">
        <h2 className="text-xl font-extrabold tracking-tight text-[#15181E]">Invitations</h2>
      </div>

      {invites.length === 0 && sent.length === 0 ? (
        <p className="text-xs leading-relaxed text-[#8A5A6C]">No invitations waiting.</p>
      ) : (
        <div className="space-y-3">
          {invites.map((invite) => (
            <div key={invite.teamId} className="rounded-2xl bg-white/45 p-3">
              <p className="flex items-start gap-2 text-xs leading-relaxed text-[#7A4055]">
                <MailIcon className="mt-0.5 h-3.5 w-3.5 shrink-0 opacity-70" />
                <span>
                  <span className="font-bold">{invite.teamName}</span> invited you to join their
                  team.
                </span>
              </p>
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  onClick={() => onAccept(invite)}
                  className="inline-flex items-center gap-1 rounded-full bg-[#2F4A37] px-3 py-1 text-[11px] font-bold text-white transition hover:bg-[#233829]"
                >
                  <CheckIcon className="h-3 w-3" strokeWidth={3} />
                  Accept
                </button>
                <button
                  type="button"
                  onClick={() => onDecline(invite)}
                  className="inline-flex items-center gap-1 rounded-full bg-white/70 px-3 py-1 text-[11px] font-semibold text-[#7A4055] transition hover:bg-white"
                >
                  <XIcon className="h-3 w-3" />
                  Decline
                </button>
              </div>
            </div>
          ))}

          {sent.length > 0 && (
            <div className="space-y-1.5">
              {sent.map((pending) => (
                <div key={pending.email} className="flex items-center gap-2 text-xs text-[#7A4055]">
                  <UserPlusIcon className="h-3.5 w-3.5 shrink-0 opacity-70" />
                  <span className="min-w-0 flex-1 truncate">
                    Sent by you: <span className="font-semibold">{pending.email}</span>
                  </span>
                  <span className="shrink-0 text-[10px] font-bold tracking-wide opacity-70">
                    Pending
                  </span>
                  <button
                    type="button"
                    onClick={() => void cancel(pending.email)}
                    disabled={busyEmail === pending.email}
                    className="rounded p-1 opacity-60 transition hover:text-rose-700 disabled:opacity-30"
                    aria-label={`Cancel invitation for ${pending.email}`}
                  >
                    <TrashIcon className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  )
}
