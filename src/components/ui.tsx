import { useEffect, useState, type ReactNode } from 'react'
import { initials, avatarColor } from '@/lib/date'
import { XIcon } from './Icons'

/**
 * Locks page scrolling while one or more dialogs are open.
 *
 * A plain "save and restore" lock breaks when dialogs overlap: if a confirm
 * dialog and its parent unmount in the same commit, the parent can restore the
 * unlocked value before the confirm restores its locked value, leaving the
 * body permanently locked. Counting locks makes restoration order-independent.
 */
let bodyLockCount = 0
let bodyOverflowBeforeLock = ''

export function useBodyScrollLock(active: boolean) {
  useEffect(() => {
    if (!active) return
    if (bodyLockCount === 0) {
      bodyOverflowBeforeLock = document.body.style.overflow
      document.body.style.overflow = 'hidden'
    }
    bodyLockCount += 1

    return () => {
      bodyLockCount = Math.max(0, bodyLockCount - 1)
      if (bodyLockCount === 0) {
        document.body.style.overflow = bodyOverflowBeforeLock
      }
    }
  }, [active])
}

export function Avatar({
  email,
  size = 'md',
  className = '',
}: {
  email: string
  size?: 'sm' | 'md'
  className?: string
}) {
  const sizes = size === 'sm' ? 'h-7 w-7 text-[10px]' : 'h-9 w-9 text-xs'
  return (
    <span
      title={email}
      className={`inline-flex shrink-0 items-center justify-center rounded-full font-bold text-white ring-2 ring-white/60 ${avatarColor(email)} ${sizes} ${className}`}
    >
      {initials(email)}
    </span>
  )
}

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  width = 'max-w-lg',
}: {
  open: boolean
  onClose: () => void
  title: string
  description?: string
  children: ReactNode
  width?: string
}) {
  useBodyScrollLock(open)

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center p-0 sm:items-center sm:p-6">
      <div
        className="animate-fade absolute inset-0 bg-slate-950/50 backdrop-blur-sm"
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`animate-in relative w-full ${width} max-h-[90dvh] overflow-y-auto rounded-t-2xl border border-slate-200 bg-white p-6 shadow-2xl sm:rounded-2xl`}
        style={{ paddingBottom: 'calc(1.5rem + env(safe-area-inset-bottom))' }}
      >
        <div className="mb-5 flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-bold tracking-tight">{title}</h2>
            {description && (
              <p className="mt-1 text-sm text-slate-500">{description}</p>
            )}
          </div>
          <button type="button" onClick={onClose} className="icon-btn -mr-1" aria-label="Close">
            <XIcon className="h-5 w-5" />
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}

export interface ConfirmOptions {
  title: string
  description?: string
  confirmLabel?: string
  hint?: string
}

/** An in-app replacement for window.confirm, using the same modal shell as
 * the rest of the app so destructive actions stay visually consistent. */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = 'Delete',
  hint,
  onConfirm,
  onClose,
}: ConfirmOptions & {
  open: boolean
  onConfirm: () => void
  onClose: () => void
}) {
  return (
    <Modal open={open} onClose={onClose} title={title} description={description} width="max-w-sm">
      {hint && (
        <p className="mb-4 rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-xs font-medium text-rose-600">
          {hint}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <button type="button" className="btn-ghost" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="btn-danger" onClick={onConfirm} autoFocus>
          {confirmLabel}
        </button>
      </div>
    </Modal>
  )
}

/** Returns an async `confirm` function plus the dialog element to render. */
export function useConfirm() {
  const [pending, setPending] = useState<
    (ConfirmOptions & { resolve: (value: boolean) => void }) | null
  >(null)

  const confirm = (options: ConfirmOptions) =>
    new Promise<boolean>((resolve) => setPending({ ...options, resolve }))

  const dialog = (
    <ConfirmDialog
      open={pending !== null}
      title={pending?.title ?? ''}
      description={pending?.description}
      confirmLabel={pending?.confirmLabel}
      hint={pending?.hint}
      onClose={() => {
        pending?.resolve(false)
        setPending(null)
      }}
      onConfirm={() => {
        pending?.resolve(true)
        setPending(null)
      }}
    />
  )

  return { confirm, dialog }
}

export function Spinner({ className = 'h-4 w-4' }: { className?: string }) {
  return (
    <svg className={`animate-spin ${className}`} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" opacity="0.25" />
      <path
        d="M21 12a9 9 0 0 0-9-9"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  )
}
