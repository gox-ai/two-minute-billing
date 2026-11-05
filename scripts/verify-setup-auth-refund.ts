/**
 * A mandate's auth amount goes back, and a capture someone already booked is not an alarm.
 *
 *  A. `reconcileUnmatchedCapture` on a gateway account shared by two businesses: the business
 *     that does not own a booked charge logs `unmatched_capture_accounted_for`, never
 *     `unmatched_capture_ours_unattributed`. A truly unbooked capture still logs the error
 *     and keeps its `provider_events` row. A setup auth tagged with a customer is expected.
 *  B. `persistVaultedPaymentMethod` queues `refund_setup_auth` for a vault that carries a
 *     `setupAuthCharge`, keyed per charge.
 *  C. `refundSetupAuth`: waits for a registering mandate, refunds once, finds its own refund on
 *     a repeat, never refunds a booked payment, throws on a refusal, refunds on the last
 *     attempts whatever the mandate says, and skips a payment that was never captured.
 *
 * RazorPay is a stub on `config.RAZORPAY_API_BASE`; nothing leaves the process.
 *
 *   pnpm verify:setup-auth-refund
 */
import "dotenv/config";
import { eq, sql } from "drizzle-orm";
import { logger } from "@/platform/logger";
import { config } from "@/platform/config";
import { systemDb, withTenant, closeDb } from "@/platform/db";
import { publicId } from "@/platform/ids";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createGatewayAccount } from "@/modules/gateway/service";
import { createCustomer } from "@/modules/customers/service";
import { recordTransaction } from "@/modules/transactions/service";
import { handleProviderEvent } from "@/modules/webhooks/inbound";
import { persistVaultedPaymentMethod } from "@/modules/payment-methods/service";
import {
  refundSetupAuth,
  setupAuthRefundKey,
  type SetupAuthRefundJob,
} from "@/modules/payment-methods/setup-auth-refund";
import { customers, payments, providerEvents } from "@db/schema";

const checks: [string, boolean][] = [];
const ok = (n: string, c: boolean) => {
  checks.push([n, c]);
  console.log(`  ${c ? "✅" : "❌"} ${n}`);
};
const uniq = () => Math.random().toString(36).slice(2, 10);

// ── log capture: the root pino instance is what every service logger writes through ──
const lines: string[] = [];
const bigintSafe = (_k: string, v: unknown) => (typeof v === "bigint" ? String(v) : v);
for (const level of ["error", "warn", "info"] as const) {
  const original = logger[level].bind(logger) as (...a: unknown[]) => void;
  (logger as unknown as Record<string, unknown>)[level] = (...args: unknown[]) => {
    lines.push(`${level} ${JSON.stringify(args[0] ?? null, bigintSafe)}`);
    original(...args);
  };
}
const mark = () => lines.length;
const logged = (from: number, event: string, level?: string) =>
  lines.slice(from).some((l) => l.includes(event) && (!level || l.startsWith(`${level} `)));

// ── RazorPay stub ────────────────────────────────────────────────────────────────
interface StubPayment {
  id: string;
  status: string;
  captured: boolean;
  amount: number;
  amount_refunded: number;
  currency: string;
  method: string;
  order_id: string;
}
const orders = new Map<string, { id: string; amount: number; notes: Record<string, string> }>();
const pays = new Map<string, StubPayment>();
const refundsAt = new Map<string, Array<{ id: string; status: string; notes: unknown }>>();
let mandateStatus = "confirmed";
let refuseRefunds = false;
const refundPosts: Array<{ charge: string; body: Record<string, unknown> }> = [];

