import { decryptCredentials, encryptCredentials } from '@/platform/secrets'
import type { SmtpEncryption } from '@/providers/mailer/smtp'

/**
 * Per-business SMTP transport settings (mirrors resolveEmailConfig / resolveDunningConfig).
 *
 * Transport only — who the mail claims to be FROM lives in `email_config`. A business with
 * no row here, or `enabled: false`, falls back to the deployment-wide MAILER_PROVIDER, so
 * every existing and imported business keeps behaving exactly as it did.
 */
export interface SmtpConfig {
  enabled: boolean
  host: string | null
  port: number | null
  encryption: SmtpEncryption
  username: string | null
}

const ENCRYPTIONS: readonly SmtpEncryption[] = ['tls', 'starttls', 'none']

/** Conventional port → encryption, used only when a stored config predates the field. */
function encryptionForPort(port: number | null): SmtpEncryption {
  return port === 465 ? 'tls' : 'starttls'
}

export function resolveSmtpConfig(biz: { smtpConfig?: unknown } | null | undefined): SmtpConfig {
  const raw = (biz?.smtpConfig ?? null) as Record<string, unknown> | null
  const port = typeof raw?.port === 'number' && Number.isInteger(raw.port) ? raw.port : null
  const encRaw = raw?.encryption
  const encryption = ENCRYPTIONS.includes(encRaw as SmtpEncryption)
    ? (encRaw as SmtpEncryption)
    : encryptionForPort(port)
  return {
    // Strictly `=== true`: a half-written config must read as off, never as on.
    enabled: raw?.enabled === true,
    host: typeof raw?.host === 'string' && raw.host.trim() ? raw.host.trim() : null,
    port,
    encryption,
    username: typeof raw?.username === 'string' && raw.username ? raw.username : null,
  }
}

/**
 * True when this business has everything needed to actually send. The DB CHECK
 * (businesses_smtp_config_ck) enforces the same rule, so this should never disagree with
 * it — it exists so callers can branch without a decrypt, and so the failure mode of a row
 * that somehow predates the constraint is "fall back to the global transport", not "throw
 * on the billing clock".
 */
export function isSmtpUsable(cfg: SmtpConfig, credentialsEnc: string | null | undefined): boolean {
  return cfg.enabled && !!cfg.host && !!cfg.port && !!credentialsEnc
}

/** Decrypt the stored secret half. Returns null when nothing is stored. */
export function readSmtpPassword(credentialsEnc: string | null | undefined): string | null {
  if (!credentialsEnc) return null
  const creds = decryptCredentials(credentialsEnc)
  return typeof creds.password === 'string' ? creds.password : null
}

/** Encrypt a password into the storage envelope. */
export function writeSmtpPassword(password: string): string {
  return encryptCredentials({ password })
}
