/**
 * Usage records + unbilled charges over the API:
 *   §1 usage: POST without `note` answers exactly as before; list / retrieve / filters;
 *      DELETE before billing drops it from the next rating; once an invoice rated the
 *      window, DELETE is 409.
 *   §2 unbilled charges: business list + filters; DELETE voids a pending charge (409 on a
 *      voided or billed one); invoice_now_estimate matches the invoice invoice_now raises;
 *      a second invoice_now finds nothing; customer scope raises one invoice per subscription.
 *   §3 the in-transaction claim: an invoice for a charge that is no longer pending rolls
 *      back whole.
 *   §4 cancel's invoice-unbilled: lines carry quantity / unit price / period, totals are
 *      unchanged, and only the charges it read are claimed.
 *   §6 idempotency: a body key alone still works; a reused key with different values is
 *      409 with or without a header; no key at all is 400.
 *   §7 the accepted window: an open pending invoice keeps its usage window open; once it
 *      closes, usage inside it is refused. §1 covers the invoiced and future cases.
 *   §8 a time-travelled business measures "now" on its simulated clock.
 *
 *   pnpm verify:usage-api
 */
import { and, eq } from "drizzle-orm";
import { buildApp } from "@/index";
import { withTenant, closeDb } from "@/platform/db";
import { runWithClockScope } from "@/platform/clock";
import {
  createOrganization,
  createBusiness,
  createApiKey,
  updateBusiness,
} from "@/modules/tenancy/service";
import { closeInvoice } from "@/modules/invoicing/pending";
import { startTimeTravel } from "@/modules/time-travel/service";
import { createCustomer } from "@/modules/customers/service";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import { createSubscription } from "@/modules/subscriptions/service";
import { aggregateUsage } from "@/modules/metering/service";
import { addPromotionalCredits } from "@/modules/customers/balances";
import {
  createInvoiceFromLines,
  previewInvoiceFromLines,
  UnbilledChargesChangedError,
} from "@/modules/invoicing/service";
import { runBillingClockTick } from "@/modules/subscriptions/renewal";
import { invoiceLineItems, invoices, subscriptions, unbilledCharges } from "@db/schema";

const checks: Array<[string, boolean, string]> = [];
const ok = (name: string, pass: boolean, detail = "") => checks.push([name, pass, detail]);

