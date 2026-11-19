import { useState, type FormEvent, type ReactNode } from 'react'
import { api, errorMessage } from '@/api'
import { Logo } from './Logo'
import { Spinner } from './ui'
import {
  ArrowRightIcon,
  CalendarIcon,
  CheckIcon,
  EyeIcon,
  EyeOffIcon,
  LockIcon,
  MailIcon,
  SparklesIcon,
  UsersIcon,
} from './Icons'

type Mode = 'login' | 'signup' | 'forgot'

interface AuthScreenProps {
  onAuthed: () => Promise<void> | void
}

const FEATURES = [
  {
    icon: UsersIcon,
    title: 'Shared team lists',
    text: 'Plan work together and see progress as it happens.',
  },
  {
    icon: CheckIcon,
    title: 'Subtasks & comments',
    text: 'Break big goals down and keep the conversation in context.',
  },
  {
    icon: CalendarIcon,
    title: 'Due dates that help',
    text: 'Today, upcoming and overdue — at a glance.',
  },
]

function FieldIcon({ children }: { children: ReactNode }) {
  return (
    <span className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-slate-400">
      {children}
    </span>
  )
}

export default function AuthScreen({ onAuthed }: AuthScreenProps) {
  const [mode, setMode] = useState<Mode>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [remember, setRemember] = useState(true)
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Password reset (two-step) state.
  const [resetStage, setResetStage] = useState<'email' | 'code'>('email')
  const [resetCode, setResetCode] = useState('')
  const [devCode, setDevCode] = useState<string | null>(null)
  const [resetSuccess, setResetSuccess] = useState(false)

  const clearMessages = () => {
    setError(null)
    setNotice(null)
  }

  const switchMode = (next: Mode) => {
    setMode(next)
    clearMessages()
    setPassword('')
    setConfirm('')
    setResetStage('email')
    setDevCode(null)
    setResetCode('')
  }

  const submitAuth = async (event: FormEvent) => {
    event.preventDefault()
    clearMessages()

    if (mode === 'signup') {
      if (password.length < 8) return setError('Password must be at least 8 characters.')
      if (password !== confirm) return setError('Those passwords do not match.')
    }

    setBusy(true)
    try {
      if (mode === 'login') {
        await api.login(email, password, remember)
      } else {
        await api.signup(email, password, remember)
      }
      await onAuthed()
    } catch (err) {
      setError(errorMessage(err))
      setBusy(false)
    }
  }

  const requestCode = async (event: FormEvent) => {
    event.preventDefault()
    clearMessages()
    setBusy(true)
    try {
      const result = await api.forgot(email)
      setDevCode(result.resetCode ?? null)
      setResetCode(result.resetCode ?? '')
      setResetStage('code')
      if (!result.resetCode) {
        setNotice('If an account exists for that email, a reset code is on its way.')
      }
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const submitReset = async (event: FormEvent) => {
    event.preventDefault()
    clearMessages()
    if (password.length < 8) return setError('Password must be at least 8 characters.')
    if (password !== confirm) return setError('Those passwords do not match.')

    setBusy(true)
    try {
      await api.reset(resetCode, password)
      setResetSuccess(true)
      setMode('login')
      setPassword('')
      setConfirm('')
      setResetStage('email')
      setDevCode(null)
      setNotice('Password updated — sign in with your new password.')
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const title =
    mode === 'login' ? 'Welcome back' : mode === 'signup' ? 'Create your account' : 'Reset password'

  const subtitle =
    mode === 'login'
      ? 'Pick up right where you left off.'
      : mode === 'signup'
        ? 'Start with a personal list, then invite your team.'
        : resetStage === 'email'
          ? 'Enter your email and we will send a reset code.'
          : 'Choose a new password for your account.'

  return (
    <div className="flex min-h-full flex-col bg-canvas lg:flex-row">
      {/* Marketing panel */}
      <aside className="relative hidden w-[46%] flex-col justify-between overflow-hidden bg-slate-950 p-10 text-white lg:flex xl:p-14">
        <div className="bg-grid absolute inset-0 opacity-60" />
        <div className="absolute -top-32 -left-24 h-96 w-96 rounded-full bg-indigo-600/30 blur-3xl" />
        <div className="absolute -right-24 bottom-0 h-96 w-96 rounded-full bg-violet-600/25 blur-3xl" />

        <div className="relative">
          <Logo className="text-white" />
        </div>

        <div className="relative mt-14 max-w-md">
          <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/5 px-3 py-1 text-xs font-medium text-indigo-200 backdrop-blur">
            <SparklesIcon className="h-3.5 w-3.5" />
            Personal lists, shared momentum
          </div>
          <h1 className="text-4xl leading-tight font-bold tracking-tight xl:text-5xl">
            Get things done,
            <br />
            <span className="bg-gradient-to-r from-indigo-300 to-violet-300 bg-clip-text text-transparent">
              together.
            </span>
          </h1>
          <p className="mt-4 max-w-sm text-[15px] leading-relaxed text-slate-300">
            DUIT — Do It. Do It Smarter. A calm, focused task list for yourself, and a shared space
            for the people you work with.
          </p>

          <ul className="mt-10 space-y-5">
            {FEATURES.map(({ icon: Icon, title: featureTitle, text }) => (
              <li key={featureTitle} className="flex gap-4">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-white/5 text-indigo-300">
                  <Icon className="h-5 w-5" />
                </span>
                <div>
                  <p className="text-sm font-semibold">{featureTitle}</p>
                  <p className="mt-0.5 text-sm text-slate-400">{text}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>

        <div className="relative mt-12">
          <div className="rounded-2xl border border-white/10 bg-white/5 p-4 backdrop-blur">
            <div className="flex items-center justify-between text-xs text-slate-400">
              <span className="font-semibold text-slate-200">Website launch</span>
              <span className="rounded-full bg-emerald-400/15 px-2 py-0.5 text-emerald-300">
                On track
              </span>
            </div>
            <div className="mt-3 space-y-2">
              {['Finalise landing copy', 'Ship the new pricing page', 'Team review'].map(
                (item, index) => (
                  <div key={item} className="flex items-center gap-2.5 text-sm text-slate-300">
                    <span
                      className={`flex h-4 w-4 items-center justify-center rounded border ${
                        index < 2
                          ? 'border-indigo-400 bg-indigo-500 text-white'
                          : 'border-slate-600'
                      }`}
                    >
                      {index < 2 && <CheckIcon className="h-3 w-3" strokeWidth={3} />}
                    </span>
                    <span className={index < 2 ? 'text-slate-500 line-through' : ''}>{item}</span>
                  </div>
                ),
              )}
            </div>
          </div>
        </div>
      </aside>

      {/* Form panel */}
      <main className="flex flex-1 flex-col bg-canvas">
        <header className="flex items-center justify-between px-6 py-5 sm:px-10">
          <Logo className="lg:invisible" />
        </header>

        <div className="flex flex-1 items-center justify-center px-6 pb-14 sm:px-10">
          <div className="animate-in w-full max-w-sm">
            <h2 className="text-2xl font-bold tracking-tight">{title}</h2>
            <p className="mt-1.5 text-sm text-slate-500">{subtitle}</p>

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

            {mode === 'forgot' && resetStage === 'code' ? (
              <form onSubmit={submitReset} className="mt-6 space-y-4">
                {devCode && (
                  <div className="rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-3 text-xs leading-relaxed text-amber-800">
                    <span className="font-semibold">Development mode:</span> no email service is
                    configured, so your reset code is{' '}
                    <code className="rounded bg-amber-200/60 px-1 py-0.5 font-mono">
                      {devCode}
                    </code>{' '}
                    (also printed in the server console).
                  </div>
                )}
                <div>
                  <label className="label" htmlFor="reset-code">
                    Reset code
                  </label>
                  <div className="relative">
                    <FieldIcon>
                      <MailIcon className="h-4.5 w-4.5" />
                    </FieldIcon>
                    <input
                      id="reset-code"
                      className="field pr-3.5 pl-10 font-mono sm:text-xs"
                      value={resetCode}
                      onChange={(event) => setResetCode(event.target.value)}
                      placeholder="Paste your reset code"
                      autoComplete="one-time-code"
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
                  placeholder="At least 8 characters"
                />
                <PasswordField
                  id="confirm-new-password"
                  label="Confirm new password"
                  value={confirm}
                  onChange={setConfirm}
                  show={showPassword}
                  onToggleShow={() => setShowPassword((value) => !value)}
                  autoComplete="new-password"
                  placeholder="Repeat your password"
                />
                <button type="submit" className="btn-primary w-full" disabled={busy}>
                  {busy ? <Spinner /> : <LockIcon className="h-4 w-4" />}
                  Update password
                </button>
                <button
                  type="button"
                  className="btn-ghost w-full"
                  onClick={() => {
                    setResetStage('email')
                    clearMessages()
                  }}
                >
                  Use a different email
                </button>
              </form>
            ) : mode === 'forgot' ? (
              <form onSubmit={requestCode} className="mt-6 space-y-4">
                <div>
                  <label className="label" htmlFor="forgot-email">
                    Email address
                  </label>
                  <div className="relative">
                    <FieldIcon>
                      <MailIcon className="h-4.5 w-4.5" />
                    </FieldIcon>
                    <input
                      id="forgot-email"
                      type="email"
                      className="field pl-10"
                      value={email}
                      onChange={(event) => setEmail(event.target.value)}
                      placeholder="you@example.com"
                      autoComplete="email"
                      required
                    />
                  </div>
                </div>
                <button type="submit" className="btn-primary w-full" disabled={busy}>
                  {busy ? <Spinner /> : <ArrowRightIcon className="h-4 w-4" />}
                  Send reset code
                </button>
                <button type="button" className="btn-ghost w-full" onClick={() => switchMode('login')}>
                  Back to sign in
                </button>
              </form>
            ) : (
              <>
                <form onSubmit={submitAuth} className="mt-6 space-y-4">
                  <div>
                    <label className="label" htmlFor="email">
                      Email address
                    </label>
                    <div className="relative">
                      <FieldIcon>
                        <MailIcon className="h-4.5 w-4.5" />
                      </FieldIcon>
                      <input
                        id="email"
                        type="email"
                        className="field pl-10"
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
                    placeholder={mode === 'login' ? 'Your password' : 'At least 8 characters'}
                  />

                  {mode === 'signup' && (
                    <PasswordField
                      id="confirm-password"
                      label="Confirm password"
                      value={confirm}
                      onChange={setConfirm}
                      show={showPassword}
                      onToggleShow={() => setShowPassword((value) => !value)}
                      autoComplete="new-password"
                      placeholder="Repeat your password"
                    />
                  )}

                  <div className="flex items-center justify-between text-sm">
                    <label className="flex cursor-pointer items-center gap-2 text-slate-600 select-none">
                      <input
                        type="checkbox"
                        checked={remember}
                        onChange={(event) => setRemember(event.target.checked)}
                        className="h-4 w-4 rounded border-slate-300 text-indigo-600 accent-indigo-600"
                      />
                      Remember me
                    </label>
                    {mode === 'login' && (
                      <button
                        type="button"
                        onClick={() => switchMode('forgot')}
                        className="font-medium text-indigo-600 hover:text-indigo-500"
                      >
                        Forgot password?
                      </button>
                    )}
                  </div>

                  <button type="submit" className="btn-primary w-full" disabled={busy}>
                    {busy ? (
                      <Spinner />
                    ) : mode === 'login' ? (
                      <ArrowRightIcon className="h-4 w-4" />
                    ) : (
                      <SparklesIcon className="h-4 w-4" />
                    )}
                    {mode === 'login' ? 'Sign in' : 'Create account'}
                  </button>
                </form>

                {resetSuccess && mode === 'login' && (
                  <p className="mt-4 text-center text-xs text-slate-400">
                    Your old sessions were signed out for safety.
                  </p>
                )}

                <p className="mt-6 text-center text-sm text-slate-500">
                  {mode === 'login' ? 'New here?' : 'Already have an account?'}{' '}
                  <button
                    type="button"
                    onClick={() => switchMode(mode === 'login' ? 'signup' : 'login')}
                    className="font-semibold text-indigo-600 hover:text-indigo-500"
                  >
                    {mode === 'login' ? 'Create an account' : 'Sign in'}
                  </button>
                </p>
              </>
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
      <label className="label" htmlFor={id}>
        {label}
      </label>
      <div className="relative">
        <FieldIcon>
          <LockIcon className="h-4.5 w-4.5" />
        </FieldIcon>
        <input
          id={id}
          type={show ? 'text' : 'password'}
          className="field pr-11 pl-10"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          autoComplete={autoComplete}
          placeholder={placeholder}
          required
        />
        <button
          type="button"
          onClick={onToggleShow}
          className="absolute top-1/2 right-2 -translate-y-1/2 rounded-lg p-1.5 text-slate-400 transition hover:text-slate-600"
          aria-label={show ? 'Hide password' : 'Show password'}
          tabIndex={-1}
        >
          {show ? <EyeOffIcon className="h-4.5 w-4.5" /> : <EyeIcon className="h-4.5 w-4.5" />}
        </button>
      </div>
    </div>
  )
}
