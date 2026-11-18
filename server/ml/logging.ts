/**
 * Local logging and graceful degradation.
 *
 * Every learning step in this system can fail for an ordinary reason — a missing
 * check-in, a half-recorded day, a model whose payload cannot be read. None of
 * those may break the user's ability to record what they actually did. This
 * module is the single place that decides how such a failure is reported and how
 * the caller recovers:
 *
 * - `mlLog` writes one plain line, locally, to the console and (optionally) to a
 *   file named by `ML_LOG_FILE`. Nothing is ever sent anywhere else.
 * - `safeRun` runs a piece of work and returns a documented fallback if it
 *   throws, logging the error instead of letting it propagate. Callers use it so
 *   a learning failure never blocks recording or serving.
 *
 * This module holds no model logic and never writes an observation.
 */

import { appendFileSync } from 'node:fs'

export type MlLogLevel = 'info' | 'warn' | 'error'

export interface MlLogEntry {
  at: number
  level: MlLogLevel
  event: string
  detail: string
}

const RING_MAX = 200
const ring: MlLogEntry[] = []

/** A short, safe description of an unknown thrown value. */
export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

function sink(entry: MlLogEntry): void {
  ring.push(entry)
  if (ring.length > RING_MAX) ring.shift()
}

/**
 * Write one local log line. File logging is opt-in through `ML_LOG_FILE` so
 * tests and normal runs never touch the filesystem unless asked to.
 */
export function mlLog(level: MlLogLevel, event: string, detail = ''): MlLogEntry {
  const entry: MlLogEntry = { at: Date.now(), level, event, detail }
  sink(entry)
  const line = `[ml:${level}] ${event}${detail ? ` — ${detail}` : ''}`
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.log(line)

  const file = process.env.ML_LOG_FILE
  if (file) {
    try {
      appendFileSync(file, `${new Date(entry.at).toISOString()} ${line}\n`, 'utf8')
    } catch {
      // A logging failure must never become a work failure.
    }
  }
  return entry
}


/**
 * Run `work`, returning `fallback` and logging the failure when it throws.
 * The caller always gets a usable value, so a broken learning step degrades
 * rather than stops.
 */
export function safeRun<T>(event: string, work: () => T, fallback: T): T {
  try {
    return work()
  } catch (error) {
    mlLog('error', event, describeError(error))
    return fallback
  }
}
