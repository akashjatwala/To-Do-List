import type { FormEvent } from 'react'
import type { Comment, Task } from '@/types'
import { timeAgo } from '@/lib/date'
import { Avatar, Spinner } from '../ui'
import { MessageIcon, PlusIcon, TrashIcon } from '../Icons'

interface TaskNotesSectionProps {
  task: Task
  currentUserId: number
  canModerate: boolean
  commentText: string
  setCommentText: (value: string) => void
  commentBusy: boolean
  submitComment: (event: FormEvent) => Promise<void>
  onDeleteComment: (comment: Comment) => void
}

export default function TaskNotesSection({
  task,
  currentUserId,
  canModerate,
  commentText,
  setCommentText,
  commentBusy,
  submitComment,
  onDeleteComment,
}: TaskNotesSectionProps) {
  return (
    <section className="mt-6 rounded-2xl bg-[#F6F6F4] p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-sm font-bold text-[#15181E]">
          <MessageIcon className="h-4 w-4 text-[#7B8190]" />
          Notes
        </h3>
        {task.comments.length > 0 && (
          <span className="rounded-full bg-white px-2 py-0.5 text-[10px] font-bold text-[#7B8190]">
            {task.comments.length}
          </span>
        )}
      </div>

      {task.comments.length === 0 ? (
        <p className="rounded-xl bg-white px-3.5 py-3 text-xs leading-relaxed text-[#7B8190] ring-1 ring-slate-200/70">
          No notes yet. Add context, a link, or an update for anyone who opens this task.
        </p>
      ) : (
        <div className="space-y-3">
          {task.comments.map((comment) => (
            <div key={comment.id} className="group flex gap-2.5">
              <Avatar email={comment.email} size="sm" />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="truncate text-xs font-bold text-[#2E3742]">
                    {comment.userId === currentUserId ? 'You' : comment.email.split('@')[0]}
                  </span>
                  <span className="shrink-0 text-[10px] text-[#7B8190]">{timeAgo(comment.createdAt)}</span>
                  {(comment.userId === currentUserId || canModerate) && (
                    <button
                      type="button"
                      onClick={() => onDeleteComment(comment)}
                      className="ml-auto rounded p-0.5 text-[#7B8190] opacity-70 transition hover:text-rose-500 focus:opacity-100"
                      aria-label="Delete note"
                    >
                      <TrashIcon className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
                <p className="mt-0.5 text-sm leading-relaxed break-words whitespace-pre-wrap text-[#3E4654]">
                  {comment.text}
                </p>
              </div>
            </div>
          ))}
        </div>
      )}

      <form onSubmit={submitComment} className="mt-3">
        <textarea
          value={commentText}
          onChange={(event) => setCommentText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              void submitComment(event)
            }
          }}
          rows={2}
          maxLength={2000}
          placeholder="Write a note…  (Enter to send)"
          aria-label="New note"
          className="field resize-none border-slate-200/80 bg-white text-sm"
        />
        <div className="mt-2 flex justify-end">
          <button
            type="submit"
            disabled={!commentText.trim() || commentBusy}
            className="inline-flex items-center justify-center gap-1.5 rounded-xl bg-[#15181E] px-3 py-1.5 text-[11px] font-bold text-white transition hover:bg-[#2E3742] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {commentBusy ? <Spinner className="h-3.5 w-3.5" /> : <PlusIcon className="h-3.5 w-3.5" />}
            Add note
          </button>
        </div>
      </form>
    </section>
  )
}
