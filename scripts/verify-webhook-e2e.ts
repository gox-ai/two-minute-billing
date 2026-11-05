/**
 * Live INBOUND webhook end-to-end (Phase 4b).
 *
 * The outbound half is covered by `verify:gateway-live`. This closes the other
 * half: a **real Stripe charge**, a **real `whsec_` minted by Stripe** (via our own
 * endpoint provisioning), and webhook payloads signed with **Stripe's own signing
 * implementation** (`stripe.webhooks.generateTestHeaderString`) delivered to the
 * REAL HTTP route — so signature verification, per-account `?id=` attribution,
 * `provider_events` logging and reconciliation all run exactly as in production.
 *
 *   pnpm verify:webhook-e2e
 *
 * What this proves that tmtest cannot:
 *   - our verification accepts a payload signed by Stripe's real algorithm, and
 *     REJECTS a tampered/wrong-secret one,
 *   - `?id=gwa_…` attributes the event to the right business + gateway account,
 *   - every inbound event is persisted to `provider_events` with an outcome,
 *   - `charge.refunded` and the dispute lifecycle reconcile against a REAL
 *     Stripe PaymentIntent id.
 *
 * What it still does NOT prove (needs a public tunnel + an async method):
 *   - that Stripe's servers can reach a deployed instance (network/DNS/TLS),
 *   - the async `in_progress → settled` transition, which requires a payment
 *     method that settles asynchronously (ACH/SEPA — not activated on this
 *     Stripe account). Card charges settle synchronously, so their
 *     `payment_intent.succeeded` webhook is correctly a no-op here.
 *
 * Gated: skips entirely without STRIPE_TEST_SECRET_KEY (and refuses non-test keys).
 */
import "dotenv/config";
import Stripe from "stripe";
import { and, eq } from "drizzle-orm";
import { buildApp } from "@/index";
import { systemDb, withTenant, closeDb } from "@/platform/db";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createGatewayAccount } from "@/modules/gateway/service";
import { provisionWebhookEndpoint } from "@/modules/gateway/webhook-endpoint";
import { createCustomer } from "@/modules/customers/service";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { decryptCredentials } from "@/platform/secrets";
import { recordTransaction } from "@/modules/transactions/service";
import { publicId } from "@/platform/ids";
import { STRIPE_API_VERSION } from "@/providers/stripe";
import {
  gatewayAccounts,
  providerEvents,
  disputes,
  transactions,
  payments,
  refunds,
  paymentMethods,
  ledgerEntries,
  events,
} from "@db/schema";

const checks: [string, boolean][] = [];
const ok = (n: string, c: boolean) => checks.push([n, c]);
const log = (s: string) => console.log(s);

