/**
 * PayPal TRANSPORT + ENGINE verification — the last untested leg for PayPal.
 *
 * `verify:paypal-live` drives the adapter directly; this drives the **engine** and
 * makes **PayPal's own servers** deliver to us:
 *
 *   gateway account (real sandbox creds) → self-register the webhook AT PayPal via
 *   the tunnel origin → vault a card → subscription billed through the ENGINE
 *   (`billSubscriptionPeriod` → `collectInvoice`) → an OUT-OF-BAND refund issued
 *   straight at PayPal → wait for PayPal to deliver PAYMENT.CAPTURE.* on its own
 *   → assert the events verify, attribute, and BOOK the refund we never recorded
 *
 * Unlike RazorPay's UPI Autopay, a PayPal capture is **synchronous** — the charge
 * comes back COMPLETED, so the engine books cash immediately and the webhook is
 * reconciliation rather than settlement.
 *
 * The refund is deliberately issued OUTSIDE tmbilling (as a merchant would in
 * PayPal's dashboard). A refund we initiate ourselves is already in `refunds`, so
 * the handler correctly declines to double-post and the event lands `ignored` —
 * proving nothing. Only the out-of-band case exercises correlation, and that is
 * precisely the case that was silently dropped while the adapter sent PayPal's
 * refund id where the capture id belonged.
 *
 * PayPal verifies inbound events by calling its own API with the `webhook_id` we
 * stored at provisioning (there is no shared secret), so this also proves the
 * per-account `creds.webhook_id` plumbing.
 *
 * ## Running it
 * ```
 * # terminal 1 — API (must share this script's DATABASE_URL)
 * pnpm dev
 * # terminal 2
 * ngrok http 4000
 * # terminal 3
 * WEBHOOK_BASE_URL=https://<id>.ngrok-free.app pnpm verify:paypal-tunnel
 * ```
 *
 * Sandbox only. Trivial amounts ($12 charge, $5 refund). The PayPal webhook is
 * deleted on exit so the sandbox isn't left with a dead endpoint.
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

import { providerEvents, payments, refunds } from "@db/schema";

const checks: [string, boolean, string?][] = [];
const ok = (n: string, c: boolean, detail?: string) => {
  checks.push([n, c, detail]);
  console.log(`  ${c ? "✅" : "❌"} ${n}${detail ? ` — ${detail}` : ""}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const uniq = Math.random().toString(36).slice(2, 8);

const US_ID = config.PAYPAL_TEST_BUSINESS_US_CLIENT_ID;
const US_SECRET = config.PAYPAL_TEST_BUSINESS_US_CLIENT_SECRET;

if (!US_ID || !US_SECRET) {
  console.log("⊘ SKIP verify:paypal-tunnel — PAYPAL_TEST_BUSINESS_US_CLIENT_ID/SECRET not set");
  process.exit(0);
}
if (!/sandbox/.test(config.PAYPAL_API_BASE)) {
  console.error(`REFUSING: PAYPAL_API_BASE=${config.PAYPAL_API_BASE} is not the sandbox`);
  process.exit(1);
}
if (!config.WEBHOOK_BASE_URL) {
  console.error(
    "REFUSING: WEBHOOK_BASE_URL must be the public tunnel origin (e.g. https://x.ngrok-free.app)",
  );
  process.exit(1);
}
if (/localhost|127\.0\.0\.1|\.invalid/.test(config.WEBHOOK_BASE_URL)) {
  console.error(`REFUSING: WEBHOOK_BASE_URL=${config.WEBHOOK_BASE_URL} is not publicly reachable`);
  process.exit(1);
}

const TEST_CARD = { number: "4005519200000004", expiry: "2030-01", name: "TmBilling Tunnel Buyer" };
const CHARGE_MINOR = 1200; // $12.00
const REFUND_MINOR = 500; //  $5.00
const DELIVERY_WAIT_MS = Number(process.env.PP_DELIVERY_WAIT_MS ?? 600_000);
const POLL_MS = 5_000;

const teardown: { run: (() => Promise<void>) | null } = { run: null };

/** Raw sandbox call — the browser-side setup-token step and endpoint cleanup only. */
async function raw(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const basic = Buffer.from(`${US_ID}:${US_SECRET}`).toString("base64");
  const tok = (await fetch(`${config.PAYPAL_API_BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  }).then((r) => r.json())) as { access_token?: string };
  const res = await fetch(`${config.PAYPAL_API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${tok.access_token}`,
      "Content-Type": "application/json",
      "PayPal-Request-Id": `ppt-${Math.random().toString(36).slice(2, 10)}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : {} };
}

async function main() {
  console.log(`tunnel origin: ${config.WEBHOOK_BASE_URL}\n`);

  // ── 1. tenant + a real paypal gateway account ─────────────────────────────
  console.log("── setup ──");
  const org = await createOrganization({ name: `PP Tunnel ${uniq}` });
  const orgId = org.organization.id;
  const biz = await createBusiness({
    organizationId: orgId,
    name: "PP Tunnel Biz",
    defaultCurrency: "USD",
    livemode: "test",
  });
  const acct = await createGatewayAccount({
    organizationId: orgId,
    businessId: biz.id,
    gatewayKey: "paypal",
    label: "PayPal sandbox",
    credentials: { client_id: US_ID!, client_secret: US_SECRET!, api_base: config.PAYPAL_API_BASE },
    currencies: ["USD"],
    methodTypes: ["card", "paypal"],
  });
  ok("gateway account created with real sandbox credentials", Boolean(acct.publicId));

  // ── 2. self-register the endpoint AT PayPal, pointed at the tunnel ────────
  const endpoint = await provisionWebhookEndpoint({
    organizationId: orgId,
    businessId: biz.id,
    gatewayAccountPublicId: acct.publicId,
    force: true,
  });
  console.log(`  notification URL: ${endpoint.notification_url}`);
  ok(
    `endpoint self-registered at PayPal (mode=${endpoint.mode})`,
    endpoint.mode === "self_provisioned",
  );
  // PayPal has no shared secret — the webhook_id IS the verification material, and
  // inbound verification fails without it being stored per-account.
  ok("per-account webhook_id stored for inbound verification", Boolean(endpoint.webhook_id));

  teardown.run = async () => {
    const list = await raw("GET", "/v1/notifications/webhooks");
    for (const w of (list.json?.webhooks ?? []) as Array<{ id: string; url: string }>) {
      if (w.url !== endpoint.notification_url) continue;
      const del = await raw("DELETE", `/v1/notifications/webhooks/${w.id}`);
      console.log(`  cleaned up webhook ${w.id} (deleted, ${del.status})`);
    }
  };

  // ── 3. customer + a vaulted card (setup token stands in for hosted fields) ─
  const customer = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: `pp-tunnel-${uniq}@tmbilling.test`,
  });
  const setup = await raw("POST", "/v3/vault/setup-tokens", {
    // The ownership binding `assertSetupTokenBelongsTo` checks: PayPal's provider
    // customer id is our own customer public id.
    customer: { merchant_customer_id: customer.publicId },
    payment_source: { card: TEST_CARD },
  });
  ok(`card setup token minted (${setup.json.status})`, setup.status === 201);
  if (setup.status !== 201) return;
  const pm = await vaultPaymentMethod({
    organizationId: orgId,
    businessId: biz.id,
    customer,
    token: setup.json.id,
    gatewayAccountId: acct.publicId,
  });
  ok(
    `vaulted as its real type (${pm.type}, ${pm.brand} ••${pm.last4})`,
    pm.type === "card" && pm.last4 === "0004",
  );

  // ── 4. bill a subscription THROUGH THE ENGINE ─────────────────────────────
  console.log("\n── engine charge ──");
  const product = await createProduct({
    organizationId: orgId,
    businessId: biz.id,
    name: "PP Tunnel Plan",
  });
  const price = await createPrice({
    organizationId: orgId,
    businessId: biz.id,
    productId: product.id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: CHARGE_MINOR,
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
  // PayPal captures synchronously — unlike RazorPay Autopay there is no pending leg.
  ok(
    `synchronous capture booked immediately (status=${payment.status})`,
    payment.status === "succeeded",
    payment.providerChargeId ?? undefined,
  );

  // ── 5. an OUT-OF-BAND refund, issued straight at PayPal ───────────────────
  // Deliberately NOT through `refundPayment`: a refund we initiate is already in
  // `refunds`, so the inbound handler correctly declines to double-post it and the
  // event lands `ignored` — which proves nothing about correlation. Refunding in
  // PayPal's dashboard (what this simulates) is the case that must reconcile, and
  // the case that was silently dropped while the adapter sent the refund id as the
  // charge id.
  console.log("\n── out-of-band refund (as if issued in PayPal's dashboard) ──");
  const oob = await raw("POST", `/v2/payments/captures/${payment.providerChargeId}/refund`, {
    amount: { value: "5.00", currency_code: "USD" },
  });
  ok(
    `refund issued outside tmbilling (${oob.json.status})`,
    oob.status === 201,
    oob.json.id ?? JSON.stringify(oob.json).slice(0, 160),
  );
  if (oob.status !== 201) return;
  const refundsBefore = await withTenant(orgId, (tx) =>
    tx.select().from(refunds).where(eq(refunds.paymentId, payment.id)),
  );
  ok("tmbilling has not recorded it yet (the webhook must)", refundsBefore.length === 0);

  // ── 6. wait for PAYPAL to deliver, unprompted ─────────────────────────────
  console.log(
    `\n── waiting for PayPal to deliver (up to ${Math.round(DELIVERY_WAIT_MS / 60000)}m) ──`,
  );
  const eventsForBiz = async () =>
    (
      await systemDb.select().from(providerEvents).where(eq(providerEvents.providerKey, "paypal"))
    ).filter((r) => r.businessId === biz.id);
  const isRefundEvent = (r: { payload: unknown }) =>
    (r.payload as { event_type?: string } | null)?.event_type === "PAYMENT.CAPTURE.REFUNDED";
  // Wait for the REFUND event specifically. Stopping at the first arrival would
  // exit on PAYMENT.CAPTURE.COMPLETED — which lands first — and then fail the
  // refund assertion purely on ordering.
  let delivered: Awaited<ReturnType<typeof eventsForBiz>> = [];
  const deadline = Date.now() + DELIVERY_WAIT_MS;
  while (Date.now() < deadline && !delivered.some(isRefundEvent)) {
    await sleep(POLL_MS);
    delivered = await eventsForBiz();
    if (!delivered.some(isRefundEvent)) process.stdout.write(delivered.length ? "+" : "·");
  }
  console.log("");
  ok("PayPal delivered a genuinely signed event to our tunnel", delivered.length > 0);
  if (delivered.length === 0) {
    console.log(
      "   (nothing arrived — check http://127.0.0.1:4040 and that the API is on the tunnelled port)",
    );
    return;
  }
  // Delivery is not enough: PayPal's verify API must have accepted it (using the
  // per-account webhook_id) and it must have attributed to this business.
  ok(
    "delivered events verified + attributed to this business",
    delivered.every((r) => r.businessId === biz.id),
  );
  ok(
    "no delivered event errored in processing",
    delivered.every((r) => r.outcome !== "error"),
  );
  for (const e of delivered) {
    const p = e.payload as { event_type?: string } | null;
    console.log(`     ${p?.event_type} → outcome=${e.outcome}`);
  }

  // Correlation is the whole point: PayPal's refund resource carries the REFUND id,
  // and the capture id our payment is keyed on only appears in its `up` link.
  //
  // PayPal delivers the CAPTURE and REFUND events independently and minutes apart, so
  // "some events arrived" does not mean the refund one did. Dereferencing it blindly
  // turned a slow delivery into a TypeError crash mid-suite, which reads as a code
  // fault rather than the timing it is — report it as a failed check instead.
  const refundEvent = delivered.find(isRefundEvent);
  if (!refundEvent) {
    ok(
      "refund event delivered within the wait budget",
      false,
      `only received: ${delivered.map((e) => (e.payload as { event_type?: string } | null)?.event_type).join(", ") || "nothing"}`,
    );
  } else {
    ok(
      `refund event reconciled, not dropped (outcome=${refundEvent.outcome})`,
      refundEvent.outcome === "processed",
      refundEvent.error ?? undefined,
    );
  }

  // ── 7. the engine booked the out-of-band refund ───────────────────────────
  console.log("\n── engine state ──");
  const paid = (
    await withTenant(orgId, (tx) =>
      tx.select().from(payments).where(eq(payments.id, payment.id)).limit(1),
    )
  )[0];
  ok(
    `payment still succeeded after the refund (status=${paid?.status})`,
    paid?.status === "succeeded",
  );
  const refundRows = await withTenant(orgId, (tx) =>
    tx.select().from(refunds).where(eq(refunds.paymentId, payment.id)),
  );
  const refunded = refundRows
    .filter((r) => r.status === "succeeded")
    .reduce((s, r) => s + r.amountMinor, 0n);
  // Booked by the WEBHOOK — tmbilling never called refund itself.
  ok(
    `webhook booked the refund against the payment (${refunded} of ${CHARGE_MINOR})`,
    refunded === BigInt(REFUND_MINOR),
  );
  ok(
    "refund row carries PayPal's refund id",
    refundRows.some((r) => r.providerRefundId === oob.json.id),
  );
}

let passed = false;
try {
  await main();
  const failed = checks.filter(([, c]) => !c);
  console.log(`\n${"─".repeat(60)}`);
  console.log(`${checks.length - failed.length}/${checks.length} checks passed`);
  if (failed.length) {
    console.log("\n❌ PAYPAL TUNNEL: FAIL");
    for (const [n] of failed) console.log(`   - ${n}`);
  } else {
    console.log("\n✅ PAYPAL TUNNEL (real delivery → engine reconciliation): PASS");
  }
  passed = failed.length === 0;
} finally {
  if (teardown.run) await teardown.run().catch((e: unknown) => console.warn("cleanup failed:", e));
  await closeDb();
}
process.exit(passed ? 0 : 1);