const realFetch = globalThis.fetch;
const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!url.startsWith(config.RAZORPAY_API_BASE)) return realFetch(input, init);
  const path = new URL(url).pathname.replace(/^\/v1/, "");
  const method = (init?.method ?? "GET").toUpperCase();
  let m: RegExpMatchArray | null;
  if (method === "GET" && (m = path.match(/^\/orders\/([^/]+)\/payments$/)))
    return reply(200, { items: [...pays.values()].filter((p) => p.order_id === m![1]) });
  if (method === "GET" && (m = path.match(/^\/orders\/([^/]+)$/))) {
    const o = orders.get(m[1]!);
    return o
      ? reply(200, { ...o, created_at: Math.floor(Date.now() / 1000) - 60 })
      : reply(400, { error: { description: "The id provided does not exist" } });
  }
  if (method === "GET" && (m = path.match(/^\/customers\/([^/]+)\/tokens\/([^/]+)$/)))
    return reply(200, {
      id: m[2],
      method: "card",
      recurring: mandateStatus === "confirmed",
      recurring_details: { status: mandateStatus, failure_reason: null },
      max_amount: 50000,
    });
  if (method === "GET" && (m = path.match(/^\/payments\/([^/]+)\/refunds$/)))
    return reply(200, { items: refundsAt.get(m[1]!) ?? [] });
  if (method === "POST" && (m = path.match(/^\/payments\/([^/]+)\/refund$/))) {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    refundPosts.push({ charge: m[1]!, body });
    if (refuseRefunds)
      return reply(400, { error: { description: "The payment has been fully refunded already" } });
    const r = { id: `rfnd_${uniq()}`, status: "processed", notes: body.notes };
    refundsAt.set(m[1]!, [...(refundsAt.get(m[1]!) ?? []), r]);
    return reply(200, r);
  }
  if (method === "GET" && (m = path.match(/^\/payments\/([^/]+)$/))) {
    const p = pays.get(m[1]!);
    return p ? reply(200, p) : reply(400, { error: { description: "not found" } });
  }
  throw new Error(`unstubbed RazorPay call: ${method} ${path}`);
}) as typeof fetch;

/** A gateway object of OURS: an order tagged with `ref`, and a captured payment on it. */
function gatewayCapture(ref: string, amount: number, status = "captured") {
  const orderId = `order_${uniq()}`;
  const chargeId = `pay_${uniq()}`;
  orders.set(orderId, { id: orderId, amount, notes: { tmbilling_ref: ref } });
  pays.set(chargeId, {
    id: chargeId,
    status,
    captured: status === "captured",
    amount,
    amount_refunded: 0,
    currency: "INR",
    method: "card",
    order_id: orderId,
  });
  return { orderId, chargeId };
}

const captureEvent = (chargeId: string, orderId: string) => ({
  providerEventId: `evt_${uniq()}`,
  type: "charge.succeeded" as const,
  providerChargeId: chargeId,
  providerIntentId: orderId,
  occurredAt: new Date(),
  raw: { stub: true },
});

