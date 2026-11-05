/**
 * Where a billing email's button sends the buyer — a LEAF module, imported by every path
 * that renders one.
 *
 * It lived inside `outbox.ts` and so reached only automatic mail. The operator-initiated
 * sender rendered its own `portalUrl` from the bare `PORTAL_BASE_URL`, which meant the
 * "Update payment method" button on the one email an operator sends by hand pointed at the
 * deployment root: no `/portal` path, and no session. `outbox.ts` had already written down
 * why that is not a small thing — a button that starts a login instead of doing the job "is
 * the difference between a button that works and a button that lies" — and the ad-hoc path
 * never got the fix. One definition, two callers, so it cannot drift again.
 *
 * A leaf for the same reason `payment-methods/mandate-afa` is one: `outbox.ts` registers an
 * event sink at import time, so importing it from the ad-hoc sender would arm the automatic
 * mail pipeline as a side effect of sending one message by hand.
 */
import type { Tx } from "@/platform/db";
import { config } from "@/platform/config";
import { createLogger } from "@/platform/logger";
import { and, eq } from "drizzle-orm";
import { businesses, invoices } from "@db/schema";
import { createPortalSession } from "@/modules/customer-portal/service";
import { actionEnabled, actionForwardUrl } from "@/modules/customer-portal/actions";
import { resolveStorefrontConfig } from "@/modules/checkout/storefront-config";

/**
 * A pre-authenticated portal link for one customer, for one email.
 *
 * `/portal/s/<token>` is the EXCHANGE route (W1): it trades the entry credential for an
 * HttpOnly cookie and redirects to a clean `/portal`, so the token never lingers in the
 * URL bar next to a payment SDK. Minted `kind: 'email'`, which is what buys it the
 * five-day window (0195) instead of the API's hour — a dunning notice read the next
 * morning has to still work.
 *
 * Returns null with no PORTAL_BASE_URL, and the caller then leaves the button pointing at
 * the request page rather than emitting a half-formed link.
 */
export async function emailPortalLink(
  tx: Tx,
  input: { organizationId: string; businessId: string; customerId: string },
  /**
   * Phase 4b: the task the email's button names. The link opens the portal on that task;
   * where the business turned the task off, it opens the portal home, as before.
   */
  action?: { kind?: "pay_invoice" | "update_card"; invoiceId?: string | null } | null,
): Promise<string | null> {
  const base = config.PORTAL_BASE_URL?.replace(/\/$/, "");
  if (!base) return null;
  const forwardUrl = await actionForwardFor(tx, input, action ?? null);
  const session = await createPortalSession({ ...input, kind: "email", tx, forwardUrl });
  return `${base}/portal/s/${session.accessToken}`;
}

async function actionForwardFor(
  tx: Tx,
  input: { businessId: string; customerId: string },
  action: { kind?: "pay_invoice" | "update_card"; invoiceId?: string | null } | null,
): Promise<string | null> {
  if (!action?.kind) return null;
  const [biz] = await tx
    .select({ storefrontConfig: businesses.storefrontConfig })
    .from(businesses)
    .where(eq(businesses.id, input.businessId))
    .limit(1);
  if (!biz || !actionEnabled(resolveStorefrontConfig(biz), action.kind)) return null;
  if (action.kind === "update_card") return actionForwardUrl("update_card");
  if (!action.invoiceId) return null;
  // The outbox carries the invoice's row id; the ad-hoc path its public id.
  const [inv] = await tx
    .select({ publicId: invoices.publicId })
    .from(invoices)
    .where(
      and(
        eq(invoices.businessId, input.businessId),
        eq(invoices.customerId, input.customerId),
        action.invoiceId.startsWith("inv_")
          ? eq(invoices.publicId, action.invoiceId)
          : eq(invoices.id, action.invoiceId),
      ),
    )
    .limit(1);
  return inv ? actionForwardUrl("pay_invoice", inv.publicId) : null;
}

/**
 * The buyer-facing portal link for automated mail.
 *
 * This used to be a bare `config.PORTAL_BASE_URL` — the deployment-wide base URL, with
 * no customer and no business in it, so every billing email's button led to a page that
 * could not know who had arrived. This is a working deep link instead.
 *
 * It deliberately does NOT embed a portal session. `createPortalSession` mints a 72h
 * bearer credential; putting one in every dunning email means a forwarded or breached
 * mailbox is account access, and the day-8 dunning notice would carry an already-expired
 * token anyway. That is what `emailPortalLink` above is for, and it is minted only for
 * the ONE button an email actually renders.
 *
 * ⚠ 2026-08-30: this used to be a per-business `/portal/request?business=…` deep link —
 * the self-serve page that asked the buyer for their email and mailed them a magic link.
 * That page and its route are gone (a single-use link a buyer requests by mail is spent
 * by the mail scanner before the human clicks; see
 * `src/modules/customer-portal/README.md` § "Self-serve access"). Pointing at the deleted
 * path would have shipped a 404 into every merchant template that writes `{{portalUrl}}`,
 * so this is now the portal's own entry: a buyer whose 72h cookie is still live lands
 * straight in their billing portal, and one whose is not gets the portal's truthful
 * "this link is invalid or has expired — please ask for a new link" card. Neither
 * outcome is a promise we cannot keep.
 *
 * It is ALSO the gate on whether an email renders an action button at all (`blocksFor`
 * builds `action` only when `portalUrl` is set, and `resolveRecipient` then overwrites
 * that url with a pre-authenticated one). Returning undefined here would silently remove
 * "Pay now" and "Update payment method" from every billing email.
 */
const portalLog = createLogger("emails.portal-link");
let warnedNoPortal = false;

export function portalEntryUrl(): string | undefined {
  // The portal is served by the dashboard app, so its origin is the fallback. Templates
  // treat `{{portalUrl}}` as always set; a deployment with neither URL is misconfigured.
  const base = (config.PORTAL_BASE_URL || config.DASHBOARD_BASE_URL)?.replace(/\/$/, "");
  if (!base) {
    if (!warnedNoPortal) {
      warnedNoPortal = true;
      portalLog.warn(
        "no PORTAL_BASE_URL or DASHBOARD_BASE_URL: billing emails go out without their button",
      );
    }
    return undefined;
  }
  // No business id in the URL any more: the portal identifies the buyer from their
  // session cookie, and there is no unauthenticated page left that a business id could
  // tell anything. Carrying one would be a parameter nothing reads.
  return `${base}/portal`;
}
