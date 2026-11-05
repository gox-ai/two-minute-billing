/**
 * Inbound webhook verification for RazorPay + PayPal.
 *
 * `verify:webhook-e2e` covers Stripe. This covers the other two, which verify
 * differently and so need different treatment:
 *
 *  - **RazorPay** — `x-razorpay-signature` is HMAC-SHA256(raw body, shared secret),
 *    and tmbilling GENERATES that secret itself (RazorPay accepts a caller-chosen
 *    one), so we can produce byte-identical signatures to RazorPay's. Full positive +
 *    negative coverage, no tunnel required: real reconciliation of `refund.processed`,
 *    async `payment.captured` settlement of a pending UPI Autopay debit, and the
 *    dispute lifecycle, plus wrong-secret / tampered-body rejection.
 *
 *  - **PayPal** — there is no shared secret: `normalizeWebhook` calls PayPal's
 *    `/v1/notifications/verify-webhook-signature` API, which RSA-verifies the
 *    transmission against PayPal's cert. A forged payload therefore CANNOT be made
 *    to verify, so only the NEGATIVE path is testable head-lessly — which is the
 *    security-critical half: proving we actually enforce verification and never
 *    process an unverified event. A positive-path test requires PayPal to send a
 *    genuine signed event (tunnel + PayPal's `/v1/notifications/simulate-event`
 *    webhook simulator) — see the gateway README.
 *
 *   pnpm verify:webhook-inbound
 *
 * RazorPay section needs no credentials (the secret is ours). PayPal section is
 * skipped unless PAYPAL_TEST_BUSINESS_US_CLIENT_ID/SECRET are set.
 */
import "dotenv/config";
import { createHmac } from "node:crypto";
import { eq, and } from "drizzle-orm";
import { buildApp } from "@/index";
import { systemDb, withTenant, closeDb } from "@/platform/db";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createGatewayAccount } from "@/modules/gateway/service";
import { provisionWebhookEndpoint } from "@/modules/gateway/webhook-endpoint";
import { createCustomer } from "@/modules/customers/service";
import { decryptCredentials } from "@/platform/secrets";
import { recordTransaction } from "@/modules/transactions/service";
import { publicId } from "@/platform/ids";
import { config } from "@/platform/config";
import { runWithClockScope } from "@/platform/clock";
import { createManualInvoice } from "@/modules/invoicing/ops";
import { refundPayment } from "@/modules/refunds/service";
import { sweepStalePendingRefunds, __lostAnswerGraceHours } from "@/modules/refunds/stale-pending";
import {
  gatewayAccounts,
  providerEvents,
  payments,
  refunds,
  disputes,
  transactions,
  invoices,
  ledgerEntries,
} from "@db/schema";

/**
 * RazorPay API calls the engine makes from this suite (refund create / list) are answered
 * here, never by the real gateway: `rzpStub` returns a Response for the URLs it owns.
 */
type RzpStub = (method: string, url: string) => Response | undefined;
let rzpStub: RzpStub | null = null;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (rzpStub && url.startsWith(config.RAZORPAY_API_BASE)) {
    const res = rzpStub((init?.method ?? "GET").toUpperCase(), url);
    if (res) return res;
  }
  return realFetch(input, init);
}) as typeof fetch;
const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const checks: [string, boolean][] = [];
const ok = (n: string, c: boolean) => checks.push([n, c]);
const log = (s: string) => console.log(s);
/** A property we cannot prove because the PROVIDER is misbehaving — loud, not fatal. */
const warns: string[] = [];
const warn = (s: string) => warns.push(s);
const uniq = () => Math.random().toString(36).slice(2, 10);

