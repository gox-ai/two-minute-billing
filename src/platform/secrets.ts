/**
 * Credential encryption at rest (C1 / GW-1).
 *
 * Gateway credentials (API secret keys, webhook secrets, etc.) are stored
 * encrypted in `gateway_accounts.credentials_enc` and are **write-only** through
 * the API — never echoed back. This helper is the only place that knows the
 * ciphertext format, so key rotation lives here too.
 *
 * Format: `v1:<base64url(iv ‖ authTag ‖ ciphertext)>` using AES-256-GCM.
 * The `v1:` prefix is a version tag so a future key/algorithm rotation can be
 * detected and migrated without ambiguity.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { config } from './config'
import { createLogger } from '@/platform/logger'

const log = createLogger('secrets')

const IV_LEN = 12 // GCM standard nonce size
const TAG_LEN = 16
const VERSION = 'v1'

/**
 * Derive the 32-byte AES key. Prefers `GATEWAY_CREDENTIALS_KEY`; falls back to a
 * key derived from `API_KEY_SECRET` so local/test runs work without extra config.
 * Either way the passphrase is hashed to exactly 32 bytes (SHA-256).
 */
let warnedFallback = false
function deriveKey(): Buffer {
  if (!config.GATEWAY_CREDENTIALS_KEY && !warnedFallback) {
    warnedFallback = true
    // Config already refuses this in production; make it loud everywhere else.
    log.warn(
      '⚠ GATEWAY_CREDENTIALS_KEY is not set — gateway credentials are encrypted with a key ' +
      'derived from API_KEY_SECRET. Fine for local/test; set a dedicated key before real gateways.',
    )
  }
  return keyFrom(config.GATEWAY_CREDENTIALS_KEY ?? legacyPassphrase())
}

const keyFrom = (passphrase: string): Buffer =>
  createHash('sha256').update(passphrase, 'utf8').digest()

/** The pre-`GATEWAY_CREDENTIALS_KEY` derivation. Kept solely to read old ciphertext. */
const legacyPassphrase = (): string => `gateway:${config.API_KEY_SECRET}`

/**
 * Keys to TRY when decrypting, newest first. Encryption always uses `deriveKey()`.
 *
 * Why this exists: setting `GATEWAY_CREDENTIALS_KEY` used to be a hard cutover — every
 * row already encrypted under the `API_KEY_SECRET` derivation became undecryptable the
 * moment the variable appeared, taking every gateway on the deployment down at once
 * (measured 2026-08-01: 954/954 active accounts unreadable). A key rotation must be a
 * config change plus a background re-encrypt, never a cliff.
 *
 * `GATEWAY_CREDENTIALS_KEY_PREVIOUS` gives the same grace to the *next* rotation.
 * Re-encrypt onto the current key with `pnpm gateway:rotate-credentials --write`, then
 * drop the previous key from the environment.
 */
function decryptionKeys(): Buffer[] {
  const keys: Buffer[] = [deriveKey()]
  if (config.GATEWAY_CREDENTIALS_KEY_PREVIOUS) keys.push(keyFrom(config.GATEWAY_CREDENTIALS_KEY_PREVIOUS))
  // Only a fallback when a dedicated key is configured — otherwise it IS the primary.
  if (config.GATEWAY_CREDENTIALS_KEY) keys.push(keyFrom(legacyPassphrase()))
  return keys
}

/** True when `envelope` decrypts under the CURRENT primary key (i.e. needs no rotation). */
export function isEncryptedWithCurrentKey(envelope: string): boolean {
  try {
    decryptWith(envelope, deriveKey())
    return true
  } catch {
    return false
  }
}

/** Encrypt a plaintext string → `v1:<base64url>` envelope. */
export function encryptSecret(plaintext: string): string {
  const key = deriveKey()
  const iv = randomBytes(IV_LEN)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${VERSION}:${Buffer.concat([iv, tag, ct]).toString('base64url')}`
}

function decryptWith(envelope: string, key: Buffer): string {
  const [version, body] = envelope.split(':', 2)
  if (version !== VERSION || !body) throw new Error(`Unsupported credential envelope: ${version ?? '(none)'}`)
  const raw = Buffer.from(body, 'base64url')
  const iv = raw.subarray(0, IV_LEN)
  const tag = raw.subarray(IV_LEN, IV_LEN + TAG_LEN)
  const ct = raw.subarray(IV_LEN + TAG_LEN)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8')
}

/**
 * Decrypt a `v1:<base64url>` envelope back to plaintext. Throws on tamper/bad key.
 *
 * Tries the current key first, then any rotation fallbacks (see `decryptionKeys`), so a
 * key change is survivable rather than an outage. GCM authenticates, so a wrong key
 * fails cleanly rather than yielding garbage — trying several is safe.
 */
export function decryptSecret(envelope: string): string {
  let lastErr: unknown
  for (const key of decryptionKeys()) {
    try {
      return decryptWith(envelope, key)
    } catch (err) {
      lastErr = err
    }
  }
  throw new Error(
    'Gateway credential could not be decrypted with any configured key. If GATEWAY_CREDENTIALS_KEY '
    + 'was just changed, put the old value in GATEWAY_CREDENTIALS_KEY_PREVIOUS and run '
    + `pnpm gateway:rotate-credentials --write. (${lastErr instanceof Error ? lastErr.message : String(lastErr)})`,
  )
}

/** Encrypt a JSON-serializable credentials object. */
export function encryptCredentials(creds: Record<string, unknown>): string {
  return encryptSecret(JSON.stringify(creds))
}

/** Decrypt to a credentials object. */
export function decryptCredentials(envelope: string): Record<string, unknown> {
  return JSON.parse(decryptSecret(envelope)) as Record<string, unknown>
}
