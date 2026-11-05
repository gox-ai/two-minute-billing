/**
 * Subscription payment gating — create AND reactivate.
 *
 * With auto-collection ON and an immediate first charge:
 *  - no usable card on file → 400 payment_error, nothing created/changed;
 *  - card that fails the first charge → 402 payment_error, and NOTHING is left
 *    behind: no subscription, no invoice, no lifecycle events (the charge is taken
 *    before anything is persisted-and-visible). Only the failed transaction is kept;
 *  - working card → 201 active + paid invoice.
 * Exemptions (no immediate charge): trials, future starts, auto-collection off.
 *
 * Reactivation is a creation-like event and mirrors the same gate: reactivating
 * a cancelled sub with auto-collect ON and no usable card is refused (400).
 *
 * …and since 2026-09-05 that refusal is CONFIGURABLE on reactivation, gated on the
 * "Payment collection when payment method is added" toggle
 * (`dunning_config.collect_on_payment_method_update`, default on). One control covers
 * both: with it on the subscription is enabled only after payment collection;
 * with it off the reactivation stands and the unpaid invoice goes to dunning. Cases 9
 * and 10 pin both positions, and case 9 is the one that proves the DEFAULT is
 * unchanged — the setting is opt-out, so a merchant who never opens the form keeps
 * today's behaviour.
 *
 * pnpm verify:create-gating
 */
import { and, eq } from "drizzle-orm";
import { buildApp } from "@/index";
import { systemDb, closeDb, withTenant } from "@/platform/db";
import { createOrganization } from "@/modules/tenancy/service";
import { listTransactionsPage } from "@/modules/transactions/service";
import {
  businesses,
  customers,
  events,
  gatewayAccounts,
  invoices,
  paymentIntents,
  payments,
  transactions,
} from "@db/schema";
import { setChargeStatus } from "@/providers/tmtest/store";
import { Tmbilling, TmbillingError } from "../sdk/index";

const checks: Array<[string, boolean]> = [];
const ok = (n: string, c: boolean) => checks.push([n, c]);

const app = await buildApp({ logger: false });
await app.listen({ port: 0, host: "127.0.0.1" });
const port = (app.server.address() as { port: number }).port;

const org = await createOrganization({ name: "Create Gating Co" });
const tmb = new Tmbilling({ apiKey: org.secret, baseUrl: `http://127.0.0.1:${port}` });
const biz = await tmb.businesses.create({
  name: "Gating Biz",
  default_currency: "USD",
  livemode: "test",
});
const product = await tmb.products.create(biz.id, { name: "Pro" });
const price = await tmb.prices.create(biz.id, {
  product: product.id,
  model: "flat",
  currency: "USD",
  amount_minor: 5000,
  interval: "month",
});

const createSub = (cus: string, extra?: Record<string, unknown>) =>
  tmb.subscriptions.create(biz.id, cus, {
    items: [{ price: price.id, quantity: 1 }],
    ...(extra ?? {}),
  } as never);

// 1) auto ON (default) + NO card → 400, nothing created.
{
  const cus = await tmb.customers.create(biz.id, { email: "nocard@gating.test" });
  let err: TmbillingError | null = null;
  try {
    await createSub(cus.id);
  } catch (e) {
    err = e as TmbillingError;
  }
  ok(
    "no card: creation refused with payment_error",
    err instanceof TmbillingError && err.status === 400 && err.type === "payment_error",
  );
  const subs = await tmb.subscriptions.list(biz.id);
  ok(
    "no card: no subscription husk",
    subs.data.filter((s) => (s as { customer?: string }).customer === cus.id).length === 0,
  );
}

// 2) auto ON + card that vaults OK but every charge fails → 402, and NOTHING is
//    left behind: the charge is taken before the subscription is
//    persisted-and-visible, so a decline deletes the provisional row and no invoice
//    or lifecycle event was ever written. Only the failed transaction survives.
{
  const cus = await tmb.customers.create(biz.id, { email: "decliner@gating.test" });
  await tmb.paymentMethods.create(biz.id, cus.id, { token: "tok_4000000000000341" }); // vault_ok_charge_fails
  let err: TmbillingError | null = null;
  try {
    await createSub(cus.id);
  } catch (e) {
    err = e as TmbillingError;
  }
  ok(
    "declining card: creation refused with 402 payment_error",
    err instanceof TmbillingError && err.status === 402 && err.type === "payment_error",
  );
  const subs = await tmb.subscriptions.list(biz.id);
  ok(
    "declining card: no subscription left behind",
    subs.data.filter((s) => (s as { customer?: string }).customer === cus.id).length === 0,
  );
  const cusRows = await systemDb
    .select({ id: customers.id })
    .from(customers)
    .where(eq(customers.publicId, cus.id));
  const inv = cusRows[0]
    ? await systemDb.select().from(invoices).where(eq(invoices.customerId, cusRows[0].id))
    : [];
  ok("declining card: no invoice left behind", inv.length === 0);
  const evs = await systemDb
    .select({ type: events.type })
    .from(events)
    .where(eq(events.resourceId, cus.id));
  ok(
    "declining card: no subscription lifecycle events",
    evs.every((e) => !e.type.startsWith("subscription")),
  );
  const txns = await systemDb
    .select()
    .from(transactions)
    .where(eq(transactions.customerId, cusRows[0]!.id));
  ok(
    "declining card: the failed charge IS recorded as a transaction",
    txns.some((t) => t.status === "failed"),
  );
}

