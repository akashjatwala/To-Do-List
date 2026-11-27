import type { OffDayKind } from '@/types'

export const OFF_KIND_LABELS: Record<OffDayKind, string> = {
  sick: 'Sick',
  travel: 'Travelling',
  holiday: 'Holiday',
  other: 'Off',
}

export function offKindLabel(kind?: OffDayKind | null): string {
  return kind ? OFF_KIND_LABELS[kind] : 'Off'
}

/** One distinct decorative emoji per reason, with a separate symbol for "just off". */
const KIND_EMOJIS: Record<OffDayKind, string> = {
  sick: '🤒',
  travel: '🧳',
  holiday: '🌴',
  other: '✨',
}

const JUST_OFF_EMOJI = '😌'

export const NO_OFF_DAY_EMOJI = '🌤️'

export function offDayEmoji(kind: OffDayKind | null): string {
  return kind ? KIND_EMOJIS[kind] : JUST_OFF_EMOJI
}
