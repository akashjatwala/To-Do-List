import { CheckIcon } from './Icons'

export function Logo({ className = '', markClassName = '' }: { className?: string; markClassName?: string }) {
  return (
    <span className={`inline-flex items-center gap-2.5 ${className}`}>
      <span
        className={`flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 text-white shadow-lg shadow-indigo-500/25 ${markClassName}`}
      >
        <CheckIcon className="h-5 w-5" strokeWidth={2.6} />
      </span>
      <span className="text-lg font-bold tracking-tight">
        To-do<span className="text-indigo-500">.</span>
      </span>
    </span>
  )
}
