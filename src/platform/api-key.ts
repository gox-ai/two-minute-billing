import { createHmac, randomBytes } from 'node:crypto'
import { config } from './config'

export type Livemode = 'live' | 'test'
/**
 * API-key mode. 'test'/'live' keys only reach businesses of the same mode;
 * 'all' is a full-access key (dashboard / bootstrap) that reaches both.
 */
export type KeyMode = Livemode | 'all'

/**
 * What a credential IS, as opposed to which partition it reaches (`KeyMode`).
 *
 *  - `api`       — minted by the organization for its own integrations. Its requests
 *                  are API traffic and are attributed to the key.
 *  - `dashboard` — the bootstrap credential our own dashboard runs on. Its requests
 *                  are attributed to the signed-in operator (falling back to
 *                  `dashboard`), never to a key id, and it is not part of the org's
 *                  API-key surface at all (`db/schema/tenancy.ts` § apiKeys).
 *
 * NOT `system`, which this was called for one commit (0150→0151). `system` means "no
 * human, no request" — a seed, a verify run, the clock. A person clicking Void in the
 * dashboard is neither, and saying so was nearly as misleading as calling it an API
 * integration.
 */
export type ApiKeyKind = 'api' | 'dashboard'

/**
 * What an API key may DO (audit H1.3), as opposed to which tenant it belongs to.
 *
 * 'read'  — GET, plus the handful of POSTs that only compute (estimates, a template preview).
 * 'write' — everything the organization can do.
 *
 * Orthogonal to a person's ROLE: a key is not a person, so `requirePerm` passes it through and
 * this is the axis that constrains it. Until this existed, every key carried full organization
 * privilege, which made "leaked integration key" and "full account takeover" the same event.
 */
export type ApiKeyScope = 'read' | 'write'

export interface GeneratedApiKey {
  /** The full secret, shown to the user exactly once. */
  raw: string
  /** What we persist — an HMAC of the raw key. The raw key is never stored. */
  hashed: string
  /** Non-secret display fragment, e.g. "sk_test_AbCd". */
  prefix: string
}

/** Mint a new API key. Format: `sk_<live|test|all>_<random>`. */
export function generateApiKey(livemode: KeyMode): GeneratedApiKey {
  const raw = `sk_${livemode}_${randomBytes(24).toString('base64url')}`
  return { raw, hashed: hashApiKey(raw), prefix: raw.slice(0, 12) }
}

/** Deterministic HMAC used to look up / verify a key by its hash. */
export function hashApiKey(raw: string): string {
  return createHmac('sha256', config.API_KEY_SECRET).update(raw).digest('hex')
}
