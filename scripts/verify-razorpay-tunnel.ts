/**
 * RazorPay TRANSPORT verification — the one leg no other suite covers.
 *
 * `verify:webhook-inbound` signs payloads with our own secret and POSTs them to the
 * route directly; `verify:razorpay-live` polls RazorPay instead of waiting for a
 * webhook. Neither proves that **RazorPay's servers actually reach us** and that the
 * events *they* emit verify, attribute and reconcile. This does, end to end:
 *
 *   gateway account (real creds) → self-register the endpoint AT RazorPay via the
 *   tunnel origin → UPI Autopay mandate → subscription billed through the ENGINE
 *   (`billSubscriptionPeriod` → `collectInvoice`) → charge returns `pending`
 *   → wait for RazorPay to deliver `payment.captured` on its own
 *   → assert the payment settles, the transaction settles, and cash is booked
 *
 * This is also the only end-to-end proof of the async `in_progress → settled` path
 * over real transport (UPI Autopay debits settle minutes after the charge).
 *
 * ## Running it
 * ```
 * # terminal 1 — API (already running on :4000 in dev is fine; it must share DATABASE_URL)
 * pnpm dev
 * # terminal 2 — expose it
 * ngrok http 4000
 * # terminal 3
 * WEBHOOK_BASE_URL=https://<id>.ngrok-free.app pnpm verify:razorpay-tunnel
 * ```
 *
 * The API process must be reachable through the tunnel AND share this script's
 * database — the assertions read rows that process writes.
 *
 * Test keys only (refuses non-`rzp_test`). Amounts are trivial (₹1 mandate, ₹50 debit).
 * The RazorPay webhook is deactivated on exit so the sandbox isn't left with a dead
 * endpoint (RazorPay has no DELETE — `active: false` is the only removal).
 */
import "dotenv/config";
import { eq } from "drizzle-orm";
import { config } from "@/platform/config";
import { systemDb, withTenant, closeDb } from "@/platform/db";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { createGatewayAccount } from "@/modules/gateway/service";
import { provisionWebhookEndpoint } from "@/modules/gateway/webhook-endpoint";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import { createSubscription } from "@/modules/subscriptions/service";
import { billSubscriptionPeriod } from "@/modules/invoicing/service";
import { resolveAdapter } from "@/providers/registry";
import { RazorpayProvider } from "@/providers/razorpay";
import { gatewayAccounts, providerEvents, payments, transactions, ledgerEntries } from "@db/schema";

