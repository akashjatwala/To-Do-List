import { useCallback, useEffect, useRef, useState } from 'react'
import type { BootstrapData, Team, View } from '@/types'
import { todayDateValue } from '@/lib/date'

export function useViewNavigation(data: BootstrapData | null, setTaskDialogOpen: (open: boolean) => void) {
  const [view, setView] = useState<View>({ kind: 'my' })
  const [selectedDate, setSelectedDate] = useState(() => todayDateValue())
  const lastTeamId = useRef<string | null>(null)

  // Keep the current view valid if teams change (including the very first team).
  useEffect(() => {
    if (!data || view.kind !== 'collab') return
    if (view.teamId && data.teams.some((team) => team.id === view.teamId)) {
      lastTeamId.current = view.teamId
      return
    }
    const fallback = data.teams[0]?.id ?? null
    lastTeamId.current = fallback
    if (fallback !== view.teamId) setView({ kind: 'collab', teamId: fallback })
  }, [data, view])

  // A different date or team means the dialog's defaults are no longer valid.
  useEffect(() => {
    setTaskDialogOpen(false)
  }, [view, selectedDate, setTaskDialogOpen])

  const currentTeam: Team | undefined =
    view.kind === 'collab' && view.teamId
      ? data?.teams.find((team) => team.id === view.teamId)
      : undefined

  const resetDateView = useCallback(() => {
    setSelectedDate(todayDateValue())
  }, [])

  const openMyTasks = useCallback(() => {
    setView({ kind: 'my' })
    resetDateView()
  }, [resetDateView])

  const openCollaborate = useCallback(() => {
    const remembered =
      lastTeamId.current && data?.teams.some((team) => team.id === lastTeamId.current)
        ? lastTeamId.current
        : (data?.teams[0]?.id ?? null)
    setView({ kind: 'collab', teamId: remembered })
    resetDateView()
  }, [data, resetDateView])

  const openTeam = useCallback(
    (teamId: string) => {
      setView({ kind: 'collab', teamId })
      resetDateView()
    },
    [resetDateView],
  )

  const resetViewState = useCallback(() => {
    setView({ kind: 'my' })
    setSelectedDate(todayDateValue())
  }, [])

  return {
    view,
    setView,
    selectedDate,
    setSelectedDate,
    currentTeam,
    isToday: selectedDate === todayDateValue(),
    resetDateView,
    openMyTasks,
    openCollaborate,
    openTeam,
    resetViewState,
  }
}
