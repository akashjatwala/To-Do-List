import type { Request, Response } from 'express'
import { parseLocalDate } from './checkins-store'

export interface AuthedRequest extends Request {
  userId?: number
}

export const SESSION_COOKIE = 'sid'

/** Express 5 types route params as string | string[]; normalise to a single string. */
export function param(req: Request, name: string): string {
  const value = req.params[name]
  if (Array.isArray(value)) return value[0] ?? ''
  return value ?? ''
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!header) return out
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index === -1) continue
    const key = part.slice(0, index).trim()
    if (!key) continue
    const raw = part.slice(index + 1).trim()
    try {
      out[key] = decodeURIComponent(raw)
    } catch {
      // A malformed escape sequence in one cookie must not turn the whole
      // request into a 500. Keep the raw value; auth lookups simply miss it.
      out[key] = raw
    }
  }
  return out
}

export function setSessionCookie(res: Response, token: string, remember: boolean): void {
  const maxAge = remember ? 1000 * 60 * 60 * 24 * 30 : undefined
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    ...(maxAge ? { maxAge } : {}),
  })
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE, { path: '/' })
}

export function fail(res: Response, status: number, message: string): void {
  res.status(status).json({ error: message })
}

export function badRequest(res: Response, message: string): void {
  fail(res, 400, message)
}

export function unauthorized(res: Response, message = 'Please sign in to continue.'): void {
  fail(res, 401, message)
}

export function forbidden(res: Response, message = 'You do not have permission to do that.'): void {
  fail(res, 403, message)
}

export function notFound(res: Response, message = 'Not found.'): void {
  fail(res, 404, message)
}

/** Trimmed, length-checked text. Returns null when invalid. */
export function text(value: unknown, max: number, min = 1): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed.length < min || trimmed.length > max) return null
  return trimmed
}

/** Validate an optional timestamp (ms since epoch). Returns undefined when absent. */
export function optionalTimestamp(value: unknown): number | null | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return value
}

/** The server's local calendar date, `YYYY-MM-DD`. */
export function localDateString(date = new Date()): string {
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/** Read a validated local date from a query string (GET) or body (other verbs). */
export function resolveDate(req: Request, field = 'date'): string | null {
  const value = req.method === 'GET' ? req.query[field] : (req.body as Record<string, unknown>)?.[field]
  if (value === undefined || value === null || value === '') return null
  return parseLocalDate(value)
}
