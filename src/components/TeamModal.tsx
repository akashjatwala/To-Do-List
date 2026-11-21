import { useEffect, useState, type FormEvent } from 'react'
import { api, errorMessage } from '@/api'
import { DEFAULT_TEAM_COLOR, TEAM_COLORS, isTeamOwner, type TeamColor } from '@/lib/team'
import type { Team, User } from '@/types'
import { Avatar, Modal, Spinner, useConfirm } from './ui'
import { CheckIcon, DoorOpenIcon, MailIcon, TrashIcon, UserPlusIcon, UsersIcon } from './Icons'
import NewTeamDialog from './NewTeamDialog'

interface TeamModalProps {
  team: Team | null
  user: User
  openTaskCount: number
  onClose: () => void
  onChanged: () => Promise<void>
  notify: (message: string, tone?: 'success' | 'error' | 'info') => void
}

const FIELD_LABEL = 'label normal-case tracking-normal'

function memberLabel(count: number, singular: string, plural: string) {
  return `${count} ${count === 1 ? singular : plural}`
}

export default function TeamModal({
  team,
  user,
  openTaskCount,
  onClose,
  onChanged,
  notify,
}: TeamModalProps) {
  if (!team) {
    return <NewTeamDialog onClose={onClose} onChanged={onChanged} notify={notify} />
  }
  return (
    <ManageTeam
      key={team.id}
      team={team}
      user={user}
      openTaskCount={openTaskCount}
      onClose={onClose}
      onChanged={onChanged}
      notify={notify}
    />
  )
}

