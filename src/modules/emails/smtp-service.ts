/**
 * Per-business SMTP transport settings: read, write, connection test, test send.
 *
 * The password never leaves this module in plaintext. Reads report a
 * `password_configured` boolean, mirroring how gateway accounts expose
 * `webhook_secret_configured` — a settings screen needs to know whether a secret exists,
 * never what it is.
 */
import { eq } from "drizzle-orm";
import { withTenant } from "@/platform/db";
import { businesses, emailMessages } from "@db/schema";
import { publicId } from "@/platform/ids";
import { SmtpMailer, type SmtpEncryption } from "@/providers/mailer";
import {
  resolveEmailConfig,
  EMAIL_TYPES,
  resolveSender,
  applySubjectPrefix,
  type EmailType,
} from "./config";
import {
  resolveSmtpConfig,
  readSmtpPassword,
  writeSmtpPassword,
  isSmtpUsable,
} from "./smtp-config";
import { resolveSesConfig, isSesUsable } from "./ses-config";
import { describeTransport, type EffectiveTransport } from "./transport-view";
import { resolveMailer, invalidateMailer } from "./mailer-resolver";
import {
  renderEmail,
  sampleVarsFor,
  DEFAULT_TEMPLATES,
  blocksFor,
  type RenderVars,
  type TemplateDef,
} from "./templates";
import { loadTemplateOverride, checkTemplate } from "./template-service";
import { createLogger } from "@/platform/logger";
import { writeAuditLog } from "@/modules/audit/service";

const log = createLogger("emails.smtp");

export class SmtpConfigError extends Error {}

export interface SmtpSettingsView {
  enabled: boolean;
  host: string | null;
  port: number | null;
  encryption: SmtpEncryption;
  username: string | null;
  /** Whether a password is stored. Never the password itself. */
  password_configured: boolean;
  /**
   * What will actually carry this business's mail right now, after the business setting,
   * the deployment MAILER_PROVIDER and its own completeness are all taken into account.
   * `unconfigured` means a transport is selected that will throw on first send.
   */
  effective_transport: EffectiveTransport;
  /**
   * Whether mail actually reaches a relay. False for the console sink — which still marks
   * rows `sent`. A settings screen that shows "sending: on" without this is inviting a
   * merchant to believe their customers are being emailed when nothing is leaving.
   */
  delivers: boolean;
  /**
   * The From header the engine will actually produce right now — the business's own
   * setting, or the deployment MAIL_FROM / MAIL_FROM_NAME when it is blank. Mirrors the
   * `cfg.fromX || config.MAIL_FROM_X` fallback used in outbox.ts, adhoc-service.ts and
   * sendTestEmail; all four must agree.
   *
   * Exposed because the settings screen previously *guessed* the fallback and guessed
   * wrong — it told merchants the From name "defaults to the business name" when the
   * engine actually uses MAIL_FROM_NAME. A screen may only state a default it can read.
   */
  effective_from_address: string;
  effective_from_name: string;
  /** Whether that identity came from this business or from the deployment default. */
  from_source: "business" | "platform";
}

export interface SmtpSettingsInput {
  enabled?: boolean;
  host?: string | null;
  port?: number | null;
  encryption?: SmtpEncryption;
  username?: string | null;
  /**
   * Tri-state, and the distinction matters. Absent → keep whatever is stored (so a
   * merchant can fix a typo'd host without re-typing the password). Empty string → clear
   * it. A value → replace it. Collapsing absent and empty would silently wipe the
   * credential every time someone edited the port.
   */
  password?: string | null;
}

function view(row: {
  smtpConfig?: unknown;
  smtpCredentialsEnc?: string | null;
  sesConfig?: unknown;
  sesCredentialsEnc?: string | null;
  emailConfig?: unknown;
}): SmtpSettingsView {
  const cfg = resolveSmtpConfig(row);
  const email = resolveEmailConfig(row);
  // Through resolveSender, not re-derived: this view exists BECAUSE the screen's own copy
  // of the fallback was wrong, so it must read the same function the senders do.
  const sender = resolveSender(email);
  return {
    enabled: cfg.enabled,
    host: cfg.host,
    port: cfg.port,
    encryption: cfg.encryption,
    username: cfg.username,
    password_configured: !!row.smtpCredentialsEnc,
    // SES is considered too: a business sending through SES must not be told by this screen
    // that its mail rides the deployment console sink.
    ...describeTransport({
      smtp: isSmtpUsable(cfg, row.smtpCredentialsEnc),
      ses: isSesUsable(resolveSesConfig(row), row.sesCredentialsEnc),
    }),
    effective_from_address: sender.from,
    effective_from_name: sender.fromName,
    from_source: email.fromAddress || email.fromName ? "business" : "platform",
  };
}

