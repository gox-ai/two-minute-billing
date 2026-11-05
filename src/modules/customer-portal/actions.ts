/**
 * Single-action portal links (storefront Phase 4b): a link that opens the portal on one task.
 *
 * The task travels as the session's `forward_url`, a `/portal?tab=…` path the portal page
 * reads to open the task. Only the shapes below are accepted, so a link can never send the
 * customer off-site, and the object must belong to the customer the link is for.
 * Per business, `storefront_config.portal_actions` turns each task off; then a link opens
 * the portal home, as links did before.
 */
import { and, eq } from "drizzle-orm";
import { withTenant } from "@/platform/db";
import { invoices, subscriptions } from "@db/schema";
import type { StorefrontConfig } from "@/modules/checkout/storefront-config";
import { PORTAL_FORWARD_PATHS } from "./service";

export const PORTAL_ACTIONS = [
  "pay_invoice",
  "update_card",
  "change_plan",
  "cancel_subscription",
] as const;
export type PortalAction = (typeof PORTAL_ACTIONS)[number];

const SWITCH: Record<PortalAction, keyof StorefrontConfig["portalActions"]> = {
  pay_invoice: "payInvoice",
  update_card: "updateCard",
  change_plan: "changePlan",
  cancel_subscription: "cancel",
};

/** The task's own object: an invoice, a subscription, or none (a card is the customer's). */
export const ACTION_OBJECT: Record<PortalAction, "invoice" | "subscription" | null> = {
  pay_invoice: "invoice",
  update_card: null,
  change_plan: "subscription",
  cancel_subscription: "subscription",
};

export function actionForwardUrl(action: PortalAction, objectId?: string | null): string {
  switch (action) {
    case "pay_invoice":
      return `/portal?tab=invoices&pay_invoice=${objectId}`;
    case "update_card":
      return "/portal?tab=methods&add_card=1";
    case "change_plan":
      return `/portal?tab=plan&change=${objectId}`;
    case "cancel_subscription":
      return `/portal?tab=plan&cancel=${objectId}`;
  }
}

const ACTION_FORWARD =
  /^\/portal\?tab=(invoices&pay_invoice=inv_[A-Za-z0-9]+|methods&add_card=1|plan&(change|cancel)=sub_[A-Za-z0-9]+)$/;

/** A forward URL the portal may open on: a section, or one task. */
export function isPortalForwardUrl(u: string): boolean {
  return (PORTAL_FORWARD_PATHS as readonly string[]).includes(u) || ACTION_FORWARD.test(u);
}

export const actionEnabled = (cfg: StorefrontConfig, action: PortalAction) =>
  cfg.portalActions[SWITCH[action]];

export class PortalActionError extends Error {}

/**
 * The forward URL for a task on one customer's link, after checking the object is theirs.
 * Throws for a missing or foreign object; returns null when the business turned the task off.
 */
export async function resolveActionForward(input: {
  organizationId: string;
  businessId: string;
  customerId: string;
  cfg: StorefrontConfig;
  action: PortalAction;
  objectId?: string | null;
}): Promise<string | null> {
  const kind = ACTION_OBJECT[input.action];
  if (kind && !input.objectId)
    throw new PortalActionError(`Give the ${kind} for the ${input.action} link.`);
  if (kind) {
    const table = kind === "invoice" ? invoices : subscriptions;
    const [row] = await withTenant(input.organizationId, (tx) =>
      tx
        .select({ id: table.id })
        .from(table)
        .where(
          and(
            eq(table.publicId, input.objectId!),
            eq(table.businessId, input.businessId),
            eq(table.customerId, input.customerId),
          ),
        )
        .limit(1),
    );
    if (!row) throw new PortalActionError(`No such ${kind} for this customer: ${input.objectId}`);
  }
  if (!actionEnabled(input.cfg, input.action)) return null;
  return actionForwardUrl(input.action, input.objectId);
}
