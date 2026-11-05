/**
 * Live RazorPay test check (server-verifiable parts): Basic-auth + Orders API.
 * Proves the keys work and RazorPay accepts our order/charge request shape.
 *
 * NOTE: off-session (recurring) charging needs a token from a prior authenticated
 * mandate (customer auth / OTP) — not headlessly scriptable. This verifies auth +
 * order creation, not a captured recurring payment.
 *
 *   pnpm verify:razorpay   (requires RAZORPAY_TEST_KEY_ID/SECRET)
 */
import { config } from "@/platform/config";
import { RazorpayProvider } from "@/providers/razorpay";
import { closeDb } from "@/platform/db";
import { createHmac } from "node:crypto";

if (!config.RAZORPAY_TEST_KEY_ID || !config.RAZORPAY_TEST_KEY_SECRET) {
  console.log("SKIP: RazorPay test keys not set");
  process.exit(0);
}

const rzp = new RazorpayProvider({
  keyId: config.RAZORPAY_TEST_KEY_ID,
  keySecret: config.RAZORPAY_TEST_KEY_SECRET,
  apiBase: config.RAZORPAY_API_BASE,
});

console.log("RazorPay base:", config.RAZORPAY_API_BASE);
console.log("authenticating (Basic) + creating test order…");
const health = await rzp.healthCheck();
console.log(
  `  authenticated=${health.authenticated} order=${health.orderId} status=${health.orderStatus}`,
);

let pass =
  health.authenticated === true &&
  !!health.orderId?.startsWith("order_") &&
  health.orderStatus === "created";

// ── Lost-answer reads, against real responses ────────────────────────────────
// An order with no payment: `fetchChargeStatus(order_…)` reads `/orders/{id}/payments` and
// must answer pending (nothing moved), never failed.
const fromOrder = await rzp.fetchChargeStatus({ providerChargeId: health.orderId! });
console.log(`  fetchChargeStatus(${health.orderId}) → ${fromOrder.status}`);
pass &&= fromOrder.status === "pending";

// ── A real refund, read back (no money moves) ───────────────────────────────
// Takes the newest refund in the test account that carries our tag, finds it again by
// that tag (`locateRefund`), and normalizes a `refund.processed` body built from the real
// refund + payment entities: the refund id and the payment's running `amount_refunded`.
const SECRET = "verify-razorpay-webhook-secret";
const signed = new RazorpayProvider({
  keyId: config.RAZORPAY_TEST_KEY_ID,
  keySecret: config.RAZORPAY_TEST_KEY_SECRET,
  apiBase: config.RAZORPAY_API_BASE,
  webhookSecret: SECRET,
});
const auth =
  "Basic " +
  Buffer.from(`${config.RAZORPAY_TEST_KEY_ID}:${config.RAZORPAY_TEST_KEY_SECRET}`).toString(
    "base64",
  );
const get = async (path: string) =>
  (
    await fetch(`${config.RAZORPAY_API_BASE}${path}`, { headers: { Authorization: auth } })
  ).json() as Promise<any>;
const recent = await get("/refunds?count=50");
const tagged = (recent.items ?? []).find((r: any) => typeof r.notes?.tmbilling_ref === "string");
if (!tagged) {
  console.log("  ⊘ SKIP refund read-back — no tagged refund in the test account");
} else {
  const ref = tagged.notes.tmbilling_ref as string;
  const found = await rzp.locateRefund({ providerChargeId: tagged.payment_id, ownershipRef: ref });
  console.log(
    `  locateRefund by our tag → ${found?.providerRefundId === tagged.id ? "found" : "NOT found"} (${found?.status})`,
  );
  const missing = await rzp.locateRefund({
    providerChargeId: tagged.payment_id,
    ownershipRef: "no_such_ref",
  });
  const paymentEntity = await get(`/payments/${tagged.payment_id}`);
  const body = JSON.stringify({
    entity: "event",
    event: "refund.processed",
    contains: ["refund", "payment"],
    created_at: Math.floor(Date.now() / 1000),
    payload: { refund: { entity: tagged }, payment: { entity: paymentEntity } },
  });
  const [ev] = await signed.normalizeWebhook({
    payload: body,
    headers: { "x-razorpay-signature": createHmac("sha256", SECRET).update(body).digest("hex") },
  });
  console.log(
    `  normalized refund.processed → refund matches=${ev?.providerRefundId === tagged.id} ` +
      `amount_refunded=${ev?.amountRefundedMinor} of ${paymentEntity.amount} (this refund ${tagged.amount})`,
  );
  pass &&=
    found?.providerRefundId === tagged.id &&
    missing === null &&
    ev?.providerRefundId === tagged.id &&
    ev?.amountRefundedMinor === BigInt(paymentEntity.amount_refunded) &&
    ev?.ownershipRef === ref;
}

console.log("");
console.log(
  pass
    ? "✅ RAZORPAY ADAPTER (auth, order shape, lost-answer reads, refund read-back): PASS"
    : "❌ RAZORPAY ADAPTER: FAIL",
);
console.log("   (off-session recurring charge needs an authenticated mandate token — manual step)");
await closeDb();
process.exit(pass ? 0 : 1);
