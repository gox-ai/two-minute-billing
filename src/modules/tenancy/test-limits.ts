/**
 * Customer and subscription limits of a TEST business (0406).
 *
 * Test mode is free, so it must not be able to run a real book. Every existing row counts
 * (archived customers and cancelled subscriptions too; a soft-deleted subscription does not),
 * so "Delete test data" is what frees room. Live businesses are never limited here.
 *
 * Limit = the business's staff override, else the env setting, else 1,000 on Cloud and none
 * on self-hosted. 0 = no limit.
 */
import { and, count, eq, isNull, sql } from "drizzle-orm";
import { businesses, customers, subscriptions } from "@db/schema";
import { config } from "@/platform/config";
import { withTenant, type Tx } from "@/platform/db";
import { isCloud } from "@/platform/edition";

export type TestLimitKind = "customers" | "subscriptions";

export const CLOUD_TEST_LIMIT = 1000;

/** The edition default; null = no limit. */
export function defaultTestLimit(kind: TestLimitKind): number | null {
  const set =
    kind === "customers"
      ? config.TEST_BUSINESS_CUSTOMER_LIMIT
      : config.TEST_BUSINESS_SUBSCRIPTION_LIMIT;
  const n = set ?? (isCloud() ? CLOUD_TEST_LIMIT : null);
  return n === 0 ? null : n;
}

function effectiveLimit(override: number | null, kind: TestLimitKind): number | null {
  if (override != null) return override === 0 ? null : override;
  return defaultTestLimit(kind);
}

/** A 400 wherever it is thrown (the global handler reads `statusCode`, `code`, `param`). */
export class TestBusinessLimitError extends Error {
  readonly statusCode = 400;
  readonly errorType = "invalid_request_error";
  readonly code = "test_business_limit_reached";
  constructor(
    readonly kind: TestLimitKind,
    readonly limit: number,
  ) {
    const noun = kind === "customers" ? "customer" : "subscription";
    super(
      `We could not create the ${noun}. This test business has reached its limit of ` +
        `${limit.toLocaleString("en-US")} ${kind}. Delete test data, or contact us to ` +
        `increase the limit.`,
    );
    this.name = "TestBusinessLimitError";
  }
}

async function countRows(tx: Tx, businessId: string, kind: TestLimitKind): Promise<number> {
  const [r] =
    kind === "customers"
      ? await tx.select({ n: count() }).from(customers).where(eq(customers.businessId, businessId))
      : await tx
          .select({ n: count() })
          .from(subscriptions)
          .where(and(eq(subscriptions.businessId, businessId), isNull(subscriptions.deletedAt)));
  return Number(r?.n ?? 0);
}

async function limitsRow(tx: Tx, businessId: string) {
  const [b] = await tx
    .select({
      livemode: businesses.livemode,
      customers: businesses.testCustomerLimit,
      subscriptions: businesses.testSubscriptionLimit,
    })
    .from(businesses)
    .where(eq(businesses.id, businessId))
    .limit(1);
  return b;
}

/**
 * Throws `TestBusinessLimitError` when `adding` more rows would pass the limit. Call inside
 * the transaction that inserts them: the advisory lock holds until it commits, so two
 * concurrent creates cannot both read the last free slot.
 */
export async function assertTestBusinessRoom(
  tx: Tx,
  businessId: string,
  kind: TestLimitKind,
  adding = 1,
): Promise<void> {
  const b = await limitsRow(tx, businessId);
  if (!b || b.livemode !== "test") return;
  const limit = effectiveLimit(b[kind], kind);
  if (limit == null) return;
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`test_limit:${kind}:${businessId}`}, 0))`,
  );
  if ((await countRows(tx, businessId, kind)) + adding > limit)
    throw new TestBusinessLimitError(kind, limit);
}

export interface TestLimitUsage {
  used: number;
  /** null = no limit. */
  limit: number | null;
}

/** Usage of a test business; null for a live one. */
export async function getTestBusinessUsage(
  organizationId: string,
  businessId: string,
): Promise<{ customers: TestLimitUsage; subscriptions: TestLimitUsage } | null> {
  return withTenant(organizationId, async (tx) => {
    const b = await limitsRow(tx, businessId);
    if (!b || b.livemode !== "test") return null;
    const usage = async (kind: TestLimitKind): Promise<TestLimitUsage> => ({
      used: await countRows(tx, businessId, kind),
      limit: effectiveLimit(b[kind], kind),
    });
    return { customers: await usage("customers"), subscriptions: await usage("subscriptions") };
  });
}