// 2b) `on_charge_failure` on create. Omitted is section 2 (refused, nothing left behind).
{
  const declining = async (email: string) => {
    const cus = await tmb.customers.create(biz.id, { email });
    await tmb.paymentMethods.create(biz.id, cus.id, { token: "tok_4000000000000341" });
    return cus;
  };
  const tryCreate = async (cus: string, extra: Record<string, unknown>) => {
    try {
      return { sub: await createSub(cus, extra), err: null };
    } catch (e) {
      return { sub: null, err: e as TmbillingError };
    }
  };

  // dun: created active, the first invoice open and owned by dunning, decline reported.
  const cusD = await declining("create-dun@gating.test");
  const d = await tryCreate(cusD.id, { on_charge_failure: "dun" });
  ok(
    `create dun: subscription created active (${d.sub?.status ?? `REFUSED ${d.err?.status}`})`,
    d.sub?.status === "active",
  );
  ok(
    `create dun: payment_error carries the decline (${d.sub?.payment_error?.code ?? "none"})`,
    !!d.sub?.payment_error?.code,
  );
  const dInv = d.sub?.latest_invoice?.id
    ? (
        await systemDb
          .select({ s: invoices.status, d: invoices.dunningStatus, n: invoices.nextAttemptAt })
          .from(invoices)
          .where(eq(invoices.publicId, d.sub.latest_invoice.id))
      )[0]
    : undefined;
  ok(
    `create dun: invoice open with a dunning retry (${dInv?.s ?? "none"}/${dInv?.d ?? "NULL"}/${dInv?.n ? "sched" : "none"})`,
    !!dInv && dInv.s !== "paid" && dInv.s !== "void" && dInv.d != null && dInv.n != null,
  );
  const dEvs = d.sub
    ? await systemDb
        .select({ type: events.type })
        .from(events)
        .where(eq(events.resourceId, d.sub.id))
    : [];
  ok(
    "create dun: subscription_created was emitted",
    dEvs.some((e) => e.type === "subscription_created"),
  );

  // refuse, explicit: the same as omitted — 402 and nothing created.
  const cusR = await declining("create-refuse@gating.test");
  const r = await tryCreate(cusR.id, { on_charge_failure: "refuse" });
  const rSubs = await tmb.subscriptions.list(biz.id);
  ok(
    `create refuse: refused with 402 (${r.sub?.status ?? `REFUSED ${r.err?.status}`})`,
    r.sub === null && r.err?.status === 402 && r.err.type === "payment_error",
  );
  ok(
    "create refuse: no subscription left behind",
    rSubs.data.filter((s) => (s as { customer?: string }).customer === cusR.id).length === 0,
  );

  // dun cannot apply to a buyer-present charge: 400 before anything is written.
  const cusS = await declining("create-dun-session@gating.test");
  const sRes = await tryCreate(cusS.id, { on_charge_failure: "dun", on_session: true });
  const sSubs = await tmb.subscriptions.list(biz.id);
  ok(
    `create dun + on_session: refused with 400 (${sRes.err?.status ?? "CREATED"})`,
    sRes.sub === null && sRes.err?.status === 400,
  );
  ok(
    "create dun + on_session: no subscription created",
    sSubs.data.filter((s) => (s as { customer?: string }).customer === cusS.id).length === 0,
  );

  // 2c) An authorized intent whose capture is refused: the subscription and its
  // invoice exist, and the invoice (committed uncollected) must have a dunning owner.
  const cusI = await tmb.customers.create(biz.id, { email: "create-intent-refused@gating.test" });
  await tmb.paymentMethods.create(biz.id, cusI.id, { token: "tok_4000000000003155" });
  const leg1 = await tryCreate(cusI.id, { on_session: true });
  const piId = (leg1.err?.body as { payment_intent?: { id?: string } } | undefined)?.payment_intent
    ?.id;
  ok(`create intent: leg 1 asks for 3DS (${leg1.err?.status ?? "CREATED"})`, !!piId);
  if (piId) {
    // Authorized on our side, voided at the gateway: the capture is refused.
    const [pi] = await systemDb
      .update(paymentIntents)
      .set({ status: "authorized" })
      .where(eq(paymentIntents.publicId, piId))
      .returning({ gw: paymentIntents.intentAtGateway });
    if (pi?.gw) await setChargeStatus(pi.gw, "voided");
    const leg2 = await tryCreate(cusI.id, { payment_intent: piId });
    const sub = leg2.sub as
      | (Awaited<ReturnType<typeof createSub>> & {
          payment_error?: { code?: string };
          latest_invoice?: { id?: string } | null;
        })
      | null;
    ok(
      `create intent refused: created with payment_error (${sub?.payment_error?.code ?? `ERR ${leg2.err?.status}`})`,
      !!sub?.payment_error,
    );
    const owned = sub?.latest_invoice?.id
      ? (
          await systemDb
            .select({ s: invoices.status, d: invoices.dunningStatus, n: invoices.nextAttemptAt })
            .from(invoices)
            .where(eq(invoices.publicId, sub.latest_invoice.id))
        )[0]
      : undefined;
    ok(
      `create intent refused: invoice has a dunning owner (${owned?.s}:${owned?.d ?? "NULL"}/${owned?.n ? "sched" : "none"})`,
      !!owned && owned.d != null && owned.n != null,
    );
  }
}

