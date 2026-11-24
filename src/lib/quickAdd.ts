import type { Priority, Team } from '@/types'
import { dateInputValue } from './date'
import { TAG_LIMIT } from './taskmeta'

/** Fields the quick-add parser can fill from plain text. */
export interface QuickAddResult {
  text: string
  due: string | null
  preferredTime: string | null
  tags: string[]
  duration: number | null
  teamId: string | null
  /** Null when the phrase did not specify a priority, so the dialog keeps its current choice. */
  priority: Priority | null
}

const WEEKDAYS: Record<string, number> = {
  sun: 0,
  sunday: 0,
  mon: 1,
  monday: 1,
  tue: 2,
  tues: 2,
  tuesday: 2,
  wed: 3,
  weds: 3,
  wednesday: 3,
  thu: 4,
  thur: 4,
  thurs: 4,
  thursday: 4,
  fri: 5,
  friday: 5,
  sat: 6,
  saturday: 6,
}

const MONTH_NAMES =
  'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?'

const MONTHS: Record<string, number> = {
  jan: 0,
  january: 0,
  feb: 1,
  february: 1,
  mar: 2,
  march: 2,
  apr: 3,
  april: 3,
  may: 4,
  jun: 5,
  june: 5,
  jul: 6,
  july: 6,
  aug: 7,
  august: 7,
  sep: 8,
  sept: 8,
  september: 8,
  oct: 9,
  october: 9,
  nov: 10,
  november: 10,
  dec: 11,
  december: 11,
}

function ymd(year: number, month: number, day: number): string | null {
  const date = new Date(year, month, day)
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month ||
    date.getDate() !== day
  ) {
    return null
  }
  return dateInputValue(date.getTime())
}

function shiftDays(now: Date, days: number): string {
  const date = new Date(now)
  date.setDate(date.getDate() + days)
  return dateInputValue(date.getTime())
}

function weekdayFrom(value: string): number | null {
  const found = WEEKDAYS[value.toLowerCase()]
  return found === undefined ? null : found
}

