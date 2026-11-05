/**
 * REAL-TRANSPORT inbound webhook test (Phase 4b, final leg).
 *
 * `verify:webhook-e2e` proves our verification/reconciliation logic using payloads
 * we sign ourselves with Stripe's signer. This script proves the one thing that
 * cannot: that **Stripe's own servers reach our endpoint over the network** and
 * that the events they actually emit are verified, attributed and reconciled.
 *
 * Requires a public tunnel to a running tmbilling API:
 *   1. start the API            → PORT=4444 pnpm tsx src/index.ts
 *   2. expose it                → ngrok http 4444
 *   3. run this with the URL    → WEBHOOK_BASE_URL=https://<id>.ngrok-free.app \
 *                                 pnpm verify:stripe-tunnel
 *
 * Flow: provision a real Stripe webhook endpoint at WEBHOOK_BASE_URL (tmbilling
 * mints + stores the whsec_ itself) → real card charge → real refund → then POLL
 * `provider_events` until Stripe delivers `charge.refunded` on its own. Cleans up
 * the Stripe endpoint at the end.
 *
 * NOTE: the API process must share this DATABASE_URL (it does by default) — the
 * assertions read the rows that process wrote.
 */
import "dotenv/config";
import Stripe from "stripe";
import { and, eq, inArray } from "drizzle-orm";
import { systemDb, withTenant, closeDb } from "@/platform/db";
import { config } from "@/platform/config";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createGatewayAccount } from "@/modules/gateway/service";
import { provisionWebhookEndpoint } from "@/modules/gateway/webhook-endpoint";
import { createCustomer } from "@/modules/customers/service";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { resolveAdapter } from "@/providers/registry";
import { recordTransaction } from "@/modules/transactions/service";
import { publicId } from "@/platform/ids";
import { gatewayAccounts, providerEvents, payments, refunds, disputes } from "@db/schema";

const checks: [string, boolean][] = [];
const ok = (n: string, c: boolean) => checks.push([n, c]);
const log = (s: string) => console.log(s);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll provider_events for an event of `type` referencing our charge. */
async function waitForEvent(
  types: string[],
  businessId: string,
  timeoutMs: number,
): Promise<typeof providerEvents.$inferSelect | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await systemDb
      .select()
      .from(providerEvents)
      .where(and(eq(providerEvents.businessId, businessId), inArray(providerEvents.type, types)));
    if (rows.length > 0) return rows[0]!;
    await sleep(1500);
  }
  return null;
}