// 3) auto ON + working card → 201 active.
{
  const cus = await tmb.customers.create(biz.id, { email: "payer@gating.test" });
  await tmb.paymentMethods.create(biz.id, cus.id, { token: "tok_4242" });
  const sub = await createSub(cus.id);
  ok("working card: created active", sub.status === "active");
}

// 4) auto OFF + no card → allowed (invoice awaits manual payment).
{
  const cus = await tmb.customers.create(biz.id, { email: "offline@gating.test" });
  const sub = await createSub(cus.id, { auto_collection: "off" });
  ok("auto_collection=off: created without a card", sub.status === "active");
}

// 5) trial + no card → allowed (no immediate charge; card can be added before trial end).
{
  const cus = await tmb.customers.create(biz.id, { email: "trial@gating.test" });
  const sub = await createSub(cus.id, { trial_days: 14 });
  ok("trial: created without a card", sub.status === "in_trial");
}

// 5b) an exact trial_end → a trial ending that day, no card needed; nonsense refused.
{
  const cus = await tmb.customers.create(biz.id, { email: "trial-end@gating.test" });
  const want = new Date(Date.now() + 10 * 86_400_000);
  const sub = await createSub(cus.id, { trial_end: want.toISOString() });
  const got = sub.trial_end ? new Date(String(sub.trial_end)) : null;
  ok("trial_end: created in trial without a card", sub.status === "in_trial");
  ok(
    `trial_end: ends on the requested day (asked ${want.toISOString()}, got ${sub.trial_end})`,
    got != null && Math.abs(+got - +want) < 86_400_000,
  );
  const refusals: Array<[string, Record<string, unknown>]> = [
    [
      "trial_end in the past is refused",
      { trial_end: new Date(Date.now() - 86_400_000).toISOString() },
    ],
    ["trial_end with trial_days is refused", { trial_end: want.toISOString(), trial_days: 5 }],
  ];
  for (const [label, extra] of refusals) {
    let status = 0;
    try {
      await createSub(cus.id, extra);
    } catch (e) {
      status = (e as TmbillingError).status ?? -1;
    }
    ok(`${label} (got ${status})`, status === 400);
  }
}

