import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { NextFunction, Request, Response } from 'express'
import { createRateLimiter, securityHeaders } from './security'

function request(email?: string): Request {
  return {
    ip: '127.0.0.1',
    socket: { remoteAddress: '127.0.0.1' },
    body: email ? { email } : {},
  } as unknown as Request
}

function response() {
  const headers: Record<string, string> = {}
  const result = {
    headers,
    statusCode: 200,
    body: undefined as unknown,
    setHeader(name: string, value: string) {
      headers[name.toLowerCase()] = value
    },
    status(code: number) {
      result.statusCode = code
      return result
    },
    json(value: unknown) {
      result.body = value
      return result
    },
  }
  return result as unknown as Response & typeof result
}

test('a rate limiter blocks only after the configured number of attempts', () => {
  const limiter = createRateLimiter({
    name: 'test-login',
    windowMs: 60_000,
    max: 2,
    identity: (req) => String((req.body as { email?: string }).email ?? '').toLowerCase(),
  })
  let nextCalls = 0
  const next = (() => {
    nextCalls += 1
  }) as NextFunction

  limiter(request('one@example.com'), response(), next)
  limiter(request('ONE@example.com'), response(), next)
  assert.equal(nextCalls, 2)

  const blocked = response()
  limiter(request('one@example.com'), blocked, next)
  assert.equal(nextCalls, 2)
  assert.equal(blocked.statusCode, 429)
  assert.match(blocked.headers['retry-after'] ?? '', /^\d+$/)

  // A different email has its own bucket.
  limiter(request('two@example.com'), response(), next)
  assert.equal(nextCalls, 3)
})

test('security headers lock down framing, sniffing and external assets', () => {
  const res = response()
  let nextCalls = 0
  securityHeaders(request(), res, (() => {
    nextCalls += 1
  }) as NextFunction)

  assert.equal(nextCalls, 1)
  assert.equal(res.headers['x-content-type-options'], 'nosniff')
  assert.equal(res.headers['x-frame-options'], 'DENY')
  assert.equal(res.headers['referrer-policy'], 'no-referrer')
  assert.match(res.headers['content-security-policy'] ?? '', /default-src 'self'/)
  assert.match(res.headers['content-security-policy'] ?? '', /frame-ancestors 'none'/)
  assert.doesNotMatch(res.headers['content-security-policy'] ?? '', /script-src[^;]*unsafe-inline/)
})
