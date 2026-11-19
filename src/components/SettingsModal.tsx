import { useState, type FormEvent } from 'react'
import { api, errorMessage } from '@/api'
import { Modal, Spinner } from './ui'
import { AlertIcon, EyeIcon, EyeOffIcon, LockIcon } from './Icons'

export default function SettingsModal({
  onClose,
  onPasswordChanged,
  onDeleted,
}: {
  onClose: () => void
  onPasswordChanged: () => void
  onDeleted: () => void
}) {
  const [tab, setTab] = useState<'password' | 'account'>('password')

  return (
    <Modal
      open
      onClose={onClose}
      title="Settings"
      description="Manage your account and security."
      width="max-w-md"
    >
      <div className="mb-4 flex gap-1 rounded-xl bg-slate-100 p-1">
        {(
          [
            { key: 'password', label: 'Password' },
            { key: 'account', label: 'Account' },
          ] as const
        ).map((item) => (
          <button
            key={item.key}
            type="button"
            onClick={() => setTab(item.key)}
            className={`flex-1 rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
              tab === item.key
                ? 'bg-white text-slate-900 shadow-sm'
                : 'text-slate-500 hover:text-slate-700'
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>

      {tab === 'password' ? (
        <ChangePassword onDone={onPasswordChanged} />
      ) : (
        <DeleteAccount onDeleted={onDeleted} />
      )}
    </Modal>
  )
}

function ChangePassword({ onDone }: { onDone: () => void }) {
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

function DeleteAccount({ onDeleted }: { onDeleted: () => void }) {
  const [password, setPassword] = useState('')
  const [show, setShow] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (busy) return
    setError(null)
    if (!password) {
      setError('Enter your password to confirm.')
      return
    }
    setBusy(true)
    try {
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
          This permanently removes your account, your personal tasks, and any teams you host. This
          cannot be undone.
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
            <button type="submit" disabled={busy} className="btn-danger">
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
