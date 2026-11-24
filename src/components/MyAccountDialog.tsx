import { useState, type FormEvent, type ReactNode } from 'react'
import { api, errorMessage } from '@/api'
import type { Team, User } from '@/types'
import { Modal, Spinner } from './ui'
import { ChangePassword, DeleteAccount } from './AccountForms'
import { PencilIcon } from './Icons'
import TagManagerDialog from './TagManager'

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
      className={`flex flex-wrap justify-between gap-x-4 gap-y-2 py-3.5 first:pt-1 last:pb-1 ${
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
      className="inline-flex min-w-[5.5rem] items-center justify-center rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-600 transition hover:bg-slate-50"
    >
      {children}
    </button>
  )
}

export default function MyAccountDialog({
  open,
  onClose,
  user,
  teams,
  onUserChanged,
  onPasswordChanged,
  onTagsChanged,
  onDeleted,
  notify,
}: {
  open: boolean
  onClose: () => void
  user: User
  teams: Team[]
  onUserChanged: (user: User) => void
  onPasswordChanged: () => void
  onTagsChanged: () => void | Promise<void>
  onDeleted: () => void
  notify: (message: string, tone?: 'success' | 'error' | 'info') => void
}) {
  const [editingName, setEditingName] = useState(false)
  const [nameDraft, setNameDraft] = useState(user.name)
  const [nameBusy, setNameBusy] = useState(false)
  const [passwordOpen, setPasswordOpen] = useState(false)
  const [tagsOpen, setTagsOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)

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
    if (passwordOpen || tagsOpen || deleteOpen) return
    onClose()
  }

  return (
    <Modal
      open={open}
      onClose={requestClose}
      title="My Account"
      description="Manage your name, password, tags, and account."
      width="max-w-2xl"
    >
      <div className="rounded-[18px] border border-slate-200 bg-white px-6 sm:px-7">
        <div className="divide-y divide-slate-100">
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
            label="Tags"
            hint="Add, rename or delete the tags used by your tasks."
            action={<TextButton onClick={() => setTagsOpen(true)}>Manage</TextButton>}
          />
          <SettingRow
            label="Password"
            hint="Last changed 3 months ago"
            action={<TextButton onClick={() => setPasswordOpen(true)}>Change</TextButton>}
          />
          <SettingRow
            label="Delete my account"
            hint="Removes your tasks and history. Hand over any teams you host first."
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

      {tagsOpen && (
        <TagManagerDialog
          open
          onClose={() => setTagsOpen(false)}
          onChanged={onTagsChanged}
          notify={notify}
        />
      )}

      {deleteOpen && (
        <Modal open onClose={() => setDeleteOpen(false)} title="Delete account" width="max-w-md">
          <DeleteAccount
            teams={teams}
            currentUserId={user.id}
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