export async function getSmtpSettings(
  organizationId: string,
  businessId: string,
): Promise<SmtpSettingsView | null> {
  return withTenant(organizationId, async (tx) => {
    const [b] = await tx.select().from(businesses).where(eq(businesses.id, businessId)).limit(1);
    return b ? view(b) : null;
  });
}

export async function saveSmtpSettings(
  organizationId: string,
  businessId: string,
  input: SmtpSettingsInput,
): Promise<SmtpSettingsView | null> {
  const result = await withTenant(organizationId, async (tx) => {
    const [b] = await tx.select().from(businesses).where(eq(businesses.id, businessId)).limit(1);
    if (!b) return null;

    const current = resolveSmtpConfig(b);
    const next = {
      enabled: input.enabled ?? current.enabled,
      host: input.host === undefined ? current.host : input.host?.trim() || null,
      port: input.port === undefined ? current.port : input.port,
      encryption: input.encryption ?? current.encryption,
      username: input.username === undefined ? current.username : input.username?.trim() || null,
    };

    let credentialsEnc = b.smtpCredentialsEnc ?? null;
    if (input.password !== undefined) {
      credentialsEnc = input.password ? writeSmtpPassword(input.password) : null;
    }

    // Fail here rather than at the DB CHECK so the merchant gets a sentence instead of a
    // constraint name — and rather than at first send, which would be hours later and
    // attributed to the wrong thing.
    if (next.enabled) {
      if (!next.host)
        throw new SmtpConfigError("An SMTP host is required to enable SMTP delivery.");
      if (!next.port)
        throw new SmtpConfigError("An SMTP port is required to enable SMTP delivery.");
      if (!credentialsEnc) {
        throw new SmtpConfigError(
          "An SMTP password is required to enable SMTP delivery. Leave the field blank only when a password is already saved.",
        );
      }
    }

    /**
     * A business has one transport (businesses_mail_transport_ck), so switching to SMTP
     * turns SES off in the same statement — the mirror of the switch in saveSesSettings, and
     * for the same reason: the dashboard models this as one "delivery method" choice.
     *
     * The SES *credentials* are deliberately left in place, so switching back does not mean
     * re-pasting an IAM key.
     */
    const ses = resolveSesConfig(b);
    const sesPatch = next.enabled && ses.enabled ? { sesConfig: { ...ses, enabled: false } } : {};

    const [updated] = await tx
      .update(businesses)
      .set({
        smtpConfig: next,
        smtpCredentialsEnc: credentialsEnc,
        ...sesPatch,
        updatedAt: new Date(),
      })
      .where(eq(businesses.id, businessId))
      .returning();
    if (!updated) return null;
    // The password is recorded as changed or cleared, never as a value.
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    for (const k of Object.keys(next) as Array<keyof typeof next>) {
      if (current[k] === next[k]) continue;
      before[k] = current[k];
      after[k] = next[k];
    }
    if (input.password !== undefined) {
      before.password = b.smtpCredentialsEnc ? "set" : "none";
      after.password = input.password ? "changed" : "cleared";
    }
    if ("sesConfig" in sesPatch) {
      before.ses_enabled = true;
      after.ses_enabled = false;
    }
    if (Object.keys(after).length) {
      await writeAuditLog(
        {
          organizationId,
          businessId,
          action: "mail_transport.smtp.update",
          resourceType: "mail_transport",
          resourceId: "smtp",
          before,
          after,
        },
        tx,
      );
    }
    return view(updated);
  });
  // Settings changed → the cached pooled transport is stale. Outside the tx: invalidating
  // a cache for a write that then rolled back would evict for nothing.
  if (result) invalidateMailer(businessId);
  return result;
}

/**
 * Open a connection and authenticate, sending nothing. Split from the test send because
 * the two failures mean different things: this one failing is reachability or
 * credentials; a send failing after this passed is the From address being refused.
 */
export async function testSmtpConnection(
  organizationId: string,
  businessId: string,
): Promise<{ ok: boolean; error: string | null }> {
  const row = await withTenant(organizationId, async (tx) => {
    const [b] = await tx.select().from(businesses).where(eq(businesses.id, businessId)).limit(1);
    return b ?? null;
  });
  if (!row) return { ok: false, error: "Business not found" };

  const cfg = resolveSmtpConfig(row);
  if (!isSmtpUsable(cfg, row.smtpCredentialsEnc)) {
    throw new SmtpConfigError(
      "SMTP is not configured for this business, so there is no connection to test.",
    );
  }
  const mailer = new SmtpMailer({
    host: cfg.host as string,
    port: cfg.port as number,
    encryption: cfg.encryption,
    username: cfg.username,
    password: readSmtpPassword(row.smtpCredentialsEnc),
  });
  try {
    await mailer.verify();
    return { ok: true, error: null };
  } catch (e) {
    // Surfaced in the settings UI; logged too, because "my emails stopped" arrives
    // as a support question long after the operator clicked Test.
    log.warn("smtp connection test failed", { error: (e as Error).message });
    return { ok: false, error: (e as Error).message ?? "connection failed" };
  } finally {
    // A throwaway instance — never cached, so nothing else will close it.
    mailer.close();
  }
}

