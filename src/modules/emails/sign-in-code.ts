/**
 * The portal sign-in code email (storefront Phase 4). A SYSTEM email: no outbox and no
 * automatic toggle. Sent by the `portal_sign_in_code_send` job (never inside the request, so
 * its timing reveals nothing), through the business's own transport; it respects
 * suppression and test mode.
 *
 * The code is never stored: the logged `email_messages` row carries a masked copy.
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

const log = createLogger("emails.sign-in-code");
const MASK = "••••••";

/** Send the code. Returns false when nothing was sent (suppressed, test mode, failure). */
export async function sendSignInCode(
  organizationId: string,
  businessId: string,
  input: { customerId: string; to: string; code: string },
): Promise<boolean> {
  const loaded = await withTenant(organizationId, async (tx) => {
    const [biz] = await tx.select().from(businesses).where(eq(businesses.id, businessId)).limit(1);
    const [cus] = await tx
      .select()
      .from(customers)
      .where(eq(customers.id, input.customerId))
      .limit(1);
    const override = await loadTemplateOverride(tx, businessId, "portal_sign_in_code");
    return { biz: biz!, cus, override };
  });
  const { biz, cus, override } = loaded;
  if (await isSuppressed(businessId, input.to)) return false;
  if (!(await testModeAllows(biz, input.to))) return false;

  const vars: RenderVars = {
    businessName: biz.name,
    customerName: (cus && accountHolderName(cus)) ?? "",
    logoUrl: biz.logoUrl ?? undefined,
    iconUrl: biz.iconUrl ?? undefined,
    brandColor: biz.brandColor ?? undefined,
  };
  const rendered = renderEmail("portal_sign_in_code", { ...vars, code: input.code }, override);
  const logged = renderEmail("portal_sign_in_code", { ...vars, code: MASK }, override);
  const emailCfg = resolveEmailConfig(biz);
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
      // Only the customer: a sign-in code is never copied to anyone else.
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
    log.warn("sign-in code send failed", { error });
  }
  await withTenant(organizationId, (tx) =>
    tx.insert(emailMessages).values({
      publicId: id,
      organizationId,
      businessId,
      customerId: input.customerId,
      eventId: null,
      type: "portal_sign_in_code",
      toAddress: input.to,
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
