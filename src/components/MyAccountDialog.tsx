import { useState, type FormEvent, type ReactNode } from 'react'
import { api, errorMessage } from '@/api'
import type { User } from '@/types'
import { Modal, Spinner } from './ui'
import { ChangePassword, DeleteAccount } from './AccountForms'
import { PencilIcon } from './Icons'

function SettingRow({
  label,
  hint,
  action,
  align = 'center',
}: {
  label: string
  hint?: string
  action: ReactNode
  align?: 'center' | 'start'
}) {
  return (
    <div
      className={`flex flex-wrap justify-between gap-x-4 gap-y-2 py-3 first:pt-0 last:pb-0 ${
        align === 'start' ? 'items-start' : 'items-center'
      }`}
    >
      <div className="min-w-0">
        <p className="text-sm font-semibold text-[#15181E]">{label}</p>
        {hint && <p className="mt-0.5 text-xs leading-snug text-[#7C818A]">{hint}</p>}
      </div>
      <div className="flex shrink-0 items-center gap-3">{action}</div>
    </div>
  )
}

function TextButton({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-lg border border-[#E1E2E0] bg-white px-3 py-1.5 text-xs font-semibold text-[#15181E] transition hover:bg-[#F6F6F4]"
    >
      {children}
    </button>
  )
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T
  options: { value: T; label: string }[]
  onChange: (value: T) => void
}) {
  return (
    <div className="inline-flex rounded-full bg-[#F6F6F4] p-1">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          aria-pressed={value === option.value}
          className={`rounded-full px-3 py-1 text-xs font-semibold transition ${
            value === option.value
              ? 'bg-white text-[#15181E] shadow-sm'
              : 'text-[#6C717A] hover:text-[#15181E]'
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

export default function MyAccountDialog({
  open,
  onClose,
  user,
  onUserChanged,
  onPasswordChanged,
  onDeleted,
  notify,
}: {
  open: boolean
  onClose: () => void
  user: User
  onUserChanged: (user: User) => void
  onPasswordChanged: () => void
  onDeleted: () => void
  notify: (message: string, tone?: 'success' | 'error' | 'info') => void
}) {
  const [editingName, setEditingName] = useState(false)
  const [nameDraft, setNameDraft] = useState(user.name)
  const [nameBusy, setNameBusy] = useState(false)
  const [passwordOpen, setPasswordOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [timeFormat, setTimeFormat] = useState<'24' | '12'>('24')

  const saveName = async (event: FormEvent) => {
    event.preventDefault()
    const next = nameDraft.trim().replace(/\s+/g, ' ')
    if (!next) {
      notify('Enter a name.', 'error')
      return
    }
    setNameBusy(true)
    try {
      const result = await api.updateName(next)
      onUserChanged(result.user)
      setEditingName(false)
      notify('Name updated.', 'success')
    } catch (error) {
      notify(errorMessage(error), 'error')
    } finally {
      setNameBusy(false)
    }
  }

  // Ignore close requests while a nested confirmation is open.
  const requestClose = () => {
    if (passwordOpen || deleteOpen) return
    onClose()
  }

  return (
    <Modal
      open={open}
      onClose={requestClose}
      title="My Account"
      description="Manage your name, password, and account."
      width="max-w-xl"
    >
      <div className="rounded-[18px] border border-[#E1E2E0] bg-white px-5">
        <div className="divide-y divide-[#E1E2E0]/80">
          {editingName ? (
            <form onSubmit={saveName} className="flex flex-wrap items-center gap-2 py-3">
              <input
                className="field max-w-[15rem] py-1.5 text-sm"
                value={nameDraft}
                onChange={(event) => setNameDraft(event.target.value)}
                autoFocus
                aria-label="Name"
              />
              <button type="submit" disabled={nameBusy} className="btn-primary px-3 py-1.5 text-xs">
                {nameBusy && <Spinner className="h-3.5 w-3.5" />}
                Save
              </button>
              <button
                type="button"
                onClick={() => {
                  setEditingName(false)
                  setNameDraft(user.name)
                }}
                className="btn-ghost px-3 py-1.5 text-xs"
              >
                Cancel
              </button>
            </form>
          ) : (
            <SettingRow
              label={user.name.trim() || user.email.split('@')[0]}
              hint={user.email}
              action={
                <TextButton
                  onClick={() => {
                    setNameDraft(user.name)
                    setEditingName(true)
                  }}
                >
                  <span className="flex items-center gap-1.5">
                    <PencilIcon className="h-3.5 w-3.5" /> Edit
                  </span>
                </TextButton>
              }
            />
          )}
          <SettingRow
            label="Password"
            hint="Last changed 3 months ago"
            action={<TextButton onClick={() => setPasswordOpen(true)}>Change</TextButton>}
          />
          <SettingRow
            label="Time format"
            action={
              <Segmented
                value={timeFormat}
                onChange={setTimeFormat}
                options={[
                  { value: '24', label: '24-hour' },
                  { value: '12', label: '12-hour' },
                ]}
              />
            }
          />
          <SettingRow
            label="Delete my account"
            hint="Removes your tasks, history, and everything the app learned. This can't be undone."
            align="start"
            action={
              <button
                type="button"
                onClick={() => setDeleteOpen(true)}
                className="rounded-lg border border-[#E5B7B1] bg-white px-3 py-1.5 text-xs font-semibold text-[#9A1C12] transition hover:bg-[#FDE3E0]"
              >
                Delete account
              </button>
            }
          />
        </div>
      </div>

      {passwordOpen && (
        <Modal
          open
          onClose={() => setPasswordOpen(false)}
          title="Change password"
          description="Choose a new password for your account."
          width="max-w-md"
        >
          <ChangePassword
            onDone={() => {
              setPasswordOpen(false)
              onPasswordChanged()
            }}
          />
        </Modal>
      )}

      {deleteOpen && (
        <Modal open onClose={() => setDeleteOpen(false)} title="Delete account" width="max-w-md">
          <DeleteAccount
            onDeleted={() => {
              setDeleteOpen(false)
              onDeleted()
            }}
          />
        </Modal>
      )}
    </Modal>
  )
}
