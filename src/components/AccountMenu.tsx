import { useEffect, useRef, useState } from 'react'
import { Avatar } from './ui'
import { ChevronDownIcon, LogOutIcon, MoonIcon, SettingsIcon, SunIcon } from './Icons'

export default function AccountMenu({
  email,
  dark,
  onToggleTheme,
  onOpenSettings,
  onLogout,
}: {
  email: string
  dark: boolean
  onToggleTheme: () => void
  onOpenSettings: () => void
  onLogout: () => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const name = email.split('@')[0]

  return (
    <div ref={ref} className="relative">
      {open && (
        <div
          role="menu"
          className="animate-in absolute top-full right-0 z-50 mt-2 w-60 overflow-hidden rounded-xl border border-slate-200 bg-white p-1 shadow-xl dark:border-slate-700 dark:bg-slate-900"
        >
          <div className="mb-1 border-b border-slate-100 px-3 py-2 sm:hidden dark:border-slate-800">
            <p className="truncate text-sm font-semibold text-slate-700 dark:text-slate-200">{name}</p>
            <p className="truncate text-[11px] text-slate-400 dark:text-slate-500">{email}</p>
          </div>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false)
              onToggleTheme()
            }}
            className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm font-medium text-slate-600 transition hover:bg-slate-100 hover:text-slate-900 sm:hidden dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-white"
          >
            {dark ? <SunIcon className="h-4 w-4" /> : <MoonIcon className="h-4 w-4" />}
            {dark ? 'Light mode' : 'Dark mode'}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false)
              onOpenSettings()
            }}
            className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm font-medium text-slate-600 transition hover:bg-slate-100 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-white"
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
            className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm font-medium text-rose-600 transition hover:bg-rose-50 dark:text-rose-400 dark:hover:bg-rose-500/10"
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
        className={`flex max-w-[13rem] items-center gap-2.5 rounded-xl px-1.5 py-1.5 text-left transition hover:bg-slate-100 dark:hover:bg-slate-800 ${
          open ? 'bg-slate-100 dark:bg-slate-800' : ''
        }`}
      >
        <Avatar email={email} size="sm" />
        <div className="hidden min-w-0 flex-1 sm:block">
          <p className="truncate text-xs font-semibold text-slate-700 dark:text-slate-200">{name}</p>
          <p className="truncate text-[11px] text-slate-400 dark:text-slate-500">{email}</p>
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
