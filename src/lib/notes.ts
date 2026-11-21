/**
 * Small, stable presentation helpers for sticky notes.
 *
 * Tilt is derived from a note's id with a simple hash, so a note keeps the same
 * lean across reloads and re-renders. Pins are always the same red accent.
 * Nothing here touches the note's data, order, dragging or editing.
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

export const PIN_COLORS = ['red'] as const
export type PinColor = (typeof PIN_COLORS)[number]

/** Every note uses the same red pin. */
export function pinColor(_id: string): PinColor {
  return 'red'
}

/** The Tailwind text colour class for the red pin head. */
export const PIN_CLASS: Record<PinColor, string> = {
  red: 'text-[#D9480F]',
}

/** The pin colour class for a note id. */
export function pinClass(_id: string): string {
  return PIN_CLASS.red
}
