import { useState, type CSSProperties, type FormEvent, type ReactNode } from 'react'
import { api, errorMessage } from '@/api'
import { ArrowRightIcon, LockIcon, MailIcon, UsersIcon } from './Icons'
import { Spinner } from './ui'

type Mode = 'login' | 'signup' | 'forgot'

interface AuthScreenProps {
  onAuthed: () => Promise<void> | void
  initialMode?: Mode
}

const AUTH_LABEL = 'mb-2 block text-sm font-semibold text-[#15181E]'
const AUTH_INPUT =
  'auth-input field h-12 rounded-xl border-slate-200 bg-white py-0 pl-11 pr-3 text-sm shadow-sm focus:border-[#D9480F] focus:ring-[#D9480F]/10'

/** Decorative notes use the same paper, tape and pin language as the real board. */
const DECOR_NOTES = [
  {
    text: 'Finish quarterly report',
    tag: 'work',
    time: 'Anytime',
    meta: '1 h 30',
    note: 'bg-[#FBD0CA] text-[#7f1d1d]',
    tape: 'bg-rose-100/90',
    tilt: '-4deg',
    left: '7%',
    top: '22%',
    width: '45%',
  },
  {
    text: 'Review pull requests',
    tag: 'code',
    time: 'Anytime',
    meta: '45 min',
    note: 'bg-[#FCDDB8] text-[#713f12]',
    tape: 'bg-amber-100/90',
    tilt: '3deg',
    left: '44%',
    top: '15%',
    width: '45%',
  },
  {
    text: 'Read 20 pages',
    tag: 'learning',
    time: 'Anytime',
    meta: '10 min',
    note: 'bg-[#CFE3F7] text-[#27557D]',
    tape: 'bg-sky-100/90',
    tilt: '2deg',
    left: '20%',
    top: '48%',
    width: '45%',
  },
  {
    text: 'Book dentist appointment',
    tag: 'personal',
    time: 'Sat 21 Nov',
    meta: '10 min',
    note: 'bg-[#F5E9A8] text-[#6b4f1d]',
    tape: 'bg-amber-100/90',
    tilt: '-3deg',
    left: '56%',
    top: '42%',
    width: '45%',
  },
]

function AuthLogo({ className = '' }: { className?: string }) {
  return (
    <span className={`inline-flex flex-col ${className}`}>
      <span className="text-[26px] font-extrabold tracking-tight text-[#15181E] leading-none">
        DUIT<span className="text-indigo-500">.</span>
      </span>
      <span className="mt-1 text-[11px] font-medium tracking-wide text-slate-400">
        Do it Smarter
      </span>
    </span>
  )
}

function FieldIcon({ children }: { children: ReactNode }) {
  return (
    <span className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-slate-400">
      {children}
    </span>
  )
}

function AuthPin() {
  return (
    <span
      aria-hidden="true"
      className="sticky-pin pointer-events-none absolute -top-3 left-1/2 z-20 -translate-x-1/2 text-[#D9480F]"
    >
      <svg viewBox="0 0 24 24" className="h-5 w-5 drop-shadow-sm" fill="none">
        <ellipse cx="12" cy="21.5" rx="3.2" ry="1.1" className="fill-slate-900/15" />
        <path d="M12 15.5v5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        <circle cx="12" cy="9.5" r="6.2" fill="currentColor" />
        <circle cx="9.9" cy="7.4" r="2.1" className="fill-white/60" />
      </svg>
    </span>
  )
}

