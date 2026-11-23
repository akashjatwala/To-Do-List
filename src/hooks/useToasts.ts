import { useCallback, useRef, useState } from 'react'
import type { Toast, ToastTone } from '@/types'

/** Owns the toast queue and keeps `notify` stable for child effects. */
export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([])
  const toastId = useRef(0)

  const notify = useCallback((message: string, tone: ToastTone = 'info') => {
    const id = (toastId.current += 1)
    setToasts((current) => [...current, { id, message, tone }])
    window.setTimeout(() => {
      setToasts((current) => current.filter((toast) => toast.id !== id))
    }, 4200)
  }, [])

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id))
  }, [])

  return { toasts, notify, dismiss }
}
