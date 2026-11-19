import { useEffect, useRef, useState } from 'react'
import { DownloadIcon, XIcon } from './Icons'

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

function isStandalone() {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (window.navigator as Navigator & { standalone?: boolean }).standalone === true
  )
}

function isAppleMobile() {
  const agent = window.navigator.userAgent
  return /iPad|iPhone|iPod/.test(agent) ||
    (agent.includes('Macintosh') && window.navigator.maxTouchPoints > 1)
}

/** Offers native installation where supported, with Share-sheet guidance on iOS. */
export default function InstallButton() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null)
  const [visible, setVisible] = useState(false)
  const [showHelp, setShowHelp] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (isStandalone()) return
    setVisible(isAppleMobile())

    const onPrompt = (event: Event) => {
      event.preventDefault()
      setDeferred(event as BeforeInstallPromptEvent)
      setVisible(true)
      setShowHelp(false)
    }
    const onInstalled = () => {
      setDeferred(null)
      setVisible(false)
      setShowHelp(false)
    }
    window.addEventListener('beforeinstallprompt', onPrompt as EventListener)
    window.addEventListener('appinstalled', onInstalled)
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt as EventListener)
      window.removeEventListener('appinstalled', onInstalled)
    }
  }, [])

  useEffect(() => {
    if (!showHelp) return
    const onPointerDown = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setShowHelp(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [showHelp])

  if (!visible) return null

  const install = async () => {
    if (!deferred) {
      setShowHelp(true)
      return
    }
    await deferred.prompt()
    const choice = await deferred.userChoice
    setDeferred(null)
    if (choice.outcome === 'accepted') setVisible(false)
  }

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => void install()}
        aria-label="Install app"
        title={deferred ? 'Install app' : 'Add this app to your home screen'}
        className="inline-flex items-center gap-1.5 rounded-lg bg-white px-2 py-1.5 text-xs font-semibold text-slate-600 ring-1 ring-slate-200 transition hover:bg-slate-50 hover:text-slate-900 focus-visible:ring-2 focus-visible:ring-indigo-400 sm:px-2.5"
      >
        <DownloadIcon className="h-4 w-4" />
        <span className="hidden sm:inline">Install</span>
      </button>

      {showHelp && (
        <div
          role="status"
          className="animate-in absolute top-full right-0 z-50 mt-2 w-64 rounded-xl border border-slate-200 bg-white p-3 text-left text-xs leading-relaxed text-slate-600 shadow-xl"
        >
          <div className="mb-1 flex items-center justify-between gap-2">
            <p className="font-bold text-slate-800">Add to Home Screen</p>
            <button
              type="button"
              onClick={() => setShowHelp(false)}
              className="rounded p-0.5 text-slate-400 hover:text-slate-700"
              aria-label="Close install help"
            >
              <XIcon className="h-3.5 w-3.5" />
            </button>
          </div>
          Tap the Share button in Safari, then choose <strong>Add to Home Screen</strong>.
        </div>
      )}
    </div>
  )
}