// 5c) a coupon given AT reactivation discounts the fresh term; a refused charge takes it off.
{
  await tmb.coupons.create(biz.id, {
    code: "REACT50",
    kind: "percentage",
    percent_off_bps: 5000,
    duration_type: "forever",
  });
  const cus = await tmb.customers.create(biz.id, { email: "react-coupon@gating.test" });
  await tmb.paymentMethods.create(biz.id, cus.id, { token: "tok_4242" });
  const sub = await createSub(cus.id);
  await tmb.subscriptions.cancel(biz.id, sub.id);
  const re = await tmb.subscriptions.reactivate(biz.id, sub.id, {
    items: [{ price: price.id, quantity: 1 }],
    coupon_code: "REACT50",
  });
  ok(
    `reactivate + coupon: the fresh term is billed at half price (got ${re.latest_invoice?.total_minor})`,
    re.status === "active" && re.latest_invoice?.total_minor === 2500,
  );

  const cus2 = await tmb.customers.create(biz.id, { email: "react-coupon-decline@gating.test" });
  await tmb.paymentMethods.create(biz.id, cus2.id, { token: "tok_4242" });
  const sub2 = await createSub(cus2.id);
  await tmb.subscriptions.cancel(biz.id, sub2.id);
  const pms = await tmb.paymentMethods.list(biz.id, cus2.id);
  for (const pm of pms.data) await tmb.paymentMethods.detach(biz.id, cus2.id, pm.id);
  await tmb.paymentMethods.create(biz.id, cus2.id, { token: "tok_4000000000000341" });
  let status = 0;
  try {
    await tmb.subscriptions.reactivate(biz.id, sub2.id, {
      items: [{ price: price.id, quantity: 1 }],
      coupon_code: "REACT50",
    });
  } catch (e) {
    status = (e as TmbillingError).status ?? -1;
  }
  const after = await tmb.subscriptions.get(biz.id, sub2.id);
  ok(`reactivate + coupon, declined: refused (got ${status})`, status === 402);
  ok(
    `…the subscription stays cancelled and keeps no coupon (discount ${JSON.stringify((after as { discount?: unknown }).discount ?? null)})`,
    after.status === "cancelled" && !(after as { discount?: unknown }).discount,
  );
}

// 6) reactivate with the card still on file → allowed (fresh term billed).
{
  const cus = await tmb.customers.create(biz.id, { email: "react-ok@gating.test" });
  await tmb.paymentMethods.create(biz.id, cus.id, { token: "tok_4242" });
  const sub = await createSub(cus.id);
  await tmb.subscriptions.cancel(biz.id, sub.id);
  const re = await tmb.subscriptions.reactivate(biz.id, sub.id);
  ok("reactivate with card: back to active", re.status === "active");
}

// 7) reactivate with auto-collect ON but the card removed → refused (mirror create gate).
{
  const cus = await tmb.customers.create(biz.id, { email: "react-nocard@gating.test" });
  await tmb.paymentMethods.create(biz.id, cus.id, { token: "tok_4242" });
  const sub = await createSub(cus.id);
  await tmb.subscriptions.cancel(biz.id, sub.id);
  const pms = await tmb.paymentMethods.list(biz.id, cus.id);
  for (const pm of pms.data) await tmb.paymentMethods.detach(biz.id, cus.id, pm.id);
  let err: TmbillingError | null = null;
  try {
    await tmb.subscriptions.reactivate(biz.id, sub.id);
  } catch (e) {
    err = e as TmbillingError;
  }
  ok(
    "reactivate no card: refused with payment_error",
    err instanceof TmbillingError && err.status === 400 && err.type === "payment_error",
  );
  const after = await tmb.subscriptions.get(biz.id, sub.id);
  ok("reactivate refused: subscription stays cancelled", after.status === "cancelled");
}

// 8) reactivate with auto-collection OFF + no card → allowed (no immediate charge).
{
  const cus = await tmb.customers.create(biz.id, { email: "react-offline@gating.test" });
  const sub = await createSub(cus.id, { auto_collection: "off" });
  await tmb.subscriptions.cancel(biz.id, sub.id);
  const re = await tmb.subscriptions.reactivate(biz.id, sub.id);
  ok("reactivate auto_collection=off: allowed without a card", re.status === "active");
}