async function main() {
  const key = process.env.STRIPE_TEST_SECRET_KEY;
  if (!key || !key.startsWith("sk_test_")) {
    log("⊘ SKIP verify:webhook-e2e — STRIPE_TEST_SECRET_KEY not set (or not a test key)");
    await closeDb();
    return;
  }
  const stripe = new Stripe(key);

  const app = await buildApp({ logger: false });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const port = (app.server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;

  const org = await createOrganization({ name: "Webhook E2E Co" });
  const orgId = org.organization.id;
  const biz = await createBusiness({
    organizationId: orgId,
    name: "WE2E Biz",
    defaultCurrency: "USD",
    livemode: "test",
  });

  // A real Stripe gateway account (creds encrypted at rest, adapter built from DB).
  const acct = await createGatewayAccount({
    organizationId: orgId,
    businessId: biz.id,
    gatewayKey: "stripe",
    label: "Stripe E2E",
    credentials: {
      secret_key: key,
      ...(process.env.STRIPE_TEST_PUBLISHABLE_KEY
        ? { publishable_key: process.env.STRIPE_TEST_PUBLISHABLE_KEY }
        : {}),
    },
  });

  // ── 1. Provision the endpoint at Stripe → get a REAL whsec_ ─────────────────
  // WEBHOOK_BASE_URL must be set for URL construction; the URL itself never has to
  // receive traffic here because we deliver the signed payload ourselves.
  const provisioned = await provisionWebhookEndpoint({
    organizationId: orgId,
    businessId: biz.id,
    gatewayAccountPublicId: acct.publicId,
    force: true,
  });
  const creds = decryptCredentials(
    (
      await withTenant(orgId, (tx) =>
        tx.select().from(gatewayAccounts).where(eq(gatewayAccounts.id, acct.id)).limit(1),
      )
    )[0]!.credentialsEnc,
  );
  const whsec = String(creds.webhook_secret ?? "");
  ok("endpoint provisioned at Stripe → real whsec_ stored", whsec.startsWith("whsec_"));
  ok(
    "notification URL carries ?id=<gwa>",
    provisioned.notification_url.includes(`id=${acct.publicId}`),
  );
  const hookPath = `/v1/gateway_webhooks/stripe?id=${acct.publicId}`;

  /** Deliver a payload signed with Stripe's OWN signing implementation. */
  const deliver = async (event: unknown, opts?: { secret?: string; tamper?: boolean }) => {
    let payload = JSON.stringify(event);
    const header = stripe.webhooks.generateTestHeaderString({
      payload,
      secret: opts?.secret ?? whsec,
    });
    if (opts?.tamper) payload = payload.replace('"amount":', '"amount_x":');
    const res = await fetch(`${base}${hookPath}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "stripe-signature": header,
        "Idempotency-Key": crypto.randomUUID(),
      },
      body: payload,
    });
    return {
      status: res.status,
      json: (await res.json().catch(() => ({}))) as Record<string, unknown>,
    };
  };

  // ── 2. Signature verification (the whole point of a secret) ────────────────
  const evtId = () => `evt_e2e_${Math.random().toString(36).slice(2, 12)}`;
  const pingEvent = (id: string) => ({
    id,
    object: "event",
    api_version: STRIPE_API_VERSION,
    type: "payment_intent.created",
    created: Math.floor(Date.now() / 1000),
    data: { object: { id: "pi_ping", amount: 100 } },
  });

  const goodSig = await deliver(pingEvent(evtId()));
  ok("valid Stripe signature accepted (200)", goodSig.status === 200);
  const wrongSecret = await deliver(pingEvent(evtId()), { secret: "whsec_" + "x".repeat(32) });
  ok("wrong-secret signature rejected (400)", wrongSecret.status === 400);
  const tampered = await deliver(pingEvent(evtId()), { tamper: true });
  ok("tampered payload rejected (400)", tampered.status === 400);

  // ── 3. A REAL charge, then a REAL refund reconciled via webhook ────────────
  const customer = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: `we2e_${Date.now()}@example.com`,
  });
  const pm = await vaultPaymentMethod({
    organizationId: orgId,
    businessId: biz.id,
    customer,
    token: "pm_card_visa",
    gatewayAccountId: acct.publicId,
  });
  ok("vaulted a real Stripe card", pm.providerPaymentMethodId.startsWith("pm_"));

  // Charge through the adapter the same way collectInvoice would.
  const { resolveAdapter } = await import("@/providers/registry");
  const row = (
    await withTenant(orgId, (tx) =>
      tx.select().from(gatewayAccounts).where(eq(gatewayAccounts.id, acct.id)).limit(1),
    )
  )[0]!;
  const adapter = resolveAdapter(row);
  // India-export rule: cross-border charges need name + address on the customer.
  await adapter.ensureCustomer?.({
    email: customer.email!,
    name: "WE2E Payer",
    customerRef: customer.publicId,
    address: {
      line1: "1 Test St",
      city: "San Francisco",
      state: "CA",
      postalCode: "94105",
      country: "US",
    },
  });
  await stripe.customers.update(pm.providerCustomerId, {
    name: "WE2E Payer",
    address: {
      line1: "1 Test St",
      city: "San Francisco",
      state: "CA",
      postal_code: "94105",
      country: "US",
    },
  });
  const charge = await adapter.charge({
    amountMinor: 2599n,
    currency: "USD",
    customer: { providerKey: "stripe", providerCustomerId: pm.providerCustomerId },
    paymentMethod: {
      providerKey: "stripe",
      providerPaymentMethodId: pm.providerPaymentMethodId,
      display: { type: "card" },
    },
    idempotencyKey: `we2e_${Date.now()}`,
    description: "webhook e2e",
  });
  ok("real Stripe charge succeeded", charge.status === "succeeded");

  // Record the engine-side payment + gateway transaction keyed by the REAL
  // PaymentIntent id. Both inbound reconcilers correlate on `payments`
  // (`applyRefund` / `handleDisputeEvent` look up providerChargeId there), so
  // without a payment row a real refund webhook is correctly `ignored` as
  // "not one of our charges".
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
        amountMinor: 2599n,
        currency: "USD",
        providerKey: "stripe",
        providerChargeId: charge.providerChargeId,
      })
      .returning(),
  );
  ok("engine payment row recorded for the real charge", Boolean(payRow));

  await withTenant(orgId, (tx) =>
    recordTransaction(
      {
        organizationId: orgId,
        businessId: biz.id,
        customerId: customer.id,
        type: "payment",
        status: "succeeded",
        amountMinor: 2599n,
        currency: "USD",
        gatewayAccountId: acct.id,
        gatewayKey: "stripe",
        idAtGateway: charge.providerChargeId,
        paymentMethodId: pm.id,
      },
      tx,
    ),
  );

  // Real refund at Stripe, then deliver the charge.refunded webhook.
  const refund = await stripe.refunds.create({ payment_intent: charge.providerChargeId });
  ok("real Stripe refund created", refund.status === "succeeded" || refund.status === "pending");

  const refundedEvt = {
    id: evtId(),
    object: "event",
    api_version: STRIPE_API_VERSION,
    type: "charge.refunded",
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: `ch_${Date.now()}`,
        payment_intent: charge.providerChargeId,
        amount_refunded: 2599,
        // The embedded list as API versions before 2022-11-15 render it.
        refunds: {
          data: [{ id: refund.id, amount: refund.amount, status: refund.status, metadata: {} }],
        },
      },
    },
  };
  const refundDelivery = await deliver(refundedEvt);
  ok("charge.refunded accepted (200)", refundDelivery.status === 200);

  // ── 4. Attribution + logging: the event must be stored against THIS account ─
  const stored = await systemDb
    .select()
    .from(providerEvents)
    .where(eq(providerEvents.providerEventId, refundedEvt.id))
    .limit(1);
  ok("inbound event persisted to provider_events", stored.length === 1);
  ok("event attributed to the right business", stored[0]?.businessId === biz.id);
  // Reconciled, not merely ignored — the reconciler found our transaction by the
  // real PaymentIntent id and acted on it.
  ok(
    `charge.refunded reconciled (outcome=${stored[0]?.outcome})`,
    stored[0]?.outcome === "processed",
  );
  ok("no error recorded on the refund event", !stored[0]?.error);
  // The reconciler must have BOOKED the out-of-band refund, not just logged it.
  const bookedRefunds = await withTenant(orgId, (tx) =>
    tx.select().from(refunds).where(eq(refunds.paymentId, payRow!.id)),
  );
  ok(
    "out-of-band refund booked against the payment",
    bookedRefunds.length === 1 &&
      bookedRefunds[0]!.amountMinor === 2599n &&
      bookedRefunds[0]!.status === "succeeded",
  );

  // Replay of the same provider event id must dedupe.
  const replay = await deliver(refundedEvt);
  const storedAll = await systemDb
    .select()
    .from(providerEvents)
    .where(eq(providerEvents.providerEventId, refundedEvt.id));
  ok("replay deduped (still one row)", replay.status === 200 && storedAll.length === 1);

  // ── 5. Dispute lifecycle against a REAL PaymentIntent id ───────────────────
  const dpId = `dp_e2e_${Date.now()}`;
  const disputeEvt = (type: string, status: string, extra: Record<string, unknown> = {}) => ({
    id: evtId(),
    object: "event",
    api_version: STRIPE_API_VERSION,
    type,
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: dpId,
        payment_intent: charge.providerChargeId,
        amount: 2599,
        currency: "usd",
        reason: "fraudulent",
        status,
        ...extra,
      },
    },
  });
  const created = await deliver(disputeEvt("charge.dispute.created", "needs_response"));
  ok("dispute.created accepted", created.status === 200);
  const withdrawn = await deliver(disputeEvt("charge.dispute.funds_withdrawn", "under_review"));
  ok("dispute.funds_withdrawn accepted", withdrawn.status === 200);
  const dpRows = await withTenant(orgId, (tx) =>
    tx.select().from(disputes).where(eq(disputes.providerDisputeId, dpId)),
  );
  ok("dispute row upserted from real webhook payloads", dpRows.length === 1);
  ok(
    "dispute carries normalized amount + currency",
    dpRows[0]?.amountMinor === 2599n && dpRows[0]?.currency === "USD",
  );

  // `charge.dispute.updated` is where a RE-ISSUED evidence deadline arrives. It must
  // refresh the deadline WITHOUT resetting a dispute already under review — the whole
  // reason it maps to `dispute.created` (whose upsert leaves status alone).
  const dueBy = Math.floor(Date.now() / 1000) + 7 * 86400;
  const updated = await deliver(
    disputeEvt("charge.dispute.updated", "under_review", { evidence_details: { due_by: dueBy } }),
  );
  ok("dispute.updated accepted", updated.status === 200);
  const dpUpd = await withTenant(orgId, (tx) =>
    tx.select().from(disputes).where(eq(disputes.providerDisputeId, dpId)),
  );
  ok(
    "dispute.updated refreshed the evidence deadline",
    dpUpd[0]?.evidenceDueBy != null &&
      Math.abs(dpUpd[0]!.evidenceDueBy!.getTime() - dueBy * 1000) < 2000,
  );
  ok("dispute.updated did NOT reset the status", dpUpd[0]?.status === "under_review");

  const won = await deliver(disputeEvt("charge.dispute.closed", "won"));
  ok("dispute.closed(won) accepted", won.status === 200);
  const dpAfter = await withTenant(orgId, (tx) =>
    tx.select().from(disputes).where(eq(disputes.providerDisputeId, dpId)),
  );
  ok("dispute resolved to won", dpAfter[0]?.status === "won");

  // ── 6. The parity sweep: events this adapter used to drop on the floor ─────
  const evt = (type: string, object: Record<string, unknown>) => ({
    id: evtId(),
    object: "event",
    api_version: STRIPE_API_VERSION,
    type,
    created: Math.floor(Date.now() / 1000),
    data: { object },
  });
  const outcomeOf = async (id: string) =>
    (
      await systemDb
        .select()
        .from(providerEvents)
        .where(eq(providerEvents.providerEventId, id))
        .limit(1)
    )[0];

  // (a) `invoice.payment_*` must no longer be mapped onto our money terms. On a
  //     shared account these describe another billing system's invoices, not ours.
  const invEvt = evt("invoice.payment_succeeded", {
    id: `in_${Date.now()}`,
    payment_intent: charge.providerChargeId,
  });
  ok("invoice.payment_succeeded accepted (200)", (await deliver(invEvt)).status === 200);
  const invStored = await outcomeOf(invEvt.id);
  ok(
    "invoice.payment_succeeded is no longer a money event (type=unknown)",
    invStored?.type === "unknown",
  );

  // (b) `mandate.updated` — the whole mandate lifecycle, previously invisible.
  const mandateEvt = (status: string, extra: Record<string, unknown> = {}) =>
    evt("mandate.updated", {
      id: `mandate_${Date.now()}`,
      status,
      type: "multi_use",
      multi_use: {},
      payment_method: pm.providerPaymentMethodId,
      payment_method_details: { type: "card" },
      ...extra,
    });
  const mActive = mandateEvt("active");
  ok("mandate.updated(active) accepted", (await deliver(mActive)).status === 200);
  ok(
    "mandate.updated(active) applied (outcome=processed)",
    (await outcomeOf(mActive.id))?.outcome === "processed",
  );
  let pmRow = (
    await withTenant(orgId, (tx) =>
      tx.select().from(paymentMethods).where(eq(paymentMethods.id, pm.id)),
    )
  )[0];
  ok("active mandate stored as `confirmed`", pmRow?.mandateStatus === "confirmed");
  ok("active mandate recorded the rail", pmRow?.mandateRail === "card");

  // The trap: `inactive` on a SINGLE-USE mandate means "previously used" — ordinary
  // completion — and must NOT invalidate a good instrument.
  const mSpent = evt("mandate.updated", {
    id: `mandate_su_${Date.now()}`,
    status: "inactive",
    type: "single_use",
    single_use: { amount: 2599, currency: "usd" },
    payment_method: pm.providerPaymentMethodId,
    payment_method_details: { type: "card" },
  });
  await deliver(mSpent);
  pmRow = (
    await withTenant(orgId, (tx) =>
      tx.select().from(paymentMethods).where(eq(paymentMethods.id, pm.id)),
    )
  )[0];
  ok(
    "single-use mandate going inactive did NOT invalidate the instrument",
    pmRow?.status !== "invalid",
  );

  // A MULTI-use mandate going inactive is a real revocation → instrument unusable.
  const mDead = mandateEvt("inactive");
  ok("mandate.updated(inactive) accepted", (await deliver(mDead)).status === 200);
  pmRow = (
    await withTenant(orgId, (tx) =>
      tx.select().from(paymentMethods).where(eq(paymentMethods.id, pm.id)),
    )
  )[0];
  ok("revoked multi-use mandate stored as `cancelled`", pmRow?.mandateStatus === "cancelled");
  ok("revoked mandate marked the instrument invalid", pmRow?.status === "invalid");

  // (c) `refund.failed` — the refund booked in step 3 did not land. The charge stays
  //     succeeded; the ledger gets a COMPENSATING entry, never an edit.
  const rfEvt = evt("refund.failed", {
    id: refund.id,
    payment_intent: charge.providerChargeId,
    amount: 2599,
    status: "failed",
    failure_reason: "expired_or_canceled_card",
  });
  ok("refund.failed accepted", (await deliver(rfEvt)).status === 200);
  ok(
    "refund.failed applied (outcome=processed)",
    (await outcomeOf(rfEvt.id))?.outcome === "processed",
  );
  const rfRows = await withTenant(orgId, (tx) =>
    tx.select().from(refunds).where(eq(refunds.providerRefundId, refund.id)),
  );
  ok("failed refund flipped to status=failed", rfRows[0]?.status === "failed");
  const reversal = await withTenant(orgId, (tx) =>
    tx
      .select()
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.sourceType, "refund_reversal"),
          eq(ledgerEntries.sourceId, rfRows[0]!.publicId),
        ),
      ),
  );
  ok(
    "refund reversal posted a balanced compensating entry",
    reversal.length === 2 &&
      reversal.reduce(
        (s, l) => s + (l.direction === "debit" ? l.amountMinor : -l.amountMinor),
        0n,
      ) === 0n,
  );
  ok(
    "reversal debits cash back",
    reversal.some(
      (l) => l.account === "cash" && l.direction === "debit" && l.amountMinor === 2599n,
    ),
  );
  // The original refund's ledger lines are untouched — append-only (locked decision 4).
  const origRefundLines = await withTenant(orgId, (tx) =>
    tx
      .select()
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.sourceType, "refund"),
          eq(ledgerEntries.sourceId, rfRows[0]!.publicId),
        ),
      ),
  );
  ok("the original refund entries were NOT mutated", origRefundLines.length === 2);

  // (d) 3DS / RBI pre-debit: an off-session debit waiting on the buyer. Correlated
  //     through the TRANSACTION, because `charge()` writes no payment_intents row.
  const afaPi = `pi_afa_${Date.now()}`;
  await withTenant(orgId, (tx) =>
    recordTransaction(
      {
        organizationId: orgId,
        businessId: biz.id,
        customerId: customer.id,
        type: "payment",
        status: "in_progress",
        amountMinor: 2800000n,
        currency: "INR",
        gatewayAccountId: acct.id,
        gatewayKey: "stripe",
        idAtGateway: afaPi,
        paymentMethodId: pm.id,
      },
      tx,
    ),
  );
  const completesAt = Math.floor(Date.now() / 1000) + 26 * 3600;
  const afaEvt = evt("payment_intent.processing", {
    id: afaPi,
    amount: 2800000,
    currency: "inr",
    processing: {
      type: "card",
      card: { customer_notification: { approval_requested: true, completes_at: completesAt } },
    },
  });
  ok(
    "payment_intent.processing(approval_requested) accepted",
    (await deliver(afaEvt)).status === 200,
  );
  const afaStored = await outcomeOf(afaEvt.id);
  ok(
    "pre-debit notification normalized to intent.requires_action",
    afaStored?.type === "intent.requires_action",
  );
  ok("pre-debit notification applied (outcome=processed)", afaStored?.outcome === "processed");
  const afaEvents = await withTenant(orgId, (tx) =>
    tx
      .select()
      .from(events)
      .where(
        and(eq(events.organizationId, orgId), eq(events.type, "payment_authentication_required")),
      ),
  );
  ok("buyer-authentication event emitted for the stalled debit", afaEvents.length >= 1);
  const afaData = afaEvents.at(-1)?.data as { payment?: Record<string, unknown> } | undefined;
  ok(
    "the event carries the gateway-stated deadline",
    typeof afaData?.payment?.authenticate_by === "string" &&
      Math.abs(
        new Date(afaData!.payment!.authenticate_by as string).getTime() - completesAt * 1000,
      ) < 2000,
  );

  // The same event WITHOUT an approval request is an ordinary slow rail — it must be
  // dropped, not turned into a challenge nobody can answer.
  const slowEvt = evt("payment_intent.processing", {
    id: afaPi,
    amount: 2800000,
    currency: "inr",
    processing: {
      type: "card",
      card: { customer_notification: { approval_requested: false, completes_at: null } },
    },
  });
  await deliver(slowEvt);
  ok(
    "processing without an approval request stays unmapped",
    (await outcomeOf(slowEvt.id))?.type === "unknown",
  );

  // (e) `charge.expired` is a LAPSED HOLD, not a decline.
  const expEvt = evt("charge.expired", { id: `ch_exp_${Date.now()}`, payment_intent: afaPi });
  ok("charge.expired accepted", (await deliver(expEvt)).status === 200);
  ok(
    "charge.expired normalized to intent.voided (not charge.failed)",
    (await outcomeOf(expEvt.id))?.type === "intent.voided",
  );
  const afaTxn = await withTenant(orgId, (tx) =>
    tx.select().from(transactions).where(eq(transactions.idAtGateway, afaPi)),
  );
  ok("a lapsed hold did not fail the transaction", afaTxn[0]?.status === "in_progress");

  // (f) Persist-only: payouts and Radar. No handler by design — but they must be
  //     RECORDED, which is what makes a bank reconciliation or a stalled charge visible.
  const poEvt = evt("payout.paid", {
    id: `po_${Date.now()}`,
    amount: 51_23,
    currency: "usd",
    status: "paid",
    statement_descriptor: "TMBILLING",
  });
  ok("payout.paid accepted", (await deliver(poEvt)).status === 200);
  ok(
    "payout.paid recorded as settlement.processed",
    (await outcomeOf(poEvt.id))?.type === "settlement.processed",
  );
  const rvEvt = evt("review.opened", {
    id: `prv_${Date.now()}`,
    payment_intent: charge.providerChargeId,
  });
  ok("review.opened accepted", (await deliver(rvEvt)).status === 200);
  ok("review.opened recorded", (await outcomeOf(rvEvt.id))?.type === "review.opened");
  const efwEvt = evt("radar.early_fraud_warning.created", {
    id: `issfr_${Date.now()}`,
    charge: `ch_${Date.now()}`,
    fraud_type: "made_with_stolen_card",
    actionable: true,
  });
  ok("early_fraud_warning accepted", (await deliver(efwEvt)).status === 200);
  ok(
    "early_fraud_warning recorded",
    (await outcomeOf(efwEvt.id))?.type === "fraud_warning.created",
  );

  // Sanity: no transaction rows were corrupted by the inbound path.
  const txns = await withTenant(orgId, (tx) => tx.select().from(transactions));
  ok(
    "no orphan/failed transaction rows created by inbound path",
    txns.every((t) => t.status !== "error"),
  );

  // ── cleanup: remove the Stripe webhook endpoint we registered ──────────────
  try {
    const eps = await stripe.webhookEndpoints.list({ limit: 100 });
    for (const ep of eps.data) {
      if (ep.url === provisioned.notification_url) await stripe.webhookEndpoints.del(ep.id);
    }
    log("  ⓘ cleaned up the provisioned Stripe webhook endpoint");
  } catch {
    /* best effort */
  }

  await app.close();
  await closeDb();

  let pass = true;
  for (const [n, c] of checks) {
    console.log(`  ${c ? "✓" : "✗"} ${n}`);
    if (!c) pass = false;
  }
  console.log("");
  console.log(pass ? "✅ WEBHOOK E2E: PASS" : "❌ WEBHOOK E2E: FAIL");
  process.exit(pass ? 0 : 1);
}

void main();
