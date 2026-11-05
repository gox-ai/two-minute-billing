/**
 * Limits on credit an operator gives for free (`credit_config.grant_limits`, per currency):
 * wallet `granted` top-ups, promotional credit, and promotional credit grants.
 *
 * `max_minor`: a grant above it is refused. `alert_above_minor`: a grant above it is allowed,
 * written to the audit log, and mailed to the team when the `large_grants` alert is on.
 * Unset means no limit and no alert, which is the behaviour before this setting.
 */
import { eq } from "drizzle-orm";
import { businesses, customers, type BusinessCreditConfig } from "@db/schema";
import { afterCommit, type Tx } from "@/platform/db";
import { formatMoney } from "@/platform/currency";
import { createLogger } from "@/platform/logger";
import { writeAuditLog } from "@/modules/audit/service";

const log = createLogger("credits.grant-limits");

export type GrantKind = "wallet_topup" | "promotional_credit" | "credit_grant";

export interface GrantLimit {
  maxMinor: number | null;
  alertAboveMinor: number | null;
}

/** Pure: the limit for one currency. Absent or malformed → none. */
export function grantLimitFor(
  cfg: BusinessCreditConfig | null | undefined,
  currency: string,
): GrantLimit {
  const l = cfg?.grant_limits?.[currency.toUpperCase()];
  const num = (v: unknown) =>
    typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;
  return { maxMinor: num(l?.max_minor), alertAboveMinor: num(l?.alert_above_minor) };
}

const KIND_LABEL: Record<GrantKind, string> = {
  wallet_topup: "wallet top-up",
  promotional_credit: "promotional credit",
  credit_grant: "credit grant",
};

/**
 * Check one free grant before it is written, inside the caller's transaction. Throws the
 * caller's own 400 error over the maximum. Over the alert threshold, after the write, call
 * `recordLargeGrant` with what this returns.
 */
export async function checkGrantLimit(
  tx: Tx,
  input: { businessId: string; currency: string; amountMinor: bigint; kind: GrantKind },
  refuse: (message: string) => Error,
): Promise<{ alertAboveMinor: number } | null> {
  const [biz] = await tx
    .select({ cfg: businesses.creditConfig })
    .from(businesses)
    .where(eq(businesses.id, input.businessId))
    .limit(1);
  const cur = input.currency.toUpperCase();
  const limit = grantLimitFor(biz?.cfg, cur);
  if (limit.maxMinor != null && input.amountMinor > BigInt(limit.maxMinor))
    throw refuse(
      `We could not give the ${KIND_LABEL[input.kind]}. The maximum for one grant is ${formatMoney(BigInt(limit.maxMinor), cur)}. Enter a smaller amount, or change the maximum in Settings > Credits.`,
    );
  if (limit.alertAboveMinor != null && input.amountMinor > BigInt(limit.alertAboveMinor))
    return { alertAboveMinor: limit.alertAboveMinor };
  return null;
}

/** Audit row in the caller's transaction; the team mail after it commits. */
export async function recordLargeGrant(
  tx: Tx,
  input: {
    organizationId: string;
    businessId: string;
    customerId: string;
    kind: GrantKind;
    reference: string;
    amountMinor: bigint;
    currency: string;
    alertAboveMinor: number;
  },
): Promise<void> {
  const [c] = await tx
    .select({ publicId: customers.publicId })
    .from(customers)
    .where(eq(customers.id, input.customerId))
    .limit(1);
  await writeAuditLog(
    {
      organizationId: input.organizationId,
      businessId: input.businessId,
      action: "credit.large_grant",
      resourceType: input.kind,
      resourceId: input.reference,
      after: {
        customer: c?.publicId ?? null,
        amount_minor: Number(input.amountMinor),
        currency: input.currency.toUpperCase(),
        alert_above_minor: input.alertAboveMinor,
      },
    },
    tx,
  );
  const send = async () => {
    const { sendLargeGrantAlert } = await import("@/modules/team-alerts/service");
    await sendLargeGrantAlert({
      organizationId: input.organizationId,
      businessId: input.businessId,
      kindLabel: KIND_LABEL[input.kind],
      reference: input.reference,
      customer: c?.publicId ?? null,
      amountMinor: input.amountMinor,
      currency: input.currency.toUpperCase(),
      alertAboveMinor: input.alertAboveMinor,
    }).catch((e) =>
      log.warn("large grant alert not sent", {
        event: "large_grant_alert_not_sent",
        error: (e as Error)?.message,
      }),
    );
  };
  if (!afterCommit(send)) await send();
}
