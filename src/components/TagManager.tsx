import { useCallback, useEffect, useState } from 'react'
import { api, errorMessage } from '@/api'
import type { UserTag } from '@/types'
import { ConfirmDialog, Modal, Spinner } from './ui'

const TAG_NAME_MAX = 24

const smallButton =
  'inline-flex min-w-[5.5rem] items-center justify-center rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-[11px] font-semibold text-slate-600 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50'

/** Tag names have one canonical form everywhere in the app. */
const canonicalName = (value: string) => value.trim().replace(/\s+/g, ' ').toLowerCase()

interface TagManagerDialogProps {
  open: boolean
  onClose: () => void
  onChanged: () => void | Promise<void>
  notify: (message: string, tone?: 'success' | 'error' | 'info') => void
  /** Optional preloaded tags, useful for tests and future cache warmups. */
  initialTags?: UserTag[]
}

/** My Account tool for adding, renaming and deleting the user's local tags. */
export default function TagManagerDialog({
  open,
  onClose,
  onChanged,
  notify,
  initialTags,
}: TagManagerDialogProps) {
  const [tags, setTags] = useState<UserTag[] | null>(initialTags ?? null)
  const [loading, setLoading] = useState(initialTags === undefined)
  const [error, setError] = useState('')
  const [adding, setAdding] = useState(false)
  const [newTagDraft, setNewTagDraft] = useState('')
  const [editingId, setEditingId] = useState<number | null>(null)
  const [draft, setDraft] = useState('')
  const [deleteId, setDeleteId] = useState<number | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const result = await api.listTags()
      setTags(result.items)
    } catch (cause) {
      setTags([])
      setError(errorMessage(cause))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!open) return
    if (initialTags) {
      setTags(initialTags)
      setLoading(false)
      return
    }
    void load()
  }, [open, initialTags, load])

  useEffect(() => {
    if (open) return
    setAdding(false)
    setNewTagDraft('')
    setEditingId(null)
    setDeleteId(null)
    setConfirmOpen(false)
  }, [open])

  const requestClose = () => {
    if (busy || confirmOpen) return
    onClose()
  }

  const validName = (value: string): string | null => {
    const next = canonicalName(value)
    if (!next || next.length > TAG_NAME_MAX) {
      notify(`Tag names must be 1–${TAG_NAME_MAX} characters.`, 'error')
      return null
    }
    return next
  }

  const applyChange = async (message: string) => {
    await load()
    await onChanged()
    notify(message, 'success')
  }

  const addTag = async () => {
    const next = validName(newTagDraft)
    if (!next) return
    setBusy(true)
    try {
      await api.createTag(next)
      setAdding(false)
      setNewTagDraft('')
      await applyChange('Tag added.')
    } catch (cause) {
      notify(errorMessage(cause), 'error')
    } finally {
      setBusy(false)
    }
  }

  const saveRename = async (tag: UserTag) => {
    const next = validName(draft)
    if (!next) return
    setBusy(true)
    try {
      await api.renameTag(tag.id, next)
      setEditingId(null)
      await applyChange('Tag renamed.')
    } catch (cause) {
      notify(errorMessage(cause), 'error')
    } finally {
      setBusy(false)
    }
  }

  const deleteTarget = tags?.find((tag) => tag.id === deleteId) ?? null

  const doDelete = async () => {
    if (!deleteTarget) return
    setBusy(true)
    setConfirmOpen(false)
    try {
      await api.deleteTag(deleteTarget.id)
      setDeleteId(null)
      await applyChange('Tag deleted. It was removed from every task.')
    } catch (cause) {
      notify(errorMessage(cause), 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={requestClose}
      title="Tag manager"
      width="max-w-2xl"
    >
      {loading ? (
        <div className="flex items-center justify-center gap-2 py-8 text-xs text-slate-500">
          <Spinner className="h-4 w-4 text-indigo-500" />
          Loading tags…
        </div>
      ) : error ? (
        <p className="rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-xs text-rose-600">
          {error}
        </p>
      ) : (
        <>
          <div className="mb-3 flex justify-end gap-2">
            {!adding && (
              <button type="button" onClick={() => setAdding(true)} className={smallButton}>
                + Add tag
              </button>
            )}
          </div>

          {adding && (
            <div className="mb-3 flex flex-wrap items-center gap-2 rounded-xl bg-slate-50 p-2">
              <input
                className="field max-w-[14rem] py-1.5 text-sm lowercase"
                value={newTagDraft}
                onChange={(event) => setNewTagDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void addTag()
                  if (event.key === 'Escape') {
                    setAdding(false)
                    setNewTagDraft('')
                  }
                }}
                placeholder="new tag"
                aria-label="New tag name"
                maxLength={TAG_NAME_MAX}
                autoFocus
              />
              <button type="button" disabled={busy} onClick={() => void addTag()} className={smallButton}>
                Add
              </button>
              <button
                type="button"
                onClick={() => {
                  setAdding(false)
                  setNewTagDraft('')
                }}
                className={smallButton}
              >
                Cancel
              </button>
            </div>
          )}

          {!tags || tags.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-slate-200 bg-white px-6 py-8 text-center sm:px-7">
              <p className="text-sm font-semibold text-slate-700">No tags yet</p>
              <p className="mt-1 text-xs text-slate-500">Add one above, or tags appear once used on a task.</p>
            </div>
          ) : (
            <div className="divide-y divide-slate-100 rounded-[18px] border border-slate-200 bg-white px-6 sm:px-7">
              {tags.map((tag) => (
                <div key={tag.id} className="py-3.5 first:pt-1 last:pb-1">
                  {editingId === tag.id ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <input
                        className="field max-w-[14rem] py-1.5 text-sm lowercase"
                        value={draft}
                        onChange={(event) => setDraft(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') void saveRename(tag)
                          if (event.key === 'Escape') setEditingId(null)
                        }}
                        aria-label={`Rename ${tag.name}`}
                        maxLength={TAG_NAME_MAX}
                        autoFocus
                      />
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void saveRename(tag)}
                        className={smallButton}
                      >
                        Save
                      </button>
                      <button type="button" onClick={() => setEditingId(null)} className={smallButton}>
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="truncate text-sm font-semibold text-slate-700">#{tag.name}</p>
                      <div className="flex shrink-0 gap-1.5">
                        <button
                          type="button"
                          onClick={() => {
                            setDraft(tag.name)
                            setEditingId(tag.id)
                          }}
                          className={smallButton}
                        >
                          Rename
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setDeleteId(tag.id)
                            setConfirmOpen(true)
                          }}
                          className={smallButton}
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      )}

      <ConfirmDialog
        open={confirmOpen}
        title="Delete tag?"
        description={
          deleteTarget
            ? `“${deleteTarget.name}” will be removed from every task. Past history stays linked to its id.`
            : undefined
        }
        confirmLabel="Delete"
        onClose={() => setConfirmOpen(false)}
        onConfirm={() => void doDelete()}
      />
    </Modal>
  )
}