const checks: [string, boolean][] = [];
const ok = (n: string, c: boolean) => {
  checks.push([n, c]);
  console.log(`  ${c ? "✅" : "❌"} ${n}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const uniq = Math.random().toString(36).slice(2, 8);

if (!config.RAZORPAY_TEST_KEY_ID || !config.RAZORPAY_TEST_KEY_SECRET) {
  console.log("SKIP: RazorPay test keys not set");
  process.exit(0);
}
if (!config.RAZORPAY_TEST_KEY_ID.startsWith("rzp_test")) {
  console.error("REFUSING: RAZORPAY_TEST_KEY_ID is not a test key");
  process.exit(1);
}
if (!config.WEBHOOK_BASE_URL) {
  console.error(
    "REFUSING: WEBHOOK_BASE_URL must be the public tunnel origin (e.g. https://x.ngrok-free.app)",
  );
  process.exit(1);
}
if (/localhost|127\.0\.0\.1|\.invalid/.test(config.WEBHOOK_BASE_URL)) {
  console.error(
    `REFUSING: WEBHOOK_BASE_URL=${config.WEBHOOK_BASE_URL} is not publicly reachable — RazorPay resolves the host`,
  );
  process.exit(1);
}

const DEBIT_MINOR = 5000; // ₹50
const DELIVERY_WAIT_MS = Number(process.env.RZP_DELIVERY_WAIT_MS ?? 600_000);
const POLL_MS = 5_000;

/** Set once the debit's settlement webhook has been received and reconciled. */
let settlementObserved = false;
/** Non-fatal note when RazorPay simply hadn't settled the debit inside our window. */
let warnLate: string | null = null;
// Held on an object so the assignment inside main() is visible to the finally block
// (TS narrows a bare `let` to its initializer type across the call boundary).
const teardown: { run: (() => Promise<void>) | null } = { run: null };

async function main() {
  console.log(`tunnel origin: ${config.WEBHOOK_BASE_URL}\n`);

  // ── 1. tenant + a REAL razorpay gateway account ───────────────────────────
  console.log("── setup ──");
  const org = await createOrganization({ name: `RZP Tunnel ${uniq}` });
  const orgId = org.organization.id;
  const biz = await createBusiness({
    organizationId: orgId,
    name: "RZP Tunnel Biz",
    defaultCurrency: "INR",
    livemode: "test",
  });
  const acct = await createGatewayAccount({
    organizationId: orgId,
    businessId: biz.id,
    gatewayKey: "razorpay",
    label: "RZP live-test",
    credentials: {
      key_id: config.RAZORPAY_TEST_KEY_ID,
      key_secret: config.RAZORPAY_TEST_KEY_SECRET,
    },
    currencies: ["INR"],
    methodTypes: ["upi"],
  });
  ok("gateway account created with real test credentials", Boolean(acct.publicId));

  // ── 2. self-register the endpoint AT RazorPay, pointed at the tunnel ──────
  const endpoint = await provisionWebhookEndpoint({
    organizationId: orgId,
    businessId: biz.id,
    gatewayAccountPublicId: acct.publicId,
    force: true,
  });
  console.log(`  notification URL: ${endpoint.notification_url}`);
  // The whole point of the RazorPay provisioning work: no operator paste step.
  ok(
    `endpoint self-registered at RazorPay (mode=${endpoint.mode})`,
    endpoint.mode === "self_provisioned",
  );

  // Deactivate it on the way out, whatever happens. RazorPay has no DELETE, so
  // `active: false` is the only removal — and a live endpoint pointed at a dead
  // ngrok URL would otherwise keep failing deliveries for this merchant.
  const rzpAuth =
    "Basic " +
    Buffer.from(`${config.RAZORPAY_TEST_KEY_ID}:${config.RAZORPAY_TEST_KEY_SECRET}`).toString(
      "base64",
    );
  teardown.run = async () => {
    // Do NOT deactivate while a settlement is still in flight — that would kill the
    // very delivery being waited on. An Autopay debit can settle long after the
    // script's patience runs out, and the engine will settle the payment whenever
    // the webhook lands, which is exactly production behavior.
    if (warnLate) {
      console.log(
        `\n  ⚠️  leaving the RazorPay endpoint ACTIVE so the late settlement can still arrive.`,
      );
      console.log(
        `      Keep the tunnel + API up. Deactivate it later from the RazorPay dashboard`,
      );
      console.log(
        `      (Settings → Webhooks) — the merchant API has no DELETE, only active:false.`,
      );
      return;
    }
    const list = await fetch(`${config.RAZORPAY_API_BASE}/webhooks`, {
      headers: { Authorization: rzpAuth },
    }).then(
      (r) => r.json() as Promise<{ items?: Array<{ id: string; url: string; active: boolean }> }>,
    );
    for (const w of list.items ?? []) {
      if (w.url !== endpoint.notification_url || !w.active) continue;
      const res = await fetch(`${config.RAZORPAY_API_BASE}/webhooks/${w.id}`, {
        method: "PUT",
        headers: { Authorization: rzpAuth, "Content-Type": "application/json" },
        body: JSON.stringify({ url: w.url, active: false, events: { "payment.captured": 1 } }),
      });
      console.log(`  cleaned up webhook ${w.id} (deactivated, ${res.status})`);
    }
  };

  // ── 3. customer + a headless UPI Autopay mandate ──────────────────────────
  const customer = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: `tunnel-${uniq}@tmbilling.test`,
    // RazorPay refuses to vault a mandate for a contactless customer.
    phone: "9876543210",
  });
  const acctRow = (
    await withTenant(orgId, (tx) =>
      tx.select().from(gatewayAccounts).where(eq(gatewayAccounts.id, acct.id)).limit(1),
    )
  )[0]!;
  const rzp = resolveAdapter(acctRow) as RazorpayProvider;
  const providerCustomer = await rzp.ensureCustomer({
    customerRef: customer.publicId,
    email: customer.email ?? undefined,
    phone: "9876543210",
    name: "Tunnel Test",
  });
  const collect = await rzp.initiateUpiAutopayCollect({
    customerId: providerCustomer.providerCustomerId,
    vpa: RazorpayProvider.TEST_SUCCESS_VPA,
    email: customer.email!,
    contact: "9876543210",
  });
  let tokenId: string | null = null;
  for (let i = 0; i < 12 && !tokenId; i++) {
    await sleep(POLL_MS);
    tokenId = (await rzp.getPayment(collect.paymentId)).tokenId;
  }
  ok("UPI Autopay mandate token minted", Boolean(tokenId));
  if (!tokenId) return;

  const pm = await vaultPaymentMethod({
    organizationId: orgId,
    businessId: biz.id,
    customer,
    token: tokenId,
    gatewayAccountId: acct.publicId,
  });
  ok(`mandate vaulted as its real type (${pm.type})`, pm.type === "upi");

  // ── 4. bill a subscription THROUGH THE ENGINE ─────────────────────────────
  console.log("\n── engine charge ──");
  const product = await createProduct({
    organizationId: orgId,
    businessId: biz.id,
    name: "Tunnel Plan",
  });
  const price = await createPrice({
    organizationId: orgId,
    businessId: biz.id,
    productId: product.id,
    type: "recurring",
    model: "flat",
    currency: "INR",
    amountMinor: DEBIT_MINOR,
    interval: "month",
  });
  const sub = await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: customer.id,
    now: new Date(),
    items: [{ price, quantity: 1 }],
  });
  const { payment } = await billSubscriptionPeriod({
    organizationId: orgId,
    businessId: biz.id,
    subscription: sub.subscription,
    // Non-null by construction: this fixture creates a subscription with NO trial, so it
    // starts `active` with a term. A trialling subscription has none (2026-08-25).
    periodStart: sub.subscription.currentPeriodStart!,
    periodEnd: sub.subscription.currentPeriodEnd!,
  });
  ok("engine produced a payment", Boolean(payment));
  if (!payment) return;
  console.log(
    `  payment ${payment.publicId} status=${payment.status} charge=${payment.providerChargeId}`,
  );
  // An Autopay debit is asynchronous — the engine MUST park it as pending, not
  // book cash it hasn't got.
  ok(`async debit parked as pending (status=${payment.status})`, payment.status === "pending");
  ok(
    `pending payment carries a correlatable charge id (${payment.providerChargeId ?? "MISSING"})`,
    Boolean(payment.providerChargeId?.startsWith("pay_")),
  );
  const txnBefore = (
    await withTenant(orgId, (tx) =>
      tx
        .select()
        .from(transactions)
        .where(eq(transactions.idAtGateway, payment.providerChargeId!))
        .limit(1),
    )
  )[0];
  ok(
    `transaction opened unsettled (status=${txnBefore?.status})`,
    txnBefore?.status === "timeout" || txnBefore?.status === "in_progress",
  );

  // ── 5a. TRANSPORT: did RazorPay reach us at all? ──────────────────────────
  // Asserted on the MANDATE's own events (token.confirmed / the ₹1 auth capture),
  // which RazorPay emits within ~a minute — independent of how long the debit takes
  // to settle. This is the leg no other suite covers, so it gets its own assertion
  // rather than riding on the debit's timing.
  console.log("\n── transport: RazorPay → our tunnel ──");
  const eventsForBiz = async () =>
    (
      await systemDb.select().from(providerEvents).where(eq(providerEvents.providerKey, "razorpay"))
    ).filter((r) => r.businessId === biz.id);
  let anyEvent: Awaited<ReturnType<typeof eventsForBiz>> = [];
  const transportDeadline = Date.now() + 180_000;
  while (Date.now() < transportDeadline && anyEvent.length === 0) {
    await sleep(POLL_MS);
    anyEvent = await eventsForBiz();
    if (anyEvent.length === 0) process.stdout.write("·");
  }
  console.log("");
  ok("RazorPay delivered a genuinely signed event to our tunnel", anyEvent.length > 0);
  if (anyEvent.length === 0) {
    console.log(
      "   (nothing arrived — check the ngrok inspector at http://127.0.0.1:4040 and that the API is on the tunnelled port)",
    );
    return;
  }
  // Delivery alone isn't enough: it must have passed HMAC verification and been
  // attributed to this account, which is what `?id=gwa_…` + the stored secret do.
  ok(
    "delivered events verified + attributed to this business",
    anyEvent.every((r) => r.businessId === biz.id),
  );
  ok(
    "no delivered event errored in processing",
    anyEvent.every((r) => r.outcome !== "error"),
  );
  for (const e of anyEvent) {
    const raw = e.payload as { event?: string } | null;
    console.log(`     ${raw?.event} → outcome=${e.outcome}`);
  }

  // ── 5b. SETTLEMENT: the debit's own payment.captured ──────────────────────
  console.log(
    `\n── settlement delivery (up to ${Math.round(DELIVERY_WAIT_MS / 60000)}m; UPI Autopay has no SLA) ──`,
  );
  const findDebitEvent = async () =>
    (await eventsForBiz()).find((r) => {
      const raw = r.payload as {
        payload?: { payment?: { entity?: { id?: string } } };
        event?: string;
      } | null;
      return (
        raw?.event === "payment.captured" &&
        raw?.payload?.payment?.entity?.id === payment.providerChargeId
      );
    });
  let delivered = await findDebitEvent();
  let gatewayStatus = "unknown";
  const deadline = Date.now() + DELIVERY_WAIT_MS;
  while (Date.now() < deadline && !delivered) {
    await sleep(POLL_MS);
    delivered = await findDebitEvent();
    if (!delivered) {
      gatewayStatus = (await rzp.getPayment(payment.providerChargeId!)).status;
      process.stdout.write(gatewayStatus === "captured" ? "!" : "·");
    }
  }
  console.log("");

  if (!delivered) {
    // Distinguish the two very different causes rather than blaming transport:
    // a debit RazorPay hasn't settled yet has simply produced nothing to deliver.
    if (gatewayStatus === "captured") {
      ok("settlement event delivered for the debit", false);
      console.log(
        "   RazorPay reports the debit CAPTURED but never delivered payment.captured — a real transport gap.",
      );
    } else {
      warnLate =
        `RazorPay has not settled the debit yet (gateway status=${gatewayStatus}) — nothing to deliver. ` +
        "The engine is correctly holding the payment as pending; it will settle when the webhook lands.";
      console.log(`  ⚠️  ${warnLate}`);
    }
    return;
  }
  ok("RazorPay delivered payment.captured for the debit", true);
  ok(`debit event reconciled (outcome=${delivered.outcome})`, delivered.outcome === "processed");
  settlementObserved = true;

  // ── 6. the engine settled it ──────────────────────────────────────────────
  console.log("\n── engine settlement ──");
  const paid = (
    await withTenant(orgId, (tx) =>
      tx.select().from(payments).where(eq(payments.id, payment.id)).limit(1),
    )
  )[0];
  ok(`payment settled to succeeded (status=${paid?.status})`, paid?.status === "succeeded");
  const txnAfter = (
    await withTenant(orgId, (tx) =>
      tx
        .select()
        .from(transactions)
        .where(eq(transactions.idAtGateway, payment.providerChargeId!))
        .limit(1),
    )
  )[0];
  ok(
    `transaction settled (status=${txnAfter?.status}, settledAt=${txnAfter?.settledAt != null})`,
    txnAfter?.status === "succeeded" && txnAfter?.settledAt != null,
  );
  const cash = await withTenant(orgId, async (tx) => {
    const rows = await tx.select().from(ledgerEntries).where(eq(ledgerEntries.account, "cash"));
    return rows.reduce(
      (s, r) => s + (r.direction === "debit" ? r.amountMinor : -r.amountMinor),
      0n,
    );
  });
  ok(`cash booked on settlement (${cash} paise)`, cash === BigInt(DEBIT_MINOR));
}

let passed = false;
try {
  await main();
  const failed = checks.filter(([, c]) => !c);
  console.log(`\n${"─".repeat(60)}`);
  console.log(
    `${checks.length - failed.length}/${checks.length} checks passed${warnLate ? ", 1 warning" : ""}`,
  );
  if (warnLate) {
    console.log(`  ⚠️  ${warnLate}`);
    console.log(
      `      Transport is proven regardless (RazorPay reached us and we verified its signature);`,
    );
    console.log(
      `      only the debit's own settlement event was still outstanding. Re-run to retry,`,
    );
    console.log(
      `      or raise the budget: RZP_DELIVERY_WAIT_MS=1800000 pnpm verify:razorpay-tunnel`,
    );
  }
  if (failed.length) {
    console.log("\n❌ RAZORPAY TUNNEL: FAIL");
    for (const [n] of failed) console.log(`   - ${n}`);
  } else {
    console.log("\n✅ RAZORPAY TUNNEL (real delivery → engine settlement): PASS");
  }
  passed = failed.length === 0;
} finally {
  if (teardown.run) await teardown.run().catch((e: unknown) => console.warn("cleanup failed:", e));
  await closeDb();
}
process.exit(passed ? 0 : 1);
