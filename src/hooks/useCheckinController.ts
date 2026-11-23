import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '@/api'
import type { CheckinStatus, DailyState } from '@/types'
import { localDateString } from '@/lib/checkin'
import { todayDateValue } from '@/lib/date'

interface UseCheckinControllerArgs {
  currentUserId: number | null
  selectedDate: string
  viewKind: 'my' | 'collab'
  notify: (message: string, tone?: 'success' | 'error' | 'info') => void
}

export function useCheckinController({
  currentUserId,
  selectedDate,
  viewKind,
  notify,
}: UseCheckinControllerArgs) {
  const [checkinStatus, setCheckinStatus] = useState<CheckinStatus | null>(null)
  const [checkinOpen, setCheckinOpen] = useState(false)
  const [checkinMode, setCheckinMode] = useState<'prompt' | 'edit'>('prompt')
  const [checkinCelebrate, setCheckinCelebrate] = useState(false)
  const [dailyStateData, setDailyStateData] = useState<DailyState | null>(null)
  const checkinCheckedFor = useRef<number | null>(null)

  const resetCheckinState = useCallback(() => {
    checkinCheckedFor.current = null
    setCheckinStatus(null)
    setCheckinOpen(false)
    setCheckinCelebrate(false)
    setDailyStateData(null)
  }, [])

  // Show the check-in first after login, or when the app opens on a new local
  // day, but only while today's check-in is neither completed nor skipped.
  // Runs once per signed-in user per app session.
  useEffect(() => {
    if (currentUserId === null) return
    if (checkinCheckedFor.current === currentUserId) return
    checkinCheckedFor.current = currentUserId
    let cancelled = false
    api
      .getCheckin(localDateString())
      .then((status) => {
        if (cancelled) return
        setCheckinStatus(status)
        if (status.state === 'not_asked' || status.state === 'partial') {
          setCheckinMode('prompt')
          setCheckinOpen(true)
        }
      })
      .catch(() => {
        /* never block the app because the check-in lookup failed */
      })
    return () => {
      cancelled = true
    }
  }, [currentUserId])

  // Load the read-only daily state for today (personal view only). It reloads
  // whenever the check-in changes, so a mid-day edit updates the summary.
  useEffect(() => {
    if (currentUserId === null || viewKind !== 'my' || selectedDate !== todayDateValue()) {
      setDailyStateData(null)
      return
    }
    let cancelled = false
    api
      .getState(selectedDate, todayDateValue())
      .then((next) => {
        if (!cancelled) setDailyStateData(next)
      })
      .catch(() => {
        if (!cancelled) setDailyStateData(null)
      })
    return () => {
      cancelled = true
    }
  }, [currentUserId, selectedDate, viewKind, checkinStatus?.checkin?.updatedAt, checkinStatus?.state])

  const refreshDailyState = useCallback(async () => {
    if (currentUserId === null || viewKind !== 'my' || selectedDate !== todayDateValue()) return
    try {
      const next = await api.getState(selectedDate, todayDateValue())
      setDailyStateData(next)
    } catch {
      /* keep the current card state; suggestion/check-in flows surface their own errors */
    }
  }, [currentUserId, selectedDate, viewKind])

  const openCheckin = useCallback(async () => {
    const date = localDateString()
    try {
      const status = await api.getCheckin(date)
      setCheckinStatus(status)
    } catch {
      notify('Could not load the check-in.', 'error')
    }
    setCheckinMode('edit')
    setCheckinOpen(true)
  }, [notify])

  return {
    checkinStatus,
    setCheckinStatus,
    checkinOpen,
    setCheckinOpen,
    checkinMode,
    checkinCelebrate,
    setCheckinCelebrate,
    dailyStateData,
    refreshDailyState,
    openCheckin,
    resetCheckinState,
  }
}