// ── 9) DEFAULT (toggle ON): a reactivation whose charge FAILS is refused ────────
// The control for case 10, and the regression guard for the default. A declining
// card (not a missing one) is the path #C changes, so it is asserted directly rather
// than inferred from case 7's no-card refusal.
{
  const cus = await tmb.customers.create(biz.id, { email: "react-decline-on@gating.test" });
  await tmb.paymentMethods.create(biz.id, cus.id, { token: "tok_4242" });
  const sub = await createSub(cus.id);
  await tmb.subscriptions.cancel(biz.id, sub.id);
  // Swap the good card for one that vaults but never charges, so the reactivation
  // gets past the has-a-card check and fails at the charge.
  for (const pm of (await tmb.paymentMethods.list(biz.id, cus.id)).data)
    await tmb.paymentMethods.detach(biz.id, cus.id, pm.id);
  await tmb.paymentMethods.create(biz.id, cus.id, { token: "tok_4000000000000341" });
  const cancelled = await tmb.subscriptions.get(biz.id, sub.id);
  const cusRowBefore = (
    await systemDb
      .select({ id: customers.id })
      .from(customers)
      .where(eq(customers.publicId, cus.id))
  )[0]!;
  const invoicesBefore = (
    await systemDb
      .select({ id: invoices.id })
      .from(invoices)
      .where(eq(invoices.customerId, cusRowBefore.id))
  ).length;
  const eventsBefore = (
    await systemDb.select({ type: events.type }).from(events).where(eq(events.resourceId, sub.id))
  ).length;
  let err: TmbillingError | null = null;
  try {
    await tmb.subscriptions.reactivate(biz.id, sub.id);
  } catch (e) {
    err = e as TmbillingError;
  }
  ok(
    "toggle ON: reactivation with a declining card is refused with 402",
    err instanceof TmbillingError && err.status === 402,
  );
  // Refused BEFORE anything is committed: the charge is taken first.
  const invoicesAfter = (
    await systemDb
      .select({ id: invoices.id })
      .from(invoices)
      .where(eq(invoices.customerId, cusRowBefore.id))
  ).length;
  ok(
    `toggle ON: no invoice is raised at all (${invoicesBefore} → ${invoicesAfter})`,
    invoicesAfter === invoicesBefore,
  );
  const newEvents = (
    await systemDb.select({ type: events.type }).from(events).where(eq(events.resourceId, sub.id))
  )
    .slice(eventsBefore)
    .map((e) => e.type);
  ok(
    `toggle ON: nothing is announced about the subscription [${newEvents.join(",")}]`,
    newEvents.length === 0,
  );
  const unchanged = await tmb.subscriptions.get(biz.id, sub.id);
  ok(
    "toggle ON: the original cancellation is kept (date and reason)",
    (unchanged as { canceled_at?: unknown }).canceled_at ===
      (cancelled as { canceled_at?: unknown }).canceled_at &&
      (unchanged as { cancel_reason?: unknown }).cancel_reason ===
        (cancelled as { cancel_reason?: unknown }).cancel_reason,
  );
  const failedPays = await systemDb
    .select({ status: payments.status, invoiceId: payments.invoiceId })
    .from(payments)
    .where(and(eq(payments.customerId, cusRowBefore.id), eq(payments.status, "failed")));
  ok(
    "toggle ON: the declined attempt is still on the record, with no invoice",
    failedPays.length === 1 && failedPays[0]!.invoiceId === null,
  );
  // With no invoice, only the row's own subscription_id reaches the subscription's tab.
  const bizIds = (
    await systemDb
      .select({ id: businesses.id, org: businesses.organizationId })
      .from(businesses)
      .where(eq(businesses.publicId, biz.id))
  )[0]!;
  const subTxns = await listTransactionsPage(bizIds.org, bizIds.id, {
    filters: [{ field: "subscription", op: "is", value: sub.id }],
  });
  ok(
    `toggle ON: the declined attempt is on the subscription's transactions [${subTxns.data.map((t) => `${t.txn.type}:${t.txn.status}`).join(",")}]`,
    subTxns.data.some((t) => t.txn.type === "payment" && t.txn.status === "failed"),
  );
  const after = await tmb.subscriptions.get(biz.id, sub.id);
  ok("toggle ON: the subscription stays cancelled", after.status === "cancelled");
  const cusRow = (
    await systemDb
      .select({ id: customers.id })
      .from(customers)
      .where(eq(customers.publicId, cus.id))
  )[0]!;
  const invs = await systemDb
    .select({ status: invoices.status })
    .from(invoices)
    .where(eq(invoices.customerId, cusRow.id));
  // The unwind, not just the refusal: nothing is left collectable.
  ok(
    `toggle ON: no invoice is left open [${invs.map((i) => i.status).join(",")}]`,
    invs.every((i) => i.status !== "payment_due"),
  );
}

