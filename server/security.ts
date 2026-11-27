import type { NextFunction, Request, Response } from 'express'
import { fail } from './http'

/**
 * Small in-process security helpers. The app is a single Node process with a
 * local SQLite file, so no external rate-limit service or header package is
 * needed. Buckets are keyed by client IP and, for auth endpoints, the submitted
 * email so one shared IP does not lock out every account.
 */
interface Bucket {
  count: number
  resetAt: number
}

export interface RateLimiterOptions {
  name: string
  windowMs: number
  max: number
  identity?: (req: Request) => string
}

export function createRateLimiter(options: RateLimiterOptions) {
  const buckets = new Map<string, Bucket>()

  return (req: Request, res: Response, next: NextFunction): void => {
    const now = Date.now()
    const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown'
    const key = `${options.name}:${ip}:${options.identity?.(req) ?? ''}`
    const bucket = buckets.get(key)

    if (!bucket || now >= bucket.resetAt) {
      buckets.set(key, { count: 1, resetAt: now + options.windowMs })
    } else if (bucket.count >= options.max) {
      res.setHeader('Retry-After', `${Math.ceil((bucket.resetAt - now) / 1000)}`)
      fail(res, 429, 'Too many attempts. Please try again shortly.')
      return
    } else {
      bucket.count += 1
    }

    // Keep the map bounded without a timer; expired buckets are cheap to drop.
    if (buckets.size > 5000) {
      for (const [entryKey, entry] of buckets) {
        if (now >= entry.resetAt) buckets.delete(entryKey)
      }
    }

    next()
  }
}

const bodyText = (req: Request, field: string): string => {
  const value = (req.body as Record<string, unknown> | undefined)?.[field]
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

/** Ten attempts per 15 minutes for each email/IP pair. */
export const loginLimiter = createRateLimiter({
  name: 'login',
  windowMs: 15 * 60 * 1000,
  max: 10,
  identity: (req) => bodyText(req, 'email'),
})

/** Five accounts per 15 minutes for each IP. */
export const signupLimiter = createRateLimiter({
  name: 'signup',
  windowMs: 15 * 60 * 1000,
  max: 5,
  identity: (req) => bodyText(req, 'email'),
})

/** Five password resets per 15 minutes for each email/IP pair. */
export const resetLimiter = createRateLimiter({
  name: 'reset',
  windowMs: 15 * 60 * 1000,
  max: 5,
  identity: (req) => bodyText(req, 'email'),
})

/** Ten password confirmations per 15 minutes for each IP. */
export const passwordLimiter = createRateLimiter({
  name: 'password',
  windowMs: 15 * 60 * 1000,
  max: 10,
})

/** Standard headers for every response, including static assets and API errors. */
export function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('Permissions-Policy', 'accelerometer=(), camera=(), geolocation=(), microphone=()')
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "object-src 'none'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "font-src 'self' data:",
      "img-src 'self' data:",
      "connect-src 'self' ws: wss:",
    ].join('; '),
  )
  next()
}
