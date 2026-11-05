/**
 * GoCardless through the engine, offline: a fake GoCardless API behind the real adapter,
 * real invoices and the real webhook route.
 *
 * What regresses without it:
 *  - a payment retried from the GoCardless dashboard (also after a late failure) is
 *    collected but never booked, and dunning debits the payer again;
 *  - a replaced mandate is booked as cancelled instead of moving the method to the new one;
 *  - a transferred mandate keeps showing the old bank;
 *  - a lagging mandate read books a cancelled mandate as active;
 *  - a batch delivered newest first leaves the older mandate status in place;
 *  - a `refunds.paid` event, which links only the refund, settles nothing;
 *  - the due date is sent as a UTC day, a day early for a business east of UTC;
 *  - a redelivered event repeats its gateway reads, against GoCardless's 10 s deadline;
 *  - a forged delivery is answered 400, which GoCardless retries, instead of 498.
 *
 *   pnpm verify:gocardless-engine
 */
import { createHmac, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { buildApp } from "@/index";
import { withTenant, systemDb, closeDb } from "@/platform/db";
import { loadGeoReference } from "@/platform/geo";
import { flushGatewayRequestLogs } from "@/providers/http";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createGatewayAccount } from "@/modules/gateway/service";
import { createCustomer } from "@/modules/customers/service";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import { createSubscription } from "@/modules/subscriptions/service";
import { billSubscriptionPeriod, collectInvoice } from "@/modules/invoicing/service";
import { refundPayment } from "@/modules/refunds/service";
import {
  businesses,
  invoices,
  paymentMethods,
  refunds,
  payments,
  providerEvents,
  transactions,
} from "@db/schema";

const RUN = randomUUID().slice(0, 8);
const SECRET = `gc_engine_${RUN}`;
const GC = "https://api-sandbox.gocardless.com";
const AMOUNT = 2_500;
// UTC+14: a due instant on the 15th (UTC) is the 16th for this business.
const ZONE = "Pacific/Kiritimati";

