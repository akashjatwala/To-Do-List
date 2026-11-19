import { useEffect, useState, type FormEvent } from 'react'
import { api, errorMessage } from '@/api'
import type { Team } from '@/types'
import { Avatar, Modal, Spinner } from './ui'
import {
  DoorOpenIcon,
  MailIcon,
  PencilIcon,
  TrashIcon,
  UserPlusIcon,
  UsersIcon,
} from './Icons'

interface TeamModalProps {
  team: Team | null
  onClose: () => void
  onChanged: () => Promise<void>
  notify: (message: string, tone?: 'success' | 'error' | 'info') => void
}

export default function TeamModal({ team, onClose, onChanged, notify }: TeamModalProps) {
  if (!team) {
    return <CreateTeam onClose={onClose} onChanged={onChanged} notify={notify} />
  }
  return (
    <ManageTeam key={team.id} team={team} onClose={onClose} onChanged={onChanged} notify={notify} />
  )
}

function CreateTeam({
  onClose,
  onChanged,
  notify,
}: {
  onClose: () => void
  onChanged: () => Promise<void>
  notify: TeamModalProps['notify']
}) {
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const value = name.trim()
    if (!value) return setError('Give your team a name.')
    setBusy(true)
    setError(null)
    try {
      await api.createTeam(value)
      await onChanged()
      notify(`“${value}” is ready — invite your teammates.`, 'success')
      onClose()
    } catch (err) {
      setError(errorMessage(err))
      setBusy(false)
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Create a team"
      description="Give your shared list a name. You can invite people once it exists."
    >
      <form onSubmit={submit} className="space-y-4">
        {error && (
          <p className="rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-sm text-rose-700">
            {error}
          </p>
        )}
        <div>
          <label className="label" htmlFor="team-name">
            Team name
          </label>
          <input
            id="team-name"
            className="field"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="e.g. Design squad, Launch plan…"
            maxLength={60}
            autoFocus
            required
          />
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn-primary" disabled={busy || !name.trim()}>
            {busy ? <Spinner /> : <UsersIcon className="h-4 w-4" />}
            Create team
          </button>
        </div>
      </form>
    </Modal>
  )
}

function ManageTeam({
  team,
  onClose,
  onChanged,
  notify,
}: {
  team: Team
  onClose: () => void
  onChanged: () => Promise<void>
  notify: TeamModalProps['notify']
}) {
  const [name, setName] = useState(team.name)
  const [renaming, setRenaming] = useState(false)
  const [inviteEmail, setInviteEmail] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [inviteError, setInviteError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [inviting, setInviting] = useState(false)

  useEffect(() => {
    setName(team.name)
  }, [team.name])

  const isHost = team.role === 'host'

  const rename = async (event: FormEvent) => {
    event.preventDefault()
    const value = name.trim()
    if (!value || value === team.name) {
      setRenaming(false)
      return
    }
    setBusy(true)
    setError(null)
    try {
      await api.renameTeam(team.id, value)
      await onChanged()
      notify('Team renamed.', 'success')
      setRenaming(false)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const invite = async (event: FormEvent) => {
    event.preventDefault()
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
    if (!window.confirm(`Remove ${email} from ${team.name}?`)) return
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
      !window.confirm(
        `Delete “${team.name}”? Its tasks, subtasks and comments will be permanently removed.`,
      )
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
    if (!window.confirm(`Leave “${team.name}”? You will lose access to its shared tasks.`)) return
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

  return (
    <Modal
      open
      onClose={onClose}
      title={team.name}
      description={`${team.members.length} ${team.members.length === 1 ? 'member' : 'members'} · You are ${team.role === 'host' ? 'the host' : 'a member'}`}
      width="max-w-xl"
    >
      <div className="space-y-6">
        {error && (
          <p className="rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-sm text-rose-700">
            {error}
          </p>
        )}

        {isHost && (
          <section>
            <h3 className="label">Team name</h3>
            {renaming ? (
              <form onSubmit={rename} className="flex gap-2">
                <input
                  className="field"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  maxLength={60}
                  autoFocus
                />
                <button type="submit" className="btn-primary shrink-0" disabled={busy}>
                  {busy ? <Spinner /> : 'Save'}
                </button>
                <button
                  type="button"
                  className="btn-ghost shrink-0"
                  onClick={() => {
                    setName(team.name)
                    setRenaming(false)
                  }}
                >
                  Cancel
                </button>
              </form>
            ) : (
              <div className="flex items-center justify-between rounded-xl border border-slate-200 px-3.5 py-2.5">
                <span className="text-sm font-medium">{team.name}</span>
                <button
                  type="button"
                  onClick={() => setRenaming(true)}
                  className="btn-ghost px-2! py-1! text-xs"
                >
                  <PencilIcon className="h-3.5 w-3.5" />
                  Rename
                </button>
              </div>
            )}
          </section>
        )}

        <section>
          <h3 className="label">Members</h3>
          <div className="space-y-1.5">
            {team.members.map((member) => (
              <div
                key={member.id}
                className="group flex items-center gap-3 rounded-xl border border-slate-100 px-3 py-2"
              >
                <Avatar email={member.email} size="sm" />
                <span className="min-w-0 flex-1 truncate text-sm text-slate-700">
                  {member.email}
                  {member.role === 'host' && (
                    <span className="ml-2 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold text-amber-700">
                      HOST
                    </span>
                  )}
                </span>
                {isHost && member.role !== 'host' && (
                  <button
                    type="button"
                    onClick={() => removeMember(member.id, member.email)}
                    className="rounded-lg p-1.5 text-slate-300 opacity-70 transition hover:bg-rose-50 hover:text-rose-500 focus:opacity-100 sm:opacity-0 sm:group-hover:opacity-100"
                    aria-label={`Remove ${member.email}`}
                    title="Remove from team"
                  >
                    <TrashIcon className="h-4 w-4" />
                  </button>
                )}
              </div>
            ))}
          </div>
        </section>

        {isHost && (
          <section>
            <h3 className="label flex items-center gap-1.5">
              <UserPlusIcon className="h-3.5 w-3.5" />
              Invite someone
            </h3>
            <form onSubmit={invite} className="flex gap-2">
              <div className="relative flex-1">
                <MailIcon className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <input
                  type="email"
                  className="field pl-9"
                  value={inviteEmail}
                  onChange={(event) => setInviteEmail(event.target.value)}
                  placeholder="teammate@example.com"
                  required
                />
              </div>
              <button type="submit" className="btn-primary shrink-0" disabled={inviting}>
                {inviting ? <Spinner /> : <UserPlusIcon className="h-4 w-4" />}
                Invite
              </button>
            </form>
            {inviteError && (
              <p className="mt-2 text-xs font-medium text-rose-600">{inviteError}</p>
            )}
            <p className="mt-2 text-[11px] leading-relaxed text-slate-400">
              Invitations show up the moment that person signs in (or creates an account with that
              email).
            </p>

            {team.invites && team.invites.length > 0 && (
              <div className="mt-4">
                <p className="mb-2 text-[11px] font-bold tracking-wider text-slate-400 uppercase">
                  Pending invitations
                </p>
                <div className="space-y-1.5">
                  {team.invites.map((pending) => (
                    <div
                      key={pending.email}
                      className="flex items-center gap-2 rounded-xl bg-slate-50 px-3 py-2 text-sm text-slate-600"
                    >
                      <MailIcon className="h-3.5 w-3.5 text-slate-400" />
                      <span className="min-w-0 flex-1 truncate">{pending.email}</span>
                      <span className="text-[10px] font-semibold text-amber-600">
                        PENDING
                      </span>
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
    </Modal>
  )
}
