import type { Toast, ToastTone } from '@/types'
import { CheckIcon, XIcon } from './Icons'

const TOAST_STYLES: Record<ToastTone, string> = {
  success: 'border-emerald-200 bg-emerald-50 text-emerald-800',
  error: 'border-rose-200 bg-rose-50 text-rose-800',
  info: 'border-slate-200 bg-white text-slate-700',
}

interface ToastViewportProps {
  toasts: Toast[]
  onDismiss: (id: number) => void
}

export default function ToastViewport({ toasts, onDismiss }: ToastViewportProps) {
  return (
    <div className="pointer-events-none fixed right-4 bottom-4 z-[60] flex w-[min(22rem,calc(100vw-2rem))] flex-col gap-2">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          role="status"
          className={`animate-in pointer-events-auto flex items-start gap-2.5 rounded-xl border px-3.5 py-2.5 text-sm shadow-lg backdrop-blur ${TOAST_STYLES[toast.tone]}`}
        >
          <span className="mt-0.5 shrink-0">
            {toast.tone === 'success' ? (
              <CheckIcon className="h-4 w-4" />
            ) : toast.tone === 'error' ? (
              <XIcon className="h-4 w-4" />
            ) : (
              <span className="block h-4 w-4 rounded-full border-2 border-current opacity-60" />
            )}
          </span>
          <span className="flex-1 leading-snug">{toast.message}</span>
          <button
            type="button"
            onClick={() => onDismiss(toast.id)}
            className="mt-0.5 rounded p-0.5 opacity-50 transition hover:opacity-100"
            aria-label="Dismiss"
          >
            <XIcon className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
    </div>
  )
}
