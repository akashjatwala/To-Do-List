/**
 * Small, stable presentation helpers for sticky notes.
 *
 * Both the tilt and the pin colour are derived from a note's id with a simple
 * hash, so a note keeps the same look across reloads and re-renders, and adding
 * a new note never changes another note's tilt or pin. Nothing here touches the
 * note's data, order, dragging or editing.
 */

function hashId(id: string): number {
  let hash = 0
  for (let index = 0; index < id.length; index += 1) {
    hash = (hash * 31 + id.charCodeAt(index)) % 997
  }
  return hash
}

/** A slight, stable tilt in degrees (about −1.8° to +1.8°). */
export function noteTilt(id: string): number {
  return ((hashId(id) % 5) - 2) * 0.9
}

export const PIN_COLORS = ['rose', 'blue', 'amber', 'emerald'] as const
export type PinColor = (typeof PIN_COLORS)[number]

/** The pin colour for a note, chosen by a stable rule (its id). */
export function pinColor(id: string): PinColor {
  return PIN_COLORS[hashId(id) % PIN_COLORS.length]
}

/** The Tailwind text colour class for a pin head, keyed by colour name. */
export const PIN_CLASS: Record<PinColor, string> = {
  rose: 'text-rose-500 dark:text-rose-400',
  blue: 'text-sky-500 dark:text-sky-400',
  amber: 'text-amber-500 dark:text-amber-400',
  emerald: 'text-emerald-500 dark:text-emerald-400',
}

/** The pin colour class for a note id. */
export function pinClass(id: string): string {
  return PIN_CLASS[pinColor(id)]
}
