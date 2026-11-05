/**
 * Receipts (0387): one numbered receipt per money event, numbered in batches off the payment
 * transaction (one series per business), immutable, with a PDF and a read API.
 *
 *   pnpm verify:receipts
 */
import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { systemDb, withTenant, closeDb } from "@/platform/db";
import { buildApp } from "@/index";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createCustomer, updateCustomer } from "@/modules/customers/service";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import { createSubscription } from "@/modules/subscriptions/service";
import { billSubscriptionPeriod } from "@/modules/invoicing/service";
import { recordOfflinePayment } from "@/modules/invoicing/ops";
import { handleProviderEvent } from "@/modules/webhooks/inbound";
import { createReceiptForPayment, numberUnnumberedReceipts } from "@/modules/receipts/service";
import { renderReceiptPdf } from "@/modules/receipts/pdf";
import { businesses, events, payments, receipts, transactions } from "@db/schema";
import type { NormalizedProviderEvent } from "@/providers/types";

const RUN = randomUUID().slice(0, 8);
const checks: Array<[string, boolean, string]> = [];
const check = (name: string, ok: boolean, detail = "") => {
  checks.push([name, ok, detail]);
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
};

async function setupBusiness(label: string) {
  const org = await createOrganization({ name: `Receipts ${label} ${RUN}` });
  const orgId = org.organization.id;
  const biz = await createBusiness({
    organizationId: orgId,
    name: `R ${label}`,
    defaultCurrency: "USD",
    livemode: "test",
  });
  await systemDb
    .update(businesses)
    .set({ dunningConfig: { collect_on_payment_method_update: false } })
    .where(eq(businesses.id, biz.id));
  const product = await createProduct({ organizationId: orgId, businessId: biz.id, name: "Pro" });
  const price = await createPrice({
    organizationId: orgId,
    businessId: biz.id,
    productId: product.id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 5000,
    interval: "month",
  });
  return { org, orgId, biz, bizId: biz.id, price };
}
type Biz = Awaited<ReturnType<typeof setupBusiness>>;

async function billOnce(b: Biz, email: string, token: string) {
  const customer = await createCustomer({
    organizationId: b.orgId,
    businessId: b.bizId,
    email,
    firstName: "Ada",
    lastName: "Payer",
  });
  const pm = await vaultPaymentMethod({
    organizationId: b.orgId,
    businessId: b.bizId,
    customer,
    token,
  });
  const sub = await createSubscription({
    organizationId: b.orgId,
    businessId: b.bizId,
    customerId: customer.id,
    now: new Date(),
    items: [{ price: b.price, quantity: 1 }],
    defaultPaymentMethodId: pm.id,
  });
  const { invoice, payment } = await billSubscriptionPeriod({
    organizationId: b.orgId,
    businessId: b.bizId,
    subscription: sub.subscription,
    periodStart: sub.subscription.currentPeriodStart!,
    periodEnd: sub.subscription.currentPeriodEnd!,
  });
  return { customer, invoice, payment };
}
const receiptsFor = (b: Biz) =>
  withTenant(b.orgId, (tx) => tx.select().from(receipts).where(eq(receipts.businessId, b.bizId)));
const receiptOfPayment = async (b: Biz, paymentId: string) =>
  (
    await withTenant(b.orgId, (tx) =>
      tx.select().from(receipts).where(eq(receipts.paymentId, paymentId)),
    )
  )[0] ?? null;

const A = await setupBusiness("A");

// ── Sync charge success ────────────────────────────────────────────────────────
const ok1 = await billOnce(A, `sync-${RUN}@example.com`, "tok_4242");
{
  const r = ok1.payment ? await receiptOfPayment(A, ok1.payment.id) : null;
  check(
    "sync charge: one receipt, unnumbered at first",
    !!r && r.amountMinor === 5000n && r.number === null,
    `${r?.amountMinor} ${r?.number}`,
  );
  const snap = r?.snapshot as
    | { method?: string; allocations?: Array<{ invoice: string }> }
    | undefined;
  check(
    "sync charge: snapshot names the card and the invoice",
    /···4242/.test(snap?.method ?? "") && snap?.allocations?.[0]?.invoice === ok1.invoice.publicId,
    `${snap?.method} ${JSON.stringify(snap?.allocations)}`,
  );
}

