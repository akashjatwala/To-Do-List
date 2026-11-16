/**
 * The daily check-in questions, plus the small pure helpers the check-in
 * wizard shares with the server-side tests.
 *
 * Answers are stored as ordinals **1–5** in the order the options are listed
 * here: the first option is 1 and the last is 5. This direction is fixed and
 * shared with the API (`server/checkins-store.ts`), so it never drifts. For
 * every question 1 is the "best" end of the scale and 5 the "worst"; Phase 2a
 * flips them so that higher always means better.
 *
 * Emoji and accent colours are **decorative only** — they are never stored, and
 * the text label is always shown next to the emoji, so the screen reader reads
 * the words and not the pictures.
 *
 * This module deliberately has no imports so the server-side tests can load it
 * directly.
 */
export const CHECKIN_ANSWER_KEYS = [
  'feeling',
  'energy',
  'motivation',
  'sleep',
  'stress',
  'free_time',
  'focus',
  'body',
  'workload',
] as const

export type CheckinAnswerKey = (typeof CHECKIN_ANSWER_KEYS)[number]

/** A partial answer set: a question that was not answered is `null`/absent. */
export type CheckinAnswerValues = Partial<Record<CheckinAnswerKey, number | null>>

export interface CheckinQuestion {
  key: CheckinAnswerKey
  /** Short field label, e.g. "Energy". */
  label: string
  prompt: string
  /** Options in stored order: the first is ordinal 1, the last is ordinal 5. */
  options: readonly [string, string, string, string, string]
  /** Decorative header emoji for the question screen. */
  emoji: string
  /** Decorative emoji per option, best first — the same order as `options`. */
  optionEmojis: readonly [string, string, string, string, string]
  /** Decorative accent colour (hex) that softly tints the question's screen. */
  accent: string
}

export const CHECKIN_QUESTIONS: readonly CheckinQuestion[] = [
  {
    key: 'feeling',
    label: 'Mood',
    prompt: 'How are you feeling today?',
    options: ['Very good', 'Good', 'Okay', 'Low', 'Very low'],
    emoji: '😊',
    optionEmojis: ['😄', '🙂', '😐', '🙁', '😞'],
    accent: '#f43f5e',
  },
  {
    key: 'energy',
    label: 'Energy',
    prompt: 'How is your energy level today?',
    options: ['Very high', 'High', 'Moderate', 'Low', 'Very low'],
    emoji: '⚡',
    optionEmojis: ['🚀', '🔋', '🪫', '😪', '😴'],
    accent: '#f59e0b',
  },
  {
    key: 'motivation',
    label: 'Motivation',
    prompt: 'How motivated do you feel to work on your tasks today?',
    options: ['Very motivated', 'Motivated', 'Neutral', 'Not very motivated', 'Not motivated at all'],
    emoji: '🎯',
    optionEmojis: ['🔥', '💪', '😐', '😕', '🛋️'],
    accent: '#f97316',
  },
  {
    key: 'sleep',
    label: 'Sleep',
    prompt: 'How well did you sleep?',
    options: ['Very well', 'Well', 'Average', 'Poorly', 'Very poorly'],
    emoji: '🌙',
    optionEmojis: ['😌', '🙂', '😐', '🥱', '😵'],
    accent: '#6366f1',
  },
  {
    key: 'stress',
    label: 'Stress',
    prompt: 'How stressful does today feel?',
    options: ['Very relaxed', 'Relaxed', 'Normal', 'Stressful', 'Very stressful'],
    emoji: '🧘',
    optionEmojis: ['😌', '🙂', '😐', '😰', '😖'],
    accent: '#14b8a6',
  },
  {
    key: 'free_time',
    label: 'Free time',
    prompt: 'How much free time do you realistically have today?',
    options: ['Plenty', 'More than usual', 'Normal', 'Limited', 'Very limited'],
    emoji: '⏳',
    optionEmojis: ['🕊️', '🙂', '⚖️', '⏱️', '🏃'],
    accent: '#0ea5e9',
  },
  {
    key: 'focus',
    label: 'Focus',
    prompt: 'How is your focus today?',
    options: ['Very sharp', 'Sharp', 'Average', 'Scattered', 'Very scattered'],
    emoji: '🧠',
    optionEmojis: ['🎯', '🙂', '😐', '🌀', '🫠'],
    accent: '#8b5cf6',
  },
  {
    key: 'body',
    label: 'Body',
    prompt: 'How does your body feel today (aches, tiredness, feeling unwell)?',
    options: ['Very good', 'Good', 'Okay', 'Poor', 'Very poor'],
    emoji: '💪',
    optionEmojis: ['🤩', '🙂', '😐', '😣', '🤒'],
    accent: '#10b981',
  },
  {
    key: 'workload',
    label: 'Workload',
    prompt: 'How heavy are your workload and fixed commitments today (work, classes, appointments)?',
    options: ['Very light', 'Light', 'Normal', 'Heavy', 'Very heavy'],
    emoji: '📋',
    optionEmojis: ['🌿', '🙂', '⚖️', '📚', '🌋'],
    accent: '#06b6d4',
  },
]

/** The short label for a field, e.g. "Energy". Falls back to the key. */
export function labelForKey(key: CheckinAnswerKey): string {
  return CHECKIN_QUESTIONS.find((question) => question.key === key)?.label ?? key
}

/**
 * The user's local calendar date as `YYYY-MM-DD`. Uses the local timezone on
 * purpose, so a late-evening session still counts as today — never UTC.
 */
export function localDateString(date: Date = new Date()): string {
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/** How many questions have an answer. Missing answers are simply not counted. */
export function answeredCount(answers: CheckinAnswerValues): number {
  let count = 0
  for (const key of CHECKIN_ANSWER_KEYS) {
    const value = answers[key]
    if (value !== null && value !== undefined) count += 1
  }
  return count
}

/**
 * The index of the first question without an answer, or `questions.length` when
 * every question is answered. This is where a resumed check-in starts.
 */
export function firstUnansweredIndex(
  answers: CheckinAnswerValues,
  questions: readonly CheckinQuestion[] = CHECKIN_QUESTIONS,
): number {
  for (let index = 0; index < questions.length; index += 1) {
    const value = answers[questions[index].key]
    if (value === null || value === undefined) return index
  }
  return questions.length
}

/** A friendly greeting for the local hour, without guessing a name. */
export function greetingForHour(hour: number): string {
  if (hour < 5) return 'Hello'
  if (hour < 12) return 'Good morning'
  if (hour < 17) return 'Good afternoon'
  if (hour < 22) return 'Good evening'
  return 'Good night'
}

/** Keep a wizard step inside `[0, total]`; `total` is the closing screen. */
export function clampStep(step: number, total: number): number {
  if (!Number.isFinite(step)) return 0
  return Math.min(Math.max(Math.trunc(step), 0), total)
}