function ManageTeam({
  team,
  user,
  openTaskCount,
  onClose,
  onChanged,
  notify,
}: {
  team: Team
  user: User
  openTaskCount: number
  onClose: () => void
  onChanged: () => Promise<void>
  notify: TeamModalProps['notify']
}) {
  const [name, setName] = useState(team.name)
  const [description, setDescription] = useState('')
  const [color, setColor] = useState<TeamColor>(DEFAULT_TEAM_COLOR)
  const [inviteEmail, setInviteEmail] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [inviteError, setInviteError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [inviting, setInviting] = useState(false)
  const { confirm, dialog } = useConfirm()

  useEffect(() => {
    setName(team.name)
  }, [team.name])

  const isHost = isTeamOwner(team, user)
  const pendingInvites = team.invites ?? []

  const save = async (event: FormEvent) => {
    event.preventDefault()
    if (!isHost) {
      onClose()
      return
    }
    const value = name.trim()
    if (!value) {
      setError('Give your team a name.')
      return
    }
    if (value === team.name) {
      onClose()
      return
    }
    setBusy(true)
    setError(null)
    try {
      await api.renameTeam(team.id, value)
      await onChanged()
      notify('Team renamed.', 'success')
      onClose()
    } catch (err) {
      setError(errorMessage(err))
      setBusy(false)
    }
  }

  const invite = async () => {
    const value = inviteEmail.trim()
    if (!value) return
    setInviting(true)
    setInviteError(null)
    try {
      await api.invite(team.id, value)
      setInviteEmail('')
      await onChanged()
      notify(`Invitation sent to ${value}.`, 'success')
    } catch (err) {
      setInviteError(errorMessage(err))
    } finally {
      setInviting(false)
    }
  }

  const removeMember = async (memberId: number, email: string) => {
    if (
      !(await confirm({
        title: 'Remove member?',
        description: `Remove ${email} from ${team.name}?`,
        confirmLabel: 'Remove member',
      }))
    ) {
      return
    }
    try {
      await api.removeMember(team.id, memberId)
      await onChanged()
      notify(`${email} was removed from the team.`, 'success')
    } catch (err) {
      notify(errorMessage(err), 'error')
    }
  }

  const cancelInvite = async (email: string) => {
    try {
      await api.cancelInvite(team.id, email)
      await onChanged()
      notify('Invitation cancelled.', 'info')
    } catch (err) {
      notify(errorMessage(err), 'error')
    }
  }

  const deleteTeam = async () => {
    if (
      !(await confirm({
        title: 'Delete team?',
        description: `Delete “${team.name}”?`,
        hint: 'Its tasks, subtasks and comments will be permanently removed.',
        confirmLabel: 'Delete team',
      }))
    ) {
      return
    }
    setBusy(true)
    try {
      await api.deleteTeam(team.id)
      await onChanged()
      notify('Team deleted.', 'info')
      onClose()
    } catch (err) {
      setError(errorMessage(err))
      setBusy(false)
    }
  }

  const leaveTeam = async () => {
    if (
      !(await confirm({
        title: 'Leave team?',
        description: `Leave “${team.name}”?`,
        hint: 'You will lose access to its shared tasks.',
        confirmLabel: 'Leave team',
      }))
    ) {
      return
    }
    setBusy(true)
    try {
      await api.leaveTeam(team.id)
      await onChanged()
      notify(`You left ${team.name}.`, 'info')
      onClose()
    } catch (err) {
      setError(errorMessage(err))
      setBusy(false)
    }
  }

  const previewName = name.trim() || 'Team name'
  const previewDescription = description.trim() || 'What is it for?'
  const previewInitial = previewName.charAt(0).toUpperCase()

  return (
    <>
      <Modal
        open
        onClose={onClose}
        title="Edit team"
        description={`${memberLabel(team.members.length, 'member', 'members')} · ${
          isHost ? 'You are the host' : 'You are a member'
        }`}
        width="max-w-5xl"
      >
        <form onSubmit={save}>
          <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_19rem]">
            <div className="min-w-0 space-y-5">
              {error && (
                <p className="rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-sm text-rose-700">
                  {error}
                </p>
              )}

              <section>
                <label className={FIELD_LABEL} htmlFor="edit-team-name">
                  Team name
                </label>
                <input
                  id="edit-team-name"
                  className="field text-base"
                  value={name}
                  onChange={(event) => {
                    setName(event.target.value)
                    setError(null)
                  }}
                  placeholder="e.g. Study group"
                  maxLength={60}
                  disabled={!isHost || busy}
                />
              </section>

              <section>
                <label className={FIELD_LABEL} htmlFor="edit-team-purpose">
                  What is it for? <span className="font-normal text-slate-400">(optional)</span>
                </label>
                <textarea
                  id="edit-team-purpose"
                  className="field min-h-[5.5rem] resize-none text-sm"
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  placeholder="Shared reading list and weekly goals."
                  maxLength={160}
                  disabled={!isHost || busy}
                />
              </section>

              {isHost && (
                <section>
                  <p className={FIELD_LABEL}>Team color</p>
                  <div className="mt-2 flex flex-wrap items-center gap-3" role="group" aria-label="Team color">
                    {TEAM_COLORS.map((option) => {
                      const selected = color.name === option.name
                      return (
                        <button
                          key={option.name}
                          type="button"
                          onClick={() => setColor(option)}
                          aria-label={`${option.name} team color`}
                          aria-pressed={selected}
                          disabled={busy}
                          className={`inline-flex h-8 w-8 items-center justify-center rounded-full transition focus-visible:ring-4 focus-visible:ring-[#D9480F]/20 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60 ${
                            selected ? 'ring-2 ring-offset-2' : 'ring-1 ring-black/10 hover:ring-black/25'
                          }`}
                          style={{
                            backgroundColor: option.bg,
                            borderColor: option.border,
                            ...(selected ? { boxShadow: `0 0 0 1px ${option.border}` } : {}),
                          }}
                        >
                          {selected && <CheckIcon className="h-4 w-4" style={{ color: option.ink }} />}
                        </button>
                      )
                    })}
                  </div>
                </section>
              )}

              <section>
                <p className={FIELD_LABEL}>Members</p>
                <ul className="mt-2 space-y-1.5">
                  {team.members.map((member) => (
                    <li
                      key={member.id}
                      className="group flex items-center gap-3 rounded-xl border border-slate-100 px-3 py-2"
                    >
                      <Avatar email={member.email} size="sm" />
                      <span className="min-w-0 flex-1 truncate text-sm text-slate-700">
                        {member.email}
                        {member.email.toLowerCase() === user.email.toLowerCase() && (
                          <span className="ml-1 font-medium text-slate-400">(you)</span>
                        )}
                      </span>
                      <span
                        className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-bold ${
                          member.role === 'host'
                            ? 'bg-amber-100 text-amber-700'
                            : 'bg-slate-100 text-slate-500'
                        }`}
                      >
                        {member.role === 'host' ? 'Host' : 'Member'}
                      </span>
                      {isHost && member.role !== 'host' && (
                        <button
                          type="button"
                          onClick={() => removeMember(member.id, member.email)}
                          className="rounded-lg p-1.5 text-slate-300 opacity-70 transition hover:bg-rose-50 hover:text-rose-500 focus:opacity-100"
                          aria-label={`Remove ${member.email}`}
                          title="Remove from team"
                        >
                          <TrashIcon className="h-4 w-4" />
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              </section>

              {isHost && (
                <section>
                  <p className={FIELD_LABEL}>Invite people</p>
                  <div className="mt-2 flex gap-2">
                    <div className="relative min-w-0 flex-1">
                      <MailIcon className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-slate-400" />
                      <input
                        type="email"
                        className="field pl-9"
                        value={inviteEmail}
                        onChange={(event) => {
                          setInviteEmail(event.target.value)
                          setInviteError(null)
                        }}
                        placeholder="name@example.com"
                        aria-label="Invite by email"
                        disabled={busy}
                      />
                    </div>
                    <button
                      type="button"
                      className="btn-primary shrink-0"
                      onClick={invite}
                      disabled={inviting || busy || !inviteEmail.trim()}
                    >
                      {inviting ? <Spinner /> : <UserPlusIcon className="h-4 w-4" />}
                      Invite
                    </button>
                  </div>
                  {inviteError && (
                    <p className="mt-2 text-xs font-medium text-rose-600">{inviteError}</p>
                  )}
                  <p className="mt-3 text-[11px] leading-relaxed text-slate-500">
                    They get an invitation in the app and join once they accept. You will be the
                    host. Members can add and complete tasks. Only the host or the person who
                    created a task can delete it.
                  </p>

                  {pendingInvites.length > 0 && (
                    <div className="mt-4">
                      <p className={FIELD_LABEL}>Pending invitations</p>
                      <div className="mt-2 space-y-1.5">
                        {pendingInvites.map((pending) => (
                          <div
                            key={pending.email}
                            className="flex items-center gap-2 rounded-xl bg-slate-50 px-3 py-2 text-sm text-slate-600"
                          >
                            <MailIcon className="h-3.5 w-3.5 text-slate-400" />
                            <span className="min-w-0 flex-1 truncate">{pending.email}</span>
                            <span className="text-[10px] font-semibold text-amber-600">Pending</span>
                            <button
                              type="button"
                              onClick={() => cancelInvite(pending.email)}
                              className="rounded p-1 text-slate-400 transition hover:text-rose-500"
                              aria-label={`Cancel invite for ${pending.email}`}
                            >
                              <TrashIcon className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </section>
              )}

              <section className="rounded-xl border border-rose-100 bg-rose-50/50 p-3.5">
                <h3 className="text-xs font-bold text-rose-600">
                  {isHost ? 'Danger zone' : 'Leave team'}
                </h3>
                <p className="mt-1 mb-2.5 text-[11px] leading-relaxed text-rose-500/80">
                  {isHost
                    ? 'Deleting the team removes every shared task, subtask and comment for everyone.'
                    : 'You will lose access to this team’s shared tasks.'}
                </p>
                {isHost ? (
                  <button type="button" onClick={deleteTeam} className="btn-danger" disabled={busy}>
                    {busy ? <Spinner /> : <TrashIcon className="h-4 w-4" />}
                    Delete team
                  </button>
                ) : (
                  <button type="button" onClick={leaveTeam} className="btn-danger" disabled={busy}>
                    {busy ? <Spinner /> : <DoorOpenIcon className="h-4 w-4" />}
                    Leave team
                  </button>
                )}
              </section>
            </div>

            <aside className="min-w-0">
              <p className={FIELD_LABEL}>Preview</p>
              <div
                className="rounded-2xl p-5 shadow-sm ring-1 ring-black/5"
                style={{ backgroundColor: color.bg, color: color.ink }}
              >
                <div className="flex items-start gap-3">
                  <span
                    className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-full text-xl font-bold ring-2 ring-white/70"
                    style={{ backgroundColor: 'rgba(255,255,255,0.65)' }}
                  >
                    {previewInitial}
                  </span>
                  <div className="min-w-0 pt-0.5">
                    <h3 className="text-base leading-snug font-bold break-words">{previewName}</h3>
                    <p className="mt-1 text-[11px] leading-snug opacity-80">{previewDescription}</p>
                  </div>
                </div>

                <div className="mt-5 flex flex-wrap items-center gap-2 text-[11px] font-semibold">
                  <span className="rounded-full bg-white/65 px-2 py-1 ring-1 ring-black/5">
                    {memberLabel(team.members.length, 'member', 'members')}
                  </span>
                  <span className="rounded-full bg-white/65 px-2 py-1 ring-1 ring-black/5">
                    {memberLabel(pendingInvites.length, 'invited', 'invited')}
                  </span>
                  <span className="rounded-full bg-white/65 px-2 py-1 ring-1 ring-black/5">
                    {memberLabel(openTaskCount, 'open task', 'open tasks')}
                  </span>
                </div>

                <p className="mt-5 border-t border-black/5 pt-4 text-[11px] leading-relaxed opacity-80">
                  The team color tints its panels, so you can tell your teams apart at a glance.
                </p>
              </div>
              <p className="mt-3 flex items-start gap-1.5 text-[11px] leading-snug text-slate-400">
                <UsersIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                {isHost
                  ? 'You are the host. Members can add and complete tasks.'
                  : 'You are a member of this team.'}
              </p>
            </aside>
          </div>

          <div className="mt-6 flex flex-wrap items-center justify-end gap-2 border-t border-slate-100 pt-4">
            <button type="button" className="btn-ghost" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button
              type="submit"
              className="btn-primary"
              disabled={busy || (isHost && !name.trim())}
            >
              {busy ? <Spinner /> : <UsersIcon className="h-4 w-4" />}
              {isHost ? 'Save changes' : 'Done'}
            </button>
          </div>
        </form>
      </Modal>
      {dialog}
    </>
  )
}