const org = await createOrganization({ name: "Usage API Org" });
const orgId = org.organization.id;
const app = await buildApp({ logger: false });
const { secret } = await createApiKey(orgId, "test");
const biz = await createBusiness({
  organizationId: orgId,
  name: "Usage API Biz",
  defaultCurrency: "USD",
  livemode: "test",
});
const ctx = { organizationId: orgId, businessId: biz.id };
const base = `/v1/businesses/${biz.publicId}`;
let keyN = 0;
// `header: null` sends no Idempotency-Key; a string sends that one.
const call = async (
  method: "GET" | "POST" | "DELETE",
  url: string,
  body?: unknown,
  opts: { header?: string | null; base?: string } = {},
) => {
  const header =
    opts.header === undefined ? (method === "GET" ? null : `usage-api-${keyN++}`) : opts.header;
  const res = await app.inject({
    method,
    url: `${opts.base ?? base}${url}`,
    headers: {
      authorization: `Bearer ${secret}`,
      ...(header ? { "idempotency-key": header } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
  });
  let json: any = null;
  try {
    json = res.json();
  } catch {
    /* empty body */
  }
  return { status: res.statusCode, json };
};

const product = await createProduct({ ...ctx, name: "API" });
const flat = await createPrice({
  ...ctx,
  productId: product.id,
  type: "recurring",
  model: "flat",
  currency: "USD",
  amountMinor: 1000,
  interval: "month",
});
const metered = await createPrice({
  ...ctx,
  productId: product.id,
  type: "recurring",
  model: "usage",
  currency: "USD",
  amountMinor: 5,
  interval: "month",
  usageAggregation: "sum",
});
async function mkSub(email: string, items = [{ price: flat, quantity: 1 }]) {
  const customer = await createCustomer({ ...ctx, email });
  await vaultPaymentMethod({ ...ctx, customer, token: "tok_4242" });
  const created = await createSubscription({
    ...ctx,
    customerId: customer.id,
    now: new Date(),
    items,
  });
  return { customer, ...created };
}

// ── §1 Usage records ─────────────────────────────────────────────────────────
{
  const s = await mkSub("usage-api@example.com", [
    { price: flat, quantity: 1 },
    { price: metered, quantity: 1 },
  ]);
  const item = s.items.find((i) => i.priceId === metered.id)!;
  const subId = s.subscription.publicId;
  // A closed past window, so the renewal bills usage in arrears (as verify:usage does).
  const T = Date.now();
  const pStart = new Date(T - 2 * 3600_000);
  const pEnd = new Date(T - 3600_000);
  await withTenant(orgId, (tx) =>
    tx
      .update(subscriptions)
      .set({ currentPeriodStart: pStart, currentPeriodEnd: pEnd, startedAt: pStart })
      .where(eq(subscriptions.id, s.subscription.id)),
  );
  const ts = new Date(T - 90 * 60_000).toISOString();

  const plain = await call("POST", `/subscriptions/${subId}/usage`, {
    item: item.publicId,
    quantity: 40,
    timestamp: ts,
  });
  ok(
    "1A: POST usage without note keeps its original response keys",
    plain.status === 201 &&
      JSON.stringify(Object.keys(plain.json).sort()) ===
        JSON.stringify(["id", "item", "object", "quantity", "timestamp"]),
    JSON.stringify(plain.json),
  );
  const noted = await call("POST", `/subscriptions/${subId}/usage`, {
    item: item.publicId,
    quantity: 35,
    timestamp: ts,
    note: "manual correction batch",
  });
  ok("1B: POST usage with note echoes it", noted.json?.note === "manual correction batch");
  await call("POST", `/subscriptions/${subId}/usage`, {
    item: item.publicId,
    quantity: 25,
    timestamp: ts,
  });
  const tooLong = await call("POST", `/subscriptions/${subId}/usage`, {
    item: item.publicId,
    quantity: 1,
    note: "x".repeat(501),
  });
  ok("1C: a note over 500 chars is 400", tooLong.status === 400, `${tooLong.status}`);

  const list = await call("GET", `/usages?subscription=${subId}`);
  ok(
    "1D: list by subscription returns the three records, none invoiced",
    list.status === 200 &&
      list.json.total === 3 &&
      list.json.data.every((u: any) => u.invoice === null && u.subscription === subId),
    JSON.stringify(list.json?.total),
  );
  const byPrice = await call("GET", `/usages?price=${metered.publicId}&invoiced[is]=false`);
  ok("1E: price + invoiced=false filters", byPrice.json?.total === 3, `${byPrice.json?.total}`);
  const paged = await call("GET", `/usages?subscription=${subId}&limit=2`);
  const page2 = await call(
    "GET",
    `/usages?subscription=${subId}&limit=2&starting_after=${paged.json?.next_cursor}`,
  );
  ok(
    "1F: keyset paging covers every record once",
    paged.json?.has_more === true && page2.json?.data.length === 1,
    `${paged.json?.data.length}+${page2.json?.data.length}`,
  );
  const badKey = await call("GET", `/usages?subscription_id=${subId}`);
  ok("1G: an unknown query key is 400", badKey.status === 400, `${badKey.status}`);

  const one = await call("GET", `/usages/${noted.json.id}`);
  ok(
    "1H: retrieve returns note, price, item",
    one.status === 200 &&
      one.json.note === "manual correction batch" &&
      one.json.price === metered.publicId &&
      one.json.item === item.publicId,
  );
  const del = await call("DELETE", `/usages/${noted.json.id}`);
  const gone = await call("GET", `/usages/${noted.json.id}`);
  const agg = await aggregateUsage(orgId, item.id, pStart, pEnd, "sum");
  ok(
    "1I: DELETE before billing removes it from the aggregate",
    del.status === 200 && del.json.deleted === true && gone.status === 404 && agg === 65n,
    `${del.status} ${gone.status} agg=${agg}`,
  );

  await runWithClockScope({ onlyBusinessId: biz.id, now: new Date() }, () =>
    runBillingClockTick(new Date()),
  );
  const after = await call("GET", `/usages?subscription=${subId}`);
  const inv = after.json?.data[0]?.invoice as string | null;
  const [invRow] = await withTenant(orgId, (tx) =>
    tx
      .select()
      .from(invoices)
      .where(and(eq(invoices.businessId, biz.id), eq(invoices.publicId, inv ?? "")))
      .limit(1),
  );
  ok(
    "1J: the renewal rated the remaining 65 units (325 + 1000) and the records name it",
    !!invRow &&
      Number(invRow.totalMinor) === 1325 &&
      after.json.data.every((u: any) => u.invoice === inv),
    `${inv} ${invRow?.totalMinor}`,
  );
  const invoicedF = await call("GET", `/usages?invoiced[is]=true&invoice[is]=${inv}`);
  ok(
    "1K: invoiced=true / invoice filters",
    invoicedF.json?.total === 2,
    `${invoicedF.json?.total}`,
  );
  const locked = await call("DELETE", `/usages/${plain.json.id}`);
  ok(
    "1L: DELETE of billed usage is 409 naming the invoice",
    locked.status === 409 && String(locked.json?.error?.message).includes(inv ?? "?"),
    `${locked.status} ${locked.json?.error?.message}`,
  );
  const fresh = await call("POST", `/subscriptions/${subId}/usage`, {
    item: item.publicId,
    quantity: 7,
  });
  const freshDel = await call("DELETE", `/usages/${fresh.json.id}`);
  ok("1M: usage in the open period stays deletable", freshDel.status === 200, `${freshDel.status}`);
  const missing = await call("DELETE", `/usages/ur_nope`);
  ok("1N: DELETE unknown usage is 404", missing.status === 404, `${missing.status}`);

  // The renewal billed [pStart, pEnd) and the next invoice starts at pEnd.
  const backdated = await call("POST", `/subscriptions/${subId}/usage`, {
    item: item.publicId,
    quantity: 9,
    timestamp: ts,
  });
  ok(
    "1O: usage backdated into the invoiced period is 400 naming the accepted window",
    backdated.status === 400 &&
      /already invoiced/.test(backdated.json?.error?.message ?? "") &&
      String(backdated.json?.error?.message).includes(`from ${pEnd.toISOString()} to `),
    `${backdated.status} ${backdated.json?.error?.message}`,
  );
  const future = await call("POST", `/subscriptions/${subId}/usage`, {
    item: item.publicId,
    quantity: 9,
    timestamp: new Date(Date.now() + 10 * 60_000).toISOString(),
  });
  ok(
    "1P: a timestamp more than 5 minutes ahead is 400",
    future.status === 400 && /more than 5 minutes in the future/.test(future.json?.error?.message),
    `${future.status} ${future.json?.error?.message}`,
  );
  const skew = await call("POST", `/subscriptions/${subId}/usage`, {
    item: item.publicId,
    quantity: 9,
    timestamp: new Date(Date.now() + 2 * 60_000).toISOString(),
  });
  ok("1Q: a timestamp up to 5 minutes ahead is accepted", skew.status === 201, `${skew.status}`);
}

// ── §6 Idempotency of the usage POST ─────────────────────────────────────────
{
  const metered2 = await createPrice({
    ...ctx,
    productId: product.id,
    type: "recurring",
    model: "usage",
    currency: "USD",
    amountMinor: 7,
    interval: "month",
    usageAggregation: "sum",
  });
  const s = await mkSub("usage-idem@example.com", [
    { price: flat, quantity: 1 },
    { price: metered, quantity: 1 },
    { price: metered2, quantity: 1 },
  ]);
  const subId = s.subscription.publicId;
  const item = s.items.find((i) => i.priceId === metered.id)!.publicId;
  const item2 = s.items.find((i) => i.priceId === metered2.id)!.publicId;
  const post = (body: Record<string, unknown>, header: string | null) =>
    call("POST", `/subscriptions/${subId}/usage`, body, { header });

  const first = await post({ item, quantity: 10, idempotency_key: "evt-1" }, null);
  ok("6A: a body key without a header is accepted", first.status === 201, `${first.status}`);
  const again = await post({ item, quantity: 10, idempotency_key: "evt-1" }, null);
  ok(
    "6B: a repeat with the same body key returns the first record",
    again.status === 201 && again.json?.id === first.json?.id,
    `${again.status} ${again.json?.id}/${first.json?.id}`,
  );
  const changed = await post({ item, quantity: 11, idempotency_key: "evt-1" }, null);
  ok(
    "6C: the same body key with a different quantity is 409",
    changed.status === 409 && changed.json?.error?.type === "idempotency_error",
    `${changed.status} ${JSON.stringify(changed.json)}`,
  );
  const changedHdr = await post({ item, quantity: 11, idempotency_key: "evt-1" }, "fresh-hdr-1");
  ok(
    "6D: a different quantity under a fresh header is 409 naming the first record",
    changedHdr.status === 409 &&
      String(changedHdr.json?.error?.message).includes(first.json?.id ?? "?"),
    `${changedHdr.status} ${JSON.stringify(changedHdr.json)}`,
  );
  const sameHdr = await post({ item, quantity: 10, idempotency_key: "evt-1" }, "fresh-hdr-2");
  ok(
    "6E: the same values under a fresh header return the first record",
    sameHdr.status === 201 && sameHdr.json?.id === first.json?.id,
    `${sameHdr.status} ${sameHdr.json?.id}`,
  );
  const otherItem = await post({ item: item2, quantity: 3, idempotency_key: "evt-1" }, null);
  ok(
    "6F: the same body key on another item is a separate event",
    otherItem.status === 201 && otherItem.json?.id !== first.json?.id,
    `${otherItem.status} ${JSON.stringify(otherItem.json)}`,
  );
  const noKey = await post({ item, quantity: 1 }, null);
  ok(
    "6G: no header and no body key is 400 idempotency_required",
    noKey.status === 400 && noKey.json?.error?.type === "idempotency_required",
    `${noKey.status} ${JSON.stringify(noKey.json)}`,
  );
  const early = await post(
    {
      item,
      quantity: 1,
      timestamp: new Date(s.subscription.currentPeriodStart!.getTime() - 86_400_000).toISOString(),
    },
    "early-1",
  );
  ok(
    "6H: a timestamp before the subscription starts is 400",
    early.status === 400 && /before the subscription starts/.test(early.json?.error?.message),
    `${early.status} ${early.json?.error?.message}`,
  );
  const list = await call("GET", `/usages?subscription=${subId}`);
  ok("6I: two records in total", list.json?.total === 2, `${list.json?.total}`);
}

// ── §7 The window follows the pending invoice ─────────────────────────────────
{
  const pbiz = await createBusiness({
    organizationId: orgId,
    name: "Usage API Pending Biz",
    defaultCurrency: "USD",
    livemode: "test",
  });
  const pctx = { organizationId: orgId, businessId: pbiz.id };
  const pprod = await createProduct({ ...pctx, name: "Pending API" });
  const pflat = await createPrice({
    ...pctx,
    productId: pprod.id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 1000,
    interval: "month",
  });
  const pmeter = await createPrice({
    ...pctx,
    productId: pprod.id,
    type: "recurring",
    model: "usage",
    currency: "USD",
    amountMinor: 5,
    interval: "month",
    usageAggregation: "sum",
  });
  const customer = await createCustomer({ ...pctx, email: "usage-pending@example.com" });
  await vaultPaymentMethod({ ...pctx, customer, token: "tok_4242" });
  const { subscription, items } = await createSubscription({
    ...pctx,
    customerId: customer.id,
    now: new Date(),
    items: [
      { price: pflat, quantity: 1 },
      { price: pmeter, quantity: 1 },
    ],
  });
  const item = items.find((i) => i.priceId === pmeter.id)!.publicId;
  // Pending mode from the next renewal on, as in verify:invoices-v2 R4.
  await updateBusiness(orgId, pbiz.publicId, { createPendingInvoices: true });
  const T = Date.now();
  const pStart = new Date(T - 2 * 3600_000);
  await withTenant(orgId, (tx) =>
    tx
      .update(subscriptions)
      .set({
        currentPeriodStart: pStart,
        currentPeriodEnd: new Date(T - 3600_000),
        startedAt: pStart,
      })
      .where(eq(subscriptions.id, subscription.id)),
  );
  await runWithClockScope({ onlyBusinessId: pbiz.id, now: new Date() }, () =>
    runBillingClockTick(new Date()),
  );
  const [draft] = await withTenant(orgId, (tx) =>
    tx
      .select()
      .from(invoices)
      .where(and(eq(invoices.subscriptionId, subscription.id), eq(invoices.status, "pending")))
      .limit(1),
  );
  const pbase = `/v1/businesses/${pbiz.publicId}`;
  const post = (body: Record<string, unknown>) =>
    call("POST", `/subscriptions/${subscription.publicId}/usage`, body, { base: pbase });
  const ts = new Date(T - 90 * 60_000).toISOString();
  const open = await post({ item, quantity: 4, timestamp: ts });
  ok(
    "7A: usage in the period an open pending invoice still bills is accepted",
    !!draft && open.status === 201,
    `${!!draft} ${open.status} ${open.json?.error?.message ?? ""}`,
  );
  if (draft) await closeInvoice(orgId, pbiz.id, draft.publicId);
  const late = await post({ item, quantity: 4, timestamp: ts });
  const lateNow = await post({ item, quantity: 4 });
  ok(
    "7B: once the pending invoice closes, usage inside its window is 400",
    late.status === 400 &&
      lateNow.status === 400 &&
      /Send the usage at or after that time/.test(lateNow.json?.error?.message ?? ""),
    `${late.status} ${lateNow.status} ${lateNow.json?.error?.message}`,
  );
}

// ── §8 Time travel: "now" is the business's simulated clock ───────────────────
{
  const tbiz = await createBusiness({
    organizationId: orgId,
    name: "Usage API Travel Biz",
    defaultCurrency: "USD",
    livemode: "test",
  });
  const tctx = { organizationId: orgId, businessId: tbiz.id };
  const tprod = await createProduct({ ...tctx, name: "Travel API" });
  const tmeter = await createPrice({
    ...tctx,
    productId: tprod.id,
    type: "recurring",
    model: "usage",
    currency: "USD",
    amountMinor: 5,
    interval: "month",
    usageAggregation: "sum",
  });
  const customer = await createCustomer({ ...tctx, email: "usage-travel@example.com" });
  await vaultPaymentMethod({ ...tctx, customer, token: "tok_4242" });
  const { subscription, items } = await createSubscription({
    ...tctx,
    customerId: customer.id,
    now: new Date(),
    items: [{ price: tmeter, quantity: 1 }],
  });
  const genesis = new Date(Date.now() + 10 * 86_400_000);
  await startTimeTravel({ orgId, bizId: tbiz.id, genesisTime: genesis });
  const post = (timestamp: Date) =>
    call(
      "POST",
      `/subscriptions/${subscription.publicId}/usage`,
      { item: items[0]!.publicId, quantity: 1, timestamp: timestamp.toISOString() },
      { base: `/v1/businesses/${tbiz.publicId}` },
    );
  const inSim = await post(new Date(genesis.getTime() + 60_000));
  const pastSim = await post(new Date(genesis.getTime() + 10 * 60_000));
  ok(
    "8A: the 5-minute limit is measured from the simulated time",
    inSim.status === 201 && pastSim.status === 400,
    `${inSim.status} ${pastSim.status} ${inSim.json?.error?.message ?? ""}`,
  );
}

// ── §2 Unbilled charges ──────────────────────────────────────────────────────
{
  const s = await mkSub("unbilled-api@example.com");
  const subId = s.subscription.publicId;
  const queue = async (description: string, amount_minor: number) =>
    (await call("POST", `/subscriptions/${subId}/charges`, { description, amount_minor })).json;
  const a = await queue("Setup", 700);
  const b = await queue("Training", 300);
  const c = await queue("Mistake", 200);
  ok(
    "2A: /charges without invoice_now still queues (default unchanged)",
    a.object === "unbilled_charge" && a.status === "pending",
    JSON.stringify(a),
  );

  const list = await call("GET", `/unbilled_charges?subscription=${subId}&status[is]=pending`);
  ok(
    "2B: business list filters by subscription + status",
    list.status === 200 &&
      list.json.total === 3 &&
      list.json.data.every((r: any) => r.subscription === subId && r.customer),
    `${list.status} ${list.json?.total}`,
  );

  const del = await call("DELETE", `/unbilled_charges/${c.id}`);
  const again = await call("DELETE", `/unbilled_charges/${c.id}`);
  const subList = await call("GET", `/subscriptions/${subId}/unbilled_charges`);
  const subKeys = Object.keys(subList.json.data[0]).sort().join(",");
  ok(
    "2C: DELETE voids a pending charge; a second DELETE is 409",
    del.status === 200 && del.json.status === "voided" && again.status === 409,
    `${del.status} ${again.status}`,
  );
  ok(
    "2D: the subscription list keeps its shape and shows the voided row",
    subKeys ===
      "amount_minor,currency,description,entity_type,id,object,period_end,period_start,quantity,status" &&
      subList.json.data.find((r: any) => r.id === c.id)?.status === "voided",
    subKeys,
  );

  const bad = await call("POST", `/unbilled_charges/invoice_now`, {});
  const both = await call("POST", `/unbilled_charges/invoice_now`, {
    subscription: subId,
    customer: s.customer.publicId,
  });
  const nosub = await call("POST", `/unbilled_charges/invoice_now`, { subscription: "sub_nope" });
  ok(
    "2E: invoice_now needs exactly one known scope",
    bad.status === 400 && both.status === 400 && nosub.status === 404,
    `${bad.status} ${both.status} ${nosub.status}`,
  );

  const est = await call("POST", `/unbilled_charges/invoice_now_estimate`, { subscription: subId });
  const e0 = est.json?.invoice_estimates?.[0];
  const now = await call("POST", `/unbilled_charges/invoice_now`, { subscription: subId });
  const i0 = now.json?.data?.[0];
  const [row] = await withTenant(orgId, (tx) =>
    tx
      .select()
      .from(invoices)
      .where(eq(invoices.publicId, i0?.id ?? ""))
      .limit(1),
  );
  ok(
    "2F: invoice_now raises one invoice for the two pending charges and collects it",
    now.status === 200 &&
      now.json.data.length === 1 &&
      i0.subscription === subId &&
      Number(row?.subtotalMinor) === 1000 &&
      i0.status === "paid",
    `${now.status} ${JSON.stringify(i0 && { s: i0.status, t: i0.total_minor })}`,
  );
  ok(
    "2G: the estimate predicted that invoice",
    !!e0 &&
      !!row &&
      e0.subtotal_minor === Number(row.subtotalMinor) &&
      e0.total_minor === Number(row.totalMinor - row.promotionalCreditsAppliedMinor) &&
      e0.amount_due_minor === Number(row.amountDueMinor) &&
      e0.lines.length === 2,
    JSON.stringify(e0),
  );
  const billed = await call("GET", `/unbilled_charges?subscription=${subId}&status[is]=billed`);
  ok(
    "2H: both charges are billed on that invoice",
    billed.json?.total === 2 && billed.json.data.every((r: any) => r.invoice === i0?.id),
    `${billed.json?.total}`,
  );
  const second = await call("POST", `/unbilled_charges/invoice_now`, { subscription: subId });
  const est2 = await call("POST", `/unbilled_charges/invoice_now_estimate`, {
    subscription: subId,
  });
  ok(
    "2I: nothing pending → no invoice, empty estimate",
    second.json?.data?.length === 0 && est2.json?.invoice_estimates?.length === 0,
  );
  const delBilled = await call("DELETE", `/unbilled_charges/${a.id}`);
  ok("2J: DELETE of a billed charge is 409", delBilled.status === 409, `${delBilled.status}`);
  void b;

  // Customer scope + promotional credit: one invoice per subscription, estimate agrees.
  const customer = await createCustomer({ ...ctx, email: "unbilled-cus@example.com" });
  await vaultPaymentMethod({ ...ctx, customer, token: "tok_4242" });
  const subs = [];
  for (let i = 0; i < 2; i++) {
    const { subscription } = await createSubscription({
      ...ctx,
      customerId: customer.id,
      now: new Date(),
      items: [{ price: flat, quantity: 1 }],
    });
    subs.push(subscription);
    await call("POST", `/subscriptions/${subscription.publicId}/charges`, {
      description: `Extra ${i}`,
      amount_minor: 400,
    });
  }
  await addPromotionalCredits({ ...ctx, customer, amountMinor: 250, currency: "USD" });
  const cEst = await call("POST", `/unbilled_charges/invoice_now_estimate`, {
    customer: customer.publicId,
  });
  const cNow = await call("POST", `/unbilled_charges/invoice_now`, {
    customer: customer.publicId,
  });
  const rows = await withTenant(orgId, (tx) =>
    tx.select().from(invoices).where(eq(invoices.customerId, customer.id)),
  );
  const byId = new Map(rows.map((r) => [r.publicId, r]));
  const firstInv = byId.get(cNow.json?.data?.[0]?.id);
  ok(
    "2K: customer scope raises one invoice per subscription",
    cNow.json?.data?.length === 2 &&
      new Set(cNow.json.data.map((d: any) => d.subscription)).size === 2,
    `${cNow.status} ${cNow.json?.data?.length}`,
  );
  ok(
    "2L: estimate matches with promotional credit drawn pre-tax",
    cEst.json?.invoice_estimates?.length === 2 &&
      !!firstInv &&
      cEst.json.invoice_estimates[0].promotional_discount_minor === 250 &&
      Number(firstInv.promotionalCreditsAppliedMinor) === 250 &&
      cEst.json.invoice_estimates[0].amount_due_minor === Number(firstInv.amountDueMinor) &&
      cEst.json.invoice_estimates[1].promotional_discount_minor === 0,
    JSON.stringify(cEst.json?.invoice_estimates?.map((e: any) => e.amount_due_minor)),
  );
}

// ── §3 The claim is in the invoice transaction ───────────────────────────────
{
  const s = await mkSub("unbilled-race@example.com");
  const q = await call("POST", `/subscriptions/${s.subscription.publicId}/charges`, {
    description: "Raced",
    amount_minor: 500,
  });
  const [charge] = await withTenant(orgId, (tx) =>
    tx.select().from(unbilledCharges).where(eq(unbilledCharges.publicId, q.json.id)),
  );
  await call("DELETE", `/unbilled_charges/${q.json.id}`);
  const before = await withTenant(orgId, (tx) =>
    tx.select().from(invoices).where(eq(invoices.subscriptionId, s.subscription.id)),
  );
  let threw = false;
  try {
    await createInvoiceFromLines({
      ...ctx,
      customerId: s.customer.id,
      subscriptionId: s.subscription.id,
      currency: "USD",
      lines: [{ description: "Raced", amountMinor: 500n, kind: "one_time" }],
      applyTax: true,
      applyCredit: true,
      subscription: s.subscription,
      markUnbilledChargesBilled: [charge!.id],
    });
  } catch (e) {
    threw = e instanceof UnbilledChargesChangedError;
  }
  const afterRows = await withTenant(orgId, (tx) =>
    tx.select().from(invoices).where(eq(invoices.subscriptionId, s.subscription.id)),
  );
  ok(
    "3A: a charge no longer pending rolls the whole invoice back",
    threw && afterRows.length === before.length,
    `${threw} ${before.length}→${afterRows.length}`,
  );
}

// ── §4 Cancel's invoice-unbilled: line detail + the same claim ─────────────────
{
  const chargeProduct = await createProduct({ ...ctx, name: "Seats pack", kind: "charge" });
  const perSeat = await createPrice({
    ...ctx,
    productId: chargeProduct.id,
    type: "one_time",
    model: "per_unit",
    currency: "USD",
    amountMinor: 250,
  });
  const s = await mkSub("unbilled-cancel@example.com");
  const subId = s.subscription.publicId;
  const periodStart = "2026-01-01T00:00:00.000Z";
  const periodEnd = "2026-01-15T00:00:00.000Z";
  await call("POST", `/subscriptions/${subId}/charges`, {
    charges: [
      { price: perSeat.publicId, quantity: 3 },
      {
        description: "Consulting",
        amount_minor: 400,
        period_start: periodStart,
        period_end: periodEnd,
      },
    ],
  });
  const pending = await withTenant(orgId, (tx) =>
    tx
      .select()
      .from(unbilledCharges)
      .where(eq(unbilledCharges.subscriptionId, s.subscription.id))
      .orderBy(unbilledCharges.createdAt),
  );
  // What the pre-change lines (description + amount only) would have totalled.
  const expected = await previewInvoiceFromLines({
    ...ctx,
    customerId: s.customer.id,
    subscriptionId: s.subscription.id,
    currency: "USD",
    lines: pending.map((c) => ({
      description: c.description,
      amountMinor: c.amountMinor,
      kind: "one_time",
    })),
  });
  const cancel = await call("POST", `/subscriptions/${subId}/cancel`, {
    cancel_option: "immediately",
    unbilled_charges_option: "invoice",
    credit_option_for_current_term_charges: "none",
  });
  const after = await withTenant(orgId, (tx) =>
    tx.select().from(unbilledCharges).where(eq(unbilledCharges.subscriptionId, s.subscription.id)),
  );
  const invId = after[0]?.invoiceId ?? "";
  const [inv] = await withTenant(orgId, (tx) =>
    tx.select().from(invoices).where(eq(invoices.id, invId)).limit(1),
  );
  const lines = await withTenant(orgId, (tx) =>
    tx.select().from(invoiceLineItems).where(eq(invoiceLineItems.invoiceId, invId)),
  );
  const seat = lines.find((l) => Number(l.amountMinor) === 750);
  const consult = lines.find((l) => l.description === "Consulting");
  ok(
    "4A: cancel invoices both charges on one invoice",
    cancel.status === 200 &&
      after.length === 2 &&
      after.every((c) => c.status === "billed" && c.invoiceId === invId),
    `${cancel.status} ${JSON.stringify(after.map((c) => c.status))}`,
  );
  ok(
    "4B: the lines carry quantity, unit price and service period",
    seat?.quantity === 3 &&
      Number(seat.unitAmountMinor) === 250 &&
      consult?.periodStart?.toISOString() === periodStart &&
      consult?.periodEnd?.toISOString() === periodEnd,
    JSON.stringify(
      lines.map((l) => [l.description, l.quantity, `${l.unitAmountMinor}`, l.periodStart]),
    ),
  );
  ok(
    "4C: totals are what the pre-change lines produced, and it is not collected",
    !!inv &&
      inv.totalMinor === expected.totalMinor &&
      inv.amountDueMinor === expected.amountDueMinor &&
      inv.status !== "paid",
    `${inv?.totalMinor}/${expected.totalMinor} ${inv?.amountDueMinor}/${expected.amountDueMinor} ${inv?.status}`,
  );

  // A charge queued after the pending set was read is not in the claim, so it stays pending.
  const s2 = await mkSub("unbilled-cancel-race@example.com");
  const first = await call("POST", `/subscriptions/${s2.subscription.publicId}/charges`, {
    description: "Read before",
    amount_minor: 300,
  });
  const late = await call("POST", `/subscriptions/${s2.subscription.publicId}/charges`, {
    description: "Queued after",
    amount_minor: 900,
  });
  const [firstRow] = await withTenant(orgId, (tx) =>
    tx.select().from(unbilledCharges).where(eq(unbilledCharges.publicId, first.json.id)),
  );
  await createInvoiceFromLines({
    ...ctx,
    customerId: s2.customer.id,
    subscriptionId: s2.subscription.id,
    currency: "USD",
    lines: [{ description: "Read before", amountMinor: 300n, kind: "one_time" }],
    applyTax: true,
    applyCredit: true,
    subscription: s2.subscription,
    markUnbilledChargesBilled: [firstRow!.id],
  });
  const states = await withTenant(orgId, (tx) =>
    tx
      .select({ id: unbilledCharges.publicId, status: unbilledCharges.status })
      .from(unbilledCharges)
      .where(eq(unbilledCharges.subscriptionId, s2.subscription.id)),
  );
  ok(
    "4D: a charge outside the claim stays pending",
    states.find((r) => r.id === first.json.id)?.status === "billed" &&
      states.find((r) => r.id === late.json.id)?.status === "pending",
    JSON.stringify(states),
  );
}

// ── §5 The error answers 409 from any route it escapes (cancel, pause, …) ────────
{
  // The real race cannot be forced from outside, so a probe route throws it through the
  // app's own error handler — the path an uncaught throw from cancel/pause takes.
  const probe = await buildApp({ logger: false });
  probe.get("/__probe/unbilled-changed", async () => {
    throw new UnbilledChargesChangedError();
  });
  const res = await probe.inject({ method: "GET", url: "/__probe/unbilled-changed" });
  const body = res.json() as { error?: { type?: string; message?: string } };
  ok(
    "5A: an escaped UnbilledChargesChangedError is a 409 conflict_error saying retry",
    res.statusCode === 409 &&
      body.error?.type === "conflict_error" &&
      /changed while we created the invoice.*Retry/.test(body.error?.message ?? ""),
    `${res.statusCode} ${JSON.stringify(body)}`,
  );
  await probe.close();
}

let failed = 0;
for (const [name, pass, detail] of checks) {
  if (!pass) failed++;
  console.log(`${pass ? "✅" : "❌"} ${name}${pass || !detail ? "" : ` — ${detail}`}`);
}
console.log("");
console.log(failed === 0 ? "✅ USAGE API: PASS" : `❌ USAGE API: FAIL (${failed})`);
await app.close();
await closeDb();
process.exit(failed === 0 ? 0 : 1);