function AuthIllustration({ headline, subtitle }: { headline: string; subtitle?: string }) {
  return (
    <aside className="auth-illustration relative hidden w-[52%] flex-col bg-white px-10 py-9 lg:flex xl:px-14">
      <AuthLogo />

      <div className="auth-notes relative flex flex-1 items-center justify-center py-6">
        <div aria-hidden="true" className="auth-notes-canvas pointer-events-none relative aspect-[1.28/1] w-full max-w-[34rem]">
          {DECOR_NOTES.map((note) => (
            <article
              key={note.text}
              className={`sticky-note absolute flex min-h-[9rem] flex-col px-3.5 pt-6 pb-3 ${note.note}`}
              style={
                {
                  '--tilt': note.tilt,
                  left: note.left,
                  top: note.top,
                  width: note.width,
                } as CSSProperties
              }
            >
              <AuthPin />
              <span
                className={`sticky-tape pointer-events-none absolute -top-2.5 left-1/2 h-4 w-16 -translate-x-1/2 -rotate-2 rounded-[3px] opacity-95 ${note.tape}`}
              />
              <div className="mt-1.5 flex items-start gap-2">
                <span className="mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border-2 border-current/50" />
                <p className="text-[11px] leading-snug font-bold">{note.text}</p>
              </div>
              <span className="mt-2 self-start rounded-full bg-white/70 px-1.5 py-0.5 text-[8px] font-bold ring-1 ring-black/5">
                #{note.tag}
              </span>
              <span className="sticky-tear mt-auto block" />
              <div className="mt-1 flex items-center justify-between gap-2 text-[8px] font-bold">
                <span className="truncate opacity-80">{note.time}</span>
                <span>{note.meta}</span>
              </div>
            </article>
          ))}
        </div>
      </div>

      <div className="max-w-lg pb-1">
        <h1 className="text-3xl leading-tight font-bold tracking-tight text-[#15181E] xl:text-4xl">
          {headline}
        </h1>
        {subtitle && (
          <p className="mt-2 max-w-md text-sm leading-relaxed text-slate-500">{subtitle}</p>
        )}
      </div>
    </aside>
  )
}

