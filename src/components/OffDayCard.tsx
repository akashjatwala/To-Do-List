import { useCallback, useEffect, useMemo, useState } from 'react'
import { api, errorMessage } from '@/api'
import type { OffDay, OffDayKind, ToastTone } from '@/types'
import { CalendarIcon, PencilIcon, TrashIcon } from './Icons'

/**
 * Off days (Phase 4, §0) — presentation only.
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
      <div className="rounded-2xl border border-slate-200 bg-white/70 px-4 py-3 text-sm text-slate-400 dark:border-slate-800 dark:bg-slate-900/60 dark:text-slate-500">
        Checking off days…
      </div>
    )
  }

  return (
    <div className="rounded-2xl border border-slate-200 bg-white/70 p-4 dark:border-slate-800 dark:bg-slate-900/60">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2.5">
          <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-300">
            <CalendarIcon className="h-4 w-4" />
          </span>
          <div>
            <p className="text-sm font-semibold text-slate-700 dark:text-slate-200">
              {onOffDay ? `Off day · ${kindLabel(offDay?.kind ?? null)}` : 'Off days'}
            </p>
            {onOffDay ? (
              <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                {summary}
                {offDay?.note ? ` · ${offDay.note}` : ''}
              </p>
            ) : (
              <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                Off days are never counted as missed. Your recorded activity is left exactly as it is.
              </p>
            )}
          </div>
        </div>

        {!editing && (
          <div className="flex shrink-0 gap-1.5">
            <button
              type="button"
              onClick={openForm}
              className="rounded-lg border border-slate-200 px-2.5 py-1 text-[11px] font-semibold text-slate-600 transition hover:bg-white dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
            >
              {onOffDay ? 'Edit' : 'Mark off'}
            </button>
            {onOffDay && (
              <button
                type="button"
                onClick={remove}
                disabled={busy}
                className="rounded-lg border border-slate-200 px-2.5 py-1 text-[11px] font-semibold text-rose-600 transition hover:bg-rose-50 disabled:opacity-50 dark:border-slate-700 dark:text-rose-400 dark:hover:bg-rose-500/10"
                aria-label="Remove off-day record"
              >
                <TrashIcon className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        )}
      </div>

      {reducedConfidence && !onOffDay && (
        <p className="mt-3 rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:bg-amber-500/10 dark:text-amber-300">
          Just back from an off period — predictions carry reduced confidence for a few days.
        </p>
      )}

      {editing && (
        <div className="mt-4 space-y-3 border-t border-slate-100 pt-4 dark:border-slate-800">
          <div className="flex flex-wrap gap-1.5">
            <button
              type="button"
              onClick={() => setKind(null)}
              className={`rounded-full px-3 py-1 text-xs font-semibold transition ${
                kind === null
                  ? 'bg-indigo-600 text-white'
                  : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300'
              }`}
            >
              Just off
            </button>
            {KIND_ORDER.map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setKind(option)}
                className={`rounded-full px-3 py-1 text-xs font-semibold transition ${
                  kind === option
                    ? 'bg-indigo-600 text-white'
                    : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300'
                }`}
              >
                {KIND_LABELS[option]}
              </button>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
            <label className="flex items-center gap-1.5">
              From
              <input
                type="date"
                value={startDate}
                onChange={(event) => {
                  setStartDate(event.target.value)
                  if (endDate < event.target.value) setEndDate(event.target.value)
                }}
                className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs dark:border-slate-700 dark:bg-slate-900"
              />
            </label>
            <label className="flex items-center gap-1.5">
              To
              <input
                type="date"
                value={endDate}
                min={startDate}
                onChange={(event) => setEndDate(event.target.value)}
                className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs dark:border-slate-700 dark:bg-slate-900"
              />
            </label>
          </div>

          <input
            type="text"
            value={note}
            maxLength={500}
            onChange={(event) => setNote(event.target.value)}
            placeholder="Optional note (only you can see this)"
            className="w-full rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-900"
          />

          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setEditing(false)}
              className="rounded-lg px-3 py-1.5 text-xs font-medium text-slate-500 transition hover:text-slate-700 dark:text-slate-400"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={save}
              disabled={busy}
              className="rounded-lg bg-indigo-600 px-3.5 py-1.5 text-xs font-semibold text-white transition hover:bg-indigo-500 disabled:opacity-50"
            >
              {busy ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      )}

      {!editing && !onOffDay && (
        <p className="mt-2 flex items-center gap-1 text-[11px] text-slate-400 dark:text-slate-500">
          <PencilIcon className="h-3 w-3" />
          You can also mark a past day or a range.
        </p>
      )}
    </div>
  )
}