async function main() {
  const org = await createOrganization({ name: `Setup Auth ${uniq()}` });
  const orgId = org.organization.id;
  const newBiz = (name: string) =>
    createBusiness({ organizationId: orgId, name, defaultCurrency: "INR", livemode: "test" });
  const bizA = await newBiz("Owner");
  const bizB = await newBiz("Sibling");
  // One RazorPay merchant connected to both businesses: every event reaches each.
  const creds = { key_id: "rzp_test_shared", key_secret: "shared" };
  const acctA = await createGatewayAccount({
    organizationId: orgId,
    businessId: bizA.id,
    gatewayKey: "razorpay",
    label: "RZP A",
    credentials: creds,
  });
  await createGatewayAccount({
    organizationId: orgId,
    businessId: bizB.id,
    gatewayKey: "razorpay",
    label: "RZP B",
    credentials: creds,
  });
  const customer = await createCustomer({
    organizationId: orgId,
    businessId: bizA.id,
    email: `setup-auth-${uniq()}@example.com`,
  });

  console.log("── A · unmatched captures ──");
  // A1: booked by the owning business, delivered to the sibling.
  const booked = gatewayCapture(`txn_${uniq()}`, 50000);
  await withTenant(orgId, async (tx) => {
    await tx.insert(payments).values({
      organizationId: orgId,
      businessId: bizA.id,
      customerId: customer.id,
      publicId: publicId("pay"),
      status: "succeeded",
      amountMinor: 50000n,
      currency: "INR",
      providerKey: "razorpay",
      providerChargeId: booked.chargeId,
    });
    await recordTransaction(
      {
        organizationId: orgId,
        businessId: bizA.id,
        customerId: customer.id,
        type: "payment",
        status: "succeeded",
        amountMinor: 50000n,
        currency: "INR",
        gatewayAccountId: acctA.id,
        gatewayKey: "razorpay",
        idAtGateway: booked.chargeId,
      },
      tx,
    );
  });
  let at = mark();
  const r1 = await handleProviderEvent("razorpay", captureEvent(booked.chargeId, booked.orderId), {
    businessId: bizB.id,
  });
  ok(`a sibling's delivery of a booked capture is ignored (${r1})`, r1 === "ignored");
  ok(
    "…and logs unmatched_capture_accounted_for",
    logged(at, "unmatched_capture_accounted_for", "info"),
  );
  ok(
    "…and NOT unmatched_capture_ours_unattributed",
    !logged(at, "unmatched_capture_ours_unattributed"),
  );

  // A2: tagged ours, booked nowhere: still the error, with its durable row.
  const lost = gatewayCapture(`txn_${uniq()}`, 70000);
  const lostEv = captureEvent(lost.chargeId, lost.orderId);
  at = mark();
  const r2 = await handleProviderEvent("razorpay", lostEv, { businessId: bizB.id });
  ok(`an unbooked capture of ours is ignored, not booked (${r2})`, r2 === "ignored");
  ok(
    "…and still logs unmatched_capture_ours_unattributed at error",
    logged(at, "unmatched_capture_ours_unattributed", "error"),
  );
  ok("…and not as accounted for", !logged(at, "unmatched_capture_accounted_for"));
  const [row] = await systemDb
    .select()
    .from(providerEvents)
    .where(eq(providerEvents.providerEventId, lostEv.providerEventId));
  ok(
    `…and keeps its provider_events row for the alert (outcome=${row?.outcome})`,
    row?.outcome === "ignored" && row?.normalized != null,
  );

  // A3: a vault setup's auth amount (order tagged with our customer id).
  const setup = gatewayCapture(customer.publicId, 100);
  at = mark();
  const r3 = await handleProviderEvent("razorpay", captureEvent(setup.chargeId, setup.orderId), {
    businessId: bizB.id,
  });
  ok(`a setup auth delivered to the sibling is ignored (${r3})`, r3 === "ignored");
  ok(
    "…as an expected setup authorization",
    lines.slice(at).some((l) => l.includes("setup_authorization")) &&
      !logged(at, "unmatched_capture_ours_unattributed"),
  );

  console.log("\n── B · the vault queues the refund ──");
  const [custRow] = await withTenant(orgId, (tx) =>
    tx.select().from(customers).where(eq(customers.id, customer.id)),
  );
  const vaultAuth = gatewayCapture(customer.publicId, 100);
  const tokenId = `token_${uniq()}`;
  const pm = await persistVaultedPaymentMethod({
    organizationId: orgId,
    businessId: bizA.id,
    customer: custRow!,
    gatewayAccountId: acctA.id,
    providerCustomerId: "cust_SETUPAUTH0001",
    vaulted: {
      providerKey: "razorpay",
      providerPaymentMethodId: tokenId,
      display: { type: "card", last4: "4366" },
      setupAuthCharge: { providerChargeId: vaultAuth.chargeId, amountMinor: 100n, currency: "INR" },
    },
  });
  const key = setupAuthRefundKey("razorpay", vaultAuth.chargeId);
  const jobs = (await systemDb.execute(
    sql`select t.identifier as task_identifier, j.max_attempts, j.payload
          from graphile_worker._private_jobs j
          join graphile_worker._private_tasks t on t.id = j.task_id
         where j.key = ${key}`,
  )) as unknown as Array<{ task_identifier: string; max_attempts: number; payload: unknown }>;
  ok(
    `vaulting a card with a setup auth queues refund_setup_auth (${jobs.length} job)`,
    jobs.length === 1 && jobs[0]!.task_identifier === "refund_setup_auth",
  );
  ok(
    "…for this payment method and charge",
    JSON.stringify(jobs[0]?.payload ?? {}).includes(pm.publicId) &&
      JSON.stringify(jobs[0]?.payload ?? {}).includes(vaultAuth.chargeId),
  );
  // Re-vaulting the same card queues no second job.
  await persistVaultedPaymentMethod({
    organizationId: orgId,
    businessId: bizA.id,
    customer: custRow!,
    gatewayAccountId: acctA.id,
    providerCustomerId: "cust_SETUPAUTH0001",
    vaulted: {
      providerKey: "razorpay",
      providerPaymentMethodId: tokenId,
      display: { type: "card", last4: "4366" },
      setupAuthCharge: { providerChargeId: vaultAuth.chargeId, amountMinor: 100n, currency: "INR" },
    },
  });
  const again = (await systemDb.execute(
    sql`select count(*)::int n from graphile_worker._private_jobs where key = ${key}`,
  )) as unknown as Array<{ n: number }>;
  ok("…and a re-vault keeps it at one job", again[0]?.n === 1);
  // This suite runs the job itself; a dev worker must not take it to the real gateway.
  await systemDb.execute(sql`select graphile_worker.remove_job(${key})`);

  console.log("\n── C · refundSetupAuth ──");
  const jobFor = (chargeId: string): SetupAuthRefundJob => ({
    organizationId: orgId,
    businessId: bizA.id,
    gatewayAccountId: acctA.id,
    providerKey: "razorpay",
    providerCustomerId: "cust_SETUPAUTH0001",
    providerPaymentMethodId: tokenId,
    providerChargeId: chargeId,
    amountMinor: "100",
    currency: "INR",
    paymentMethod: pm.publicId,
  });
  const first = { attempts: 1, maxAttempts: 12 };
  const auth = gatewayCapture(customer.publicId, 100);

  mandateStatus = "initiated";
  const waiting = await refundSetupAuth(jobFor(auth.chargeId), first).catch((e: Error) => e);
  ok(
    "a still-registering mandate defers the refund (throws, no refund call)",
    waiting instanceof Error && refundPosts.length === 0,
  );

  mandateStatus = "confirmed";
  const done = await refundSetupAuth(jobFor(auth.chargeId), first);
  const post = refundPosts.at(-1);
  ok(`a confirmed mandate's auth is refunded (${done})`, done === "refunded");
  ok(
    "…for the auth amount, tagged with the per-charge key",
    post?.charge === auth.chargeId &&
      post.body.amount === 100 &&
      (post.body.notes as Record<string, string>)?.tmbilling_ref ===
        setupAuthRefundKey("razorpay", auth.chargeId),
  );
  const repeat = await refundSetupAuth(jobFor(auth.chargeId), first);
  ok(
    `a repeat finds its own refund and makes no second one (${repeat})`,
    repeat === "already_refunded" && refundPosts.length === 1,
  );

  // Money we booked is never refunded here.
  const bookedAuth = gatewayCapture(customer.publicId, 100);
  await withTenant(orgId, (tx) =>
    tx.insert(payments).values({
      organizationId: orgId,
      businessId: bizA.id,
      customerId: customer.id,
      publicId: publicId("pay"),
      status: "succeeded",
      amountMinor: 100n,
      currency: "INR",
      providerKey: "razorpay",
      providerChargeId: bookedAuth.chargeId,
    }),
  );
  const guarded = await refundSetupAuth(jobFor(bookedAuth.chargeId), first);
  ok(
    `a booked payment is never auto-refunded (${guarded})`,
    guarded === "booked_payment" && refundPosts.length === 1,
  );

  const refused = gatewayCapture(customer.publicId, 100);
  refuseRefunds = true;
  const err = await refundSetupAuth(jobFor(refused.chargeId), first).catch((e: Error) => e);
  refuseRefunds = false;
  ok(
    "a refused refund throws so the queue retries it",
    err instanceof Error && /refused the refund/.test(err.message),
  );

  mandateStatus = "initiated";
  const last = gatewayCapture(customer.publicId, 100);
  const forced = await refundSetupAuth(jobFor(last.chargeId), { attempts: 12, maxAttempts: 12 });
  mandateStatus = "confirmed";
  ok(`the last attempt refunds whatever the mandate says (${forced})`, forced === "refunded");

  const lapsed = gatewayCapture(customer.publicId, 100, "refunded");
  const before = refundPosts.length;
  const none = await refundSetupAuth(jobFor(lapsed.chargeId), first);
  ok(
    `an auth the gateway never captured needs no refund (${none})`,
    none === "not_captured" && refundPosts.length === before,
  );

  const failed = checks.filter(([, c]) => !c);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  await closeDb();
  if (failed.length) {
    console.log("❌ SETUP AUTH REFUND: FAIL");
    process.exit(1);
  }
  console.log("✅ SETUP AUTH REFUND: PASS");
  process.exit(0);
}

main().catch(async (e) => {
  console.error(e);
  await closeDb().catch(() => {});
  process.exit(1);
});