// ── 10) toggle OFF: the same reactivation STANDS, and dunning owns the invoice ──
{
  const cus = await tmb.customers.create(biz.id, { email: "react-decline-off@gating.test" });
  await tmb.paymentMethods.create(biz.id, cus.id, { token: "tok_4242" });
  const sub = await createSub(cus.id);
  await tmb.subscriptions.cancel(biz.id, sub.id);
  for (const pm of (await tmb.paymentMethods.list(biz.id, cus.id)).data)
    await tmb.paymentMethods.detach(biz.id, cus.id, pm.id);
  await tmb.paymentMethods.create(biz.id, cus.id, { token: "tok_4000000000000341" });
  const bizRow = (
    await systemDb
      .select({ id: businesses.id, org: businesses.organizationId })
      .from(businesses)
      .where(eq(businesses.publicId, biz.id))
  )[0]!;
  await withTenant(bizRow.org, (tx) =>
    tx
      .update(businesses)
      .set({ dunningConfig: { collect_on_payment_method_update: false } })
      .where(eq(businesses.id, bizRow.id)),
  );
  // Caught, not awaited bare: if the toggle stops being honoured this refuses with a
  // 402, and an uncaught throw here takes the whole suite down before the four checks
  // below ever run. A regression should name itself, not crash the harness.
  let re: { status?: string } | null = null;
  let reErr: TmbillingError | null = null;
  try {
    re = await tmb.subscriptions.reactivate(biz.id, sub.id);
  } catch (e) {
    reErr = e as TmbillingError;
  }
  ok(
    `toggle OFF: the reactivation stands (${re?.status ?? `REFUSED ${reErr?.status}`})`,
    re?.status === "active",
  );
  const cusRow = (
    await systemDb
      .select({ id: customers.id })
      .from(customers)
      .where(eq(customers.publicId, cus.id))
  )[0]!;
  const invs = await systemDb
    .select({ status: invoices.status, dunning: invoices.dunningStatus })
    .from(invoices)
    .where(eq(invoices.customerId, cusRow.id));
  // The point of the OFF position: the debt survives for dunning to chase. An invoice
  // that got voided anyway would mean the toggle only skipped the CANCEL, which would
  // leave an active subscription with nothing to collect — worse than either position.
  ok(
    `toggle OFF: the unpaid invoice survives for dunning [${invs.map((i) => `${i.status}/${i.dunning}`).join(",")}]`,
    invs.some((i) => i.status === "payment_due"),
  );
  // Restore, so anything added after this block sees the documented default.
  await withTenant(bizRow.org, (tx) =>
    tx.update(businesses).set({ dunningConfig: {} }).where(eq(businesses.id, bizRow.id)),
  );
}