function monthFrom(value: string): number | null {
  const found = MONTHS[value.toLowerCase().replace(/\.$/, '')]
  return found === undefined ? null : found
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Resolve a trailing team name against the teams the user can choose from. */
function findTeam(text: string, teams: Team[]): { pattern: RegExp; teamId: string } | null {
  const candidates = teams
    .map((team) => ({ team, name: team.name.trim().replace(/\s+/g, ' ') }))
    .filter((candidate) => candidate.name.length > 0)
    .sort((a, b) => b.name.length - a.name.length)

  for (const { team, name } of candidates) {
    const pattern = new RegExp(`(?:^|\\s)${escapeRegExp(name)}[\\s,;:–—-]*$`, 'i')
    if (pattern.test(text)) return { pattern, teamId: team.id }
  }
  return null
}

interface DateMatch {
  pattern: RegExp
  value: string | null
}

/** Find the first supported date phrase, leaving later phrases in the title. */
function findDate(input: string, now: Date): DateMatch | null {
  const checks: Array<{
    pattern: RegExp
    resolve: (match: RegExpExecArray) => string | null
  }> = [
    {
      pattern: /\b(today|tomorrow|tonight)\b/i,
      resolve: (match) => {
        const word = match[1].toLowerCase()
        return shiftDays(now, word === 'tomorrow' ? 1 : 0)
      },
    },
    {
      pattern: /\bnext\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|tues|wed|weds|thu|thur|thurs|fri|sat|sun)\b/i,
      resolve: (match) => {
        const target = weekdayFrom(match[1])
        if (target === null) return null
        const delta = (target - now.getDay() + 7) % 7 || 7
        return shiftDays(now, delta)
      },
    },
    {
      pattern: /\b(in)\s+(\d{1,3})\s+(day|days|week|weeks)\b/i,
      resolve: (match) => {
        const amount = Number(match[2])
        if (!Number.isFinite(amount) || amount < 1) return null
        return shiftDays(now, amount * (/week/i.test(match[3]) ? 7 : 1))
      },
    },
    {
      pattern: /\b(\d{4})-(\d{1,2})-(\d{1,2})\b/,
      resolve: (match) => ymd(Number(match[1]), Number(match[2]) - 1, Number(match[3])),
    },
    {
      pattern: /\b(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})\b/,
      resolve: (match) => {
        const first = Number(match[1])
        const second = Number(match[2])
        let year = Number(match[3])
        if (year < 100) year += 2000
        if (first > 12 && second > 12) return null
        // Prefer day/month/year; accept month/day/year when only the second part can be a month.
        const day = first > 12 || second <= 12 ? first : second
        const month = (first > 12 || second <= 12 ? second : first) - 1
        return ymd(year, month, day)
      },
    },
    {
      pattern: new RegExp(`\\b(${MONTH_NAMES})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`, 'i'),
      resolve: (match) => {
        const month = monthFrom(match[1])
        if (month === null) return null
        const year = match[3] ? Number(match[3]) : now.getFullYear()
        let value = ymd(year, month, Number(match[2]))
        if (!match[3] && value && value < dateInputValue(now.getTime())) {
          value = ymd(year + 1, month, Number(match[2]))
        }
        return value
      },
    },
    {
      pattern: new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_NAMES})\\b`, 'i'),
      resolve: (match) => {
        const month = monthFrom(match[2])
        if (month === null) return null
        let value = ymd(now.getFullYear(), month, Number(match[1]))
        if (value && value < dateInputValue(now.getTime())) {
          value = ymd(now.getFullYear() + 1, month, Number(match[1]))
        }
        return value
      },
    },
    {
      pattern: /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|tues|wed|weds|thu|thur|thurs|fri|sat|sun)\b/i,
      resolve: (match) => {
        const target = weekdayFrom(match[1])
        if (target === null) return null
        const delta = (target - now.getDay() + 7) % 7
        return shiftDays(now, delta)
      },
    },
  ]

  for (const check of checks) {
    const match = check.pattern.exec(input)
    if (!match) continue
    return { pattern: check.pattern, value: check.resolve(match) }
  }
  return null
}

function timeFrom(hour: number, minute: number, period?: string): string | null {
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null
  if (minute < 0 || minute > 59) return null
  let normalized = hour
  if (period) {
    if (hour < 1 || hour > 12) return null
    normalized = hour % 12 + (period.toLowerCase() === 'pm' ? 12 : 0)
  } else if (hour < 0 || hour > 23) {
    return null
  }
  return `${`${normalized}`.padStart(2, '0')}:${`${minute}`.padStart(2, '0')}`
}

function cleanTitle(value: string): string {
  return value
    .replace(/\s+/g, ' ')
    .replace(/^\s*(?:on|at|for|due|by)\s+/i, '')
    .replace(/\s+(?:on|at|for|due|by)$/i, '')
    .replace(/^[\s,;:–—-]+|[\s,;:–—-]+$/g, '')
    .trim()
}

/**
 * Turn a phrase like "Submit report tomorrow 3pm #work" into New Task fields.
 * Only local date math is used; nothing is sent to the server.
 */
export function parseQuickAdd(
  input: string,
  now = new Date(),
  teams: Team[] = [],
): QuickAddResult {
  let text = input.trim().replace(/\s+/g, ' ')
  let due: string | null = null
  const tonight = /\btonight\b/i.test(text)

  const dateMatch = findDate(text, now)
  if (dateMatch?.value) {
    due = dateMatch.value
    text = text.replace(dateMatch.pattern, ' ')
  }

  let preferredTime: string | null = null
  text = text.replace(/\b(noon|midnight)\b/gi, (match) => {
    if (preferredTime === null) preferredTime = match.toLowerCase() === 'noon' ? '12:00' : '00:00'
    return ' '
  })
  text = text.replace(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/gi, (match, hour, minute, period) => {
    const value = timeFrom(Number(hour), minute ? Number(minute) : 0, period)
    if (value === null || preferredTime !== null) return match
    preferredTime = value
    return ' '
  })
  text = text.replace(/\b(\d{1,2}):(\d{2})\b/g, (match, hour, minute) => {
    const value = timeFrom(Number(hour), Number(minute))
    if (value === null || preferredTime !== null) return match
    preferredTime = value
    return ' '
  })
  if (preferredTime === null && tonight) preferredTime = '20:00'

  let duration: number | null = null
  text = text.replace(
    /\b(?:for\s+)?(\d{1,3}(?:\.\d+)?)\s*(hours?|hrs?|h|minutes?|mins?|m)\b/gi,
    (match, amount, unit) => {
      const value = Number(amount)
      if (!Number.isFinite(value) || value <= 0) return match
      const minutes = /^h/i.test(unit) ? Math.round(value * 60) : Math.round(value)
      if (minutes < 1 || minutes > 60 * 24 * 7) return match
      if (duration === null) duration = minutes
      return ' '
    },
  )

  let priority: Priority | null = null
  text = text.replace(
    /\b(?:no|none)\s+priority\b|\b(high|medium|low)\s+priority\b|(?:^|\s)!(high|medium|low|none)\b/gi,
    (_match, phrase: string | undefined, shorthand: string | undefined) => {
      if (priority !== null) return ' '
      const value = (phrase ?? shorthand ?? 'none').toLowerCase()
      priority =
        value === 'high' ? 'high' : value === 'medium' ? 'medium' : value === 'low' ? 'low' : 'none'
      return ' '
    },
  )

  const tags: string[] = []
  text = text.replace(/(?:^|\s)#([A-Za-z0-9][A-Za-z0-9_-]{0,23})\b/g, (match, raw: string) => {
    const tag = raw.toLowerCase()
    if (tags.includes(tag) || tags.length >= TAG_LIMIT) return match
    tags.push(tag)
    return ' '
  })

  let teamId: string | null = null
  if (teams.length > 0) {
    const teamMatch = findTeam(text, teams)
    if (teamMatch) {
      teamId = teamMatch.teamId
      text = text.replace(teamMatch.pattern, ' ')
    }
  }

  return {
    text: cleanTitle(text),
    due,
    preferredTime,
    tags,
    duration,
    teamId,
    priority,
  }
}
