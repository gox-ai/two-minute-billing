import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

/**
 * Where CSP violations land (audit M6).
 *
 * ── WHY THIS HAS TO EXIST BEFORE THE POLICY CAN BE ENFORCED ─────────────────────
 * The dashboard's CSP ships report-ONLY, on sound reasoning: an incomplete `connect-src`
 * allow-list does not degrade a checkout page, it breaks it, so the policy waits until a real
 * payment run says the host list is complete. But the policy named no reporting destination at
 * all, so every violation went to the browser console of whoever happened to be looking. There
 * was no way to learn the host list, which meant the report-only phase could never end. A
 * policy that reports into the void is documentation, not an alarm.
 *
 * ── WHY IT IS UNAUTHENTICATED, AND WHY THAT IS SAFE ─────────────────────────────
 * The browser posts these itself, with no session and no CSRF token, so requiring auth would
 * mean receiving nothing. That makes it writable by anyone — so it stores NOTHING and trusts
 * NOTHING. It logs a fixed set of fields it has bounded itself, and answers 204 regardless.
 * The worst an abuser achieves is noise in a log, which is why the payload is truncated and the
 * shape is never echoed back.
 *
 * ── WHY IT STAYS AFTER ENFORCEMENT ──────────────────────────────────────────────
 * The allow-list is only ever as complete as the flows someone exercised. A path nobody drove
 * during the migration can still violate in production, and without a live report sink the
 * first sign of that is a customer saying checkout is broken. `report-to` is not scaffolding.
 */

/** Report-only bodies arrive in two shapes depending on the browser and the directive used. */
interface LegacyReport {
  'csp-report'?: Record<string, unknown>
}

const FIELDS = [
  'document-uri', 'documentURL', 'violated-directive', 'effectiveDirective',
  'effective-directive', 'blocked-uri', 'blockedURL', 'disposition', 'status-code',
] as const

/** Truncate anything that reaches a log: these values are attacker-supplied. */
const clip = (v: unknown, max = 300) =>
  typeof v === 'string' ? v.slice(0, max) : typeof v === 'number' || typeof v === 'boolean' ? v : undefined

export async function POST(req: NextRequest) {
  try {
    const raw = (await req.json()) as LegacyReport | LegacyReport[] | Record<string, unknown>
    // `report-uri` sends `{ "csp-report": {...} }`; `report-to`/Reporting API sends an ARRAY of
    // `{ type, url, body }`. Both are handled rather than assuming one, because which arrives
    // depends on the browser and would otherwise look like "reporting does not work".
    const items = Array.isArray(raw) ? raw : [raw]
    for (const item of items) {
      const body =
        (item as LegacyReport)['csp-report'] ??
        ((item as { body?: Record<string, unknown> }).body as Record<string, unknown> | undefined) ??
        (item as Record<string, unknown>)
      const picked: Record<string, unknown> = {}
      for (const f of FIELDS) {
        const v = clip(body?.[f])
        if (v !== undefined) picked[f] = v
      }
      // One line per violation, greppable by the directive that fired — which is the question
      // anyone closing the allow-list actually asks.
      console.warn('[csp-violation]', JSON.stringify(picked))
    }
  } catch {
    // A malformed body is not worth a 400: the sender is a browser doing its best, and an
    // error status here would put a failed request in the console of an innocent page.
  }
  // 204 always. The browser does nothing with the response, and saying anything else only
  // tells an abuser whether their probe registered.
  return new NextResponse(null, { status: 204 })
}