// ── 10b) the two settings are INDEPENDENT (split 2026-09-07) ───────────────────
// ONE control used to cover both "charge a new card now" and "refuse a reactivation
// whose charge fails". The operator using the screen reported it as confusing, and it
// was: these are separate decisions. Cases 9 and 10
// pin the LEGACY key's two positions; these pin that the new key overrides it in both
// directions, which is the whole claim of the split.
{
  const bizRow = (
    await systemDb
      .select({ id: businesses.id, org: businesses.organizationId })
      .from(businesses)
      .where(eq(businesses.publicId, biz.id))
  )[0]!;
  const setCfg = (cfg: Record<string, unknown>) =>
    withTenant(bizRow.org, (tx) =>
      tx.update(businesses).set({ dunningConfig: cfg }).where(eq(businesses.id, bizRow.id)),
    );

  // A cancelled subscription whose only card now declines — the same fixture as 9/10.
  const armed = async (email: string) => {
    const cus = await tmb.customers.create(biz.id, { email });
    await tmb.paymentMethods.create(biz.id, cus.id, { token: "tok_4242" });
    const sub = await createSub(cus.id);
    await tmb.subscriptions.cancel(biz.id, sub.id);
    for (const pm of (await tmb.paymentMethods.list(biz.id, cus.id)).data)
      await tmb.paymentMethods.detach(biz.id, cus.id, pm.id);
    await tmb.paymentMethods.create(biz.id, cus.id, { token: "tok_4000000000000341" });
    return Object.assign(sub, { cus: cus.id });
  };
  const reactivate = async (subId: string) => {
    try {
      return { sub: await tmb.subscriptions.reactivate(biz.id, subId), err: null };
    } catch (e) {
      return { sub: null, err: e as TmbillingError };
    }
  };

  // (a) collection ON, reactivation gate OFF — impossible before the split.
  const subA = await armed("react-split-a@gating.test");
  await setCfg({
    collect_on_payment_method_update: true,
    require_successful_charge_on_reactivation: false,
  });
  const a = await reactivate(subA.id);
  ok(
    `split: collect ON + gate OFF reactivates anyway (${a.sub?.status ?? `REFUSED ${a.err?.status}`})`,
    a.sub?.status === "active",
  );

  // (b) collection OFF, reactivation gate ON — the other impossible combination.
  const subB = await armed("react-split-b@gating.test");
  await setCfg({
    collect_on_payment_method_update: false,
    require_successful_charge_on_reactivation: true,
  });
  const b = await reactivate(subB.id);
  ok(
    `split: collect OFF + gate ON still refuses (${b.sub?.status ?? `REFUSED ${b.err?.status}`})`,
    b.sub === null && b.err?.status === 402,
  );

  // (c) THE MIGRATION, and it is the assertion that matters most. An ABSENT new key
  // inherits the old one, so a business that turned collection off before the split —
  // and thereby turned this refusal off with it — must still reactivate. Reading the
  // new key as "default ON" would silently switch the refusal back on for exactly
  // those businesses, which is a behaviour change dressed as a default.
  const subC = await armed("react-split-c@gating.test");
  await setCfg({ collect_on_payment_method_update: false });
  const c = await reactivate(subC.id);
  ok(
    `split: an absent gate INHERITS collect=false (${c.sub?.status ?? `REFUSED ${c.err?.status}`})`,
    c.sub?.status === "active",
  );

  // …and inherits a true just as faithfully.
  const subD = await armed("react-split-d@gating.test");
  await setCfg({ collect_on_payment_method_update: true });
  const d = await reactivate(subD.id);
  ok(
    `split: an absent gate INHERITS collect=true (${d.sub?.status ?? `REFUSED ${d.err?.status}`})`,
    d.sub === null && d.err?.status === 402,
  );

  // ── 10c) `on_charge_failure` overrides the business rule for one call ──────────
  const reactivateWith = async (subId: string, choice: "refuse" | "dun") => {
    try {
      return {
        sub: await tmb.subscriptions.reactivate(biz.id, subId, { on_charge_failure: choice }),
        err: null,
      };
    } catch (e) {
      return { sub: null, err: e as TmbillingError };
    }
  };

  // (e) business refuses, the call says dun: active, invoice open and owned by dunning.
  const subE = await armed("react-override-e@gating.test");
  await setCfg({ require_successful_charge_on_reactivation: true });
  const e = await reactivateWith(subE.id, "dun");
  ok(
    `override: gate ON + dun reactivates (${e.sub?.status ?? `REFUSED ${e.err?.status}`})`,
    e.sub?.status === "active",
  );
  ok(
    `override: dun reports the decline as payment_error (${e.sub?.payment_error?.code ?? "none"})`,
    !!e.sub?.payment_error?.code,
  );
  const eInv = e.sub?.latest_invoice?.id
    ? (
        await systemDb
          .select({ s: invoices.status, n: invoices.nextAttemptAt })
          .from(invoices)
          .where(eq(invoices.publicId, e.sub.latest_invoice.id))
      )[0]
    : undefined;
  ok(
    `override: dun leaves the invoice open with a dunning retry (${eInv?.s ?? "none"}/${eInv?.n ? "sched" : "none"})`,
    !!eInv && eInv.s !== "void" && eInv.s !== "paid" && eInv.n != null,
  );

  // (f) business dunns, the call says refuse: 402, still cancelled.
  const subF = await armed("react-override-f@gating.test");
  await setCfg({ require_successful_charge_on_reactivation: false });
  const f = await reactivateWith(subF.id, "refuse");
  const fAfter = await tmb.subscriptions.get(biz.id, subF.id);
  ok(
    `override: gate OFF + refuse refuses (${f.sub?.status ?? `REFUSED ${f.err?.status}`}, now ${fAfter.status})`,
    f.sub === null && f.err?.status === 402 && fAfter.status === "cancelled",
  );

  // ── 10d) `collect_open_invoices` overrides collect_on_payment_method_update ────
  // A reactivation that dunned leaves one open invoice; a good card then decides it.
  const owing = async (email: string) => {
    await setCfg({ require_successful_charge_on_reactivation: false });
    const sub = await armed(email);
    const r = await reactivate(sub.id);
    return { cus: sub.cus, inv: r.sub?.latest_invoice?.id };
  };
  const invStatus = async (id?: string) =>
    id
      ? (
          await systemDb
            .select({ s: invoices.status })
            .from(invoices)
            .where(eq(invoices.publicId, id))
        )[0]?.s
      : undefined;
  const addCard = (cus: string, collect?: boolean) =>
    tmb.paymentMethods.create(biz.id, cus, {
      token: "tok_4242",
      ...(collect === undefined ? {} : { collect_open_invoices: collect }),
    });

  const g = await owing("pm-collect-g@gating.test");
  ok(
    `collect override: fixture owes (${await invStatus(g.inv)})`,
    (await invStatus(g.inv)) === "payment_due",
  );
  await setCfg({ collect_on_payment_method_update: true });
  const gPm = await addCard(g.cus, false);
  ok(
    `collect override: rule ON + false leaves it open (${await invStatus(g.inv)})`,
    (await invStatus(g.inv)) === "payment_due" && !gPm.collected_invoices,
  );
  await setCfg({ collect_on_payment_method_update: false });
  const hPm = await addCard(g.cus, true);
  ok(
    `collect override: rule OFF + true collects (${await invStatus(g.inv)})`,
    (await invStatus(g.inv)) === "paid" &&
      !!hPm.collected_invoices?.some((x) => x.invoice === g.inv),
  );

  // Omitted: the business rule, both ways.
  const i = await owing("pm-collect-i@gating.test");
  await setCfg({ collect_on_payment_method_update: false });
  await addCard(i.cus);
  ok(
    `collect override: rule OFF + omitted leaves it open (${await invStatus(i.inv)})`,
    (await invStatus(i.inv)) === "payment_due",
  );
  await setCfg({ collect_on_payment_method_update: true });
  await addCard(i.cus);
  ok(
    `collect override: rule ON + omitted collects (${await invStatus(i.inv)})`,
    (await invStatus(i.inv)) === "paid",
  );

  await setCfg({});
}

