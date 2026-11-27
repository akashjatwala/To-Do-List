import type { Task } from '@/types'
import { StickyBoard } from './StickyBoard'
import { Modal } from './ui'

interface RepeatingTasksDialogProps {
  open: boolean
  /** Recurring tasks in the current personal or team scope. */
  tasks: Task[]
  currentUserId: number
  showOwner: boolean
  canDelete: (task: Task) => boolean
  onClose: () => void
  onOpenTask: (task: Task) => void
  onToggleTask: (task: Task) => void
  onDeleteTask: (task: Task) => void
}

/** The "View all repeating tasks" destination, built from the same notes. */
export default function RepeatingTasksDialog({
  open,
  tasks,
  currentUserId,
  showOwner,
  canDelete,
  onClose,
  onOpenTask,
  onToggleTask,
  onDeleteTask,
}: RepeatingTasksDialogProps) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="All repeating tasks"
      description="Every recurring note in this list, whatever day it lands on."
      width="max-w-6xl"
    >
      <StickyBoard
        tasks={tasks}
        emptyTitle="No repeating tasks"
        emptyText="Tasks with a daily, weekly, monthly or custom repeat will collect here."
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
