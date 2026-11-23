import { useEffect, useState } from 'react'

/** A ticking clock for the header, independent of render time. */
export function useHeaderClock() {
  const [now, setNow] = useState(() => new Date())

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 10_000)
    return () => window.clearInterval(timer)
  }, [])

  return {
    currentHour: now.getHours(),
    clockLabel: `${`${now.getHours()}`.padStart(2, '0')}:${`${now.getMinutes()}`.padStart(2, '0')}`,
  }
}
