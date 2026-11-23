import type { ReactNode } from 'react'

export default function DetailPillRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-2.5">
      <p className="w-[72px] shrink-0 text-xs font-bold text-[#5F6165]">{label}</p>
      <div className="flex min-h-8 min-w-0 flex-1 items-center rounded-xl bg-white px-2.5 py-1 text-xs font-semibold text-[#2E3742] shadow-[0_1px_2px_rgba(21,24,30,0.04)]">
        {children}
      </div>
    </div>
  )
}
