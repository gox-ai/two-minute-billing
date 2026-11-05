/**
 * Live EU VAT-ID validation via VIES (VAT Information Exchange System) — the
 * real implementation behind the `TaxIdValidator` interface (see tax-id.ts).
 *
 * VIES is the EU Commission's cross-border VAT-number lookup. A `valid` result
 * is what legally permits the B2B reverse-charge (seller charges 0% VAT, buyer
 * self-accounts). It only knows EU member-state numbers, so anything outside the
 * EU set resolves to 'undetermined' — we can't confirm it, and must not silently
 * treat it as valid. The service is also famously flaky (member-state backends go
 * down independently), so any transport/timeout/5xx error is 'undetermined' too:
 * validation failures must never block customer creation or invoicing.
 */
import { config } from '@/platform/config'
import type { TaxIdValidator, VatNumberStatus } from './tax-id'
import { createLogger } from '@/platform/logger'

const log = createLogger('customers.vies')

// EU member states in VIES vocabulary. Note Greece is `EL` (not ISO `GR`), and
// Northern Ireland VAT numbers use the `XI` prefix post-Brexit.
const VIES_COUNTRIES = new Set([
  'AT', 'BE', 'BG', 'CY', 'CZ', 'DE', 'DK', 'EE', 'EL', 'ES', 'FI', 'FR', 'HR',
  'HU', 'IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'PL', 'PT', 'RO', 'SE', 'SI',
  'SK', 'XI',
])

/** Map an ISO-3166 alpha-2 country to its VIES code (Greece: GR → EL). */
function toViesCountry(cc: string): string {
  const up = cc.trim().toUpperCase()
  return up === 'GR' ? 'EL' : up
}

/**
 * Split a raw VAT id into (countryCode, number). The country prefix embedded in
 * the VAT number wins over the customer's `country` field (a French customer can
 * legitimately carry a DE VAT id). Falls back to the customer country otherwise.
 */
function parseVat(vatNumber: string, country: string | null): { cc: string; num: string } | null {
  const raw = vatNumber.replace(/[\s-]/g, '').toUpperCase()
  const prefix = raw.slice(0, 2)
  if (/^[A-Z]{2}$/.test(prefix) && (VIES_COUNTRIES.has(prefix) || prefix === 'GR')) {
    return { cc: toViesCountry(prefix), num: raw.slice(2) }
  }
  if (country) {
    const cc = toViesCountry(country)
    // Number may still carry a non-matching alpha prefix we don't recognize; send as-is.
    return { cc, num: raw }
  }
  return null
}

/** VIES REST returns `{ isValid: boolean, userError, name, address, ... }`. */
interface ViesResponse {
  isValid?: boolean
  userError?: string
}

export const viesTaxIdValidator: TaxIdValidator = {
  async validate({ country, vatNumber }): Promise<VatNumberStatus> {
    if (!vatNumber || vatNumber.trim().length === 0) return 'not_validated'

    const parsed = parseVat(vatNumber, country)
    // Not an EU member-state number → outside VIES's remit; we can't confirm it.
    if (!parsed || !VIES_COUNTRIES.has(parsed.cc)) return 'undetermined'

    const base = config.VIES_API_BASE.replace(/\/$/, '')
    const url = `${base}/ms/${encodeURIComponent(parsed.cc)}/vat/${encodeURIComponent(parsed.num)}`

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), config.VIES_TIMEOUT_MS)
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: controller.signal,
      })
      // Member-state service unavailable / rate limited / transient — undetermined.
      if (!res.ok) return 'undetermined'
      const body = (await res.json()) as ViesResponse
      if (body.isValid === true) return 'valid'
      if (body.isValid === false) return 'invalid'
      return 'undetermined'
    } catch (e) {
      // Network error, timeout (abort), or malformed JSON — never fatal. Logged
      // because a member-state outage looks identical to a genuinely undetermined
      // VAT number in the tax result, and only the log tells them apart.
      log.warn('VIES lookup failed — VAT treated as undetermined', {
        memberState: parsed.cc,
        timeoutMs: config.VIES_TIMEOUT_MS,
        error: (e as Error)?.message,
      })
      return 'undetermined'
    } finally {
      clearTimeout(timer)
    }
  },
}
