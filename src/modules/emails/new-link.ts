/**
 * The `new_link` email: a fresh link the customer asked for from an expired one. A SYSTEM
 * email like the sign-in code: no outbox, no toggle, sent by a job (`new_link_send`), only
 * to the customer's own address, through the business's transport. It respects suppression
 * and test mode. The logged copy masks the link: it is a credential.
 */
import { eq } from "drizzle-orm";
import { withTenant } from "@/platform/db";
import { publicId } from "@/platform/ids";
import { createLogger } from "@/platform/logger";
import { businesses, customers, emailMessages } from "@db/schema";
import { accountHolderName } from "@/modules/customers/names";
import { applySubjectPrefix, resolveEmailConfig, resolveSender } from "./config";
import { resolveMailer } from "./mailer-resolver";
import { isSuppressed } from "./suppression";
import { testModeAllows } from "./test-mode";
import { renderEmail, type RenderVars } from "./templates";
import { loadTemplateOverride } from "./template-service";

const log = createLogger("emails.new-link");
const MASKED_URL = "https://link.removed/";

/** "5 days", "48 hours", "1 day". */
export function linkWindowText(ms: number): string {
  const hours = Math.round(ms / 3_600_000);
  if (hours % 24 === 0) {
    const d = hours / 24;
    return `${d} ${d === 1 ? "day" : "days"}`;
  }
  return `${hours} ${hours === 1 ? "hour" : "hours"}`;
}

/** Send the new link. Returns false when nothing was sent (no address, suppressed, test mode, failure). */
export async function sendNewLinkEmail(
  organizationId: string,
  businessId: string,
  input: { customerId: string; url: string; label: string; windowMs: number },
): Promise<boolean> {
  const { biz, cus, override } = await withTenant(organizationId, async (tx) => {
    const [biz] = await tx.select().from(businesses).where(eq(businesses.id, businessId)).limit(1);
    const [cus] = await tx
      .select()
      .from(customers)
      .where(eq(customers.id, input.customerId))
      .limit(1);
    const override = await loadTemplateOverride(tx, businessId, "new_link");
    return { biz: biz!, cus, override };
  });
  const to = cus?.email?.trim();
  if (!to) return false;
  if (await isSuppressed(businessId, to)) return false;
  if (!(await testModeAllows(biz, to))) return false;

  const vars: RenderVars = {
    businessName: biz.name,
    customerName: (cus && accountHolderName(cus)) ?? "there",
    linkWindow: linkWindowText(input.windowMs),
    logoUrl: biz.logoUrl ?? undefined,
    iconUrl: biz.iconUrl ?? undefined,
    brandColor: biz.brandColor ?? undefined,
    buttonTextColor: biz.buttonTextColor ?? undefined,
  };
  const rendered = renderEmail(
    "new_link",
    { ...vars, action: { label: input.label, url: input.url } },
    override,
  );
  const logged = renderEmail(
    "new_link",
    { ...vars, action: { label: input.label, url: MASKED_URL } },
    override,
  );
  const emailCfg = resolveEmailConfig(biz);
  const mailer = resolveMailer(biz);
  const id = publicId("em");
  const now = new Date();
  let ok = true;
  let error: string | null = null;
  let providerMessageId: string | null = null;
  try {
    const res = await mailer.send({
      to,
      ...resolveSender(emailCfg),
      // Only the customer: the link opens their account.
      cc: [],
      bcc: [],
      subject: applySubjectPrefix(emailCfg, rendered.subject),
      html: rendered.html,
      text: rendered.text,
      idempotencyKey: id,
    });
    providerMessageId = res.providerMessageId;
  } catch (e) {
    ok = false;
    error = (e as Error).message ?? "send failed";
    log.warn("new link send failed", { error });
  }
  await withTenant(organizationId, (tx) =>
    tx.insert(emailMessages).values({
      publicId: id,
      organizationId,
      businessId,
      customerId: input.customerId,
      eventId: null,
      type: "new_link",
      toAddress: to,
      ccAddresses: [],
      subject: logged.subject,
      bodyHtml: logged.html,
      bodyText: logged.text,
      status: ok ? "sent" : "failed",
      transport: mailer.kind,
      attempts: 1,
      lastError: error,
      providerMessageId,
      lastAttemptAt: now,
      nextAttemptAt: null,
      sentAt: ok ? now : null,
    }),
  );
  return ok;
}
