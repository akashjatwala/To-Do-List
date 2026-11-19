import { useCallback, useEffect, useMemo, useState } from 'react'
import { api, errorMessage } from '@/api'
import type { OffDay, OffDayKind, ToastTone } from '@/types'
import { CalendarIcon, PencilIcon, TrashIcon } from './Icons'

/**
 * Off days.
 *
 * One tap marks the selected day off, with an optional reason and an optional
 * end date for a whole period. A record can be added after the fact, edited and
 * removed. Nothing here writes to the sessions or the per-day statuses: an off
 * day is flagged, never recorded as a failure, and the note can always be
 * deleted again.
 */

interface OffDayCardProps {
  /** The selected local date (`YYYY-MM-DD`). */
  date: string
  notify: (message: string, tone?: ToastTone) => void
  /** Called after any change so the surrounding view can reload. */
  onChanged?: () => void
}

const KIND_LABELS: Record<OffDayKind, string> = {
  sick: 'Sick',
  travel: 'Travelling',
  holiday: 'Holiday',
  other: 'Other',
}

const KIND_ORDER: OffDayKind[] = ['sick', 'travel', 'holiday', 'other']

function kindLabel(kind: OffDayKind | null): string {
  return kind ? KIND_LABELS[kind] : 'Off'
}

export default function OffDayCard({ date, notify, onChanged }: OffDayCardProps) {
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [offDay, setOffDay] = useState<OffDay | null>(null)
  const [onOffDay, setOnOffDay] = useState(false)
  const [reducedConfidence, setReducedConfidence] = useState(false)
  const [editing, setEditing] = useState(false)

  // Form state, seeded from the selected day each time the form opens.
  const [kind, setKind] = useState<OffDayKind | null>(null)
  const [startDate, setStartDate] = useState(date)
  const [endDate, setEndDate] = useState(date)
  const [note, setNote] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const result = await api.getOffDayDay(date)
      setOffDay(result.offDay)
      setOnOffDay(result.onOffDay)
      setReducedConfidence(result.reducedConfidence)
    } catch (error) {
      notify(errorMessage(error), 'error')
    } finally {
      setLoading(false)
    }
  }, [date, notify])

  useEffect(() => {
    void load()
  }, [load])

  const openForm = useCallback(() => {
    setKind(offDay?.kind ?? null)
    setStartDate(offDay?.startDate ?? date)
    setEndDate(offDay?.endDate ?? offDay?.startDate ?? date)
    setNote(offDay?.note ?? '')
    setEditing(true)
  }, [offDay, date])

  const save = useCallback(async () => {
    if (endDate < startDate) {
      notify('The end date cannot be before the start date.', 'error')
      return
    }
    setBusy(true)
    try {
      const payload = { kind, startDate, endDate, note: note.trim() || null }
      if (offDay) await api.updateOffDay(offDay.id, payload)
      else await api.createOffDay(payload)
      setEditing(false)
      await load()
      onChanged?.()
      notify(offDay ? 'Off day updated.' : 'Marked as an off day.', 'success')
    } catch (error) {
      notify(errorMessage(error), 'error')
    } finally {
      setBusy(false)
    }
  }, [endDate, kind, note, offDay, onChanged, startDate, load, notify])

  const remove = useCallback(async () => {
    if (!offDay) return
    setBusy(true)
    try {
      await api.deleteOffDay(offDay.id)
      setEditing(false)
      await load()
      onChanged?.()
      notify('Off-day record removed.', 'success')
    } catch (error) {
      notify(errorMessage(error), 'error')
    } finally {
      setBusy(false)
    }
  }, [offDay, load, notify, onChanged])

  const summary = useMemo(() => {
    if (!offDay) return ''
    const span = offDay.startDate === offDay.endDate ? offDay.startDate : `${offDay.startDate} → ${offDay.endDate}`
    return span
  }, [offDay])

  if (loading) {
    return (
      <div className="insight-card flex items-center gap-3 px-4 py-4">
        <span className="insight-icon bg-slate-100 text-slate-400">
          <CalendarIcon className="h-4 w-4" />
        </span>
        <div>
          <p className="insight-eyebrow">Day settings</p>
          <p className="insight-title">Checking off days…</p>
        </div>
      </div>
    )
  }

  return (
    <section className="insight-card" aria-label="Off days">
      <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
        <div className="flex min-w-0 items-start gap-3">
          <span className="insight-icon bg-indigo-50 text-indigo-500">
            <CalendarIcon className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <p className="insight-eyebrow">Day settings</p>
            <h2 className="insight-title">{onOffDay ? `Off day · ${kindLabel(offDay?.kind ?? null)}` : 'Off days'}</h2>
            <p className="insight-subtitle">
              {onOffDay
                ? [summary, offDay?.note].filter(Boolean).join(' · ')
                : 'Time away is never counted as missed. Your logged activity stays exactly as it is.'}
            </p>
          </div>
        </div>

        {!editing && (
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {onOffDay && (
              <span className="insight-pill bg-emerald-50 text-emerald-700 ring-1 ring-emerald-100">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                Marked off
              </span>
            )}
            <button
              type="button"
              onClick={openForm}
              className="insight-quiet ring-1 ring-slate-200"
            >
              <PencilIcon className="h-3 w-3" />
              {onOffDay ? 'Edit' : 'Mark off'}
            </button>
            {onOffDay && (
              <button
                type="button"
                onClick={remove}
                disabled={busy}
                className="insight-quiet text-rose-600 ring-1 ring-rose-100 hover:bg-rose-50"
                aria-label="Remove off-day record"
              >
                <TrashIcon className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        )}
      </div>

      {reducedConfidence && !onOffDay && (
        <p className="mx-4 mb-4 rounded-xl border-l-2 border-amber-400 bg-amber-50/80 px-3 py-2.5 text-xs leading-relaxed text-amber-800">
          Just back from an off period — predictions carry reduced confidence for a few days.
        </p>
      )}

      {editing && (
        <div className="border-t border-slate-100 bg-slate-50/60 px-4 py-4">
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setKind(null)}
              className={`insight-pill px-3 py-1.5 text-xs transition ${
                kind === null
                  ? 'bg-indigo-600 text-white shadow-sm'
                  : 'bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50'
              }`}
            >
              Just off
            </button>
            {KIND_ORDER.map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setKind(option)}
                className={`insight-pill px-3 py-1.5 text-xs transition ${
                  kind === option
                    ? 'bg-indigo-600 text-white shadow-sm'
                    : 'bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50'
                }`}
              >
                {KIND_LABELS[option]}
              </button>
            ))}
          </div>

          <div className="mt-4 flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1.5 text-[10px] font-bold uppercase tracking-[0.12em] text-slate-400">
              From
              <input
                type="date"
                value={startDate}
                onChange={(event) => {
                  setStartDate(event.target.value)
                  if (endDate < event.target.value) setEndDate(event.target.value)
                }}
                className="field w-auto! px-2.5! py-1.5! text-base! font-normal normal-case tracking-normal! sm:text-xs!"
              />
            </label>
            <label className="flex flex-col gap-1.5 text-[10px] font-bold uppercase tracking-[0.12em] text-slate-400">
              To
              <input
                type="date"
                value={endDate}
                min={startDate}
                onChange={(event) => setEndDate(event.target.value)}
                className="field w-auto! px-2.5! py-1.5! text-base! font-normal normal-case tracking-normal! sm:text-xs!"
              />
            </label>
            <span className="insight-hint pb-1.5">Leave the same date for a single day.</span>
          </div>

          <input
            type="text"
            value={note}
            maxLength={500}
            onChange={(event) => setNote(event.target.value)}
            placeholder="Optional note (only you can see this)"
            className="field mt-3"
          />

          <div className="mt-3 flex justify-end gap-2">
            <button type="button" onClick={() => setEditing(false)} className="insight-quiet">
              Cancel
            </button>
            <button type="button" onClick={save} disabled={busy} className="insight-primary">
              {busy ? 'Saving…' : 'Save off day'}
            </button>
          </div>
        </div>
      )}

      {!editing && !onOffDay && (
        <p className="insight-hint flex items-center gap-1.5 border-t border-slate-100 px-4 py-2.5">
          <PencilIcon className="h-3 w-3" />
          You can also mark a past day or a whole range.
        </p>
      )}
    </section>
  )
}
