import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseCookies } from './http'

test('parseCookies returns an empty object when the header is missing or empty', () => {
  assert.deepEqual(parseCookies(undefined), {})
  assert.deepEqual(parseCookies(''), {})
})

test('parseCookies decodes percent-encoded values', () => {
  assert.deepEqual(parseCookies('sid=abc%20123; theme=dark'), {
    sid: 'abc 123',
    theme: 'dark',
  })
})

test('parseCookies keeps a malformed value raw instead of throwing', () => {
  assert.deepEqual(parseCookies('sid=%ZZ; theme=dark'), {
    sid: '%ZZ',
    theme: 'dark',
  })
})

test('parseCookies keeps every cookie parseable when one value is malformed', () => {
  assert.deepEqual(parseCookies('theme=dark; sid=%E0%A4%A; lang=en'), {
    theme: 'dark',
    sid: '%E0%A4%A',
    lang: 'en',
  })
})

test('parseCookies ignores malformed pairs', () => {
  assert.deepEqual(parseCookies('novalue; =orphan;   ; sid=abc'), { sid: 'abc' })
})

test('parseCookies preserves additional equals signs in values', () => {
  assert.deepEqual(parseCookies('token=ab=cd; encoded=ab%3Dcd'), {
    token: 'ab=cd',
    encoded: 'ab=cd',
  })
})