export default function AuthScreen({ onAuthed, initialMode = 'login' }: AuthScreenProps) {
  const [mode, setMode] = useState<Mode>(initialMode)
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [remember, setRemember] = useState(true)
  const [showPassword, setShowPassword] = useState(false)
  const [showConfirm, setShowConfirm] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const clearMessages = () => {
    setError(null)
    setNotice(null)
  }

  const switchMode = (next: Mode) => {
    setMode(next)
    clearMessages()
    setPassword('')
    setConfirm('')
    setShowPassword(false)
    setShowConfirm(false)
  }

  const submitAuth = async (event: FormEvent) => {
    event.preventDefault()
    clearMessages()

    if (mode === 'signup') {
      if (!name.trim()) return setError('Please enter your name.')
      if (name.trim().length > 60) return setError('Name must be 60 characters or fewer.')
      if (password.length < 8) return setError('Password must be at least 8 characters.')
      if (password !== confirm) return setError('Those passwords do not match.')
    }

    setBusy(true)
    try {
      if (mode === 'login') {
        await api.login(email, password, remember)
      } else {
        await api.signup(email, name.trim(), password, remember)
      }
      await onAuthed()
    } catch (err) {
      setError(errorMessage(err))
      setBusy(false)
    }
  }

  const submitReset = async (event: FormEvent) => {
    event.preventDefault()
    clearMessages()
    if (!email.trim()) return setError('Please enter your email.')
    if (password.length < 8) return setError('Password must be at least 8 characters.')
    if (password !== confirm) return setError('Those passwords do not match.')

    setBusy(true)
    try {
      await api.reset(email.trim(), password)
      switchMode('login')
      setNotice('Password updated — sign in with your new password.')
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const title =
    mode === 'login'
      ? 'Welcome back'
      : mode === 'signup'
        ? 'Create your account'
        : 'Reset your password'

  const subtitle =
    mode === 'login'
      ? 'Log in to see your day.'
      : mode === 'signup'
        ? "Let's get you started."
        : 'Enter your email and choose a new password.'

  const switchPrompt =
    mode === 'login'
      ? { text: 'New here?', action: 'Create account', next: 'signup' as Mode }
      : mode === 'signup'
        ? { text: 'Already have an account?', action: 'Log in', next: 'login' as Mode }
        : null

  return (
    <div className="auth-page flex min-h-full bg-white lg:flex-row">
      <AuthIllustration
        headline={
          mode === 'signup'
            ? 'Start with one task,'
            : mode === 'forgot'
              ? 'Almost there,'
              : 'Your day, sorted.'
        }
        subtitle={
          mode === 'signup'
            ? 'Tasks, suggested times, and your teams in one calm place.'
            : mode === 'forgot'
              ? "Pick a new password and you're back in."
              : undefined
        }
      />

      <main className="auth-main flex min-h-full flex-1 flex-col bg-[#F6F6F4]">
        <header className="auth-header flex items-center justify-between gap-3 px-6 py-7 sm:px-10">
          <AuthLogo className="lg:invisible" />
          {switchPrompt && (
            <p className="text-right text-xs font-medium text-slate-500 sm:text-sm">
              {switchPrompt.text}{' '}
              <button
                type="button"
                onClick={() => switchMode(switchPrompt.next)}
                className="font-bold text-[#D9480F] transition hover:text-[#C23E0C]"
              >
                {switchPrompt.action}
              </button>
            </p>
          )}
        </header>

        <div className="auth-content flex flex-1 items-center justify-center px-6 pb-10 sm:px-10">
          <div className="animate-in w-full max-w-[25.75rem]">
            <h2 className="text-3xl leading-tight font-bold tracking-tight text-[#15181E]">{title}</h2>
            <p className="mt-2 text-sm text-slate-500">{subtitle}</p>

            {notice && (
              <div className="mt-5 rounded-xl border border-emerald-200 bg-emerald-50 px-3.5 py-2.5 text-sm text-emerald-700">
                {notice}
              </div>
            )}

            {error && (
              <div
                role="alert"
                className="mt-5 rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-sm text-rose-700"
              >
                {error}
              </div>
            )}

            {mode === 'forgot' ? (
              <form onSubmit={submitReset} className="auth-form mt-7 space-y-4">
                <div>
                  <label className={AUTH_LABEL} htmlFor="reset-email">
                    Email
                  </label>
                  <div className="relative">
                    <FieldIcon>
                      <MailIcon className="h-4.5 w-4.5" />
                    </FieldIcon>
                    <input
                      id="reset-email"
                      type="email"
                      className={AUTH_INPUT}
                      value={email}
                      onChange={(event) => setEmail(event.target.value)}
                      placeholder="you@example.com"
                      autoComplete="email"
                      required
                    />
                  </div>
                </div>
                <PasswordField
                  id="new-password"
                  label="New password"
                  value={password}
                  onChange={setPassword}
                  show={showPassword}
                  onToggleShow={() => setShowPassword((value) => !value)}
                  autoComplete="new-password"
                  placeholder="Use at least 8 characters."
                />
                <PasswordField
                  id="confirm-password"
                  label="Confirm password"
                  value={confirm}
                  onChange={setConfirm}
                  show={showConfirm}
                  onToggleShow={() => setShowConfirm((value) => !value)}
                  autoComplete="new-password"
                  placeholder="Confirm your password"
                />
                <button type="submit" className="auth-primary" disabled={busy}>
                  {busy ? <Spinner /> : <LockIcon className="h-4 w-4" />}
                  Reset password
                </button>
                <button
                  type="button"
                  className="w-full py-1 text-xs font-semibold text-slate-500 transition hover:text-[#D9480F]"
                  onClick={() => switchMode('login')}
                >
                  Back to log in
                </button>
              </form>
            ) : (
                <form onSubmit={submitAuth} className="auth-form mt-7 space-y-4">
                  {mode === 'signup' && (
                    <div>
                      <label className={AUTH_LABEL} htmlFor="name">
                        Your name
                      </label>
                      <input
                        id="name"
                        type="text"
                        className="auth-input field h-12 rounded-xl border-slate-200 bg-white py-0 text-sm shadow-sm focus:border-[#D9480F] focus:ring-[#D9480F]/10"
                        value={name}
                        onChange={(event) => setName(event.target.value)}
                        placeholder="Your name"
                        autoComplete="name"
                        maxLength={60}
                        required
                      />
                    </div>
                  )}

                  <div>
                    <label className={AUTH_LABEL} htmlFor="email">
                      Email
                    </label>
                    <div className="relative">
                      <FieldIcon>
                        <MailIcon className="h-4.5 w-4.5" />
                      </FieldIcon>
                      <input
                        id="email"
                        type="email"
                        className={AUTH_INPUT}
                        value={email}
                        onChange={(event) => setEmail(event.target.value)}
                        placeholder="you@example.com"
                        autoComplete="email"
                        required
                      />
                    </div>
                  </div>

                  <PasswordField
                    id="password"
                    label="Password"
                    value={password}
                    onChange={setPassword}
                    show={showPassword}
                    onToggleShow={() => setShowPassword((value) => !value)}
                    autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                    placeholder={mode === 'login' ? 'Your password' : 'Use at least 8 characters.'}
                  />

                  {mode === 'signup' && (
                    <PasswordField
                      id="confirm-password"
                      label="Confirm password"
                      value={confirm}
                      onChange={setConfirm}
                      show={showConfirm}
                      onToggleShow={() => setShowConfirm((value) => !value)}
                      autoComplete="new-password"
                      placeholder="Confirm your password"
                    />
                  )}

                  <div className="flex items-center justify-between gap-3 pt-1 text-xs">
                    <label className="flex cursor-pointer items-center gap-2 text-slate-600 select-none">
                      <input
                        type="checkbox"
                        checked={remember}
                        onChange={(event) => setRemember(event.target.checked)}
                        className="h-4 w-4 rounded border-slate-300 accent-[#D9480F]"
                      />
                      Keep me logged in
                    </label>
                    {mode === 'login' && (
                      <button
                        type="button"
                        onClick={() => switchMode('forgot')}
                        className="font-semibold text-[#D9480F] transition hover:text-[#C23E0C]"
                      >
                        Forgot password?
                      </button>
                    )}
                  </div>

                  <button type="submit" className="auth-primary" disabled={busy}>
                    {busy ? (
                      <Spinner />
                    ) : mode === 'login' ? (
                      <ArrowRightIcon className="h-4 w-4" />
                    ) : (
                      <UsersIcon className="h-4 w-4" />
                    )}
                    {mode === 'login' ? 'Log in' : 'Create account'}
                  </button>
                </form>
            )}
          </div>
        </div>
      </main>
    </div>
  )
}

function PasswordField({
  id,
  label,
  value,
  onChange,
  show,
  onToggleShow,
  autoComplete,
  placeholder,
}: {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  show: boolean
  onToggleShow: () => void
  autoComplete: string
  placeholder: string
}) {
  return (
    <div>
      <label className={AUTH_LABEL} htmlFor={id}>
        {label}
      </label>
      <div className="relative">
        <FieldIcon>
          <LockIcon className="h-4.5 w-4.5" />
        </FieldIcon>
        <input
          id={id}
          type={show ? 'text' : 'password'}
          className={`${AUTH_INPUT} ${value ? 'pr-14' : 'pr-3'}`}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          autoComplete={autoComplete}
          placeholder={placeholder}
          required
        />
        {value.length > 0 && (
          <button
            type="button"
            onClick={onToggleShow}
            className="absolute top-1/2 right-3 -translate-y-1/2 text-xs font-semibold text-[#D9480F] transition hover:text-[#C23E0C]"
            aria-label={show ? 'Hide password' : 'Show password'}
            tabIndex={-1}
          >
            {show ? 'Hide' : 'Show'}
          </button>
        )}
      </div>
    </div>
  )
}
