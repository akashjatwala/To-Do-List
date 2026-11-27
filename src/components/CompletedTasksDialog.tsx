import type { Task } from '@/types'
import { StickyBoard } from './StickyBoard'
import { Modal } from './ui'

interface CompletedTasksDialogProps {
  open: boolean
  /** Completed tasks in the current personal or team scope for the selected day. */
  tasks: Task[]
  currentUserId: number
  showOwner: boolean
  canDelete: (task: Task) => boolean
  onClose: () => void
  onOpenTask: (task: Task) => void
  onToggleTask: (task: Task) => void
  onDeleteTask: (task: Task) => void
}

/**
 * The "View all completed tasks" destination. It reuses the main sticky notes
 * so finished tasks look exactly like the overdue overview; ordering stays on
 * the dated board, so the grip is hidden here.
 */
export default function CompletedTasksDialog({
  open,
  tasks,
  currentUserId,
  showOwner,
  canDelete,
  onClose,
  onOpenTask,
  onToggleTask,
  onDeleteTask,
}: CompletedTasksDialogProps) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="All completed tasks"
      description="Finished on the selected day."
      width="max-w-6xl"
    >
      <StickyBoard
        tasks={tasks}
        emptyTitle="Nothing completed yet"
        emptyText="Finished tasks for this day will collect here."
        currentUserId={currentUserId}
        showOwner={showOwner}
        canDelete={canDelete}
        onOpen={onOpenTask}
        onToggle={onToggleTask}
        onDelete={onDeleteTask}
        onReorder={() => undefined}
        allowReorder={false}
      />
    </Modal>
  )
}
