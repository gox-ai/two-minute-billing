'use client'

import Script from 'next/script'
import { useId } from 'react'

/**
 * The Cloudflare Turnstile widget (audit M3.2).
 *
 * Renders ONLY when a site key is configured — the same rule the "Sign in with Google" button
 * follows, and for the same reason CLAUDE.md gives: a challenge box that cannot be solved
 * because no key is set is worse than no box, since the person cannot tell whether the problem
 * is them or us. Unconfigured, this returns null and the server skips the check, so the two
 * halves are never out of step.
 *
 * `cf-turnstile` writes its result into a hidden input named `turnstile_token`, which is what
 * the server action forwards. No client state to manage and nothing to wire up.
 */
export function Turnstile({ siteKey }: { siteKey?: string }) {
  const id = useId()
  if (!siteKey) return null
  return (
    <>
      <Script src="https://challenges.cloudflare.com/turnstile/v0/api.js" strategy="lazyOnload" />
      <div
        id={id}
        className="cf-turnstile"
        data-sitekey={siteKey}
        data-response-field-name="turnstile_token"
        // The widget paints its own surface, so it is told which way round the page is
        // rather than guessing — otherwise it renders a light box on a dark card.
        data-theme="auto"
      />
    </>
  )
}
