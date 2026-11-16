import type { DatabaseSync } from 'node:sqlite'
import { CHECKIN_ANSWER_KEYS, listCheckins, type CheckinAnswerKey } from '../checkins-store'
import {
  SUB_SCORE_NAMES,
  readinessFromCheckin,
  type SubScoreName,
} from './readiness'

/**
 * Recent-days context (Phase 2a).
 *
 * Looks at the last couple of weeks and says, in plain words, what has been
 * changing per sub-score, and whether a single field has been stuck at one end
 * for several days. It only speaks up when a pattern is clear, and it always
 * frames what it finds as an association, never a cause.
 */

/** Minimum points of change (on the 0–100 sub-score) before a trend is shown. */
export const CLEAR_DELTA = 12
/** Days in the recent window. */
export const RECENT_WINDOW = 3
/** Days in the comparison window just before it. */
export const PREVIOUS_WINDOW = 7
/** Consecutive low/high days before a streak is shown. */
export const MIN_STREAK = 3
/** How far back to look for streaks. */
export const STREAK_SCAN = 10

export interface SubScoreTrend {
  name: SubScoreName
  direction: 'rising' | 'falling' | 'steady'
  recentAverage: number
  previousAverage: number
  delta: number
  /** Plain line, or null when the change is not clear enough to mention. */
  line: string | null
}

export interface FieldStreak {
  key: CheckinAnswerKey
  days: number
  direction: 'low' | 'high'
  line: string
}

export interface RecentContextResult {
  available: boolean
  trends: SubScoreTrend[]
  streaks: FieldStreak[]
  /** The clear lines only, ready to show. */
  lines: string[]
}

const SUB_SCORE_LABELS: Record<SubScoreName, string> = {
  physical: 'Physical energy',
  mental: 'Mood and focus',
  capacity: 'Capacity',
}

const STREAK_PHRASES: Record<CheckinAnswerKey, { low: string; high: string }> = {
  feeling: { low: 'feeling low', high: 'in good spirits' },
  energy: { low: 'low energy', high: 'high energy' },
  motivation: { low: 'low motivation', high: 'strong motivation' },
  sleep: { low: 'poor sleep', high: 'good sleep' },
  stress: { low: 'high stress', high: 'low stress' },
  free_time: { low: 'limited free time', high: 'plenty of free time' },
  focus: { low: 'scattered focus', high: 'sharp focus' },
  body: { low: 'feeling off physically', high: 'feeling good physically' },
  workload: { low: 'a heavy workload', high: 'a light workload' },
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1)
}

function subScoreTrends(historyDescending: ReturnType<typeof listCheckins>): SubScoreTrend[] {
  const trends: SubScoreTrend[] = []
  for (const name of SUB_SCORE_NAMES) {
    const recent: number[] = []
    const previous: number[] = []
    let index = 0
    for (const row of historyDescending) {
      const sub = readinessFromCheckin(row).subScores.find((item) => item.name === name)
      if (!sub || sub.score === null) continue
      if (index < RECENT_WINDOW) recent.push(sub.score)
      else if (index < RECENT_WINDOW + PREVIOUS_WINDOW) previous.push(sub.score)
      else break
      index += 1
    }
    if (recent.length === 0 || previous.length < 2) continue
    const recentAverage = recent.reduce((a, b) => a + b, 0) / recent.length
    const previousAverage = previous.reduce((a, b) => a + b, 0) / previous.length
    const delta = Math.round(recentAverage - previousAverage)
    let direction: SubScoreTrend['direction'] = 'steady'
    let line: string | null = null
    if (delta >= CLEAR_DELTA) {
      direction = 'rising'
      line = `${SUB_SCORE_LABELS[name]} has been higher than the week before.`
    } else if (delta <= -CLEAR_DELTA) {
      direction = 'falling'
      line = `${SUB_SCORE_LABELS[name]} has been lower than the week before.`
    }
    trends.push({ name, direction, recentAverage: Math.round(recentAverage), previousAverage: Math.round(previousAverage), delta, line })
  }
  return trends
}

function fieldStreaks(historyDescending: ReturnType<typeof listCheckins>): FieldStreak[] {
  const streaks: FieldStreak[] = []
  const recent = historyDescending.slice(0, STREAK_SCAN)
  for (const key of CHECKIN_ANSWER_KEYS) {
    let lowRun = 0
    let highRun = 0
    let bestLow = 0
    let bestHigh = 0
    for (const row of recent) {
      const value = row[key]
      if (value === null) {
        lowRun = 0
        highRun = 0
        continue
      }
      const goodness = 6 - value
      if (goodness <= 2) {
        lowRun += 1
        highRun = 0
      } else if (goodness >= 4) {
        highRun += 1
        lowRun = 0
      } else {
        lowRun = 0
        highRun = 0
      }
      bestLow = Math.max(bestLow, lowRun)
      bestHigh = Math.max(bestHigh, highRun)
    }
    if (bestLow >= MIN_STREAK) {
      streaks.push({
        key,
        days: bestLow,
        direction: 'low',
        line: `${capitalize(STREAK_PHRASES[key].low)} ${bestLow} days in a row.`,
      })
    } else if (bestHigh >= MIN_STREAK) {
      streaks.push({
        key,
        days: bestHigh,
        direction: 'high',
        line: `${capitalize(STREAK_PHRASES[key].high)} ${bestHigh} days in a row.`,
      })
    }
  }
  return streaks
}

/**
 * Look at the recent days and report only clear patterns. `date` is the day the
 * summary is for; only days before it are considered, so an edit today cannot
 * change what "recent" meant yesterday.
 */
export function recentContext(db: DatabaseSync, userId: number, date: string): RecentContextResult {
  const historyDescending = listCheckins(db, userId, 400)
    .filter((row) => row.date < date && row.skipped !== 1)
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))

  if (historyDescending.length < MIN_STREAK) {
    return { available: false, trends: [], streaks: [], lines: [] }
  }

  const trends = subScoreTrends(historyDescending)
  const streaks = fieldStreaks(historyDescending)
  const lines = [
    ...streaks.map((streak) => streak.line),
    ...trends.filter((trend) => trend.line).map((trend) => trend.line as string),
  ]
  return { available: lines.length > 0, trends, streaks, lines }
}
