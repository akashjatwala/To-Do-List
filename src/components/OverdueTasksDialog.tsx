import type { Task } from '@/types'
import { StickyBoard } from './StickyBoard'
import { Modal } from './ui'

interface OverdueTasksDialogProps {
  open: boolean
  /** Overdue tasks in the current personal or team scope. */
  tasks: Task[]
  currentUserId: number
  showOwner: boolean
  canDelete: (task: Task) => boolean
  onClose: () => void
  onOpenTask: (task: Task) => void
  onToggleTask: (task: Task) => void
  onDeleteTask: (task: Task) => void
  onRemind: (task: Task) => void
}

/**
 * The "View all overdue tasks" destination from the Overdue card. It reuses
 * the main sticky notes so the shape and colours stay identical, but hides the
 * grip: these notes span every past date in the current scope, so ordering
 * belongs to the dated board rather than this overview.
 */
export default function OverdueTasksDialog({
  open,
  tasks,
  currentUserId,
  showOwner,
  canDelete,
  onClose,
  onOpenTask,
  onToggleTask,
  onDeleteTask,
  onRemind,
}: OverdueTasksDialogProps) {
  const overdue = tasks.filter((task) => !task.done)

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="All overdue tasks"
      width="max-w-6xl"
    >
      <StickyBoard
        tasks={overdue}
        emptyTitle="No overdue tasks"
        emptyText="Nothing is past its due date. Nice work."
        currentUserId={currentUserId}
        showOwner={showOwner}
        canDelete={canDelete}
        onOpen={onOpenTask}
        onToggle={onToggleTask}
        onDelete={onDeleteTask}
        onRemind={onRemind}
        onReorder={() => undefined}
        allowReorder={false}
      />
    </Modal>
  )
}
