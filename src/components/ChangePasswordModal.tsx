import { useState, type FormEvent } from 'react'
import { api, errorMessage } from '@/api'
import { Modal, Spinner } from './ui'
import { EyeIcon, EyeOffIcon, LockIcon } from './Icons'

export default function ChangePasswordModal({
  onClose,
  onDone,
}: {
  onClose: () => void
  onDone: () => void
}) {
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
    <Modal
      open
      onClose={onClose}
      title="Change password"
      description="Confirm your current password, then choose a new one."
      width="max-w-md"
    >
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
          <p className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-medium text-rose-600 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-300">
            {error}
          </p>
        )}

        <p className="text-[11px] leading-relaxed text-slate-400 dark:text-slate-500">
          Changing your password signs you out of every other device. This session stays active.
        </p>

        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} className="btn-ghost">
            Cancel
          </button>
          <button type="submit" disabled={busy} className="btn-primary">
            {busy && <Spinner className="h-4 w-4" />}
            Update password
          </button>
        </div>
      </form>
    </Modal>
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
          className="absolute top-1/2 right-2 -translate-y-1/2 rounded-lg p-1.5 text-slate-400 transition hover:text-slate-600 dark:hover:text-slate-200"
          aria-label={show ? 'Hide password' : 'Show password'}
          tabIndex={-1}
        >
          {show ? <EyeOffIcon className="h-4.5 w-4.5" /> : <EyeIcon className="h-4.5 w-4.5" />}
        </button>
      </div>
    </div>
  )
}
