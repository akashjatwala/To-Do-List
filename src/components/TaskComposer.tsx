import { useRef, useState, type FormEvent } from 'react'
import type { Priority, Recurrence } from '@/types'
import { dueFromDateInput } from '@/lib/date'
import { PRIORITY_META, PRIORITY_VALUES, RECURRENCE_META, RECURRENCE_VALUES } from '@/lib/taskmeta'
import { CalendarIcon, FlagIcon, PlusIcon, RepeatIcon, TagIcon } from './Icons'
import { Spinner } from './ui'

export interface NewTaskInput {
  text: string
  due: number | null
  priority: Priority
  tags: string[]
  recurrence: Recurrence
}

export default function TaskComposer({
  contextLabel,
  onAdd,
}: {
  contextLabel: string
  onAdd: (input: NewTaskInput) => Promise<boolean>
}) {
  const [text, setText] = useState('')
  const [due, setDue] = useState('')
  const [priority, setPriority] = useState<Priority>('none')
  const [recurrence, setRecurrence] = useState<Recurrence>('none')
  const [tags, setTags] = useState('')
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const value = text.trim()
    if (!value || busy) return
    setBusy(true)
    const ok = await onAdd({
      text: value,
      due: dueFromDateInput(due),
      priority,
      tags: tags
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean),
      recurrence,
    })
    setBusy(false)
    if (ok) {
      setText('')
      setDue('')
      setPriority('none')
      setRecurrence('none')
      setTags('')
      inputRef.current?.focus()
    }
  }

  const selectClass =
    'cursor-pointer rounded-lg border-0 bg-transparent py-1.5 pr-6 pl-7 text-xs font-medium text-slate-600 outline-none transition hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800'

  return (
    <form
      onSubmit={submit}
      className="card mb-7 p-2 transition focus-within:border-indigo-300 focus-within:ring-4 focus-within:ring-indigo-500/10 dark:focus-within:border-indigo-500/60"
    >
      <div className="flex items-center gap-2 px-2 pt-1">
        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 border-dashed border-slate-300 text-slate-400 dark:border-slate-600">
          <PlusIcon className="h-3 w-3" />
        </span>
        <input
          ref={inputRef}
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder={`Add a task to ${contextLabel}…`}
          maxLength={500}
          className="w-full border-0 bg-transparent py-2 text-[15px] text-slate-900 outline-none placeholder:text-slate-400 dark:text-slate-100 dark:placeholder:text-slate-500"
          aria-label="New task"
        />
      </div>

      <div className="mt-1 flex flex-wrap items-center gap-x-1 gap-y-2 border-t border-slate-100 px-2 pt-2 dark:border-slate-800">
        <label className="flex cursor-pointer items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-medium text-slate-500 transition hover:bg-slate-100 hover:text-slate-700 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200">
          <CalendarIcon className="h-4 w-4" />
          <input
            type="date"
            value={due}
            onChange={(event) => setDue(event.target.value)}
            className="max-w-[7.5rem] cursor-pointer border-0 bg-transparent p-0 text-xs font-medium text-slate-600 outline-none dark:text-slate-300"
            aria-label="Due date"
          />
        </label>

        <label className="relative flex items-center">
          <FlagIcon
            className={`pointer-events-none absolute left-2 h-4 w-4 ${PRIORITY_META[priority].text}`}
          />
          <select
            value={priority}
            onChange={(event) => setPriority(event.target.value as Priority)}
            className={selectClass}
            aria-label="Priority"
          >
            {PRIORITY_VALUES.map((value) => (
              <option key={value} value={value}>
                {value === 'none' ? 'Priority' : PRIORITY_META[value].label}
              </option>
            ))}
          </select>
        </label>

        <label className="relative flex items-center">
          <RepeatIcon
            className={`pointer-events-none absolute left-2 h-4 w-4 ${
              recurrence === 'none' ? 'text-slate-400' : 'text-indigo-500 dark:text-indigo-400'
            }`}
          />
          <select
            value={recurrence}
            onChange={(event) => setRecurrence(event.target.value as Recurrence)}
            className={selectClass}
            aria-label="Repeat"
          >
            {RECURRENCE_VALUES.map((value) => (
              <option key={value} value={value}>
                {value === 'none' ? 'Repeat' : RECURRENCE_META[value].short}
              </option>
            ))}
          </select>
        </label>

        <label className="relative flex min-w-[8rem] flex-1 items-center">
          <TagIcon className="pointer-events-none absolute left-2 h-4 w-4 text-slate-400" />
          <input
            value={tags}
            onChange={(event) => setTags(event.target.value)}
            placeholder="Tags (comma separated)"
            maxLength={200}
            className="w-full rounded-lg border-0 bg-transparent py-1.5 pr-2 pl-7 text-xs font-medium text-slate-600 outline-none placeholder:text-slate-400 hover:bg-slate-100 dark:text-slate-300 dark:placeholder:text-slate-500 dark:hover:bg-slate-800"
            aria-label="Tags"
          />
        </label>

        <div className="ml-auto flex items-center gap-3">
          <span className="hidden text-[11px] text-slate-400 lg:inline">
            Press{' '}
            <kbd className="rounded border border-slate-200 px-1 py-0.5 font-sans text-[10px] dark:border-slate-700">
              Enter
            </kbd>
          </span>
          <button
            type="submit"
            className="btn-primary px-3! py-1.5! text-xs"
            disabled={!text.trim() || busy}
          >
            {busy ? <Spinner className="h-3.5 w-3.5" /> : <PlusIcon className="h-3.5 w-3.5" />}
            Add task
          </button>
        </div>
      </div>
    </form>
  )
}
