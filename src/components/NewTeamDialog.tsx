import { useState, type FormEvent, type KeyboardEvent } from 'react'
import { api, errorMessage } from '@/api'
import { DEFAULT_TEAM_COLOR, TEAM_COLORS, type TeamColor } from '@/lib/team'
import { CheckIcon, MailIcon, UsersIcon, UserPlusIcon, XIcon } from './Icons'
import { Modal, Spinner } from './ui'

interface NewTeamDialogProps {
  onClose: () => void
  onChanged: () => Promise<void>
  notify: (message: string, tone?: 'success' | 'error' | 'info') => void
}

const FIELD_LABEL = 'label normal-case tracking-normal'
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export default function NewTeamDialog({ onClose, onChanged, notify }: NewTeamDialogProps) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [color, setColor] = useState<TeamColor>(DEFAULT_TEAM_COLOR)
  const [emailDraft, setEmailDraft] = useState('')
  const [emails, setEmails] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [emailError, setEmailError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const addEmail = () => {
    const value = emailDraft.trim().toLowerCase()
    if (!value) return
    if (!EMAIL_PATTERN.test(value)) {
      setEmailError('Enter a valid email address.')
      return
    }
    if (emails.some((email) => email.toLowerCase() === value)) {
      setEmailError('That person is already invited.')
      return
    }
    setEmails((current) => [...current, value])
    setEmailDraft('')
    setEmailError(null)
  }

  const onEmailKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault()
      addEmail()
      return
    }
    if (event.key === 'Backspace' && !emailDraft && emails.length > 0) {
      setEmails((current) => current.slice(0, -1))
    }
  }

  const removeEmail = (email: string) => {
    setEmails((current) => current.filter((item) => item !== email))
    setEmailError(null)
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const value = name.trim()
    if (!value) {
      setError('Give your team a name.')
      return
    }

    // Add a pending address if the person forgot to press Enter or Invite.
    const pending = emailDraft.trim().toLowerCase()
    const inviteList =
      pending && EMAIL_PATTERN.test(pending) && !emails.includes(pending)
        ? [...emails, pending]
        : emails

    setBusy(true)
    setError(null)
    try {
      const { team } = await api.createTeam(value)
      const failed: string[] = []
      for (const email of inviteList) {
        try {
          await api.invite(team.id, email)
        } catch {
          failed.push(email)
        }
      }
      await onChanged()
      if (failed.length) {
        notify(`Team created, but the invite to ${failed.join(', ')} failed.`, 'error')
      } else if (inviteList.length) {
        notify(`“${value}” is ready — ${inviteList.length} invite${inviteList.length === 1 ? '' : 's'} sent.`, 'success')
      } else {
        notify(`“${value}” is ready — invite your teammates.`, 'success')
      }
      onClose()
    } catch (err) {
      setError(errorMessage(err))
      setBusy(false)
    }
  }

  const previewName = name.trim() || 'Team name'
  const previewDescription = description.trim() || 'What is it for?'
  const previewInitial = previewName.charAt(0).toUpperCase()
  const invitedLabel = `${emails.length} invited`

  return (
    <Modal open onClose={onClose} title="New team" width="max-w-5xl">
      <form onSubmit={submit}>
        <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_19rem]">
          <div className="min-w-0 space-y-5">
            {error && (
              <p className="rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-sm text-rose-700">
                {error}
              </p>
            )}

            <section>
              <label className={FIELD_LABEL} htmlFor="new-team-name">
                Team name
              </label>
              <input
                id="new-team-name"
                className="field text-base"
                value={name}
                onChange={(event) => {
                  setName(event.target.value)
                  setError(null)
                }}
                placeholder="e.g. Study group"
                maxLength={60}
                autoFocus
                required
              />
            </section>

            <section>
              <label className={FIELD_LABEL} htmlFor="new-team-purpose">
                What is it for? <span className="font-normal text-slate-400">(optional)</span>
              </label>
              <textarea
                id="new-team-purpose"
                className="field min-h-[5.5rem] resize-none text-sm"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="Shared reading list and weekly goals."
                maxLength={160}
              />
            </section>

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
                      className={`inline-flex h-8 w-8 items-center justify-center rounded-full transition focus-visible:ring-4 focus-visible:ring-[#D9480F]/20 focus-visible:outline-none ${
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

            <section>
              <p className={FIELD_LABEL}>Invite people</p>
              <div className="mt-2 flex gap-2">
                <div className="relative min-w-0 flex-1">
                  <MailIcon className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-slate-400" />
                  <input
                    type="email"
                    className="field pl-9"
                    value={emailDraft}
                    onChange={(event) => {
                      setEmailDraft(event.target.value)
                      setEmailError(null)
                    }}
                    onKeyDown={onEmailKeyDown}
                    placeholder="name@example.com"
                    aria-label="Invite by email"
                  />
                </div>
                <button
                  type="button"
                  className="btn-primary shrink-0"
                  onClick={addEmail}
                  disabled={busy || !emailDraft.trim()}
                >
                  <UserPlusIcon className="h-4 w-4" />
                  Invite
                </button>
              </div>
              {emailError && <p className="mt-2 text-xs font-medium text-rose-600">{emailError}</p>}

              {emails.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-2" aria-label="People to invite">
                  {emails.map((email) => (
                    <span
                      key={email}
                      className="inline-flex items-center gap-1 rounded-md bg-slate-100 py-1 pr-1 pl-2 text-[11px] font-medium text-slate-600"
                    >
                      {email}
                      <button
                        type="button"
                        onClick={() => removeEmail(email)}
                        className="rounded p-0.5 opacity-60 transition hover:bg-slate-200 hover:opacity-100"
                        aria-label={`Remove ${email}`}
                      >
                        <XIcon className="h-3 w-3" />
                      </button>
                    </span>
                  ))}
                </div>
              )}

              <p className="mt-3 text-[11px] leading-relaxed text-slate-500">
                They get an invitation in the app and join once they accept. You will be the host.
                Members can add and complete tasks. Only the host or the person who created a task
                can delete it.
              </p>
              <p className="mt-2 text-[11px] leading-relaxed text-slate-400">
                You can invite people later from the Members panel.
              </p>
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
                  1 member
                </span>
                <span className="rounded-full bg-white/65 px-2 py-1 ring-1 ring-black/5">
                  {invitedLabel}
                </span>
                <span className="rounded-full bg-white/65 px-2 py-1 ring-1 ring-black/5">
                  0 open tasks
                </span>
              </div>

              <p className="mt-5 border-t border-black/5 pt-4 text-[11px] leading-relaxed opacity-80">
                The team color tints its panels, so you can tell your teams apart at a glance.
              </p>
            </div>
            <p className="mt-3 flex items-start gap-1.5 text-[11px] leading-snug text-slate-400">
              <UsersIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              You will be the host. Members can add and complete tasks.
            </p>
          </aside>
        </div>

        <div className="mt-6 flex flex-wrap items-center justify-end gap-2 border-t border-slate-100 pt-4">
          <button type="button" className="btn-ghost" onClick={onClose} disabled={busy}>
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
