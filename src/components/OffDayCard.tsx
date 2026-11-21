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

/** One distinct, decorative emoji for each reason. Always paired with its label. */
const KIND_EMOJIS: Record<OffDayKind, string> = {
  sick: '🤒',
  travel: '🧳',
  holiday: '🌴',
  other: '✨',
}

const JUST_OFF_EMOJI = '😌'
const NO_OFF_DAY_EMOJI = '🌤️'

const KIND_ORDER: OffDayKind[] = ['sick', 'travel', 'holiday', 'other']

function kindLabel(kind: OffDayKind | null): string {
  return kind ? KIND_LABELS[kind] : 'Off'
}

export function offDayEmoji(kind: OffDayKind | null): string {
  return kind ? KIND_EMOJIS[kind] : JUST_OFF_EMOJI
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
      <div className="flex items-center gap-2.5 rounded-[24px] border border-[#DCE9EE] bg-[#EEF5F8] px-5 py-4">
        <span className="insight-icon h-8 w-8 bg-white/70 text-[#454B58]">
          <CalendarIcon className="h-4 w-4" />
        </span>
        <p className="insight-title">Checking off days…</p>
      </div>
    )
  }

  return (
    <section
      className="overflow-hidden rounded-[24px] border border-[#DCE9EE] bg-[#EEF5F8] p-5"
      aria-label="Off Day"
    >
      <div className="mb-3">
        <h2 className="text-xl font-extrabold tracking-tight text-[#15181E]">Off Day</h2>
      </div>

      <div className="flex flex-col items-center rounded-2xl bg-white/70 px-4 py-6 text-center shadow-sm ring-1 ring-white/80">
        <span className="text-3xl" aria-hidden="true">
          {onOffDay ? offDayEmoji(offDay?.kind ?? null) : NO_OFF_DAY_EMOJI}
        </span>
        <p className="mt-2 flex flex-wrap items-baseline justify-center gap-x-1.5 text-sm font-semibold text-slate-700">
          <span>{onOffDay ? 'Off day' : 'No off day marked'}</span>
          {onOffDay && (
            <span className="text-[11px] font-medium text-slate-500">
              · {kindLabel(offDay?.kind ?? null)}
            </span>
          )}
        </p>
        <p className="mt-1 max-w-xs text-xs leading-relaxed text-slate-500">
          {onOffDay
            ? [summary, offDay?.note].filter(Boolean).join(' · ')
            : 'Off days never count as missed.'}
        </p>

        {!editing && (
          <div className="mt-4 flex flex-nowrap items-center justify-center gap-2 whitespace-nowrap">
            <button
              type="button"
              onClick={openForm}
              className="btn-primary shrink-0 text-xs! px-4! py-2!"
            >
              <PencilIcon className="h-3 w-3" />
              {onOffDay ? 'Edit off day' : 'Mark today off'}
            </button>
            {onOffDay && (
              <button
                type="button"
                onClick={remove}
                disabled={busy}
                className="btn-ghost shrink-0 px-3! py-2! text-xs! text-rose-600 hover:bg-rose-50"
                aria-label="Remove off-day record"
              >
                <TrashIcon className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        )}
      </div>

      {reducedConfidence && !onOffDay && (
        <p className="mx-3 mb-2.5 rounded-lg border-l-2 border-amber-400 bg-amber-50/80 px-2.5 py-1.5 text-[11px] leading-snug text-amber-800">
          Just back from an off period — predictions carry reduced confidence for a few days.
        </p>
      )}

      {editing && (
        <div className="border-t border-white/70 bg-white/50 px-4 py-4">
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setKind(null)}
              className={`insight-pill px-2.5 py-1 text-[10px] transition ${
                kind === null
                  ? 'bg-indigo-600 text-white shadow-sm'
                  : 'bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50'
              }`}
            >
              <span aria-hidden="true">{JUST_OFF_EMOJI}</span> Just off
            </button>
            {KIND_ORDER.map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setKind(option)}
                className={`insight-pill px-2.5 py-1 text-[10px] transition ${
                  kind === option
                    ? 'bg-indigo-600 text-white shadow-sm'
                    : 'bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50'
                }`}
              >
                <span aria-hidden="true">{KIND_EMOJIS[option]}</span> {KIND_LABELS[option]}
              </button>
            ))}
          </div>

          <div className="mt-4 flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1 text-[9px] font-bold uppercase tracking-[0.1em] text-slate-500">
              From
              <input
                type="date"
                value={startDate}
                onChange={(event) => {
                  setStartDate(event.target.value)
                  if (endDate < event.target.value) setEndDate(event.target.value)
                }}
                className="field w-auto! px-2.5! py-1.5! text-xs! font-normal normal-case tracking-normal!"
              />
            </label>
            <label className="flex flex-col gap-1 text-[9px] font-bold uppercase tracking-[0.1em] text-slate-500">
              To
              <input
                type="date"
                value={endDate}
                min={startDate}
                onChange={(event) => setEndDate(event.target.value)}
                className="field w-auto! px-2.5! py-1.5! text-xs! font-normal normal-case tracking-normal!"
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

    </section>
  )
}
