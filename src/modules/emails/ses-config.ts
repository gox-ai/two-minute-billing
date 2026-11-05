import { decryptCredentials, encryptCredentials } from "@/platform/secrets";

/**
 * Per-business Amazon SES transport settings (mirrors resolveSmtpConfig).
 *
 * Transport only — who the mail claims to be FROM lives in `email_config`. A business with
 * no row here, or `enabled: false`, falls back to the deployment-wide MAILER_PROVIDER, so
 * every existing and imported business keeps behaving exactly as it did.
 *
 * A business configures SES *or* SMTP, never both: `businesses_mail_transport_ck` rejects
 * the ambiguous state at the database rather than leaving resolveMailer to guess.
 */
export interface SesConfig {
  enabled: boolean;
  region: string | null;
  /**
   * The IAM access key id. Deliberately in the NON-secret half, exactly as SMTP keeps
   * `username` out of its envelope: an access key id identifies a credential, it does not
   * authenticate one — the secret access key alone does that. Keeping it readable means the
   * settings screen can show *which* key is installed, which is the question an operator
   * actually has when rotating one, and means a config read is never a decrypt.
   */
  accessKeyId: string | null;
  /** Optional SES configuration set — the hook for bounce/complaint events via SNS. */
  configurationSet: string | null;
}

export function resolveSesConfig(biz: { sesConfig?: unknown } | null | undefined): SesConfig {
  const raw = (biz?.sesConfig ?? null) as Record<string, unknown> | null;
  const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
  return {
    // Strictly `=== true`: a half-written config must read as off, never as on.
    enabled: raw?.enabled === true,
    region: str(raw?.region),
    accessKeyId: str(raw?.accessKeyId),
    configurationSet: str(raw?.configurationSet),
  };
}

/**
 * True when this business has everything needed to actually send. The DB CHECK
 * (businesses_ses_config_ck) enforces the same rule, so this should never disagree with it —
 * it exists so callers can branch without a decrypt, and so the failure mode of a row that
 * somehow predates the constraint is "fall back to the global transport", not "throw on the
 * billing clock".
 */
export function isSesUsable(cfg: SesConfig, credentialsEnc: string | null | undefined): boolean {
  return cfg.enabled && !!cfg.region && !!cfg.accessKeyId && !!credentialsEnc;
}

/** Decrypt the stored secret half. Returns null when nothing is stored. */
export function readSesSecret(credentialsEnc: string | null | undefined): string | null {
  if (!credentialsEnc) return null;
  const creds = decryptCredentials(credentialsEnc);
  return typeof creds.secretAccessKey === "string" ? creds.secretAccessKey : null;
}

/** Encrypt a secret access key into the storage envelope. */
export function writeSesSecret(secretAccessKey: string): string {
  return encryptCredentials({ secretAccessKey });
}