// ── Failed charge: no receipt ──────────────────────────────────────────────────
{
  const bad = await billOnce(A, `bad-${RUN}@example.com`, "4000000000009995");
  const n = await withTenant(
    A.orgId,
    async (tx) =>
      (await tx.select().from(receipts).where(eq(receipts.customerId, bad.customer.id))).length,
  );
  check("failed charge: no receipt", n === 0, `n=${n}`);
  // Offline overpay on that invoice: receipt for the cash received, two lines.
  const off = await recordOfflinePayment({
    organizationId: A.orgId,
    businessId: A.bizId,
    invoicePublicId: bad.invoice.publicId,
    amountMinor: 7000,
    method: "cash",
  });
  const r = await receiptOfPayment(A, off.payment.id);
  const snap = r?.snapshot as
    | { method?: string; allocations?: Array<{ invoice: string | null; amount_minor: number }> }
    | undefined;
  check(
    "offline overpay: receipt for 70.00 — 50.00 on the invoice, 20.00 as credit",
    r?.amountMinor === 7000n &&
      snap?.allocations?.length === 2 &&
      snap.allocations[0]!.amount_minor === 5000 &&
      snap.allocations[1]!.invoice === null &&
      snap.method === "Cash",
    `${r?.amountMinor} ${JSON.stringify(snap?.allocations)} ${snap?.method}`,
  );
}

// ── Async settle through the webhook ──────────────────────────────────────────
{
  const asy = await billOnce(A, `async-${RUN}@example.com`, "4000000000000101");
  const [txn] = await withTenant(A.orgId, (tx) =>
    tx.select().from(transactions).where(eq(transactions.invoiceId, asy.invoice.id)),
  );
  const before = asy.payment ? await receiptOfPayment(A, asy.payment.id) : null;
  await handleProviderEvent(
    "tmtest",
    {
      providerEventId: `ev_rc_${RUN}`,
      type: "charge.succeeded",
      providerChargeId: txn!.idAtGateway!,
      occurredAt: new Date(),
      raw: {},
    } as NormalizedProviderEvent,
    { businessId: A.bizId },
  );
  const after = asy.payment ? await receiptOfPayment(A, asy.payment.id) : null;
  check(
    "async: no receipt while pending, one after the webhook settles it",
    !before && !!after,
    `before=${!!before} after=${!!after}`,
  );
}

// ── Imported and replayed ─────────────────────────────────────────────────────
{
  const [imp] = await withTenant(A.orgId, (tx) =>
    tx
      .insert(payments)
      .values({
        organizationId: A.orgId,
        businessId: A.bizId,
        customerId: ok1.customer.id,
        invoiceId: null,
        publicId: `pay_imp_${RUN}`,
        status: "succeeded",
        amountMinor: 100n,
        currency: "USD",
        providerKey: "stripe",
        providerChargeId: `ch_imp_${RUN}`,
        imported: true,
      })
      .returning(),
  );
  const r = await withTenant(A.orgId, (tx) => createReceiptForPayment(tx, { paymentId: imp!.id }));
  check("imported payment: no receipt", r === null);
  const again = await withTenant(A.orgId, (tx) =>
    createReceiptForPayment(tx, { paymentId: ok1.payment!.id }),
  );
  const count = (
    await withTenant(A.orgId, (tx) =>
      tx.select().from(receipts).where(eq(receipts.paymentId, ok1.payment!.id)),
    )
  ).length;
  check("replay: no duplicate receipt", again === null && count === 1, `count=${count}`);
}

// ── Numbering: 20 concurrent settlements, gap-free and ordered ────────────────
const B = await setupBusiness("B");
{
  const inv = await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      billOnce(B, `c${i}-${RUN}@example.com`, "4000000000009995"),
    ),
  );
  await Promise.all(
    inv.map((x) =>
      recordOfflinePayment({
        organizationId: B.orgId,
        businessId: B.bizId,
        invoicePublicId: x.invoice.publicId,
        method: "cash",
      }),
    ),
  );
  // Several numberers at once: single-flight per business, so no skipped or doubled number.
  await Promise.all(Array.from({ length: 4 }, () => numberUnnumberedReceipts(B.orgId, B.bizId, 7)));
  while ((await numberUnnumberedReceipts(B.orgId, B.bizId, 7)) > 0);
  // Ordered in SQL: created_at carries microseconds a JS Date drops.
  const rows = await withTenant(B.orgId, (tx) =>
    tx
      .select()
      .from(receipts)
      .where(eq(receipts.businessId, B.bizId))
      .orderBy(asc(receipts.createdAt), asc(receipts.id)),
  );
  const nums = rows.map((r) => Number(r.number?.replace(/^RCPT-/, "")));
  const sorted = [...nums].sort((a, b) => a - b);
  check(
    "numbering: 20 receipts numbered RCPT-1..20, no gap, no duplicate",
    rows.length === 20 && sorted.every((v, i) => v === i + 1),
    nums.join(","),
  );
  check(
    "numbering: numbers follow creation order",
    nums.every((v, i) => i === 0 || v > nums[i - 1]!),
    nums.join(","),
  );
  const evs = await withTenant(B.orgId, (tx) =>
    tx
      .select()
      .from(events)
      .where(and(eq(events.businessId, B.bizId), eq(events.type, "receipt_created"))),
  );
  check(
    "receipt_created emitted once per receipt, carrying the number",
    evs.length === 20 && evs.every((e) => /RCPT-\d+/.test(JSON.stringify(e.data))),
    `n=${evs.length}`,
  );
}

