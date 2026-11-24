import { useEffect, useRef, useState } from 'react'
import { LogOutIcon, SettingsIcon } from './Icons'

export default function AccountMenu({
  name,
  email,
  onOpenAccount,
  onLogout,
  defaultOpen = false,
}: {
  name: string
  email: string
  onOpenAccount: () => void
  onLogout: () => void
  /** Used by static rendering tests; the app leaves this closed. */
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const displayName = name.trim() || email.split('@')[0]

  return (
    <div ref={ref} className="relative">
      {open && (
        <div
          role="menu"
          className="animate-in absolute top-full right-0 z-50 mt-2 w-60 overflow-hidden rounded-xl border border-slate-200 bg-white p-1 shadow-xl"
        >
          <div className="mb-1 border-b border-slate-100 px-3 py-2 sm:hidden">
            <p className="truncate text-sm font-semibold text-slate-700">{displayName}</p>
            <p className="truncate text-[11px] text-slate-400">{email}</p>
          </div>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false)
              onOpenAccount()
            }}
            className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm font-medium text-slate-600 transition hover:bg-slate-100 hover:text-slate-900"
          >
            <SettingsIcon className="h-4 w-4" />
            My Account
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false)
              onLogout()
            }}
            className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm font-medium text-rose-600 transition hover:bg-rose-50"
          >
            <LogOutIcon className="h-4 w-4" />
            Sign out
          </button>
        </div>
      )}

      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
        className={`flex items-center gap-3 rounded-full py-1 pl-2 pr-1 text-left transition hover:bg-slate-50 ${
          open ? 'bg-slate-50' : ''
        }`}
      >
        <span className="hidden text-sm font-semibold text-[#454B58] sm:block">{displayName}</span>
        <span className="flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-full bg-[#15181E] text-sm font-bold text-white">
          {displayName.slice(0, 1).toUpperCase()}
        </span>
      </button>
    </div>
  )
}