// ── 11) #63: a THROWN charge must not leave an invoice nobody owns ──────────────
// The refusal branch only sees a RETURNED failed payment. When the charge THROWS —
// a gateway error, not a decline — the subscription is already reactivated and the
// invoice already committed, and this used to end as `payment_due` with
// `dunning_status` NULL and `next_attempt_at` NULL: invisible to `runDunningPass`
// (scans next_attempt_at IS NOT NULL) and to `sweepExpiredParkedDunning` (scans
// dunning_status = 'parked'). Measured live 2026-09-04 on an active subscription
// owing ₹17,736.11 that no pass would ever have touched.
//
// The throw is forced by corrupting the vaulted instrument id so tmtest raises
// `payment_method_missing` instead of returning a decline. NOT voided and NOT
// re-cancelled on purpose: a throw means the gateway's outcome is unknown.
{
  const cus = await tmb.customers.create(biz.id, { email: "react-throw@gating.test" });
  await tmb.paymentMethods.create(biz.id, cus.id, { token: "tok_4242" });
  const sub = await createSub(cus.id);
  await tmb.subscriptions.cancel(biz.id, sub.id);
  const cusRow = (
    await systemDb
      .select({ id: customers.id })
      .from(customers)
      .where(eq(customers.publicId, cus.id))
  )[0]!;
  const bizRow = (
    await systemDb
      .select({ id: businesses.id, org: businesses.organizationId })
      .from(businesses)
      .where(eq(businesses.publicId, biz.id))
  )[0]!;
  // Disabling the gateway account makes the COLLECTION step throw
  // (`GatewayRouterError('gateway_disabled')`, collection.ts:201) rather than return a
  // decline — and it throws AFTER the invoice is committed, which is the shape #63 needs.
  // No magic test PAN can do this: every instrument behaviour RETURNS a result.
  await withTenant(bizRow.org, (tx) =>
    tx
      .update(gatewayAccounts)
      .set({ status: "disabled" })
      .where(eq(gatewayAccounts.businessId, bizRow.id)),
  );
  let threw: TmbillingError | null = null;
  try {
    await tmb.subscriptions.reactivate(biz.id, sub.id);
  } catch (e) {
    threw = e as TmbillingError;
  }
  ok(
    `#63: a gateway ERROR still surfaces to the caller (${threw?.status ?? "NO ERROR"})`,
    threw != null,
  );
  const invs = await systemDb
    .select({ s: invoices.status, d: invoices.dunningStatus, n: invoices.nextAttemptAt })
    .from(invoices)
    .where(eq(invoices.customerId, cusRow.id));
  // ⚠️ What this case turned out to prove is NOT what it was written for, and the
  // difference is worth recording. A disabled gateway does not reach the route as a
  // THROW: the collection path books it as a failed payment, so the refusal branch runs
  // and the invoice is voided. Good behaviour — and it means this lever cannot reach the
  // stranded state #63 was measured in. No available lever can: every magic instrument
  // behaviour RETURNS a result, and a disabled gateway is converted to one.
  //
  // So the assertion here is the CLASS invariant, which holds however the charge failed:
  // an invoice is never left `payment_due` with no dunning owner. That is exactly the
  // state measured live on 2026-09-04 (dunning_status NULL, next_attempt_at NULL, zero
  // payment rows), invisible to every pass. #63's route fix guarantees it for a throw;
  // this guarantees it for the paths a suite can actually drive.
  const stranded = invs.filter((i) => i.s === "payment_due" && (i.d == null || i.n == null));
  ok(
    `#63: no invoice is left payment_due without a dunning owner [${invs.map((i) => `${i.s}:${i.d ?? "NULL"}/${i.n ? "sched" : "none"}`).join(",")}]`,
    stranded.length === 0,
  );
}

let failed = 0;
for (const [name, pass] of checks) {
  console.log(`  ${pass ? "✓" : "✗"} ${name}`);
  if (!pass) failed++;
}
console.log(
  failed === 0 ? `\nPASS — ${checks.length} checks` : `\nFAIL — ${failed}/${checks.length} failed`,
);
await app.close();
await closeDb();
process.exit(failed === 0 ? 0 : 1);
