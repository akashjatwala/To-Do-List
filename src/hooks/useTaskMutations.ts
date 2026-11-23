import { useCallback } from 'react'
import { api, errorMessage } from '@/api'
import type {
  BootstrapData,
  Comment,
  Priority,
  Recurrence,
  RecurrenceConfig,
  Subtask,
  Task,
  ToastTone,
  UserInvite,
  View,
} from '@/types'
import { dueFromDateInput } from '@/lib/date'
import type { NewTaskInput } from '@/components/NewTaskDialog'

interface UseTaskMutationsArgs {
  refresh: () => Promise<void>
  notify: (message: string, tone?: ToastTone) => void
  todayValue: string
  setData: (value: BootstrapData | null | ((current: BootstrapData | null) => BootstrapData | null)) => void
  setSelectedId: (value: string | null | ((current: string | null) => string | null)) => void
  setView: (value: View | ((current: View) => View)) => void
}

export function useTaskMutations({
  refresh,
  notify,
  todayValue,
  setData,
  setSelectedId,
  setView,
}: UseTaskMutationsArgs) {
  const addTask = useCallback(
    async (input: NewTaskInput) => {
      try {
        await api.createTask({
          text: input.text,
          teamId: input.teamId,
          due: input.due,
          priority: input.priority,
          tags: input.tags,
          recurrence: input.recurrence,
          recurrenceConfig: input.recurrenceConfig,
          duration: input.duration,
          preferredTime: input.preferredTime,
        })
        await refresh()
        return true
      } catch (error) {
        notify(errorMessage(error), 'error')
        return false
      }
    },
    [notify, refresh],
  )

  const toggleTask = useCallback(
    async (task: Task) => {
      const wasRecurring = !task.done && task.recurrence !== 'none'
      setData((current) =>
        current
          ? {
              ...current,
              tasks: current.tasks.map((item) =>
                item.id === task.id
                  ? {
                      ...item,
                      done: !item.done,
                      // Mirror the API: completing sets 100%, and un-completing a
                      // fully finished task clears progress back to 0%.
                      progress: !item.done ? 100 : item.progress === 100 ? 0 : item.progress,
                    }
                  : item,
              ),
            }
          : current,
      )
      try {
        await api.updateTask(task.id, { done: !task.done })
        if (wasRecurring) {
          // Completing a recurring task spawns its next occurrence server-side.
          await refresh()
          notify('Done — the next occurrence was added.', 'success')
        }
      } catch (error) {
        notify(errorMessage(error), 'error')
        await refresh().catch(() => undefined)
      }
    },
    [notify, refresh, setData],
  )

  const deleteTask = useCallback(
    async (task: Task) => {
      try {
        await api.deleteTask(task.id)
        setSelectedId((current) => (current === task.id ? null : current))
        await refresh()
        notify('Task deleted.', 'info')
      } catch (error) {
        notify(errorMessage(error), 'error')
      }
    },
    [notify, refresh, setSelectedId],
  )

  const reorderTasks = useCallback(
    async (orderedIds: string[]) => {
      try {
        await api.reorderTasks(orderedIds)
        await refresh()
      } catch (error) {
        notify(errorMessage(error), 'error')
        await refresh().catch(() => undefined)
      }
    },
    [notify, refresh],
  )

  const updateTask = useCallback(
    async (
      task: Task,
      patch: {
        text?: string
        done?: boolean
        due?: number | null
        progress?: number
        priority?: Priority
        tags?: string[]
        recurrence?: Recurrence
        recurrenceConfig?: RecurrenceConfig | null
        duration?: number | null
        preferredTime?: string | null
      },
    ) => {
      try {
        await api.updateTask(task.id, patch)
        await refresh()
        return true
      } catch (error) {
        notify(errorMessage(error), 'error')
        return false
      }
    },
    [notify, refresh],
  )

  const moveOverdueToToday = useCallback(
    async (task: Task) => {
      const moved = await updateTask(task, { due: dueFromDateInput(todayValue) })
      if (moved) notify(`Moved “${task.text}” to today.`, 'success')
    },
    [notify, todayValue, updateTask],
  )

  const setAssignees = useCallback(
    async (task: Task, userIds: number[]) => {
      try {
        await api.setTaskAssignees(task.id, userIds)
        await refresh()
        return true
      } catch (error) {
        notify(errorMessage(error), 'error')
        return false
      }
    },
    [notify, refresh],
  )

  const addSubtask = useCallback(
    async (task: Task, text: string, assigneeId: number | null) => {
      try {
        await api.addSubtask(task.id, text, assigneeId)
        await refresh()
        return true
      } catch (error) {
        notify(errorMessage(error), 'error')
        return false
      }
    },
    [notify, refresh],
  )

  const assignSubtask = useCallback(
    async (task: Task, subtask: Subtask, assigneeId: number | null) => {
      try {
        await api.updateSubtask(task.id, subtask.id, { assigneeId })
        await refresh()
        return true
      } catch (error) {
        notify(errorMessage(error), 'error')
        return false
      }
    },
    [notify, refresh],
  )

  const toggleSubtask = useCallback(
    async (task: Task, subtask: Subtask) => {
      try {
        await api.updateSubtask(task.id, subtask.id, { done: !subtask.done })
        await refresh()
      } catch (error) {
        notify(errorMessage(error), 'error')
      }
    },
    [notify, refresh],
  )

  const deleteSubtask = useCallback(
    async (task: Task, subtask: Subtask) => {
      try {
        await api.deleteSubtask(task.id, subtask.id)
        await refresh()
      } catch (error) {
        notify(errorMessage(error), 'error')
      }
    },
    [notify, refresh],
  )

  const addComment = useCallback(
    async (task: Task, text: string) => {
      try {
        await api.addComment(task.id, text)
        await refresh()
        return true
      } catch (error) {
        notify(errorMessage(error), 'error')
        return false
      }
    },
    [notify, refresh],
  )

  const deleteComment = useCallback(
    async (task: Task, comment: Comment) => {
      try {
        await api.deleteComment(task.id, comment.id)
        await refresh()
      } catch (error) {
        notify(errorMessage(error), 'error')
      }
    },
    [notify, refresh],
  )

  const acceptInvite = useCallback(
    async (invite: UserInvite) => {
      try {
        await api.acceptInvite(invite.teamId)
        await refresh()
        setView({ kind: 'collab', teamId: invite.teamId })
        notify(`You joined ${invite.teamName}.`, 'success')
      } catch (error) {
        notify(errorMessage(error), 'error')
      }
    },
    [notify, refresh, setView],
  )

  const declineInvite = useCallback(
    async (invite: UserInvite) => {
      try {
        await api.declineInvite(invite.teamId)
        await refresh()
        notify('Invitation declined.', 'info')
      } catch (error) {
        notify(errorMessage(error), 'error')
      }
    },
    [notify, refresh],
  )

  return {
    addTask,
    toggleTask,
    deleteTask,
    reorderTasks,
    updateTask,
    moveOverdueToToday,
    setAssignees,
    addSubtask,
    assignSubtask,
    toggleSubtask,
    deleteSubtask,
    addComment,
    deleteComment,
    acceptInvite,
    declineInvite,
  }
}
