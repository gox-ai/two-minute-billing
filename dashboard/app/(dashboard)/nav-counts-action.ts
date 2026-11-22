"use server";

import { listRetries } from "@/lib/api/retries";
import { listDisputes } from "@/lib/api/disputes";
import { getBillingModels } from "@/lib/api/billing-models";
import type { BillingModelId } from "@/lib/billing-models";
import { allows, requireUser } from "@/lib/session";

export interface NavCounts {
  retries?: number;
  disputes?: number;
  /** The billing models the business has; absent when unknown, so no report is hidden. */
  models?: BillingModelId[];
}

/**
 * Badge counts for one business's rail. Called by the rail on every navigation, so the
 * count follows the business being viewed and the work done since.
 *
 * Each count soft-fails on its own and is left out when unknown or not allowed: the rail
 * then shows no badge, never a zero it did not count.
 */
export async function navCountsAction(biz: string): Promise<NavCounts> {
  if (!/^biz_[A-Za-z0-9]+$/.test(biz)) return {};
  const user = await requireUser();
  const [retries, disputes, models] = await Promise.all([
    // The "Needs attention" segment of Retries: what the badge sends the operator to.
    allows(user, "invoices:view", "ops")
      ? listRetries(biz, { limit: 1, activeOnly: true }).then(
          (r) => r.total ?? undefined,
          () => undefined,
        )
      : undefined,
    // `needs_response` only: under review waits on the gateway, not on the operator.
    allows(user, "payments:view", "ops")
      ? listDisputes(biz, { limit: 1, status: "needs_response" }).then(
          (r) => r.total ?? undefined,
          () => undefined,
        )
      : undefined,
    allows(user, "reports:view", "ops") ? getBillingModels(biz) : null,
  ]);
  return {
    ...(models ? { models } : {}),
    ...(retries != null ? { retries } : {}),
    ...(disputes != null ? { disputes } : {}),
  };
}
