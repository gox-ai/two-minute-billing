/**
 * Fixtures for the meter billing suites (verify:rate-cards, verify:usage-late): a business,
 * meters, events written straight to `usage_events` with a chosen receive time, and a renewal
 * over a chosen period.
 */
import { randomBytes } from "node:crypto";
import { desc, eq, sql } from "drizzle-orm";
import { systemDb, withTenant } from "@/platform/db";
import { createBusiness, createOrganization } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { createProduct } from "@/modules/catalog/service";
import { runBillingClockTick } from "@/modules/subscriptions/renewal";
import { runWithClockScope } from "@/platform/clock";
import { invoiceLineItems, invoices, meters, subscriptions } from "@db/schema";

export function checker() {
  const fails: string[] = [];
  const check = (name: string, cond: boolean, detail?: unknown) => {
    console.log(
      `  ${cond ? "✓" : "✗"} ${name}${!cond && detail !== undefined ? ` — ${JSON.stringify(detail, (_k, v) => (typeof v === "bigint" ? String(v) : v))}` : ""}`,
    );
    if (!cond) fails.push(name);
  };
  return { fails, check };
}

/** A uuid_v7 whose id-time is `ms`: the event's receive time. */
export function uuidAt(ms: number): string {
  const h = Math.floor(ms).toString(16).padStart(12, "0");
  const r = randomBytes(10).toString("hex");
  const variant = (8 | (parseInt(r[3]!, 16) & 3)).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-7${r.slice(0, 3)}-${variant}${r.slice(4, 7)}-${r.slice(7, 19)}`;
}

export async function meterBusiness(name: string) {
  const org = await createOrganization({ name });
  const orgId = org.organization.id;
  const biz = await createBusiness({
    organizationId: orgId,
    name: "Biz",
    defaultCurrency: "USD",
    livemode: "test",
  });
  const ids = { organizationId: orgId, businessId: biz.id };
  const product = await createProduct({ ...ids, name: "AI usage" });
  return { org, orgId, biz, ids, product };
}

export async function newCustomer(
  ids: { organizationId: string; businessId: string },
  tag: string,
) {
  const customer = await createCustomer({ ...ids, email: `${tag}-${Date.now()}@example.com` });
  await vaultPaymentMethod({ ...ids, customer, token: "tok_4242" });
  return customer;
}

let meterN = 0;
export async function createTestMeter(
  ids: { organizationId: string; businessId: string },
  m: {
    aggregation?: string;
    valueProperty?: string | null;
    uniqueProperty?: string | null;
    groupBy?: string[];
    recurring?: boolean;
    eventName?: string;
  } = {},
) {
  const key = `m${++meterN}-${Date.now()}`;
  const aggregation = m.aggregation ?? "sum";
  const [row] = await systemDb
    .insert(meters)
    .values({
      ...ids,
      key,
      name: key,
      eventName: m.eventName ?? key,
      aggregation,
      valueProperty:
        m.valueProperty !== undefined
          ? m.valueProperty
          : aggregation === "count" || aggregation === "unique"
            ? null
            : "tokens",
      uniqueProperty: m.uniqueProperty ?? null,
      groupBy: m.groupBy ?? [],
      recurring: m.recurring ?? false,
    })
    .returning();
  return row!;
}

let eventN = 0;
/** Write one matched event. `receivedMs` defaults to 10 minutes ago (inside any cutoff). */
export async function sendEvent(
  ids: { organizationId: string; businessId: string },
  e: {
    customerId: string;
    eventName: string;
    at: Date;
    properties: Record<string, string | number | boolean>;
    receivedMs?: number;
    amount?: string;
    cost?: string;
    currency?: string;
  },
) {
  const id = uuidAt(e.receivedMs ?? Date.now() - 10 * 60_000);
  await systemDb.execute(sql`
    insert into usage_events (id, organization_id, business_id, customer_id, customer_key,
      event_name, properties, "timestamp", key, amount, cost, currency, matched_at)
    values (${id}::uuid, ${ids.organizationId}, ${ids.businessId}, ${e.customerId}, ${e.customerId},
      ${e.eventName}, ${JSON.stringify(e.properties)}::jsonb, ${e.at.toISOString()}::timestamptz,
      ${`ev-${Date.now()}-${++eventN}`}, ${e.amount ?? null}::numeric, ${e.cost ?? null}::numeric,
      ${e.currency ?? null}, null)`);
  return id;
}

/** Put a subscription's term on [start, end). */
export async function setTerm(subscriptionId: string, start: Date, end: Date) {
  await systemDb
    .update(subscriptions)
    .set({ currentPeriodStart: start, currentPeriodEnd: end })
    .where(eq(subscriptions.id, subscriptionId));
}

/** Run the billing clock for this business only, at `now`. */
export function tick(businessId: string, now = new Date()) {
  return runWithClockScope({ onlyBusinessId: businessId }, () => runBillingClockTick(now));
}

/** Every invoice of a subscription, newest first, with its lines. */
export async function invoicesOf(orgId: string, subscriptionId: string) {
  return withTenant(orgId, async (tx) => {
    const invs = await tx
      .select()
      .from(invoices)
      .where(eq(invoices.subscriptionId, subscriptionId))
      .orderBy(desc(invoices.createdAt));
    const out = [];
    for (const inv of invs)
      out.push({
        inv,
        lines: await tx
          .select()
          .from(invoiceLineItems)
          .where(eq(invoiceLineItems.invoiceId, inv.id)),
      });
    return out;
  });
}

export const usageLines = <L extends { kind: string; adjustment: string | null }>(lines: L[]) =>
  lines.filter((l) => l.kind === "usage" && !l.adjustment);
