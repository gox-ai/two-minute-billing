/**
 * Per-business Amazon SES transport settings: read, write, connection test.
 *
 * The mirror of smtp-service.ts, and deliberately shaped like it — same tri-state secret
 * handling, same "fail with a sentence, not a constraint name" validation, same
 * `effective_*` fields resolved through the shared `describeTransport` so the two settings
 * screens can never disagree about what is carrying a business's mail.
 *
 * The secret access key never leaves this module in plaintext; reads report a
 * `secret_configured` boolean. The access key ID *is* returned, because it identifies
 * rather than authenticates — see the note in ses-config.ts.
 *
 * There is no test-send here: `sendTestEmail` in smtp-service.ts already routes through
 * `resolveMailer`, which picks SES automatically once it is enabled. A second copy would be
 * a second thing to keep in step for no gain.
 */
import { eq } from "drizzle-orm";
import { withTenant } from "@/platform/db";
import { businesses } from "@db/schema";
import { resolveEmailConfig, resolveSender } from "./config";
import { resolveSmtpConfig, isSmtpUsable } from "./smtp-config";
import { resolveSesConfig, isSesUsable, writeSesSecret } from "./ses-config";
import { describeTransport, type EffectiveTransport } from "./transport-view";
import { invalidateMailer } from "./mailer-resolver";
import { writeAuditLog } from "@/modules/audit/service";

export class SesConfigError extends Error {}

export interface SesSettingsView {
  enabled: boolean;
  region: string | null;
  /** Identifies the credential; safe to render. The secret half is never returned. */
  access_key_id: string | null;
  configuration_set: string | null;
  /** Whether a secret access key is stored. Never the key itself. */
  secret_configured: boolean;
  effective_transport: EffectiveTransport;
  delivers: boolean;
  effective_from_address: string;
  effective_from_name: string;
  from_source: "business" | "platform";
}

export interface SesSettingsInput {
  enabled?: boolean;
  region?: string | null;
  accessKeyId?: string | null;
  configurationSet?: string | null;
  /**
   * Tri-state, and the distinction matters. Absent → keep whatever is stored (so a merchant
   * can fix a typo'd region without re-pasting the key). Empty string → clear it. A value →
   * replace it. Collapsing absent and empty would silently wipe the credential every time
   * someone edited the configuration set.
   */
  secretAccessKey?: string | null;
}

function view(row: {
  smtpConfig?: unknown;
  smtpCredentialsEnc?: string | null;
  sesConfig?: unknown;
  sesCredentialsEnc?: string | null;
  emailConfig?: unknown;
}): SesSettingsView {
  const cfg = resolveSesConfig(row);
  const email = resolveEmailConfig(row);
  // Through resolveSender, not re-derived — the same rule smtp-service follows, and for the
  // same reason: a screen may only state a default it can read.
  const sender = resolveSender(email);
  return {
    enabled: cfg.enabled,
    region: cfg.region,
    access_key_id: cfg.accessKeyId,
    configuration_set: cfg.configurationSet,
    secret_configured: !!row.sesCredentialsEnc,
    ...describeTransport({
      smtp: isSmtpUsable(resolveSmtpConfig(row), row.smtpCredentialsEnc),
      ses: isSesUsable(cfg, row.sesCredentialsEnc),
    }),
    effective_from_address: sender.from,
    effective_from_name: sender.fromName,
    from_source: email.fromAddress || email.fromName ? "business" : "platform",
  };
}

export async function getSesSettings(
  organizationId: string,
  businessId: string,
): Promise<SesSettingsView | null> {
  return withTenant(organizationId, async (tx) => {
    const [b] = await tx.select().from(businesses).where(eq(businesses.id, businessId)).limit(1);
    return b ? view(b) : null;
  });
}

export async function saveSesSettings(
  organizationId: string,
  businessId: string,
  input: SesSettingsInput,
): Promise<SesSettingsView | null> {
  const result = await withTenant(organizationId, async (tx) => {
    const [b] = await tx.select().from(businesses).where(eq(businesses.id, businessId)).limit(1);
    if (!b) return null;

    const current = resolveSesConfig(b);
    const next = {
      enabled: input.enabled ?? current.enabled,
      region: input.region === undefined ? current.region : input.region?.trim() || null,
      accessKeyId:
        input.accessKeyId === undefined ? current.accessKeyId : input.accessKeyId?.trim() || null,
      configurationSet:
        input.configurationSet === undefined
          ? current.configurationSet
          : input.configurationSet?.trim() || null,
    };

    let credentialsEnc = b.sesCredentialsEnc ?? null;
    if (input.secretAccessKey !== undefined) {
      credentialsEnc = input.secretAccessKey ? writeSesSecret(input.secretAccessKey) : null;
    }

    // Fail here rather than at the DB CHECK so the merchant gets a sentence instead of a
    // constraint name — and rather than at first send, which would be hours later and
    // attributed to the wrong thing.
    if (next.enabled) {
      if (!next.region)
        throw new SesConfigError("An AWS region is required to enable SES delivery.");
      if (!next.accessKeyId) {
        throw new SesConfigError("An AWS access key ID is required to enable SES delivery.");
      }
      if (!credentialsEnc) {
        throw new SesConfigError(
          "An AWS secret access key is required to enable SES delivery. Leave the field blank only when a key is already saved.",
        );
      }
    }

    /**
     * A business has one transport (businesses_mail_transport_ck), so switching to SES turns
     * SMTP off in the same statement. Done here rather than refused, because the dashboard
     * models this as one "delivery method" choice and a merchant selecting SES has already
     * said what they want — an error telling them to go and disable SMTP first would be the
     * screen making them do the database's bookkeeping.
     *
     * The SMTP *credentials* are deliberately left in place. Switching back should not mean
     * re-typing a password, and clearing a secret is not something a save on a different
     * form should ever do silently.
     */
    const smtp = resolveSmtpConfig(b);
    const smtpPatch =
      next.enabled && smtp.enabled ? { smtpConfig: { ...smtp, enabled: false } } : {};

    const [updated] = await tx
      .update(businesses)
      .set({
        sesConfig: next,
        sesCredentialsEnc: credentialsEnc,
        ...smtpPatch,
        updatedAt: new Date(),
      })
      .where(eq(businesses.id, businessId))
      .returning();
    if (!updated) return null;
    // Key material is recorded as changed or cleared, never as a value.
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    for (const k of ["enabled", "region", "configurationSet"] as const) {
      if (current[k] === next[k]) continue;
      before[k] = current[k];
      after[k] = next[k];
    }
    if (current.accessKeyId !== next.accessKeyId) {
      before.accessKeyId = current.accessKeyId ? "set" : "none";
      after.accessKeyId = next.accessKeyId ? "changed" : "cleared";
    }
    if (input.secretAccessKey !== undefined) {
      before.secretAccessKey = b.sesCredentialsEnc ? "set" : "none";
      after.secretAccessKey = input.secretAccessKey ? "changed" : "cleared";
    }
    if ("smtpConfig" in smtpPatch) {
      before.smtp_enabled = true;
      after.smtp_enabled = false;
    }
    if (Object.keys(after).length) {
      await writeAuditLog(
        {
          organizationId,
          businessId,
          action: "mail_transport.ses.update",
          resourceType: "mail_transport",
          resourceId: "ses",
          before,
          after,
        },
        tx,
      );
    }
    return view(updated);
  });
  // Settings changed → the cached transport is stale. Outside the tx: invalidating a cache
  // for a write that then rolled back would evict for nothing.
  if (result) invalidateMailer(businessId);
  return result;
}
