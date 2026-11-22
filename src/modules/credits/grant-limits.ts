/**
 * Limits on credit an operator gives for free (`credit_config.grant_limits`, per currency):
 * wallet `granted` top-ups, promotional credit, and promotional credit grants. A grant in a
 * unit with no rate has no money value: `credit_config.unit_grant_limits`, per unit, in units.
 *
 * `max_minor`: a grant above it is refused. `alert_above_minor`: a grant above it is allowed,
 * written to the audit log, and sent as the "Large free credit grant" notification.
 * Unset means no limit and no alert, which is the behaviour before this setting.
 */
import { eq } from "drizzle-orm";
import { businesses, customers, type BusinessCreditConfig } from "@db/schema";
import { type Tx } from "@/platform/db";
import { formatMoney } from "@/platform/currency";
import { formatSteps } from "./units";
import { writeAuditLog } from "@/modules/audit/service";
import { enqueueNotification } from "@/modules/notifications/enqueue";

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
      `We could not give the ${KIND_LABEL[input.kind]}. The maximum for one grant is ${formatMoney(BigInt(limit.maxMinor), cur)}. Enter a smaller amount, or change the maximum in Settings → Credits.`,
    );
  if (limit.alertAboveMinor != null && input.amountMinor > BigInt(limit.alertAboveMinor))
    return { alertAboveMinor: limit.alertAboveMinor };
  return null;
}

export interface UnitGrantLimit {
  maxUnits: number | null;
  alertAboveUnits: number | null;
}

/** Pure: the limit of one unit with no rate, in its smallest step. Absent or malformed → none. */
export function unitGrantLimitFor(
  cfg: BusinessCreditConfig | null | undefined,
  unitKey: string,
): UnitGrantLimit {
  const l = cfg?.unit_grant_limits?.[unitKey];
  const num = (v: unknown) =>
    typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;
  return { maxUnits: num(l?.max_units), alertAboveUnits: num(l?.alert_above_units) };
}

/**
 * `checkGrantLimit` for a free grant in a unit with no rate: the limit is in units
 * (`credit_config.unit_grant_limits.<unit>`), because such credit has no money value.
 */
export async function checkUnitGrantLimit(
  tx: Tx,
  input: {
    businessId: string;
    unit: { key: string; name: string; pluralName: string | null; decimals: number };
    amount: bigint;
  },
  refuse: (message: string) => Error,
): Promise<{ alertAboveUnits: number } | null> {
  const [biz] = await tx
    .select({ cfg: businesses.creditConfig })
    .from(businesses)
    .where(eq(businesses.id, input.businessId))
    .limit(1);
  const limit = unitGrantLimitFor(biz?.cfg, input.unit.key);
  if (limit.maxUnits != null && input.amount > BigInt(limit.maxUnits))
    throw refuse(
      `We could not give the credit grant. The maximum for one grant is ${unitAmountText(BigInt(limit.maxUnits), input.unit)}. Enter a smaller amount, or change the maximum in Settings → Credits.`,
    );
  if (limit.alertAboveUnits != null && input.amount > BigInt(limit.alertAboveUnits))
    return { alertAboveUnits: limit.alertAboveUnits };
  return null;
}

/** "12500.5" → "12,500.5": groups the whole part of a number that people read. */
export function groupDigits(n: string): string {
  const [whole = "", frac] = n.split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+$)/g, ",");
  return frac === undefined ? grouped : `${grouped}.${frac}`;
}

/** "250 credits", "1 credit", "12.5 credits", "12,500 credits". */
export function unitAmountText(
  steps: bigint,
  unit: { name: string; pluralName: string | null; decimals: number },
): string {
  const n = formatSteps(steps, unit.decimals);
  return `${groupDigits(n)} ${n === "1" ? unit.name : (unit.pluralName ?? unit.name)}`;
}

/** Audit row and the team notification, both in the caller's transaction. */
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
    /** A unit with no rate: the grant and the limit as text ("250 credits"), not money. */
    units?: { unit: string; amount: string; alertAbove: string; amountSteps: bigint };
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
      after: input.units
        ? {
            customer: c?.publicId ?? null,
            unit: input.units.unit,
            amount_units: Number(input.units.amountSteps),
            alert_above_units: input.alertAboveMinor,
          }
        : {
            customer: c?.publicId ?? null,
            amount_minor: Number(input.amountMinor),
            currency: input.currency.toUpperCase(),
            alert_above_minor: input.alertAboveMinor,
          },
    },
    tx,
  );
  // The "Large free credit grant" notification, queued in this transaction: a rollback sends nothing.
  const label = KIND_LABEL[input.kind];
  await enqueueNotification(tx, {
    organizationId: input.organizationId,
    businessId: input.businessId,
    kinds: ["large_credit_grant"],
    dedupeKey: `direct:large_credit_grant:${input.businessId}:${input.kind}:${input.reference}`,
    payload: {
      record: c ? { type: "customer", id: c.publicId } : null,
      facts: {
        amountMinor: Number(input.amountMinor),
        currency: input.currency.toUpperCase(),
        ...(input.units ? { amountText: input.units.amount } : {}),
        reason: `${label.charAt(0).toUpperCase()}${label.slice(1)} ${input.reference}`,
      },
    },
  });
}