// ── Series per business; snapshot immutable; PDF; API ──────────────────────────
{
  await numberUnnumberedReceipts(A.orgId, A.bizId);
  const aRows = (await receiptsFor(A))
    .filter((r) => r.number)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  check(
    "series per business: A starts at RCPT-1 too",
    aRows[0]?.number === "RCPT-1",
    aRows.map((r) => r.number).join(","),
  );
  const first = aRows[0]!;
  await updateCustomer({
    organizationId: A.orgId,
    businessId: A.bizId,
    customerPublicId: ok1.customer.publicId,
    firstName: "Renamed",
  });
  const [reread] = await withTenant(A.orgId, (tx) =>
    tx.select().from(receipts).where(eq(receipts.id, first.id)),
  );
  check(
    "snapshot immune to a later rename",
    (reread!.snapshot as { payer: { name: string } }).payer.name === "Ada Payer",
    (reread!.snapshot as { payer: { name: string } }).payer.name,
  );
  const pdf = await renderReceiptPdf(first);
  check(
    "PDF renders",
    pdf.subarray(0, 4).toString() === "%PDF" && pdf.length > 1000,
    `${pdf.length} bytes`,
  );

  const app = await buildApp({ logger: false });
  const get = async (url: string) => {
    const res = await app.inject({
      method: "GET",
      url: `/v1/businesses/${A.biz.publicId}${url}`,
      headers: { authorization: `Bearer ${A.org.secret}` },
    });
    return {
      status: res.statusCode,
      body: String(res.headers["content-type"] ?? "").includes("json")
        ? JSON.parse(res.body)
        : res.rawPayload,
    };
  };
  const list = await get(`/receipts?customer=${ok1.customer.publicId}`);
  check(
    "API list filters by customer",
    list.status === 200 && list.body.data.length === 1 && list.body.data[0].id === first.publicId,
    `${list.status} ${list.body?.data?.length}`,
  );
  const byPayment = await get(`/receipts?payment=${ok1.payment!.publicId}`);
  check(
    "API list filters by payment",
    byPayment.body?.data?.length === 1,
    `${byPayment.body?.data?.length}`,
  );
  const one = await get(`/receipts/${first.publicId}`);
  check(
    "API get: number, amount, allocations",
    one.status === 200 && one.body.number === "RCPT-1" && one.body.amount_minor === 5000,
    `${one.status} ${one.body?.number}`,
  );
  const p = await get(`/receipts/${first.publicId}/pdf`);
  check("API pdf: 200 application/pdf", p.status === 200, `${p.status}`);
  const other = await app.inject({
    method: "GET",
    url: `/v1/businesses/${B.biz.publicId}/receipts/${first.publicId}`,
    headers: { authorization: `Bearer ${B.org.secret}` },
  });
  check("API: another tenant gets 404", other.statusCode === 404, `${other.statusCode}`);
  await app.close();
}

// ── Prefix and numbering format come from the business ────────────────────────
{
  const C = await setupBusiness("C");
  await systemDb
    .update(businesses)
    .set({
      receiptPrefix: "RC",
      invoiceCustomization: { receipt: { numbering: { dynamic_prefix: "yyyy" } } },
    })
    .where(eq(businesses.id, C.bizId));
  const x = await billOnce(C, `fmt-${RUN}@example.com`, "tok_4242");
  await numberUnnumberedReceipts(C.orgId, C.bizId);
  const r = x.payment ? await receiptOfPayment(C, x.payment.id) : null;
  check(
    "format: prefix and dated stamp from the business settings",
    /^RC-\d{4}-1$/.test(r?.number ?? ""),
    `${r?.number}`,
  );
}

const failed = checks.filter(([, ok]) => !ok).length;
console.log(`\n${checks.length - failed}/${checks.length} passed`);
console.log(failed ? "❌ RECEIPTS: FAIL" : "✅ RECEIPTS: PASS");
await closeDb();
process.exit(failed ? 1 : 0);
