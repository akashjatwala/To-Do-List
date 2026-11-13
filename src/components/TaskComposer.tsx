import { useRef, useState, type FormEvent } from 'react'
import { dueFromDateInput } from '@/lib/date'
import { CalendarIcon, PlusIcon } from './Icons'
import { Spinner } from './ui'

export default function TaskComposer({
  contextLabel,
  onAdd,
}: {
  contextLabel: string
  onAdd: (text: string, due: number | null) => Promise<boolean>
}) {
  const [text, setText] = useState('')
  const [due, setDue] = useState('')
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const value = text.trim()
    if (!value || busy) return
    setBusy(true)
    const ok = await onAdd(value, dueFromDateInput(due))
    setBusy(false)
    if (ok) {
      setText('')
      setDue('')
      inputRef.current?.focus()
    }
  }

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
      <div className="mt-1 flex items-center justify-between gap-2 border-t border-slate-100 px-2 pt-2 dark:border-slate-800">
        <label className="flex cursor-pointer items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-medium text-slate-500 transition hover:bg-slate-100 hover:text-slate-700 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200">
          <CalendarIcon className="h-4 w-4" />
          <span>{due ? '' : 'Due date'}</span>
          <input
            type="date"
            value={due}
            onChange={(event) => setDue(event.target.value)}
            className="max-w-[7.5rem] cursor-pointer border-0 bg-transparent p-0 text-xs font-medium text-slate-600 outline-none dark:text-slate-300"
            aria-label="Due date"
          />
        </label>
        <div className="flex items-center gap-3">
          <span className="hidden text-[11px] text-slate-400 sm:inline">
            Press <kbd className="rounded border border-slate-200 px-1 py-0.5 font-sans text-[10px] dark:border-slate-700">Enter</kbd>
          </span>
          <button type="submit" className="btn-primary px-3! py-1.5! text-xs" disabled={!text.trim() || busy}>
            {busy ? <Spinner className="h-3.5 w-3.5" /> : <PlusIcon className="h-3.5 w-3.5" />}
            Add task
          </button>
        </div>
      </div>
    </form>
  )
}