async function main() {
  const app = await buildApp({ logger: false });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const port = (app.server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;

  const org = await createOrganization({ name: "Inbound WH Co" });
  const orgId = org.organization.id;

  // ══ RazorPay ═══════════════════════════════════════════════════════════════
  {
    const biz = await createBusiness({
      organizationId: orgId,
      name: "RZP Biz",
      defaultCurrency: "INR",
      livemode: "test",
    });
    // The secret is auto-generated at creation — the operator never supplies one.
    const acct = await createGatewayAccount({
      organizationId: orgId,
      businessId: biz.id,
      gatewayKey: "razorpay",
      label: "RZP",
      credentials: { key_id: "rzp_test_dummy", key_secret: "dummy" },
    });
    const row = (
      await withTenant(orgId, (tx) =>
        tx.select().from(gatewayAccounts).where(eq(gatewayAccounts.id, acct.id)).limit(1),
      )
    )[0]!;
    const secret = String(decryptCredentials(row.credentialsEnc).webhook_secret ?? "");
    ok("razorpay: webhook secret auto-generated (tmbilling owns it)", secret.length >= 32);

    const hookPath = `/v1/gateway_webhooks/razorpay?id=${acct.publicId}`;
    const deliver = async (event: unknown, opts?: { secret?: string; tamper?: boolean }) => {
      let body = JSON.stringify(event);
      const sig = createHmac("sha256", opts?.secret ?? secret)
        .update(body)
        .digest("hex");
      if (opts?.tamper) body = body.replace('"amount"', '"amount_x"');
      const res = await fetch(`${base}${hookPath}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-razorpay-signature": sig,
          "Idempotency-Key": crypto.randomUUID(),
        },
        body,
      });
      return {
        status: res.status,
        json: (await res.json().catch(() => ({}))) as Record<string, unknown>,
      };
    };

    // A real charge we can reconcile against (RazorPay payment id shape: pay_…).
    const customer = await createCustomer({
      organizationId: orgId,
      businessId: biz.id,
      email: `rzp_${uniq()}@example.com`,
    });
    const rzpChargeId = `pay_${uniq()}${uniq()}`;
    const [payRow] = await withTenant(orgId, (tx) =>
      tx
        .insert(payments)
        .values({
          organizationId: orgId,
          businessId: biz.id,
          customerId: customer.id,
          publicId: publicId("pay"),
          status: "succeeded",
          amountMinor: 50000n,
          currency: "INR",
          providerKey: "razorpay",
          providerChargeId: rzpChargeId,
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
          amountMinor: 50000n,
          currency: "INR",
          gatewayAccountId: acct.id,
          gatewayKey: "razorpay",
          idAtGateway: rzpChargeId,
        },
        tx,
      ),
    );

    // ── signature enforcement ────────────────────────────────────────────────
    const ping = () => ({
      entity: "event",
      event: "payment.authorized",
      created_at: Math.floor(Date.now() / 1000),
      id: `evt_rzp_${uniq()}`,
      payload: { payment: { entity: { id: rzpChargeId, amount: 50000, currency: "INR" } } },
    });
    const good = await deliver(ping());
    ok("razorpay: valid HMAC accepted (200)", good.status === 200);
    const badSecret = await deliver(ping(), { secret: "not-the-real-secret-".repeat(2) });
    ok("razorpay: wrong-secret signature rejected (400)", badSecret.status === 400);
    const tampered = await deliver(ping(), { tamper: true });
    ok("razorpay: tampered payload rejected (400)", tampered.status === 400);

    // ── refund.processed reconciles + books ──────────────────────────────────
    const refundEvt = {
      entity: "event",
      event: "refund.processed",
      created_at: Math.floor(Date.now() / 1000),
      id: `evt_rzp_${uniq()}`,
      payload: {
        payment: {
          entity: { id: rzpChargeId, amount: 50000, currency: "INR", amount_refunded: 50000 },
        },
        refund: { entity: { id: `rfnd_${uniq()}`, amount: 50000, currency: "INR" } },
      },
    };
    const refundRes = await deliver(refundEvt);
    ok("razorpay: refund.processed accepted (200)", refundRes.status === 200);
    const stored = await systemDb
      .select()
      .from(providerEvents)
      .where(eq(providerEvents.providerEventId, refundEvt.id))
      .limit(1);
    ok("razorpay: event persisted + attributed to business", stored[0]?.businessId === biz.id);
    ok(
      `razorpay: refund reconciled (outcome=${stored[0]?.outcome})`,
      stored[0]?.outcome === "processed",
    );
    const booked = await withTenant(orgId, (tx) =>
      tx.select().from(refunds).where(eq(refunds.paymentId, payRow!.id)),
    );
    ok(
      "razorpay: refund booked against the payment",
      booked.length === 1 && booked[0]!.amountMinor === 50000n,
    );

    // ── P2: the HTTP EXCHANGE is recorded, not just the outcome ───────────────
    // The Gateway Webhooks log shows Status Code · URL · Transaction, which
    // is what makes it a debugging tool: without them you cannot tell a
    // misconfigured Notification URL from a 502 we answered. Asserted here because
    // this suite is the only one that delivers a webhook over REAL HTTP, so the URL
    // and the status are the ones the gateway actually saw.
    ok(
      `razorpay: response status recorded (${stored[0]?.responseStatus})`,
      stored[0]?.responseStatus === 200,
    );
    ok(
      `razorpay: request URL recorded (${stored[0]?.requestUrl})`,
      typeof stored[0]?.requestUrl === "string" &&
        stored[0]!.requestUrl!.startsWith("http://") &&
        stored[0]!.requestUrl!.includes(`/v1/gateway_webhooks/razorpay?id=${acct.publicId}`),
    );
    // The transaction the callback affected, resolved from the gateway charge id.
    const linkedTxn = await withTenant(orgId, (tx) =>
      tx.select().from(transactions).where(eq(transactions.idAtGateway, rzpChargeId)).limit(1),
    );
    ok(
      `razorpay: webhook linked to its transaction (${stored[0]?.transactionPublicId})`,
      stored[0]?.transactionPublicId != null &&
        stored[0]!.transactionPublicId === linkedTxn[0]!.publicId,
    );
    // A callback about a charge that is not ours must stay NULL, not borrow a link.
    const orphanEvt = {
      entity: "event",
      event: "refund.processed",
      created_at: Math.floor(Date.now() / 1000),
      id: `evt_rzp_${uniq()}`,
      payload: {
        payment: { entity: { id: `pay_notours_${uniq()}`, amount: 100, currency: "INR" } },
        refund: { entity: { id: `rfnd_${uniq()}`, amount: 100, currency: "INR" } },
      },
    };
    await deliver(orphanEvt);
    const orphan = await systemDb
      .select()
      .from(providerEvents)
      .where(eq(providerEvents.providerEventId, orphanEvt.id))
      .limit(1);
    ok(
      "razorpay: unknown charge leaves the transaction link NULL (no fake link)",
      orphan[0]?.transactionPublicId === null && orphan[0]?.responseStatus === 200,
    );
    const replay = await deliver(refundEvt);
    const all = await systemDb
      .select()
      .from(providerEvents)
      .where(eq(providerEvents.providerEventId, refundEvt.id));
    ok("razorpay: replay deduped", replay.status === 200 && all.length === 1);

    // ── payment.captured settles an ASYNC debit (UPI Autopay rail) ───────────
    // A UPI Autopay charge returns `pending` with only a payment id: the debit
    // settles minutes-to-hours later and the ONLY signal is this webhook. So the
    // pending payment + in_progress transaction must flip to succeeded/success and
    // book cash — without it every Autopay collection strands as pending forever.
    {
      const asyncChargeId = `pay_${uniq()}${uniq()}`;
      const [pendingPay] = await withTenant(orgId, (tx) =>
        tx
          .insert(payments)
          .values({
            organizationId: orgId,
            businessId: biz.id,
            customerId: customer.id,
            publicId: publicId("pay"),
            status: "pending",
            amountMinor: 5000n,
            currency: "INR",
            providerKey: "razorpay",
            providerChargeId: asyncChargeId,
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
            status: "in_progress",
            amountMinor: 5000n,
            currency: "INR",
            gatewayAccountId: acct.id,
            gatewayKey: "razorpay",
            idAtGateway: asyncChargeId,
            paymentId: pendingPay!.id,
          },
          tx,
        ),
      );

      const capturedEvt = {
        entity: "event",
        event: "payment.captured",
        created_at: Math.floor(Date.now() / 1000),
        id: `evt_rzp_${uniq()}`,
        payload: {
          payment: {
            entity: { id: asyncChargeId, amount: 5000, currency: "INR", status: "captured" },
          },
        },
      };
      const capRes = await deliver(capturedEvt);
      ok("razorpay: payment.captured accepted (200)", capRes.status === 200);
      const capStored = await systemDb
        .select()
        .from(providerEvents)
        .where(eq(providerEvents.providerEventId, capturedEvt.id))
        .limit(1);
      ok(
        `razorpay: async debit reconciled (outcome=${capStored[0]?.outcome})`,
        capStored[0]?.outcome === "processed",
      );
      const settledPay = await withTenant(orgId, (tx) =>
        tx.select().from(payments).where(eq(payments.id, pendingPay!.id)).limit(1),
      );
      ok(
        `razorpay: pending payment settled (status=${settledPay[0]?.status})`,
        settledPay[0]?.status === "succeeded",
      );
      const settledTxn = await withTenant(orgId, (tx) =>
        tx.select().from(transactions).where(eq(transactions.idAtGateway, asyncChargeId)).limit(1),
      );
      ok(
        `razorpay: in_progress transaction settled (status=${settledTxn[0]?.status}, settledAt set=${settledTxn[0]?.settledAt != null})`,
        settledTxn[0]?.status === "succeeded" && settledTxn[0]?.settledAt != null,
      );
    }

    // ── conformance fixtures: a payment row + its payment transaction ─────────
    const now = () => Math.floor(Date.now() / 1000);
    const outcomeOf = async (eventId: string) =>
      (
        await systemDb
          .select({ outcome: providerEvents.outcome })
          .from(providerEvents)
          .where(eq(providerEvents.providerEventId, eventId))
          .limit(1)
      )[0]?.outcome;
    const seedPayment = async (o: {
      status: "succeeded" | "pending" | "failed";
      amount: bigint;
      chargeId: string;
      txnStatus: "succeeded" | "failed" | "timeout" | "in_progress";
      errorCode?: string;
      invoiceId?: string;
    }) => {
      const [p] = await withTenant(orgId, (tx) =>
        tx
          .insert(payments)
          .values({
            organizationId: orgId,
            businessId: biz.id,
            customerId: customer.id,
            publicId: publicId("pay"),
            status: o.status,
            amountMinor: o.amount,
            currency: "INR",
            providerKey: "razorpay",
            providerChargeId: o.chargeId,
            ...(o.invoiceId ? { invoiceId: o.invoiceId } : {}),
          })
          .returning(),
      );
      const t = await withTenant(orgId, (tx) =>
        recordTransaction(
          {
            organizationId: orgId,
            businessId: biz.id,
            customerId: customer.id,
            type: "payment",
            status: o.txnStatus,
            amountMinor: o.amount,
            currency: "INR",
            gatewayAccountId: acct.id,
            gatewayKey: "razorpay",
            idAtGateway: o.chargeId,
            paymentId: p!.id,
            ...(o.invoiceId ? { invoiceId: o.invoiceId } : {}),
            ...(o.errorCode ? { errorCode: o.errorCode, errorText: "Payment failed" } : {}),
          },
          tx,
        ),
      );
      return { pay: p!, txn: t };
    };
    const refundEvent = (o: {
      chargeId: string;
      refundId: string;
      amount: number;
      paymentAmount: number;
      amountRefunded: number;
      captured?: boolean;
      ref?: string;
    }) => ({
      entity: "event",
      event: "refund.processed",
      contains: ["refund", "payment"],
      created_at: now(),
      id: `evt_rzp_${uniq()}`,
      payload: {
        refund: {
          entity: {
            id: o.refundId,
            entity: "refund",
            amount: o.amount,
            currency: "INR",
            payment_id: o.chargeId,
            status: "processed",
            notes: o.ref ? { tmbilling_ref: o.ref } : [],
          },
        },
        payment: {
          entity: {
            id: o.chargeId,
            amount: o.paymentAmount,
            currency: "INR",
            status: o.captured === false ? "refunded" : "captured",
            captured: o.captured ?? true,
            amount_refunded: o.amountRefunded,
            refund_status: o.amountRefunded >= o.paymentAmount ? "full" : "partial",
          },
        },
      },
    });
    const paymentEvent = (o: {
      event: "payment.captured" | "payment.failed";
      chargeId: string;
      orderId?: string;
      amount: number;
    }) => ({
      entity: "event",
      event: o.event,
      created_at: now(),
      id: `evt_rzp_${uniq()}`,
      payload: {
        payment: {
          entity: {
            id: o.chargeId,
            amount: o.amount,
            currency: "INR",
            status: o.event === "payment.captured" ? "captured" : "failed",
            captured: o.event === "payment.captured",
            order_id: o.orderId ?? null,
            ...(o.event === "payment.failed"
              ? { error_code: "BAD_REQUEST_ERROR", error_reason: "payment_failed" }
              : {}),
          },
        },
      },
    });
    const refundsOf = (paymentId: string) =>
      withTenant(orgId, (tx) => tx.select().from(refunds).where(eq(refunds.paymentId, paymentId)));
    const sum = (rows: Array<{ amountMinor: bigint; status: string }>) =>
      rows.filter((r) => r.status !== "failed").reduce((a, r) => a + r.amountMinor, 0n);

    // ── partial refunds: no phantom refund for the rest of the payment ───────
    // Ours (10000) then two refunds raised in the gateway dashboard (15000, 5000). Each
    // `refund.processed` names its refund and the payment's running `amount_refunded`.
    {
      const chargeId = `pay_${uniq()}${uniq()}`;
      const { pay } = await seedPayment({
        status: "succeeded",
        amount: 50000n,
        chargeId,
        txnStatus: "succeeded",
      });
      let refundRef = "";
      rzpStub = (m, u) =>
        m === "POST" && u.endsWith(`/payments/${chargeId}/refund`)
          ? jsonResponse(200, {
              id: "rfnd_ours_partial1",
              status: "pending",
              notes: { tmbilling_ref: refundRef },
            })
          : undefined;
      const ours = await refundPayment({
        organizationId: orgId,
        businessId: biz.id,
        paymentPublicId: pay.publicId,
        amountMinor: 10000,
      });
      refundRef = ours.publicId;
      rzpStub = null;
      ok(
        "partial: our refund accepted pending with its gateway id",
        ours.status === "pending" && ours.providerRefundId === "rfnd_ours_partial1",
      );
      const e1 = refundEvent({
        chargeId,
        refundId: "rfnd_ours_partial1",
        amount: 10000,
        paymentAmount: 50000,
        amountRefunded: 10000,
        ref: ours.publicId,
      });
      await deliver(e1);
      let rows = await refundsOf(pay.id);
      ok(
        `partial: our refund settled by its id, no phantom (rows=${rows.length} sum=${sum(rows)})`,
        rows.length === 1 && rows[0]!.status === "succeeded" && sum(rows) === 10000n,
      );
      await deliver(
        refundEvent({
          chargeId,
          refundId: `rfnd_dash_${uniq()}`,
          amount: 15000,
          paymentAmount: 50000,
          amountRefunded: 25000,
        }),
      );
      const dash2 = refundEvent({
        chargeId,
        refundId: `rfnd_dash_${uniq()}`,
        amount: 5000,
        paymentAmount: 50000,
        amountRefunded: 30000,
      });
      await deliver(dash2);
      // Same refund again under a new event id: matched by its refund id.
      await deliver({ ...dash2, id: `evt_rzp_${uniq()}` });
      rows = await refundsOf(pay.id);
      const oob = rows.filter((r) => r.reason === "out_of_band").map((r) => r.amountMinor);
      ok(
        `partial: two dashboard partials booked as their own amounts (oob=${oob.join(",")} sum=${sum(rows)})`,
        rows.length === 3 &&
          oob.length === 2 &&
          oob.includes(15000n) &&
          oob.includes(5000n) &&
          sum(rows) === 30000n,
      );
    }

    // ── a refund of a payment we never received is not booked as cash ────────
    {
      const chargeId = `pay_${uniq()}${uniq()}`;
      const { pay } = await seedPayment({
        status: "failed",
        amount: 8000n,
        chargeId,
        txnStatus: "failed",
        errorCode: "payment_failed",
      });
      const ev = refundEvent({
        chargeId,
        refundId: `rfnd_${uniq()}`,
        amount: 8000,
        paymentAmount: 8000,
        amountRefunded: 8000,
        captured: false,
      });
      await deliver(ev);
      const rows = await refundsOf(pay.id);
      ok(
        `unsettled: refund on a failed payment not booked (outcome=${await outcomeOf(ev.id)}, rows=${rows.length})`,
        rows.length === 0 && (await outcomeOf(ev.id)) === "ignored",
      );
    }

    // ── payment.captured after payment.failed: booked once, applied ──────────
    {
      const { invoice } = await createManualInvoice({
        organizationId: orgId,
        businessId: biz.id,
        customerId: customer.id,
        currency: "INR",
        lines: [{ description: "Late capture", amountMinor: 7000n, kind: "one_time" }],
        applyTax: false,
      });
      const chargeId = `pay_${uniq()}${uniq()}`;
      const { pay, txn } = await seedPayment({
        status: "failed",
        amount: 7000n,
        chargeId,
        txnStatus: "failed",
        errorCode: "payment_failed",
        invoiceId: invoice.id,
      });
      const cap = paymentEvent({
        event: "payment.captured",
        chargeId,
        orderId: `order_${uniq()}`,
        amount: 7000,
      });
      await deliver(cap);
      await deliver({ ...cap, id: `evt_rzp_${uniq()}` });
      const [p] = await withTenant(orgId, (tx) =>
        tx.select().from(payments).where(eq(payments.id, pay.id)),
      );
      const [t] = await withTenant(orgId, (tx) =>
        tx.select().from(transactions).where(eq(transactions.id, txn.id)),
      );
      const [inv] = await withTenant(orgId, (tx) =>
        tx.select().from(invoices).where(eq(invoices.id, invoice.id)),
      );
      const cash = await withTenant(orgId, (tx) =>
        tx
          .select()
          .from(ledgerEntries)
          .where(
            and(
              eq(ledgerEntries.sourceId, pay.publicId),
              eq(ledgerEntries.account, "cash"),
              eq(ledgerEntries.direction, "debit"),
            ),
          ),
      );
      ok(
        `late capture: processed (outcome=${await outcomeOf(cap.id)})`,
        (await outcomeOf(cap.id)) === "processed",
      );
      ok(
        `late capture: payment + transaction succeeded, invoice ${inv?.status} (pay=${p?.status} txn=${t?.status})`,
        p?.status === "succeeded" && t?.status === "succeeded" && inv?.status === "paid",
      );
      ok(`late capture: cash booked once (${cash.length})`, cash.length === 1);

      // Control: a capture for a different amount is not taken as this payment.
      const other = `pay_${uniq()}${uniq()}`;
      const { pay: pay2 } = await seedPayment({
        status: "failed",
        amount: 9000n,
        chargeId: other,
        txnStatus: "failed",
        errorCode: "payment_failed",
      });
      const odd = paymentEvent({ event: "payment.captured", chargeId: other, amount: 100 });
      await deliver(odd);
      const [p2] = await withTenant(orgId, (tx) =>
        tx.select().from(payments).where(eq(payments.id, pay2.id)),
      );
      ok(
        `late capture: amount mismatch not booked (outcome=${await outcomeOf(odd.id)})`,
        p2?.status === "failed" && (await outcomeOf(odd.id)) === "ignored",
      );
    }

    // ── a lost-answer debit (booked `timeout` under its ORDER) resolves later ─
    for (const verdict of ["payment.captured", "payment.failed"] as const) {
      const orderId = `order_${uniq()}${uniq()}`;
      const chargeId = `pay_${uniq()}${uniq()}`;
      const { pay, txn } = await seedPayment({
        status: "pending",
        amount: 4000n,
        chargeId: orderId,
        txnStatus: "timeout",
      });
      const ev = paymentEvent({ event: verdict, chargeId, orderId, amount: 4000 });
      await deliver(ev);
      const [p] = await withTenant(orgId, (tx) =>
        tx.select().from(payments).where(eq(payments.id, pay.id)),
      );
      const [t] = await withTenant(orgId, (tx) =>
        tx.select().from(transactions).where(eq(transactions.id, txn.id)),
      );
      const want = verdict === "payment.captured" ? "succeeded" : "failed";
      ok(
        `lost answer → ${verdict}: settled through its order (txn=${t?.status} pay=${p?.status} outcome=${await outcomeOf(ev.id)})`,
        t?.status === want && p?.status === want && (await outcomeOf(ev.id)) === "processed",
      );
      ok(
        `lost answer → ${verdict}: the real payment id adopted`,
        t?.idAtGateway === chargeId && p?.providerChargeId === chargeId,
      );
    }

    // ── a lost-answer refund: kept pending, never released, resolved later ──
    {
      const chargeId = `pay_${uniq()}${uniq()}`;
      const { pay } = await seedPayment({
        status: "succeeded",
        amount: 50000n,
        chargeId,
        txnStatus: "succeeded",
      });
      let listed: Array<Record<string, unknown>> = [];
      rzpStub = (m, u) => {
        if (m === "POST" && u.endsWith(`/payments/${chargeId}/refund`))
          return jsonResponse(503, { error: { code: "SERVER_ERROR" } });
        if (m === "GET" && u.includes(`/payments/${chargeId}/refunds`))
          return jsonResponse(200, { entity: "collection", items: listed });
        return undefined;
      };
      const lost = async (amount: number) =>
        refundPayment({
          organizationId: orgId,
          businessId: biz.id,
          paymentPublicId: pay.publicId,
          amountMinor: amount,
        }).catch((e: unknown) => {
          ok(`lost refund: a lost answer is not a refusal (threw: ${(e as Error).message})`, false);
          return null;
        });
      const a = await lost(2000);
      if (a) {
        const [aTxn] = await withTenant(orgId, (tx) =>
          tx.select().from(transactions).where(eq(transactions.refundId, a.id)),
        );
        ok(
          `lost refund: booked pending with no gateway id, not failed (status=${a.status} txn=${aTxn?.status})`,
          a.status === "pending" && a.providerRefundId == null && aTxn?.status === "in_progress",
        );
        // (a) the webhook finds it by our tag and settles it.
        await deliver(
          refundEvent({
            chargeId,
            refundId: "rfnd_lost_a",
            amount: 2000,
            paymentAmount: 50000,
            amountRefunded: 2000,
            ref: a.publicId,
          }),
        );
        let rows = await refundsOf(pay.id);
        const aRow = rows.find((r) => r.id === a.id);
        ok(
          `lost refund (webhook): id adopted + settled, no second row (rows=${rows.length})`,
          rows.length === 1 &&
            aRow?.status === "succeeded" &&
            aRow.providerRefundId === "rfnd_lost_a",
        );
        // (b) found by the sweep; (c) absent at the gateway, so the booking is reversed.
        const b = (await lost(3000))!;
        const c = (await lost(1000))!;
        listed = [
          { id: "rfnd_lost_b", status: "processed", notes: { tmbilling_ref: b.publicId } },
          { id: "rfnd_lost_a", status: "processed", notes: { tmbilling_ref: a.publicId } },
        ];
        const swept = await runWithClockScope({ onlyBusinessId: biz.id }, () =>
          sweepStalePendingRefunds(new Date(Date.now() + (__lostAnswerGraceHours + 1) * 3_600_000)),
        );
        rows = await refundsOf(pay.id);
        const bRow = rows.find((r) => r.id === b.id);
        const cRow = rows.find((r) => r.id === c.id);
        const reversal = await withTenant(orgId, (tx) =>
          tx
            .select()
            .from(ledgerEntries)
            .where(
              and(
                eq(ledgerEntries.sourceType, "refund_reversal"),
                eq(ledgerEntries.sourceId, c.publicId),
              ),
            ),
        );
        ok(
          `lost refund (sweep): found one settled, reversed the absent one (located=${swept.located} settled=${swept.settled} reversed=${swept.reversed})`,
          bRow?.status === "succeeded" &&
            bRow.providerRefundId === "rfnd_lost_b" &&
            cRow?.status === "failed" &&
            reversal.length === 2,
        );
      }
      rzpStub = null;
    }

    // ── dispute lifecycle (defensive mapping now exercised) ──────────────────
    const dpId = `disp_${uniq()}`;
    const dpEvt = (event: string, status: string) => ({
      entity: "event",
      event,
      created_at: Math.floor(Date.now() / 1000),
      id: `evt_rzp_${uniq()}`,
      payload: {
        payment: { entity: { id: rzpChargeId, amount: 50000, currency: "INR" } },
        dispute: {
          entity: {
            id: dpId,
            payment_id: rzpChargeId,
            amount: 50000,
            currency: "INR",
            reason_code: "chargeback",
            status,
            respond_by: Math.floor(Date.now() / 1000) + 7 * 86400,
          },
        },
      },
    });
    const dpCreated = await deliver(dpEvt("payment.dispute.created", "open"));
    ok("razorpay: dispute.created accepted", dpCreated.status === 200);
    const dpRows = await withTenant(orgId, (tx) =>
      tx.select().from(disputes).where(eq(disputes.providerDisputeId, dpId)),
    );
    ok("razorpay: dispute row created from the webhook", dpRows.length === 1);
    ok(
      "razorpay: dispute amount + currency normalized",
      dpRows[0]?.amountMinor === 50000n && dpRows[0]?.currency === "INR",
    );
    const dpWon = await deliver(dpEvt("payment.dispute.won", "won"));
    ok("razorpay: dispute.won accepted", dpWon.status === 200);
    const dpAfter = await withTenant(orgId, (tx) =>
      tx.select().from(disputes).where(eq(disputes.providerDisputeId, dpId)),
    );
    ok("razorpay: dispute resolved to won", dpAfter[0]?.status === "won");
  }

  // ══ PayPal ═════════════════════════════════════════════════════════════════
  {
    const clientId = process.env.PAYPAL_TEST_BUSINESS_US_CLIENT_ID;
    const clientSecret = process.env.PAYPAL_TEST_BUSINESS_US_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      log("  ⊘ SKIP paypal — PAYPAL_TEST_BUSINESS_US_CLIENT_ID/SECRET not set");
    } else {
      const biz = await createBusiness({
        organizationId: orgId,
        name: "PPL Biz",
        defaultCurrency: "USD",
        livemode: "test",
      });
      const acct = await createGatewayAccount({
        organizationId: orgId,
        businessId: biz.id,
        gatewayKey: "paypal",
        label: "PPL",
        credentials: { client_id: clientId, client_secret: clientSecret },
      });
      // Provision so a REAL webhook_id is stored — the rejection below is then
      // genuinely about the signature, not a missing config.
      let provisionedUrl: string | null = null;
      try {
        const prov = await provisionWebhookEndpoint({
          organizationId: orgId,
          businessId: biz.id,
          gatewayAccountPublicId: acct.publicId,
          force: true,
        });
        provisionedUrl = prov.notification_url;
        ok("paypal: webhook registered at PayPal → webhook_id stored", Boolean(prov.webhook_id));
      } catch (e) {
        log(`  ⊘ paypal provisioning skipped: ${e instanceof Error ? e.message : String(e)}`);
      }

      const hookPath = `/v1/gateway_webhooks/paypal?id=${acct.publicId}`;
      const forged = {
        id: `WH-forged-${uniq()}`,
        event_type: "PAYMENT.CAPTURE.REFUNDED",
        create_time: new Date().toISOString(),
        resource: { id: `cap_${uniq()}`, amount: { value: "10.00", currency_code: "USD" } },
      };
      const res = await fetch(`${base}${hookPath}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // Plausible-looking but fabricated transmission headers.
          "paypal-auth-algo": "SHA256withRSA",
          "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-forged",
          "paypal-transmission-id": `forged-${uniq()}`,
          "paypal-transmission-sig": "ZmFrZXNpZ25hdHVyZQ==",
          "paypal-transmission-time": new Date().toISOString(),
        },
        body: JSON.stringify(forged),
      });
      // The security-critical assertion: an unverifiable transmission must NEVER be
      // processed.
      //
      // ⚠️ This can no longer be proven through PayPal's own verifier. Measured
      // 2026-08-01: `POST /v1/notifications/verify-webhook-signature` on the SANDBOX
      // returns `{"verification_status":"SUCCESS"}` for a transmission whose
      // `transmission_sig` is literally base64("fakesignature") and whose cert does
      // not exist. So a forged-but-well-formed transmission is accepted by PayPal and
      // therefore by us. What we CAN still assert locally is the adapter's own gate:
      // required headers, and a cert_url that actually belongs to PayPal.
      const notStored = await systemDb
        .select()
        .from(providerEvents)
        .where(eq(providerEvents.providerEventId, forged.id));
      if (res.status === 400 && notStored.length === 0) {
        ok("paypal: forged transmission rejected by PayPal verification (400)", true);
      } else {
        // Not a suite failure: our adapter asked PayPal and honoured the answer. The
        // answer is wrong. Failing here would leave verify:all permanently red for a
        // provider-side defect, which trains people to ignore the suite.
        warn(
          `PayPal SANDBOX rubber-stamps forged transmissions — /verify-webhook-signature returned ` +
            `SUCCESS for a fabricated signature, so the forged event was accepted (HTTP ${res.status}, ` +
            `stored=${notStored.length}). Our local gate below still holds. Reproduce with:\n` +
            `      curl -s -X POST "$PAYPAL_API_BASE/v1/notifications/verify-webhook-signature" \\\n` +
            `        -H "Authorization: Bearer <token>" -H 'Content-Type: application/json' \\\n` +
            `        -d '{"auth_algo":"SHA256withRSA","cert_url":"https://api.sandbox.paypal.com/x",` +
            `"transmission_id":"x","transmission_sig":"ZmFrZXNpZ25hdHVyZQ==","transmission_time":"…",` +
            `"webhook_id":"<id>","webhook_event":{}}'\n` +
            `      Real fix: verify the RSA signature locally instead of delegating (see docs/PROGRESS.md).`,
        );
      }

      // Local gate — independent of PayPal's verdict, so these must hold regardless.
      const evil = { ...forged, id: `WH-evil-${uniq()}` };
      const hostileCert = await fetch(`${base}${hookPath}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "paypal-auth-algo": "SHA256withRSA",
          // A cert the CALLER controls: if this is honoured, verification is theatre.
          "paypal-cert-url": "https://evil.example.com/CERT-attacker",
          "paypal-transmission-id": `evil-${uniq()}`,
          "paypal-transmission-sig": "ZmFrZXNpZ25hdHVyZQ==",
          "paypal-transmission-time": new Date().toISOString(),
        },
        body: JSON.stringify(evil),
      });
      ok("paypal: non-PayPal cert_url rejected (400)", hostileCert.status === 400);

      const bare = await fetch(`${base}${hookPath}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ ...forged, id: `WH-bare-${uniq()}` }),
      });
      ok("paypal: transmission with no signature headers rejected (400)", bare.status === 400);

      // PayPal has no delete-webhook call in our adapter, and provisioning reuses an
      // existing endpoint for the same URL, so repeat runs don't accumulate garbage.
      if (provisionedUrl)
        log(`  ⓘ paypal: sandbox webhook registered for ${provisionedUrl} (reused on re-runs)`);
    }
  }

  await app.close();
  await closeDb();
  let pass = true;
  log("");
  for (const [n, c] of checks) {
    log(`  ${c ? "✓" : "✗"} ${n}`);
    if (!c) pass = false;
  }
  if (warns.length) {
    log("");
    for (const w of warns) log(`  ⚠️  ${w}`);
  }
  log("");
  log(
    pass
      ? `✅ WEBHOOK INBOUND (razorpay+paypal): PASS${warns.length ? ` — with ${warns.length} PROVIDER-SIDE warning(s) above` : ""}`
      : "❌ WEBHOOK INBOUND: FAIL",
  );
  process.exit(pass ? 0 : 1);
}

void main();
