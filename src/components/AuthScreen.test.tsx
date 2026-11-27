import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import AuthScreen from './AuthScreen'

test('the login page follows the reference layout and copy', () => {
  const html = renderToStaticMarkup(<AuthScreen onAuthed={async () => {}} />)

  assert.match(html, /DUIT<span class="text-indigo-500">\.<\/span>/)
  assert.match(html, /text-\[26px\] font-extrabold tracking-tight text-\[#15181E\]/)
  assert.match(html, /Do it Smarter/)
  assert.doesNotMatch(html, /Do It\./i)
  assert.match(html, /Welcome back/)
  assert.match(html, /Log in to see your day\./)
  assert.match(html, /New here\?/)
  assert.match(html, /Create account/)
  assert.match(html, />Email</)
  assert.match(html, />Password</)
  assert.doesNotMatch(html, />Show</)
  assert.match(html, /Keep me logged in/)
  assert.doesNotMatch(html, /Forgot password\?/)
  assert.match(html, />Log in</)
  assert.match(html, /bg-\[#F6F6F4\]/)
  assert.match(html, /class="auth-primary"/)
  assert.match(html, /text-\[#D9480F\]/)
  assert.match(html, /Your day, sorted\./)
  assert.match(html, /Tasks, suggested times, and your teams in one calm place\./)
})

test('the signup page follows the reference layout and copy', () => {
  const html = renderToStaticMarkup(
    <AuthScreen onAuthed={async () => {}} initialMode="signup" />
  )

  assert.doesNotMatch(html, /Do It\./i)
  assert.match(html, /Do it Smarter/)
  assert.match(html, /Create your account/)
  assert.match(html, /Let(?:&#x27;|')s get you started\./)
  assert.match(html, /Already have an account\?/)
  assert.match(html, />Log in</)
  assert.match(html, />Your name</)
  assert.match(html, />Email</)
  assert.match(html, />Password</)
  assert.match(html, /Use at least 8 characters\./)
  assert.match(html, />Confirm password</)
  assert.match(html, /id="confirm-password"/)
  assert.match(html, /Repeat your password/)
  assert.match(html, /Create account/)
  assert.match(html, /Start with one task,/)
})

test('the decorative notes keep the app rule that there is no Urgent priority', () => {
  const html = renderToStaticMarkup(<AuthScreen onAuthed={async () => {}} />)
  assert.doesNotMatch(html, /Urgent/)
  assert.doesNotMatch(html, />High</)
  assert.doesNotMatch(html, />Medium</)
  assert.doesNotMatch(html, />Low</)
  assert.doesNotMatch(html, /sticky-note[^>]*border-\[?/)
  assert.match(html, /text-\[#D9480F\]/)
  assert.doesNotMatch(html, /bg-(rose|sky|amber|yellow)-500/)
  assert.match(html, /sticky-tear/)
  assert.match(html, /#work/)
  assert.match(html, />Anytime</)
})