let pass = true;
const ok = (label: string, cond: boolean, detail = "") => {
  if (!cond) pass = false;
  console.log(`${cond ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
};
const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

// ── fake GoCardless ─────────────────────────────────────────────────────────
interface Call {
  method: string;
  path: string;
  body: Record<string, any> | undefined;
}
const calls: Call[] = [];
const mandates = new Map<string, Record<string, unknown>>();
const banks = new Map<string, Record<string, unknown>>();
const gcPayments = new Map<
  string,
  { id: string; status: string; amount: number; currency: string; amount_refunded?: number }
>();
const gcRefunds = new Map<
  string,
  { id: string; status: string; amount: number; links: { payment: string } }
>();
let seq = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!url.startsWith(GC)) return realFetch(input, init);
  const u = new URL(url);
  const method = init?.method ?? "GET";
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;
  calls.push({ method, path: u.pathname, body });
  const json = (status: number, b: unknown) =>
    new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
  const p = u.pathname;
  if (method === "POST" && p === "/customers")
    return json(201, { customers: { id: `CU${RUN}${++seq}` } });
  if (method === "GET" && p.startsWith("/mandates/")) {
    const m = mandates.get(p.slice("/mandates/".length));
    return m
      ? json(200, { mandates: m })
      : json(404, { error: { code: 404, message: "not found" } });
  }
  if (method === "GET" && p.startsWith("/customer_bank_accounts/")) {
    const b = banks.get(p.slice("/customer_bank_accounts/".length));
    return b ? json(200, { customer_bank_accounts: b }) : json(404, { error: { code: 404 } });
  }
  if (method === "POST" && p === "/payments") {
    const id = `PM${RUN}${++seq}`.toUpperCase();
    const row = {
      id,
      status: "pending_submission",
      amount: body.payments.amount,
      currency: body.payments.currency,
    };
    gcPayments.set(id, row);
    return json(201, { payments: row });
  }
  if (method === "GET" && p.startsWith("/payments/")) {
    const row = gcPayments.get(p.slice("/payments/".length));
    return row
      ? json(200, { payments: { amount_refunded: 0, ...row } })
      : json(404, { error: { code: 404 } });
  }
  if (method === "POST" && p === "/refunds") {
    const id = `RF${RUN}${++seq}`.toUpperCase();
    const row = {
      id,
      status: "pending_submission",
      amount: body.refunds.amount,
      links: { payment: body.refunds.links.payment },
    };
    gcRefunds.set(id, row);
    return json(201, { refunds: row });
  }
  if (method === "GET" && p.startsWith("/refunds/")) {
    const row = gcRefunds.get(p.slice("/refunds/".length));
    return row ? json(200, { refunds: row }) : json(404, { error: { code: 404 } });
  }
  if (method === "GET" && p === "/events") return json(200, { events: [], meta: { cursors: {} } });
  if (method === "GET" && p === "/creditors")
    return json(200, { creditors: [{ id: "CR000000000001", country_code: "GB" }] });
  return json(404, { error: { code: 404, message: `no fake for ${method} ${p}` } });
}) as typeof fetch;

const mandate = (id: string, bank: string, ending: string, name: string, status = "active") => {
  mandates.set(id, {
    id,
    status,
    scheme: "bacs",
    reference: `REF-${id.slice(-4)}`,
    next_possible_charge_date: day(3),
    links: { customer_bank_account: bank },
  });
  banks.set(bank, { id: bank, account_number_ending: ending, bank_name: name, country_code: "GB" });
};

// ── fixtures ────────────────────────────────────────────────────────────────
await loadGeoReference();
const org = await createOrganization({ name: `GoCardless Engine ${RUN}` });
const orgId = org.organization.id;
const biz = await createBusiness({
  organizationId: orgId,
  name: "Direct Debit Co",
  defaultCurrency: "GBP",
  livemode: "test",
});
await withTenant(orgId, (tx) =>
  tx.update(businesses).set({ timezone: ZONE }).where(eq(businesses.id, biz.id)),
);
const ctx = { organizationId: orgId, businessId: biz.id };
const account = await createGatewayAccount({
  ...ctx,
  gatewayKey: "gocardless",
  label: "GoCardless",
  credentials: { access_token: "sandbox_fake", webhook_secret: SECRET },
});
const app = await buildApp({ logger: false });

const product = await createProduct({ ...ctx, name: "Plan" });
const price = await createPrice({
  ...ctx,
  productId: product.id,
  type: "recurring",
  model: "flat",
  currency: "GBP",
  amountMinor: AMOUNT,
  interval: "month",
});

async function customerOn(label: string, mandateId: string) {
  const customer = await createCustomer({ ...ctx, email: `${label}-${RUN}@example.com` });
  const pm = await vaultPaymentMethod({
    ...ctx,
    customer,
    token: mandateId,
    gatewayAccountId: account.publicId,
  });
  return { customer, pm };
}

/** A billed invoice whose GoCardless debit is pending. */
async function billed(label: string) {
  mandate(`MD${RUN}${label}`.toUpperCase(), `BA${RUN}${label}`.toUpperCase(), "01", "TEST BANK");
  const { customer, pm } = await customerOn(label, `MD${RUN}${label}`.toUpperCase());
  const sub = await createSubscription({
    ...ctx,
    customerId: customer.id,
    now: new Date(),
    items: [{ price, quantity: 1 }],
    defaultPaymentMethodId: pm.id,
  });
  const { invoice } = await billSubscriptionPeriod({
    ...ctx,
    subscription: sub.subscription,
    periodStart: sub.subscription.currentPeriodStart!,
    periodEnd: sub.subscription.currentPeriodEnd!,
  });
  const [pay] = await withTenant(orgId, (tx) =>
    tx.select().from(payments).where(eq(payments.invoiceId, invoice.id)),
  );
  if (pay?.status !== "pending" || !pay.providerChargeId)
    throw new Error(`${label}: expected a pending GoCardless debit, got ${pay?.status}`);
  return { customer, pm, invoice, sub: sub.subscription, chargeId: pay.providerChargeId };
}

const evt = (
  resource_type: string,
  action: string,
  links: Record<string, string>,
  details: Record<string, unknown> = {},
) => ({
  id: `EV${RUN}${++seq}`.toUpperCase(),
  created_at: new Date().toISOString(),
  resource_type,
  action,
  links,
  details: { origin: "gocardless", ...details },
});

async function deliver(events: unknown[], secret = SECRET) {
  const payload = JSON.stringify({ events, meta: { webhook_id: `WB${RUN}${++seq}` } });
  const res = await app.inject({
    method: "POST",
    url: `/v1/gateway_webhooks/gocardless?id=${account.publicId}`,
    headers: {
      "content-type": "application/json",
      "webhook-signature": createHmac("sha256", secret).update(payload).digest("hex"),
    },
    payload,
  });
  return { status: res.statusCode, results: (res.json() as { results?: string[] }).results ?? [] };
}

const paymentOf = async (invoiceId: string) =>
  (
    await withTenant(orgId, (tx) =>
      tx.select().from(payments).where(eq(payments.invoiceId, invoiceId)),
    )
  ).sort((a, b) => +a.createdAt - +b.createdAt);
const invoiceById = async (id: string) =>
  (await withTenant(orgId, (tx) => tx.select().from(invoices).where(eq(invoices.id, id))))[0]!;
const pmById = async (id: string) =>
  (
    await withTenant(orgId, (tx) =>
      tx.select().from(paymentMethods).where(eq(paymentMethods.id, id)),
    )
  )[0]!;
const txnByCharge = async (chargeId: string) =>
  (
    await withTenant(orgId, (tx) =>
      tx.select().from(transactions).where(eq(transactions.idAtGateway, chargeId)),
    )
  )[0];

try {
  // ── 1. a payment retried after we booked it failed is booked ────────────────
  {
    const a = await billed("lc");
    const failed = await deliver([
      evt(
        "payments",
        "failed",
        { payment: a.chargeId },
        { origin: "bank", cause: "insufficient_funds" },
      ),
    ]);
    gcPayments.get(a.chargeId)!.status = "failed";
    const afterFail = await invoiceById(a.invoice.id);
    ok(
      "late capture: setup — the failure is booked",
      failed.status === 200 &&
        (await txnByCharge(a.chargeId))?.status === "failed" &&
        afterFail.status === "payment_due",
      `${failed.status} ${failed.results} invoice=${afterFail.status}`,
    );
    // The operator retries it in GoCardless's dashboard; it collects.
    gcPayments.get(a.chargeId)!.status = "confirmed";
    const confirmed = evt("payments", "confirmed", { payment: a.chargeId });
    const res = await deliver([
      evt("payments", "resubmission_requested", { payment: a.chargeId }),
      confirmed,
    ]);
    const inv = await invoiceById(a.invoice.id);
    const [pay] = await paymentOf(a.invoice.id);
    ok(
      "late capture: confirmed after a booked failure pays the invoice",
      res.status === 200 &&
        res.results.at(-1) === "processed" &&
        inv.status === "paid" &&
        pay?.status === "succeeded" &&
        (await txnByCharge(a.chargeId))?.status === "succeeded",
      `results=${res.results} invoice=${inv.status} payment=${pay?.status}`,
    );

    // An API refund, settled by `refunds.paid` — which links only the refund.
    try {
      const rf = await refundPayment({ ...ctx, paymentPublicId: pay!.publicId, amountMinor: 400 });
      gcRefunds.get(rf.providerRefundId!)!.status = "paid";
      gcPayments.get(a.chargeId)!.amount_refunded = 400;
      const paidEv = await deliver([evt("refunds", "paid", { refund: rf.providerRefundId! })]);
      const settled = (
        await withTenant(orgId, (tx) => tx.select().from(refunds).where(eq(refunds.id, rf.id)))
      )[0];
      ok(
        "refund: refunds.paid (refund link only) settles our refund",
        paidEv.results.join() === "processed" && settled?.status === "succeeded",
        `results=${paidEv.results} refund=${settled?.status}`,
      );
    } catch (e) {
      ok("refund: refunds.paid (refund link only) settles our refund", false, String(e));
    }

    // A redelivery is answered from the dedup, with no gateway read.
    const before = calls.length;
    const again = await deliver([confirmed]);
    ok(
      "webhook: a settled event is answered without a GoCardless read",
      again.status === 200 &&
        again.results.join() === "duplicate" &&
        !calls.slice(before).some((c) => c.method === "GET"),
      `results=${again.results} reads=${calls
        .slice(before)
        .map((c) => c.path)
        .join(",")}`,
    );
  }

  // ── 2. a payment retried after a LATE failure is booked again ──────────────
  {
    const b = await billed("lf");
    gcPayments.get(b.chargeId)!.status = "confirmed";
    await deliver([evt("payments", "confirmed", { payment: b.chargeId })]);
    const paid = await invoiceById(b.invoice.id);
    gcPayments.get(b.chargeId)!.status = "failed";
    const late = await deliver([
      evt(
        "payments",
        "failed",
        { payment: b.chargeId },
        { origin: "bank", cause: "refer_to_payer" },
      ),
    ]);
    const reopened = await invoiceById(b.invoice.id);
    const lateTxn = await txnByCharge(b.chargeId);
    gcPayments.get(b.chargeId)!.status = "confirmed";
    const res = await deliver([evt("payments", "confirmed", { payment: b.chargeId })]);
    const inv = await invoiceById(b.invoice.id);
    ok(
      "late capture: setup — paid, then a late failure reopens the invoice",
      paid.status === "paid" &&
        late.status === 200 &&
        lateTxn?.status === "late_failed" &&
        reopened.status !== "paid",
      `paid=${paid.status} txn=${lateTxn?.status} reopened=${reopened.status}`,
    );
    ok(
      "late capture: confirmed after a late failure pays the invoice again",
      res.results.join() === "processed" &&
        inv.status === "paid" &&
        (await txnByCharge(b.chargeId))?.status === "succeeded",
      `results=${res.results} invoice=${inv.status}`,
    );
  }

  // ── 3. the due date is the business's calendar day ─────────────────────────
  {
    const c = await billed("tz");
    gcPayments.get(c.chargeId)!.status = "failed";
    await deliver([
      evt(
        "payments",
        "failed",
        { payment: c.chargeId },
        { origin: "bank", cause: "insufficient_funds" },
      ),
    ]);
    const year = new Date().getUTCFullYear() + 1;
    // 10:30 UTC on 15 Jan is 00:30 on 16 Jan in UTC+14.
    await withTenant(orgId, (tx) =>
      tx
        .update(invoices)
        .set({ dueDate: new Date(`${year}-01-15T10:30:00Z`) })
        .where(eq(invoices.id, c.invoice.id)),
    );
    const before = calls.length;
    await collectInvoice({ ...ctx, invoice: await invoiceById(c.invoice.id), subscription: c.sub });
    const post = calls.slice(before).find((x) => x.method === "POST" && x.path === "/payments");
    ok(
      "due date: charge_date is the due day in the business's timezone",
      post?.body?.payments?.charge_date === `${year}-01-16`,
      `charge_date=${post?.body?.payments?.charge_date}`,
    );
  }

  // ── 4. replaced mandate: the method moves to the new mandate ───────────────
  {
    mandate(`MD${RUN}RPOLD`, `BA${RUN}RPOLD`, "10", "OLD BANK", "cancelled");
    const { pm } = await customerOn("rp", `MD${RUN}RPOLD`);
    // A charge refused with `mandate_replaced` had already written the instrument off.
    await withTenant(orgId, (tx) =>
      tx.update(paymentMethods).set({ status: "invalid" }).where(eq(paymentMethods.id, pm.id)),
    );
    mandate(`MD${RUN}RPNEW`, `BA${RUN}RPNEW`, "42", "NEW BANK");
    const res = await deliver([
      evt(
        "mandates",
        "replaced",
        { mandate: `MD${RUN}RPOLD`, new_mandate: `MD${RUN}RPNEW` },
        { cause: "scheme_identifier_changed" },
      ),
    ]);
    const row = await pmById(pm.id);
    ok(
      "replaced: the method now points at the new mandate, live and chargeable",
      res.results.join() === "processed" &&
        row.providerPaymentMethodId === `MD${RUN}RPNEW` &&
        row.status === "valid" &&
        row.mandateStatus === "active" &&
        row.last4 === "42" &&
        row.issuerName === "NEW BANK",
      `results=${res.results} id=${row.providerPaymentMethodId} status=${row.status}/${row.mandateStatus} ••${row.last4} ${row.issuerName}`,
    );
  }

  // ── 5. transferred mandate: the bank display is refreshed ──────────────────
  {
    mandate(`MD${RUN}TR`, `BA${RUN}TR1`, "11", "FIRST BANK");
    const { pm } = await customerOn("tr", `MD${RUN}TR`);
    mandate(`MD${RUN}TR`, `BA${RUN}TR2`, "99", "SECOND BANK");
    const res = await deliver([
      evt(
        "mandates",
        "transferred",
        {
          mandate: `MD${RUN}TR`,
          previous_customer_bank_account: `BA${RUN}TR1`,
          new_customer_bank_account: `BA${RUN}TR2`,
        },
        { origin: "bank", cause: "bank_account_transferred" },
      ),
    ]);
    const row = await pmById(pm.id);
    ok(
      "transferred: the stored bank details are the new account's",
      res.results.join() === "processed" &&
        row.last4 === "99" &&
        row.issuerName === "SECOND BANK" &&
        row.status === "valid",
      `results=${res.results} ••${row.last4} ${row.issuerName} ${row.status}`,
    );
  }

  // ── 6. a lagging mandate read does not undo the event ──────────────────────
  {
    mandate(`MD${RUN}LG`, `BA${RUN}LG`, "33", "LAG BANK");
    const { pm } = await customerOn("lg", `MD${RUN}LG`);
    // GoCardless's API still says active when the cancellation arrives.
    const res = await deliver([
      evt(
        "mandates",
        "cancelled",
        { mandate: `MD${RUN}LG` },
        { origin: "bank", cause: "bank_account_closed" },
      ),
    ]);
    const row = await pmById(pm.id);
    ok(
      "mandate: a cancellation is booked though the API still reads active",
      res.results.join() === "processed" &&
        row.mandateStatus === "cancelled" &&
        row.status === "invalid",
      `results=${res.results} ${row.mandateStatus}/${row.status}`,
    );
  }

  // ── 6b. a batch delivered newest first keeps the newest status ─────────────
  {
    mandate(`MD${RUN}OO`, `BA${RUN}OO`, "44", "ORDER BANK", "pending_submission");
    const { pm } = await customerOn("oo", `MD${RUN}OO`);
    const t0 = Date.now();
    const active = {
      ...evt("mandates", "active", { mandate: `MD${RUN}OO` }),
      created_at: new Date(t0).toISOString(),
    };
    const submitted = {
      ...evt("mandates", "submitted", { mandate: `MD${RUN}OO` }),
      created_at: new Date(t0 - 5_000).toISOString(),
    };
    const res = await deliver([active, submitted]);
    const row = await pmById(pm.id);
    ok(
      "mandate: a batch delivered newest first ends on the newest status",
      res.status === 200 && row.mandateStatus === "active",
      `results=${res.results} mandate=${row.mandateStatus}`,
    );
  }

  // ── 7. a forged delivery: 498, nothing recorded ────────────────────────────
  {
    const forged = evt("payments", "confirmed", { payment: "PM000000FORGED" });
    const res = await deliver([forged], "not-the-secret");
    const rows = await systemDb
      .select()
      .from(providerEvents)
      .where(
        and(
          eq(providerEvents.providerKey, "gocardless"),
          eq(providerEvents.providerEventId, forged.id),
        ),
      );
    ok(
      "forged delivery: 498 (GoCardless does not retry it) and nothing recorded",
      res.status === 498 && rows.length === 0,
      `status=${res.status} rows=${rows.length}`,
    );
  }
} catch (e) {
  ok("suite completed", false, e instanceof Error ? (e.stack ?? e.message) : String(e));
} finally {
  globalThis.fetch = realFetch;
}

console.log(pass ? "\n✅ GOCARDLESS ENGINE: PASS" : "\n❌ GOCARDLESS ENGINE: FAIL");
await app.close();
await flushGatewayRequestLogs();
await closeDb();
process.exit(pass ? 0 : 1);