async function main() {
  const key = process.env.STRIPE_TEST_SECRET_KEY;
  if (!key || !key.startsWith("sk_test_")) {
    log("⊘ SKIP — STRIPE_TEST_SECRET_KEY not set (or not a test key)");
    await closeDb();
    return;
  }
  const baseUrl = config.WEBHOOK_BASE_URL;
  if (!baseUrl || !baseUrl.startsWith("https://")) {
    log("⊘ SKIP — set WEBHOOK_BASE_URL to your public https tunnel origin first");
    await closeDb();
    return;
  }
  const stripe = new Stripe(key);
  log(`Using tunnel: ${baseUrl}`);

  const org = await createOrganization({ name: "Tunnel E2E Co" });
  const orgId = org.organization.id;
  const biz = await createBusiness({
    organizationId: orgId,
    name: "Tunnel Biz",
    defaultCurrency: "USD",
    livemode: "test",
  });
  const acct = await createGatewayAccount({
    organizationId: orgId,
    businessId: biz.id,
    gatewayKey: "stripe",
    label: "Stripe Tunnel",
    credentials: { secret_key: key },
  });

  // 1. Register the tunnel URL with Stripe; we keep the whsec_ Stripe mints.
  const prov = await provisionWebhookEndpoint({
    organizationId: orgId,
    businessId: biz.id,
    gatewayAccountPublicId: acct.publicId,
    force: true,
  });
  ok("endpoint registered at Stripe for the tunnel URL", prov.notification_url.startsWith(baseUrl));
  log(`  → ${prov.notification_url}`);

  // 2. Real charge on a real card.
  const customer = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: `tun_${Date.now()}@example.com`,
  });
  const pm = await vaultPaymentMethod({
    organizationId: orgId,
    businessId: biz.id,
    customer,
    token: "pm_card_visa",
    gatewayAccountId: acct.publicId,
  });
  const row = (
    await withTenant(orgId, (tx) =>
      tx.select().from(gatewayAccounts).where(eq(gatewayAccounts.id, acct.id)).limit(1),
    )
  )[0]!;
  const adapter = resolveAdapter(row);
  // India-export rule: cross-border charges need name + address.
  await stripe.customers.update(pm.providerCustomerId, {
    name: "Tunnel Payer",
    address: {
      line1: "1 Test St",
      city: "San Francisco",
      state: "CA",
      postal_code: "94105",
      country: "US",
    },
  });
  const charge = await adapter.charge({
    amountMinor: 3199n,
    currency: "USD",
    customer: { providerKey: "stripe", providerCustomerId: pm.providerCustomerId },
    paymentMethod: {
      providerKey: "stripe",
      providerPaymentMethodId: pm.providerPaymentMethodId,
      display: { type: "card" },
    },
    idempotencyKey: `tun_${Date.now()}`,
    description: "tunnel e2e",
  });
  ok("real Stripe charge succeeded", charge.status === "succeeded");

  // Engine-side payment + transaction so the reconcilers can correlate.
  const [payRow] = await withTenant(orgId, (tx) =>
    tx
      .insert(payments)
      .values({
        organizationId: orgId,
        businessId: biz.id,
        customerId: customer.id,
        paymentMethodId: pm.id,
        publicId: publicId("pay"),
        status: "succeeded",
        amountMinor: 3199n,
        currency: "USD",
        providerKey: "stripe",
        providerChargeId: charge.providerChargeId,
      })
      .returning(),
  );
  await withTenant(orgId, (tx) =>
    recordTransaction(
      {
        organizationId: orgId,
        businessId: biz.id,
        customerId: customer.id,
        type: "payment",
        status: "succeeded",
        amountMinor: 3199n,
        currency: "USD",
        gatewayAccountId: acct.id,
        gatewayKey: "stripe",
        idAtGateway: charge.providerChargeId,
        paymentMethodId: pm.id,
      },
      tx,
    ),
  );

  // 3. Real refund → Stripe will POST charge.refunded to the tunnel on its own.
  const refund = await stripe.refunds.create({ payment_intent: charge.providerChargeId });
  log(`  refund ${refund.id} created — waiting for Stripe to deliver the webhook…`);

  const delivered = await waitForEvent(["charge.refunded"], biz.id, 90_000);
  ok("Stripe DELIVERED charge.refunded over the tunnel", Boolean(delivered));
  if (delivered) {
    ok("delivered event verified + attributed to this business", delivered.businessId === biz.id);
    ok(
      `delivered event reconciled (outcome=${delivered.outcome})`,
      delivered.outcome === "processed",
    );
    ok("no error on the delivered event", !delivered.error);
    const booked = await withTenant(orgId, (tx) =>
      tx.select().from(refunds).where(eq(refunds.paymentId, payRow!.id)),
    );
    ok(
      "refund booked from the real delivered webhook",
      booked.length === 1 && booked[0]!.amountMinor === 3199n,
    );
  }

  // 4. Real dispute: Stripe's `4000000000000259` card charges then disputes itself.
  //    This exercises the genuine dispute webhook chain over the wire.
  let disputeSeen = false;
  try {
    const dpPm = await stripe.paymentMethods.create({
      type: "card",
      card: { token: "tok_createDispute" },
    });
    await stripe.paymentMethods.attach(dpPm.id, { customer: pm.providerCustomerId });
    const dpCharge = await adapter.charge({
      amountMinor: 4200n,
      currency: "USD",
      customer: { providerKey: "stripe", providerCustomerId: pm.providerCustomerId },
      paymentMethod: {
        providerKey: "stripe",
        providerPaymentMethodId: dpPm.id,
        display: { type: "card" },
      },
      idempotencyKey: `tun_dp_${Date.now()}`,
      description: "tunnel dispute e2e",
    });
    if (dpCharge.status === "succeeded") {
      await withTenant(orgId, (tx) =>
        tx.insert(payments).values({
          organizationId: orgId,
          businessId: biz.id,
          customerId: customer.id,
          paymentMethodId: pm.id,
          publicId: publicId("pay"),
          status: "succeeded",
          amountMinor: 4200n,
          currency: "USD",
          providerKey: "stripe",
          providerChargeId: dpCharge.providerChargeId,
        }),
      );
      await withTenant(orgId, (tx) =>
        recordTransaction(
          {
            organizationId: orgId,
            businessId: biz.id,
            customerId: customer.id,
            type: "payment",
            status: "succeeded",
            amountMinor: 4200n,
            currency: "USD",
            gatewayAccountId: acct.id,
            gatewayKey: "stripe",
            idAtGateway: dpCharge.providerChargeId,
            paymentMethodId: pm.id,
          },
          tx,
        ),
      );
      log("  disputed-card charge created — waiting for Stripe dispute webhooks…");
      const dpEvent = await waitForEvent(
        ["dispute.created", "dispute.funds_withdrawn"],
        biz.id,
        90_000,
      );
      disputeSeen = Boolean(dpEvent);
      ok("Stripe DELIVERED a dispute event over the tunnel", disputeSeen);
      if (dpEvent) {
        const dpRows = await withTenant(orgId, (tx) => tx.select().from(disputes));
        ok("dispute row created from the real delivered webhook", dpRows.length >= 1);
      }
    } else {
      log(`  ⊘ dispute-card charge did not succeed (${dpCharge.status}) — skipping dispute leg`);
    }
  } catch (e) {
    log(`  ⊘ dispute leg skipped: ${e instanceof Error ? e.message : String(e)}`);
  }
  void disputeSeen;

  // 5. Clean up the Stripe endpoint so the sandbox isn't left with a dead URL.
  try {
    const eps = await stripe.webhookEndpoints.list({ limit: 100 });
    for (const ep of eps.data)
      if (ep.url === prov.notification_url) await stripe.webhookEndpoints.del(ep.id);
    log("  ⓘ removed the provisioned Stripe webhook endpoint");
  } catch {
    /* best effort */
  }

  await closeDb();
  let pass = true;
  log("");
  for (const [n, c] of checks) {
    log(`  ${c ? "✓" : "✗"} ${n}`);
    if (!c) pass = false;
  }
  log("");
  log(pass ? "✅ WEBHOOK TUNNEL: PASS" : "❌ WEBHOOK TUNNEL: FAIL");
  process.exit(pass ? 0 : 1);
}

void main();
