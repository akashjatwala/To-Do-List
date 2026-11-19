import { useEffect, useRef, useState } from 'react'
import { Avatar } from './ui'
import { ChevronDownIcon, LogOutIcon, SettingsIcon } from './Icons'

export default function AccountMenu({
  email,
  onOpenSettings,
  onLogout,
}: {
  email: string
  onOpenSettings: () => void
  onLogout: () => void
}) {
  const [open, setOpen] = useState(false)
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

  const name = email.split('@')[0]

  return (
    <div ref={ref} className="relative">
      {open && (
        <div
          role="menu"
          className="animate-in absolute top-full right-0 z-50 mt-2 w-60 overflow-hidden rounded-xl border border-slate-200 bg-white p-1 shadow-xl"
        >
          <div className="mb-1 border-b border-slate-100 px-3 py-2 sm:hidden">
            <p className="truncate text-sm font-semibold text-slate-700">{name}</p>
            <p className="truncate text-[11px] text-slate-400">{email}</p>
          </div>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false)
              onOpenSettings()
            }}
            className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm font-medium text-slate-600 transition hover:bg-slate-100 hover:text-slate-900"
          >
            <SettingsIcon className="h-4 w-4" />
            Settings
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
        className={`flex max-w-[13rem] items-center gap-2.5 rounded-xl px-1.5 py-1.5 text-left transition hover:bg-slate-100 ${
          open ? 'bg-slate-100' : ''
        }`}
      >
        <Avatar email={email} size="sm" />
        <div className="hidden min-w-0 flex-1 sm:block">
          <p className="truncate text-xs font-semibold text-slate-700">{name}</p>
          <p className="truncate text-[11px] text-slate-400">{email}</p>
        </div>
        <ChevronDownIcon
          className={`hidden h-4 w-4 shrink-0 text-slate-400 transition-transform sm:block ${
            open ? 'rotate-180' : ''
          }`}
        />
      </button>
    </div>
  )
}
