import { useState, type FormEvent } from 'react'
import { api, errorMessage } from '@/api'
import type { Team } from '@/types'
import { Spinner } from './ui'
import { AlertIcon, EyeIcon, EyeOffIcon, LockIcon } from './Icons'

export function ChangePassword({ onDone }: { onDone: () => void }) {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [show, setShow] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (busy) return
    setError(null)

    if (next !== confirm) {
      setError('The new passwords do not match.')
      return
    }
    if (next.length < 8) {
      setError('Password must be at least 8 characters.')
      return
    }

    setBusy(true)
    try {
      await api.changePassword(current, next)
      onDone()
    } catch (err) {
      setError(errorMessage(err))
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <PasswordField
        id="current-password"
        label="Current password"
        value={current}
        onChange={setCurrent}
        show={show}
        onToggleShow={() => setShow((value) => !value)}
        autoComplete="current-password"
        placeholder="Your current password"
        autoFocus
      />
      <PasswordField
        id="new-password"
        label="New password"
        value={next}
        onChange={setNext}
        show={show}
        onToggleShow={() => setShow((value) => !value)}
        autoComplete="new-password"
        placeholder="At least 8 characters"
      />
      <PasswordField
        id="confirm-password"
        label="Confirm new password"
        value={confirm}
        onChange={setConfirm}
        show={show}
        onToggleShow={() => setShow((value) => !value)}
        autoComplete="new-password"
        placeholder="Repeat your new password"
      />

      {error && (
        <p className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-medium text-rose-600">
          {error}
        </p>
      )}

      <p className="text-[11px] leading-relaxed text-slate-400">
        Changing your password signs you out of every other device. This session stays active.
      </p>

      <div className="flex justify-end gap-2 pt-1">
        <button type="submit" disabled={busy} className="btn-primary">
          {busy && <Spinner className="h-4 w-4" />}
          Update password
        </button>
      </div>
    </form>
  )
}

export function DeleteAccount({
  teams,
  currentUserId,
  onDeleted,
}: {
  teams: Team[]
  currentUserId: number
  onDeleted: () => void
}) {
  const [password, setPassword] = useState('')
  const [show, setShow] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [newHosts, setNewHosts] = useState<Record<string, number>>({})
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const hostedTeams = teams.filter((team) => team.role === 'host')
  const candidates = (team: Team) => team.members.filter((member) => member.id !== currentUserId)
  const readyToDelete = hostedTeams.every(
    (team) => newHosts[team.id] && candidates(team).length > 0,
  )

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (busy) return
    setError(null)
    if (!password) {
      setError('Enter your password to confirm.')
      return
    }
    for (const team of hostedTeams) {
      if (!newHosts[team.id]) {
        setError(`Choose a new host for ${team.name}.`)
        return
      }
    }
    setBusy(true)
    try {
      for (const team of hostedTeams) {
        await api.transferHost(team.id, newHosts[team.id])
      }
      await api.deleteAccount(password)
      onDeleted()
    } catch (err) {
      setError(errorMessage(err))
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-rose-200 bg-rose-50/70 p-3.5">
        <p className="flex items-center gap-2 text-sm font-semibold text-rose-700">
          <AlertIcon className="h-4 w-4" />
          Delete account
        </p>
        <p className="mt-1 text-xs leading-relaxed text-rose-600/90">
          This permanently removes your account, personal tasks, history and learning data. Teams
          you host are handed to a member you choose below, not deleted.
        </p>
      </div>

      {!confirming ? (
        <div className="flex justify-end">
          <button type="button" onClick={() => setConfirming(true)} className="btn-danger">
            <AlertIcon className="h-4 w-4" />
            Delete my account
          </button>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          <PasswordField
            id="delete-password"
            label="Confirm your password"
            value={password}
            onChange={setPassword}
            show={show}
            onToggleShow={() => setShow((value) => !value)}
            autoComplete="current-password"
            placeholder="Your password"
            autoFocus
          />

          {hostedTeams.length > 0 && (
            <div className="space-y-3 rounded-xl border border-[#E1E2E0] bg-white p-3.5">
              <div>
                <p className="text-xs font-semibold text-[#15181E]">Teams you host</p>
                <p className="mt-0.5 text-[11px] leading-relaxed text-[#7C818A]">
                  Choose who takes over each team before you can delete your account.
                </p>
              </div>
              {hostedTeams.map((team) => (
                <label key={team.id} className="block">
                  <span className="mb-1 block text-[11px] font-semibold text-[#15181E]">
                    {team.name}
                  </span>
                  <select
                    className="field py-1.5 text-xs"
                    value={newHosts[team.id] ?? ''}
                    onChange={(event) =>
                      setNewHosts((current) => ({
                        ...current,
                        [team.id]: Number(event.target.value) || 0,
                      }))
                    }
                    aria-label={`New host for ${team.name}`}
                  >
                    <option value="">Choose a new host…</option>
                    {candidates(team).map((member) => (
                      <option key={member.id} value={member.id}>
                        {member.email.split('@')[0]} ({member.email})
                      </option>
                    ))}
                  </select>
                  {candidates(team).length === 0 && (
                    <span className="mt-1 block text-[11px] text-rose-600">
                      Invite another member to this team first.
                    </span>
                  )}
                </label>
              ))}
            </div>
          )}

          {error && (
            <p className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-medium text-rose-600">
              {error}
            </p>
          )}

          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => {
                setConfirming(false)
                setPassword('')
                setError(null)
              }}
              className="btn-ghost"
            >
              Cancel
            </button>
            <button type="submit" disabled={busy || !readyToDelete} className="btn-danger">
              {busy && <Spinner className="h-4 w-4" />}
              Permanently delete
            </button>
          </div>
        </form>
      )}
    </div>
  )
}

function PasswordField({
  id,
  label,
  value,
  onChange,
  show,
  onToggleShow,
  autoComplete,
  placeholder,
  autoFocus,
}: {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  show: boolean
  onToggleShow: () => void
  autoComplete: string
  placeholder: string
  autoFocus?: boolean
}) {
  return (
    <div>
      <label className="label" htmlFor={id}>
        {label}
      </label>
      <div className="relative">
        <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-slate-400">
          <LockIcon className="h-4.5 w-4.5" />
        </span>
        <input
          id={id}
          type={show ? 'text' : 'password'}
          className="field pr-11 pl-10"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          autoComplete={autoComplete}
          placeholder={placeholder}
          autoFocus={autoFocus}
          required
        />
        <button
          type="button"
          onClick={onToggleShow}
          className="absolute top-1/2 right-2 -translate-y-1/2 rounded-lg p-1.5 text-slate-400 transition hover:text-slate-600"
          aria-label={show ? 'Hide password' : 'Show password'}
          tabIndex={-1}
        >
          {show ? <EyeOffIcon className="h-4.5 w-4.5" /> : <EyeIcon className="h-4.5 w-4.5" />}
        </button>
      </div>
    </div>
  )
}