/**
 * Render one email type with sample data and send it now, straight through the resolved
 * transport — no outbox, no clock wait, because the whole point is immediate feedback.
 *
 * It IS recorded in email_messages, subject-prefixed `[Test]` and with no customer
 * attached. An unrecorded test would lose its own error the moment the operator navigated
 * away, which is when they most need it.
 */
export async function sendTestEmail(
  organizationId: string,
  businessId: string,
  input: { to: string; type: EmailType; draft?: TemplateDef },
): Promise<{ ok: boolean; error: string | null; transport: string; email_id: string }> {
  if (!EMAIL_TYPES.includes(input.type)) {
    throw new SmtpConfigError(
      `Unknown email type '${input.type}'. Known types: ${EMAIL_TYPES.join(", ")}`,
    );
  }

  const loaded = await withTenant(organizationId, async (tx) => {
    const [b] = await tx.select().from(businesses).where(eq(businesses.id, businessId)).limit(1);
    if (!b) return null;
    // The test must show the template that would ACTUALLY be sent — a test that always
    // rendered the built-in would report a customised template as working while never
    // having exercised it.
    return { biz: b, override: await loadTemplateOverride(tx, businessId, input.type) };
  });
  if (!loaded) throw new SmtpConfigError("Business not found");
  const { biz } = loaded;
  // A draft is what the editor is showing; send exactly that, layout included.
  const override = input.draft
    ? { ...(loaded.override ?? DEFAULT_TEMPLATES[input.type]), ...input.draft }
    : loaded.override;
  if (input.draft) {
    const errors = checkTemplate(input.type, override!).filter((i) => i.severity === "error");
    if (errors.length) throw new SmtpConfigError(errors.map((e) => e.message).join(" "));
  }

  const emailCfg = resolveEmailConfig(biz);
  // A test send has to be the WHOLE email, blocks included.
  //
  // This rendered sample vars straight into `renderEmail` and so arrived with no facts
  // card, no action button and no sign-off — a stripped email, sent to the one person
  // checking what their customers receive. `previewTemplate` had the identical defect and
  // was fixed; this path was not, and only a screenshot of a real inbox found it. Both now
  // go through the outbox's own `blocksFor`, so all three paths agree by construction.
  const testVars: RenderVars = {
    ...sampleVarsFor(input.type),
    businessName: biz.name,
    // Brand Styles (0185) — a test mail that is not branded has not tested what
    // the customer receives.
    logoUrl: biz.logoUrl ?? undefined,
    iconUrl: biz.iconUrl ?? undefined,
    brandColor: biz.brandColor ?? undefined,
    ...(emailCfg.footerNote ? { footerNote: emailCfg.footerNote } : {}),
  };
  const rendered = renderEmail(
    input.type,
    { ...testVars, ...blocksFor(input.type, testVars) },
    override,
  );
  // `[Test]` outermost so it survives a merchant prefix and stays the first thing an
  // operator sees in their inbox: "[Test] [Fernhill] Your invoice …".
  const subject = `[Test] ${applySubjectPrefix(emailCfg, rendered.subject)}`;
  const mailer = resolveMailer(biz);
  const id = publicId("em");
  const now = new Date();

  let ok = true;
  let error: string | null = null;
  let providerMessageId: string | null = null;
  try {
    const res = await mailer.send({
      to: input.to,
      ...resolveSender(emailCfg),
      subject,
      html: rendered.html,
      text: rendered.text,
      idempotencyKey: id,
    });
    providerMessageId = res.providerMessageId;
  } catch (e) {
    ok = false;
    error = (e as Error).message ?? "send failed";
    log.warn("smtp test send failed", { error });
  }

  // `failed`, not `pending`: a test is a one-shot. Leaving it pending would hand it to
  // the billing clock, which would then retry an operator's test six times over six hours.
  await withTenant(organizationId, async (tx) => {
    await tx.insert(emailMessages).values({
      publicId: id,
      organizationId,
      businessId,
      customerId: null,
      eventId: null,
      type: input.type,
      toAddress: input.to,
      subject,
      bodyHtml: rendered.html,
      bodyText: rendered.text,
      status: ok ? "sent" : "failed",
      transport: mailer.kind,
      attempts: 1,
      lastError: error,
      providerMessageId,
      lastAttemptAt: now,
      nextAttemptAt: null,
      sentAt: ok ? now : null,
    });
  });

  return { ok, error, transport: mailer.kind, email_id: id };
}
