'use client'

import * as React from 'react'

/**
 * The value, settled — it only updates once `value` has stopped changing for
 * `delayMs`. Use it to keep a text field responsive while the expensive work it
 * drives (re-filtering thousands of rows, or a network round-trip) runs once the
 * operator stops typing rather than on every keystroke.
 *
 * The field itself must stay bound to the raw state, not to this: debouncing what
 * is *displayed* makes typing feel broken.
 */
export function useDebounced<T>(value: T, delayMs = 250): T {
  const [settled, setSettled] = React.useState(value)

  React.useEffect(() => {
    if (value === settled) return
    const t = setTimeout(() => setSettled(value), delayMs)
    return () => clearTimeout(t)
  }, [value, settled, delayMs])

  return settled
}
