/**
 * verify:pending-change — `billing_rules_config.failed_change_charge: apply_when_paid`: a change
 * applies only once its invoice is paid.
 *
 *  §0  defaults: a new business gets `apply_when_paid`; unset is `start_dunning`; expiry 23 / 168.
 *  §1  paid at once: 200, applied, one invoice.
 *  §2  declined: 402 with pending_change; nothing applied, no credits, no MRR; a repeat with
 *      4242 pays the SAME invoice (same amount) and applies the change as of the request.
 *  §3  requires_action (on_session): 402 with the intent; completing it applies the change.
 *  §4  a slow method: in progress, 168 h expiry; the gateway settles it and the change applies.
 *  §5  expiry by hours, and by the term end: invoice and credit note voided, nothing applied.
 *  §6  a second change replaces the pending one.  §7 cancel while pending.  §8 a void by hand.
 *  §9  the subscription moved before payment: the change is not applied, the money is credit.
 *  §10 two concurrent changes: one pending change, one live invoice.
 *  §11 POST /items and update_for_items (swap + add, one invoice) are held too; operator cancel.
 *  §12 hosted checkout: a decline keeps the session open; a retry pays the same invoice.
 *  §13 the webhooks.  §14 `revert` and `next_renewal` unchanged.
 *
 * tmtest: 4000000000000002 fails at capture; 4000000000003155 needs 3-D Secure;
 * 4000000000000101 stays in progress until the suite settles it.
 *
 *   pnpm verify:all:fresh -- --suite pending-change
 */
import { buildApp } from "@/index";
import { closeDb, withTenant } from "@/platform/db";
import { and, eq, inArray } from "drizzle-orm";
import {
  businesses,
  checkoutSessions,
  creditNotes,
  events,
  invoices,
  payments,
  products,
  subscriptionItems,
  subscriptionPendingChanges,
  subscriptions,
} from "@db/schema";
import { createOrganization, createBusiness, createApiKey } from "@/modules/tenancy/service";
import { getCustomerByPublicId } from "@/modules/customers/service";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import {
  initialBillingRulesConfig,
  resolveBillingRulesConfig,
} from "@/modules/subscriptions/billing-rules-config";
import { runPendingChanges } from "@/modules/subscriptions/pending-change";
import { createPortalSession } from "@/modules/customer-portal/service";
import { clearPublicRateLimits } from "./lib/rate-limit-reset";
import { runWithClockScope } from "@/platform/clock";
import { runPlanCreditResets } from "@/modules/credits/credit-clock";
import { TmtestProvider } from "@/providers/tmtest";
import { setChargeStatus } from "@/providers/tmtest/store";
import { advanceTmtest } from "@/providers/tmtest/webhooks";

let pass = 0;
let fail = 0;
const ok = (label: string, cond: boolean, detail?: unknown) => {
  if (cond) pass++;
  else fail++;
  console.log(
    `${cond ? "✓" : "✗"} ${label}${!cond && detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`,
  );
};

const HARD = "4000000000000002";
const THREE_DS = "4000000000003155";
const SLOW = "4000000000000101";

const app = await buildApp({ logger: false });
await clearPublicRateLimits();
const org = await createOrganization({ name: "Pending Change Org" });
const orgId = org.organization.id;
const { secret } = await createApiKey(orgId, "test");
let n = 0;
const call = async (
  method: "GET" | "POST" | "PATCH" | "DELETE",
  url: string,
  payload?: unknown,
  token = secret,
) => {
  const res = await app.inject({
    method,
    url,
    headers: {
      authorization: `Bearer ${token}`,
      ...(payload !== undefined ? { "content-type": "application/json" } : {}),
      ...(method === "GET" ? {} : { "idempotency-key": `pc-${n++}-${Date.now()}` }),
    },
    ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}),
  });
  let body: any = {};
  try {
    body = res.json();
  } catch {
    body = {};
  }
  return { status: res.statusCode, body };
};
const must = (r: { status: number; body: any }, what: string) => {
  if (r.status >= 300) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
};

// ── §0 · defaults ────────────────────────────────────────────────────────────
{
  const fresh = initialBillingRulesConfig({ hasOperator: true }) as any;
  ok(
    "§0 a new business gets failed_change_charge: apply_when_paid",
    fresh?.failed_change_charge === "apply_when_paid",
    fresh?.failed_change_charge,
  );
  const unset = resolveBillingRulesConfig({ billingRulesConfig: null });
  ok(
    "§0 unset stays start_dunning, expiry 23 h / slow 168 h",
    unset.failedChangeCharge === "start_dunning" &&
      unset.pendingChangeExpiryHours === 23 &&
      unset.pendingChangeExpiryHoursSlow === 168,
    unset,
  );
  ok(
    "§0 a key-created business keeps the resolver defaults",
    initialBillingRulesConfig({}) === undefined,
  );
}

const biz = await createBusiness({
  organizationId: orgId,
  name: "Pending Change Biz",
  defaultCurrency: "USD",
  livemode: "test",
  timezone: "UTC",
});
const B = `/v1/businesses/${biz.publicId}`;
must(
  await call("POST", `${B}/credit_units`, {
    id: "credit",
    name: "credit",
    currency: "USD",
    minor_per_unit: null,
    decimals: 1,
  }),
  "credit unit",
);
for (const p of ["basic", "pro", "max"])
  must(await call("POST", `${B}/products`, { id: p, name: p, kind: "plan" }), `product ${p}`);
must(await call("POST", `${B}/products`, { id: "seats", name: "seats", kind: "addon" }), "addon");
const plan = (id: string, product: string, amount: number, grant: number, interval = "month") =>
  call("POST", `${B}/prices`, {
    id,
    product,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amount_minor: amount,
    interval,
    grants_credit: { kind: "per_cycle", unit: "credit", amount: grant },
  });
must(await plan("basic-monthly", "basic", 2900, 500), "basic");
must(await plan("pro-monthly", "pro", 9900, 5000), "pro");
must(await plan("max-monthly", "max", 19900, 9000), "max");
must(await plan("basic-weekly", "basic", 900, 100, "week"), "basic weekly");
must(await plan("pro-weekly", "pro", 2900, 1000, "week"), "pro weekly");
must(
  await call("POST", `${B}/prices`, {
    id: "seat-monthly",
    product: "seats",
    type: "recurring",
    model: "flat",
    currency: "USD",
    amount_minor: 1000,
    interval: "month",
  }),
  "seat price",
);

type Signup = { cus: string; sub: string; customer: any; pm: string };
async function signup(tag: string, price: string, token = "tok_4242"): Promise<Signup> {
  const cus = must(
    await call("POST", `${B}/customers`, {
      email: `${tag}@example.com`,
      address: {
        line1: "1 Main Street",
        city: "Austin",
        state_code: "TX",
        postal_code: "73301",
        country: "US",
        first_name: "Test",
        last_name: "Buyer",
      },
    }),
    "customer",
  );
  const customer = (await getCustomerByPublicId(orgId, biz.id, cus.id))!;
  const pm = await setCard(cus.id, customer, token);
  const sub = must(
    await call("POST", `${B}/customers/${cus.id}/subscriptions`, { items: [{ price }] }),
    `${price} subscription`,
  );
  return { cus: cus.id as string, sub: sub.id as string, customer, pm };
}
async function setCard(cus: string, customer: any, token: string) {
  const pm = await vaultPaymentMethod({
    organizationId: orgId,
    businessId: biz.id,
    customer,
    token,
  });
  must(
    await call("POST", `${B}/customers/${cus}/payment_methods/${pm.publicId}/default`, {}),
    "default",
  );
  return pm.publicId as string;
}
/** Leave only `token` on file, so collection cannot fall back to the good card. */
async function onlyCard(x: Signup, token: string) {
  await setCard(x.cus, x.customer, token);
  must(
    await call("POST", `${B}/customers/${x.cus}/payment_methods/${x.pm}/delete_local`, {}),
    "remove 4242",
  );
}
const rules = async (cfg: unknown) =>
  must(await call("PATCH", B, { billing_rules_config: cfg }), "billing rules");
const subOf = async (id: string) => must(await call("GET", `${B}/subscriptions/${id}`), "sub");
const invoicesOf = async (id: string) =>
  (must(await call("GET", `${B}/invoices?subscription=${id}`), "invoices").data ?? []) as any[];
const invoiceOf = async (id: string) => must(await call("GET", `${B}/invoices/${id}`), "invoice");
const grantsOf = async (cus: string) =>
  (must(await call("GET", `${B}/customers/${cus}/credit_grants`), "grants").data ?? []) as any[];
const onPlan = (sub: any, price: string) => (sub.items ?? []).some((i: any) => i.price === price);
const prices = (sub: any) => (sub.items ?? []).map((i: any) => i.price);
const itemOf = async (sub: string, price: string) =>
  (await subOf(sub)).items.find((i: any) => i.price === price).id as string;
const toPro = async (sub: string, from = "basic-monthly", to = "pro-monthly") => ({
  changes: [{ item: await itemOf(sub, from), price: to }],
  invoice_immediately: true,
});
const creditClock = async () => {
  const now = new Date();
  await runWithClockScope({ onlyBusinessId: biz.id, now }, () => runPlanCreditResets(now));
};
const proGrants = async (cus: string) => {
  await creditClock();
  return (await grantsOf(cus)).filter((g) => g.amount === 5000).map((g) => g.status);
};
const pendingRows = async (subPublic: string) =>
  withTenant(orgId, async (tx) => {
    const [s] = await tx
      .select({ id: subscriptions.id })
      .from(subscriptions)
      .where(eq(subscriptions.publicId, subPublic));
    return tx
      .select()
      .from(subscriptionPendingChanges)
      .where(eq(subscriptionPendingChanges.subscriptionId, s!.id));
  });
const eventsFor = async (subPublic: string, type: string) =>
  (
    await withTenant(orgId, (tx) =>
      tx
        .select()
        .from(events)
        .where(and(eq(events.businessId, biz.id), eq(events.type, type))),
    )
  ).filter((e: any) => e.data?.subscription?.id === subPublic);
const balanceOf = async (cus: string) => {
  const c = must(await call("GET", `${B}/customers/${cus}`), "customer");
  return (c.balances ?? []).find((x: any) => x.currency_code === "USD") ?? null;
};
const notesOf = async (cus: string) =>
  (must(await call("GET", `${B}/credit_notes?customer=${cus}`), "notes").data ?? []) as any[];

/** What the invoice's succeeded payments took, against what it asked for after credits. */
const charged = async (invId: string) => {
  const inv = await invoiceOf(invId);
  const rows = await withTenant(orgId, (tx) =>
    tx
      .select({ amount: payments.amountMinor })
      .from(payments)
      .innerJoin(invoices, eq(invoices.id, payments.invoiceId))
      .where(and(eq(invoices.publicId, invId), eq(payments.status, "succeeded"))),
  );
  return {
    charged: rows.reduce((t, r) => t + Number(r.amount), 0),
    payments: rows.length,
    total: inv.total_minor as number,
    credits: inv.credits_applied_minor as number,
  };
};
/** One charge, for the amount due after the unused-time credit: never the gross. */
const chargedOnce = async (tag: string, invId: string, due?: number) => {
  const c = await charged(invId);
  ok(
    `${tag}: charged once, the amount due (${c.charged}), not the total (${c.total})`,
    c.payments === 1 &&
      c.credits > 0 &&
      c.charged === c.total - c.credits &&
      c.charged < c.total &&
      (due === undefined || c.charged === due),
    { ...c, due },
  );
};

/** 402 with pending_change; the subscription untouched. */
const held = (tag: string, r: { status: number; body: any }, code = "payment_failed") => {
  ok(
    `${tag}: 402 ${code} with pending_change { invoice, expires_at }`,
    r.status === 402 &&
      r.body?.error?.code === code &&
      typeof r.body?.pending_change?.invoice === "string" &&
      typeof r.body?.pending_change?.expires_at === "string",
    [r.status, r.body],
  );
};
const untouched = async (tag: string, x: Signup, oldPrice: string, mrr: number) => {
  const s = await subOf(x.sub);
  ok(
    `${tag}: still on ${oldPrice}, nothing applied`,
    onPlan(s, oldPrice) && prices(s).length === 1,
    prices(s),
  );
  ok(`${tag}: MRR unchanged`, s.mrr === mrr, [s.mrr, mrr]);
  ok(
    `${tag}: no Pro credit, held or live`,
    (await proGrants(x.cus)).length === 0,
    await proGrants(x.cus),
  );
  return s;
};

await rules({ failed_change_charge: "apply_when_paid" });

// ── §1 · paid at once ────────────────────────────────────────────────────────
{
  const a = await signup("paid", "basic-monthly");
  const r = await call("POST", `${B}/subscriptions/${a.sub}/change`, await toPro(a.sub));
  ok("§1 paid at once: 200", r.status === 200, [r.status, r.body]);
  const s = await subOf(a.sub);
  ok("§1 on Pro", onPlan(s, "pro-monthly") && !onPlan(s, "basic-monthly"), prices(s));
  const inv = r.body?.proration_invoice;
  ok("§1 its invoice is paid", inv?.status === "paid", inv);
  await chargedOnce("§1 paid at once", inv?.id);
  const change = (await invoicesOf(a.sub)).filter((i) => i.total_minor !== 2900);
  ok(
    "§1 one change invoice",
    change.length === 1,
    change.map((i) => [i.id, i.status]),
  );
  const rows = await pendingRows(a.sub);
  ok(
    "§1 the pending change is applied",
    rows.length === 1 && rows[0]!.status === "applied",
    rows.map((x) => x.status),
  );
  ok("§1 no pending_change on the subscription", s.pending_change === null, s.pending_change);
  ok(
    "§1 Pro's credit is live",
    (await proGrants(a.cus)).join() === "active",
    await proGrants(a.cus),
  );
}

// ── §2 · declined, then a repeat with 4242 ───────────────────────────────────
let declinedTotal = 0;
{
  const a = await signup("declined", "basic-monthly");
  const mrr0 = (await subOf(a.sub)).mrr;
  await onlyCard(a, HARD);
  const body = await toPro(a.sub);
  const r = await call("POST", `${B}/subscriptions/${a.sub}/change`, body);
  held("§2 declined", r);
  ok(
    "§2 the decline code is named",
    typeof r.body?.error?.decline_code === "string",
    r.body?.error,
  );
  const invId = r.body?.pending_change?.invoice as string;
  const s = await untouched("§2 declined", a, "basic-monthly", mrr0);
  ok(
    "§2 the subscription exposes pending_change",
    s.pending_change?.invoice === invId && s.pending_change?.status === "pending",
    s.pending_change,
  );
  ok(
    "§2 pending_change names the products, and its invoice is not a due",
    s.pending_change?.items?.[0]?.product_name === "pro" &&
      s.pending_change?.items?.[0]?.from_product_name === "basic" &&
      s.due_invoices_count === 0,
    [s.pending_change?.items, s.due_invoices_count],
  );
  const inv = await invoiceOf(invId);
  declinedTotal = inv.total_minor;
  ok(
    "§2 the invoice is open and dunning will not retry it",
    inv.status === "payment_due" && inv.dunning_status === "stopped" && !inv.next_retry_at,
    [inv.status, inv.dunning_status, inv.next_retry_at],
  );
  const rows = await pendingRows(a.sub);
  const [row] = rows;
  ok(
    "§2 expiry is the request + 23 h",
    !!row && Math.abs(row.expiresAt.getTime() - row.requestedAt.getTime() - 23 * 3_600_000) < 1000,
    row && [row.requestedAt, row.expiresAt],
  );
  const notes = await notesOf(a.cus);
  ok(
    "§2 the unused-Basic credit note sits on the held invoice",
    notes.length === 1 && notes[0].status !== "voided",
    notes.map((x) => x.status),
  );

  await setCard(a.cus, a.customer, "tok_4242");
  const again = await call("POST", `${B}/subscriptions/${a.sub}/change`, body);
  ok("§2 a repeat with 4242: 200", again.status === 200, [again.status, again.body]);
  ok(
    "§2 …it paid the SAME invoice",
    again.body?.proration_invoice?.id === invId,
    again.body?.proration_invoice,
  );
  const paid = await invoiceOf(invId);
  ok("§2 …for the same amount", paid.status === "paid" && paid.total_minor === declinedTotal, [
    paid.status,
    paid.total_minor,
    declinedTotal,
  ]);
  const change = (await invoicesOf(a.sub)).filter((i) => i.total_minor !== 2900);
  ok(
    "§2 one change invoice, no second charge",
    change.length === 1,
    change.map((i) => i.id),
  );
  const okPays = await withTenant(orgId, (tx) =>
    tx
      .select({ id: payments.id })
      .from(payments)
      .innerJoin(invoices, eq(invoices.id, payments.invoiceId))
      .where(and(eq(invoices.publicId, invId), eq(payments.status, "succeeded"))),
  );
  ok("§2 one succeeded payment", okPays.length === 1, okPays.length);
  await chargedOnce("§2 retry by API", invId, s.pending_change?.amount_due_minor);
  const s2 = await subOf(a.sub);
  ok("§2 on Pro now, no pending_change", onPlan(s2, "pro-monthly") && s2.pending_change === null, [
    prices(s2),
    s2.pending_change,
  ]);
  ok(
    "§2 Pro's credit is live",
    (await proGrants(a.cus)).join() === "active",
    await proGrants(a.cus),
  );
  // Proration as of the request: the swap's MRR movement is dated at the request instant.
  const [applied] = await pendingRows(a.sub);
  ok(
    "§2 applied, as requested at",
    applied?.status === "applied" && !!applied.appliedAt,
    applied?.status,
  );
  ok(
    "§2 a subscription_pending_change_applied event",
    (await eventsFor(a.sub, "subscription_pending_change_applied")).length === 1,
  );
}

// ── §3 · requires_action ─────────────────────────────────────────────────────
{
  const a = await signup("threeds", "basic-monthly");
  await onlyCard(a, THREE_DS);
  const r = await call("POST", `${B}/subscriptions/${a.sub}/change`, {
    ...(await toPro(a.sub)),
    on_session: true,
  });
  held("§3 3-D Secure on session", r, "requires_action");
  ok(
    "§3 …with the payment intent and next_action",
    /^pi_/.test(String(r.body?.payment_intent?.id)) && !!r.body?.next_action,
    r.body?.payment_intent,
  );
  ok("§3 nothing applied", onPlan(await subOf(a.sub), "basic-monthly"));
  const invId = r.body?.pending_change?.invoice;
  const done = await call("POST", `${B}/invoices/${invId}/collect`, {
    payment_intent: r.body?.payment_intent?.id,
    on_session: true,
    client_result: { nonce: "tmtest_ok" },
  });
  ok(
    "§3 the authenticated intent pays the invoice",
    done.status === 200 && done.body?.status === "paid",
    [done.status, done.body?.status],
  );
  const s = await subOf(a.sub);
  ok("§3 the change applies", onPlan(s, "pro-monthly") && s.pending_change === null, [
    prices(s),
    s.pending_change,
  ]);
}

{
  // Off session the bank asks the payer: in progress, waiting for them.
  const a = await signup("threeds-off", "basic-monthly");
  await onlyCard(a, THREE_DS);
  const r = await call("POST", `${B}/subscriptions/${a.sub}/change`, await toPro(a.sub));
  held("§3 3-D Secure off session", r, "requires_action");
  ok(
    "§3 …no intent; the payment waits for the payer",
    !r.body?.payment_intent && r.body?.pending_change?.payment_in_progress === true,
    r.body,
  );
}

// ── §4 · a slow method ───────────────────────────────────────────────────────
{
  const a = await signup("slow", "basic-monthly");
  await onlyCard(a, SLOW);
  const r = await call("POST", `${B}/subscriptions/${a.sub}/change`, await toPro(a.sub));
  held("§4 slow method", r);
  ok(
    "§4 the payment is in progress",
    r.body?.pending_change?.payment_in_progress === true,
    r.body?.pending_change,
  );
  const [row] = await pendingRows(a.sub);
  ok(
    "§4 expiry is the request + 168 h",
    !!row && Math.abs(row.expiresAt.getTime() - row.requestedAt.getTime() - 168 * 3_600_000) < 1000,
    row && [row.requestedAt, row.expiresAt],
  );
  const busy = await call("DELETE", `${B}/subscriptions/${a.sub}/pending_change`);
  ok("§4 cancelling it while the payment is in progress: 409", busy.status === 409, [
    busy.status,
    busy.body,
  ]);
  const [pay] = await withTenant(orgId, (tx) =>
    tx
      .select()
      .from(payments)
      .where(and(eq(payments.invoiceId, row!.invoiceId), eq(payments.status, "pending"))),
  );
  await setChargeStatus(pay!.providerChargeId!, "succeeded");
  await new TmtestProvider(biz.id).triggerSyntheticEvent("charge.succeeded", {
    charge_id: pay!.providerChargeId!,
  });
  await advanceTmtest(orgId, new Date());
  const s = await subOf(a.sub);
  ok(
    "§4 the settled payment applies the change",
    onPlan(s, "pro-monthly") && s.pending_change === null,
    [prices(s), s.pending_change],
  );
}

/** A declined change left pending, for the cases below. */
async function declined(tag: string, price = "basic-monthly", to = "pro-monthly") {
  const a = await signup(tag, price);
  const mrr = (await subOf(a.sub)).mrr as number;
  await onlyCard(a, HARD);
  const r = await call("POST", `${B}/subscriptions/${a.sub}/change`, await toPro(a.sub, price, to));
  held(`${tag}`, r);
  return { a, mrr, inv: r.body?.pending_change?.invoice as string };
}
/** Ended: invoice and credit notes voided, no credit left, nothing applied, the event's reason. */
async function ended(
  tag: string,
  x: { a: Signup; mrr: number; inv: string },
  reason: string,
  oldPrice = "basic-monthly",
) {
  const inv = await invoiceOf(x.inv);
  ok(`${tag}: the invoice is voided`, inv.status === "voided", inv.status);
  const notes = await notesOf(x.a.cus);
  ok(
    `${tag}: the credit notes are voided`,
    notes.every((c) => c.status === "voided"),
    notes.map((c) => c.status),
  );
  const bal = await balanceOf(x.a.cus);
  ok(
    `${tag}: no credit left on the customer`,
    !bal || (bal.refundable_credits === 0 && bal.promotional_credits === 0),
    bal,
  );
  const s = await subOf(x.a.sub);
  ok(
    `${tag}: nothing applied`,
    onPlan(s, oldPrice) && !onPlan(s, "pro-monthly") && s.pending_change === null,
    [prices(s), s.pending_change],
  );
  const ev = await eventsFor(x.a.sub, "subscription_pending_change_expired");
  ok(
    `${tag}: subscription_pending_change_expired, reason ${reason}`,
    ev.some((e: any) => e.data?.pending_change?.reason === reason),
    ev.map((e: any) => e.data?.pending_change),
  );
}

// ── §5 · expiry ──────────────────────────────────────────────────────────────
{
  const x = await declined("expiry-hours");
  const [row] = await pendingRows(x.a.sub);
  const early = new Date(row!.expiresAt.getTime() - 60_000);
  await runWithClockScope({ onlyBusinessId: biz.id, now: early }, () => runPendingChanges(early));
  ok("§5 before expiry the change waits", (await pendingRows(x.a.sub))[0]?.status === "pending");
  const late = new Date(row!.expiresAt.getTime() + 1000);
  await runWithClockScope({ onlyBusinessId: biz.id, now: late }, () => runPendingChanges(late));
  await ended("§5 expiry by hours", x, "expired");
  const voided = await withTenant(orgId, (tx) =>
    tx.select({ status: invoices.status }).from(invoices).where(eq(invoices.publicId, x.inv)),
  );
  ok("§5 a payment can no longer reach the invoice", voided[0]?.status === "voided");
}
{
  await rules({ pending_change_expiry_hours: 720 });
  const x = await declined("expiry-term", "basic-weekly", "pro-weekly");
  const [row] = await pendingRows(x.a.sub);
  const s = await subOf(x.a.sub);
  const [sub] = await withTenant(orgId, (tx) =>
    tx.select().from(subscriptions).where(eq(subscriptions.publicId, x.a.sub)),
  );
  ok(
    "§5 expiry never passes the term end",
    !!row && row.expiresAt.getTime() === sub!.currentPeriodEnd!.getTime(),
    [row?.expiresAt, sub?.currentPeriodEnd, s.current_period_end],
  );
  const late = new Date(row!.expiresAt.getTime() + 1000);
  await runWithClockScope({ onlyBusinessId: biz.id, now: late }, () => runPendingChanges(late));
  await ended("§5 expiry by the term end", x, "expired", "basic-weekly");
  await rules({ pending_change_expiry_hours: 23 });
}

// ── §6 · replaced by a second change ─────────────────────────────────────────
{
  const x = await declined("replaced");
  const r = await call(
    "POST",
    `${B}/subscriptions/${x.a.sub}/change`,
    await toPro(x.a.sub, "basic-monthly", "max-monthly"),
  );
  held("§6 a second change (to Max)", r);
  const first = await invoiceOf(x.inv);
  ok("§6 the first change's invoice is voided", first.status === "voided", first.status);
  const rows = await pendingRows(x.a.sub);
  ok(
    "§6 one pending change, the second",
    rows.filter((p) => p.status === "pending").length === 1 &&
      rows.find((p) => p.status === "cancelled")?.endReason === "replaced",
    rows.map((p) => [p.status, p.endReason]),
  );
  ok("§6 the second invoice is not the first", r.body?.pending_change?.invoice !== x.inv);
}

// ── §7 · cancel while pending ────────────────────────────────────────────────
{
  const x = await declined("cancelled");
  const r = await call("POST", `${B}/subscriptions/${x.a.sub}/cancel`, {
    cancel_option: "immediately",
  });
  ok("§7 cancel: 200", r.status === 200, [r.status, r.body]);
  const inv = await invoiceOf(x.inv);
  ok("§7 the held invoice is voided", inv.status === "voided", inv.status);
  const ev = await eventsFor(x.a.sub, "subscription_pending_change_expired");
  ok(
    "§7 reason cancelled",
    ev.some((e: any) => e.data?.pending_change?.reason === "cancelled"),
  );
  const s = await subOf(x.a.sub);
  ok("§7 cancelled on Basic", s.status === "cancelled" && onPlan(s, "basic-monthly"), [
    s.status,
    prices(s),
  ]);
}

// ── §8 · a void by hand ──────────────────────────────────────────────────────
{
  const x = await declined("voided");
  const r = await call("POST", `${B}/invoices/${x.inv}/void`, {});
  ok("§8 void: 200", r.status === 200, [r.status, r.body]);
  await ended("§8 a void by hand", x, "voided");
}

// ── §9 · the subscription moved before payment ───────────────────────────────
{
  const x = await declined("moved");
  // A write that does not pass through the pending-change hooks.
  await withTenant(orgId, async (tx) => {
    const [s] = await tx.select().from(subscriptions).where(eq(subscriptions.publicId, x.a.sub));
    await tx
      .update(subscriptionItems)
      .set({ quantity: 3 })
      .where(eq(subscriptionItems.subscriptionId, s!.id));
  });
  await setCard(x.a.cus, x.a.customer, "tok_4242");
  const r = await call("POST", `${B}/invoices/${x.inv}/collect`, {});
  ok("§9 the operator collects the held invoice", r.status === 200 && r.body?.status === "paid", [
    r.status,
    r.body?.status,
  ]);
  const s = await subOf(x.a.sub);
  ok(
    "§9 the change is not applied",
    onPlan(s, "basic-monthly") && !onPlan(s, "pro-monthly"),
    prices(s),
  );
  const [row] = await pendingRows(x.a.sub);
  ok(
    "§9 the pending change expired: moved",
    row?.status === "expired" && row.endReason === "moved",
    [row?.status, row?.endReason],
  );
  const paid = await withTenant(orgId, (tx) =>
    tx
      .select({ amount: payments.amountMinor })
      .from(payments)
      .innerJoin(invoices, eq(invoices.id, payments.invoiceId))
      .where(and(eq(invoices.publicId, x.inv), eq(payments.status, "succeeded"))),
  );
  const cash = paid.reduce((t, p) => t + Number(p.amount), 0);
  const kept = await withTenant(orgId, (tx) =>
    tx.select().from(creditNotes).where(eq(creditNotes.reasonCode, "pending_change_not_applied")),
  );
  const note = kept.find((c) => c.publicId === row?.keptCreditNote);
  ok(
    "§9 the cash paid comes back as one credit note",
    !!note && Number(note.totalMinor) === cash && cash > 0,
    [cash, note?.totalMinor],
  );
  const bal = await balanceOf(x.a.cus);
  ok("§9 …kept as the customer's credit", bal?.refundable_credits === cash, [bal, cash]);
  ok(
    "§9 an expired event, reason moved",
    (await eventsFor(x.a.sub, "subscription_pending_change_expired")).some(
      (e: any) => e.data?.pending_change?.reason === "moved",
    ),
  );
}

// ── §10 · two concurrent changes ─────────────────────────────────────────────
{
  const a = await signup("concurrent", "basic-monthly");
  await onlyCard(a, HARD);
  const item = await itemOf(a.sub, "basic-monthly");
  const [r1, r2] = await Promise.all([
    call("POST", `${B}/subscriptions/${a.sub}/change`, {
      changes: [{ item, price: "pro-monthly" }],
      invoice_immediately: true,
    }),
    call("POST", `${B}/subscriptions/${a.sub}/change`, {
      changes: [{ item, price: "max-monthly" }],
      invoice_immediately: true,
    }),
  ]);
  ok(
    "§10 each answers 402 or 409",
    [r1, r2].every((r) => r.status === 402 || r.status === 409),
    [r1.status, r2.status, r1.body?.error, r2.body?.error],
  );
  const rows = await pendingRows(a.sub);
  ok(
    "§10 at most one pending change",
    rows.filter((p) => p.status === "pending").length <= 1,
    rows.map((p) => p.status),
  );
  const live = (await invoicesOf(a.sub)).filter(
    (i) => i.total_minor !== 2900 && i.status !== "voided",
  );
  ok(
    "§10 at most one live change invoice",
    live.length <= 1,
    live.map((i) => [i.id, i.status]),
  );
  ok("§10 nothing applied", onPlan(await subOf(a.sub), "basic-monthly"));
}

// ── §11 · POST /items, update_for_items, operator cancel ─────────────────────
{
  const a = await signup("item-add", "basic-monthly");
  await onlyCard(a, HARD);
  const body = { price: "seat-monthly", invoice_immediately: true };
  const r = await call("POST", `${B}/subscriptions/${a.sub}/items`, body);
  held("§11 POST /items declined", r);
  ok("§11 no seat yet", !onPlan(await subOf(a.sub), "seat-monthly"));
  await setCard(a.cus, a.customer, "tok_4242");
  const again = await call("POST", `${B}/subscriptions/${a.sub}/items`, body);
  ok(
    "§11 a repeat pays it: 201 with the seat",
    again.status === 201 && again.body?.price === "seat-monthly",
    [again.status, again.body],
  );
  ok(
    "§11 …the same invoice",
    again.body?.proration_invoice?.id === r.body?.pending_change?.invoice,
    again.body?.proration_invoice,
  );
  const seats = (await subOf(a.sub)).items.filter((i: any) => i.price === "seat-monthly");
  ok("§11 one seat", seats.length === 1, seats.length);
}
{
  const a = await signup("ufi", "basic-monthly");
  await onlyCard(a, HARD);
  const body = {
    items: [{ price: "pro-monthly" }, { price: "seat-monthly" }],
    replace_items_list: true,
    invoice_immediately: true,
  };
  const r = await call("POST", `${B}/subscriptions/${a.sub}/update_for_items`, body);
  held("§11 update_for_items swap + add declined", r);
  ok("§11 nothing applied", (await subOf(a.sub)).items.length === 1);
  const before = (await invoicesOf(a.sub)).filter((i) => i.status !== "voided").length;
  await setCard(a.cus, a.customer, "tok_4242");
  const again = await call("POST", `${B}/subscriptions/${a.sub}/update_for_items`, body);
  ok(
    "§11 a repeat applies the swap and the add",
    again.status === 200 &&
      onPlan(await subOf(a.sub), "pro-monthly") &&
      onPlan(await subOf(a.sub), "seat-monthly"),
    [again.status, again.body?.error],
  );
  const after = (await invoicesOf(a.sub)).filter((i) => i.status !== "voided").length;
  ok("§11 one invoice for both", after === before, [before, after]);
}
{
  const x = await declined("operator-cancel");
  const r = await call("DELETE", `${B}/subscriptions/${x.a.sub}/pending_change`);
  ok("§11 operator cancel: 200", r.status === 200 && r.body?.cancelled === true, [
    r.status,
    r.body,
  ]);
  await ended("§11 operator cancel", x, "cancelled");
  const none = await call("DELETE", `${B}/subscriptions/${x.a.sub}/pending_change`);
  ok("§11 nothing left to cancel: 404", none.status === 404, none.status);
}

// ── §12 · hosted checkout ────────────────────────────────────────────────────
{
  const a = await signup("hosted", "basic-monthly");
  await onlyCard(a, HARD);
  const session = must(
    await call("POST", `${B}/checkout_sessions`, {
      mode: "change",
      subscription: a.sub,
      items: [{ price: "pro-monthly" }],
      replace_items_list: true,
    }),
    "change session",
  );
  const view = async () =>
    (await call("GET", "/checkout/v1/session", undefined, session.token)).body?.change?.preview;
  const before = await view();
  const done = await call("POST", "/checkout/v1/complete", {}, session.token);
  ok(
    "§12 hosted: the decline shows on the page",
    done.status === 400 && /We could not change your plan/.test(done.body?.error?.message ?? ""),
    [done.status, done.body],
  );
  const [sess] = await withTenant(orgId, (tx) =>
    tx
      .select({ status: checkoutSessions.status })
      .from(checkoutSessions)
      .where(eq(checkoutSessions.publicId, session.id)),
  );
  ok("§12 hosted: the session stays open", !!sess && sess.status !== "completed", sess);
  const rows = await pendingRows(a.sub);
  ok(
    "§12 hosted: one pending change from checkout",
    rows.length === 1 && rows[0]!.source === "checkout",
    rows.map((p) => [p.status, p.source]),
  );
  const heldInv = await withTenant(orgId, (tx) =>
    tx.select({ id: invoices.publicId }).from(invoices).where(eq(invoices.id, rows[0]!.invoiceId)),
  );
  const heldId = heldInv[0]!.id;
  const heldDue = (await subOf(a.sub)).pending_change?.amount_due_minor;
  ok(
    "§12 hosted: the first quote equals the held invoice's amount due",
    typeof before?.amountDueMinor === "number" && before.amountDueMinor === heldDue,
    [before?.amountDueMinor, heldDue],
  );
  const reload = await view();
  ok(
    "§12 hosted: after the decline the page shows the held invoice, credit included",
    reload?.heldInvoice === heldId &&
      reload?.amountDueMinor === heldDue &&
      reload?.totalMinor === heldDue &&
      (reload?.creditAppliedToThisInvoiceMinor ?? 0) > 0 &&
      reload?.invoiceTotalMinor - reload?.creditAppliedToThisInvoiceMinor === heldDue,
    reload && {
      held: reload.heldInvoice,
      due: reload.amountDueMinor,
      total: reload.invoiceTotalMinor,
      credit: reload.creditAppliedToThisInvoiceMinor,
      heldDue,
    },
  );
  // A NEW session for the same change shows the held invoice and when it expires; one for
  // another change does not (its confirm replaces the hold).
  const sessionView = async (price: string) => {
    const s2 = must(
      await call("POST", `${B}/checkout_sessions`, {
        mode: "change",
        subscription: a.sub,
        items: [{ price }],
        replace_items_list: true,
      }),
      `change session ${price}`,
    );
    return (await call("GET", "/checkout/v1/session", undefined, s2.token)).body?.change?.preview;
  };
  const heldExpiry = (await subOf(a.sub)).pending_change?.expires_at;
  const again = await sessionView("pro-monthly");
  ok(
    "§12 hosted: a new session for the same change shows the held invoice and its expiry",
    again?.heldInvoice === heldId &&
      again?.amountDueMinor === heldDue &&
      typeof heldExpiry === "string" &&
      again?.heldExpiresAt === new Date(heldExpiry).toISOString(),
    again && { held: again.heldInvoice, due: again.amountDueMinor, at: again.heldExpiresAt },
  );
  const other = await sessionView("max-monthly");
  ok(
    "§12 hosted: a session for another change shows no held invoice",
    !!other && other.heldInvoice === undefined && other.heldExpiresAt === undefined,
    other && { held: other.heldInvoice, at: other.heldExpiresAt },
  );
  await setCard(a.cus, a.customer, "tok_4242");
  const retry = await call("POST", "/checkout/v1/complete", {}, session.token);
  const s = await subOf(a.sub);
  ok("§12 hosted: a retry completes on Pro", retry.status < 300 && onPlan(s, "pro-monthly"), [
    retry.status,
    retry.body?.error ?? null,
    prices(s),
  ]);
  const after = await pendingRows(a.sub);
  ok(
    "§12 hosted: the same invoice paid it",
    after.length === 1 && after[0]!.status === "applied",
    after.map((p) => p.status),
  );
  await chargedOnce("§12 retry through hosted checkout", heldId, heldDue);
}

// ── §12b · customer portal ───────────────────────────────────────────────────
{
  await withTenant(orgId, (tx) =>
    tx
      .update(businesses)
      .set({ storefrontConfig: { allow_plan_changes: true } })
      .where(eq(businesses.id, biz.id)),
  );
  await withTenant(orgId, (tx) =>
    tx.update(products).set({ enabledInPortal: true }).where(eq(products.businessId, biz.id)),
  );
  // The portal follows the business: change charges are invoiced now.
  must(await call("PATCH", B, { default_invoice_immediately: true }), "invoice immediately");
  const a = await signup("portal", "basic-monthly");
  await onlyCard(a, HARD);
  const session = await createPortalSession({
    organizationId: orgId,
    businessId: biz.id,
    customerId: a.customer.id,
  });
  const ex = await app.inject({
    method: "POST",
    url: "/portal/v1/session",
    headers: { authorization: `Bearer ${session.accessToken}` },
  });
  const token = (ex.json() as { token: string }).token;
  const portal = async (url: string, payload: object) => {
    const res = await app.inject({
      method: "POST",
      url,
      headers: { authorization: `Bearer ${token}`, "idempotency-key": crypto.randomUUID() },
      payload,
    });
    let body: any = {};
    try {
      body = res.json();
    } catch {
      body = {};
    }
    return { status: res.statusCode, body };
  };
  const quote = await portal(`/portal/v1/subscriptions/${a.sub}/change/preview`, {
    plan: "pro-monthly",
  });
  ok("§12b portal: preview", quote.status === 200, [quote.status, quote.body]);
  const req = {
    plan: "pro-monthly",
    expected_total_minor: quote.body?.total_minor,
    priced_at: quote.body?.priced_at,
    quote: quote.body?.quote,
  };
  const first = await portal(`/portal/v1/subscriptions/${a.sub}/change`, req);
  ok(
    "§12b portal: the decline shows on the page",
    first.status === 400 && /We could not change your plan/.test(first.body?.error?.message ?? ""),
    [first.status, first.body],
  );
  ok("§12b portal: nothing applied", onPlan(await subOf(a.sub), "basic-monthly"));
  const [held] = await pendingRows(a.sub);
  ok(
    "§12b portal: one pending change from the portal",
    held?.status === "pending" && held.source === "portal",
    held && [held.status, held.source],
  );
  const heldDue = (await subOf(a.sub)).pending_change?.amount_due_minor;
  const heldId = (await subOf(a.sub)).pending_change?.invoice;
  ok(
    "§12b portal: the first quote equals the held invoice's amount due",
    quote.body?.total_minor === heldDue,
    [quote.body?.total_minor, heldDue],
  );
  const again1 = await portal(`/portal/v1/subscriptions/${a.sub}/change/preview`, {
    plan: "pro-monthly",
  });
  ok(
    "§12b portal: after the decline the preview shows the held invoice",
    again1.body?.due_today?.held_invoice === heldId &&
      again1.body?.total_minor === heldDue &&
      again1.body?.due_today?.credit_minor > 0,
    again1.body?.due_today,
  );
  await setCard(a.cus, a.customer, "tok_4242");
  const again = await portal(`/portal/v1/subscriptions/${a.sub}/change`, req);
  ok(
    "§12b portal: a retry with another card applies the change",
    again.status === 200 && onPlan(await subOf(a.sub), "pro-monthly"),
    [again.status, again.body],
  );
  const [after] = await pendingRows(a.sub);
  ok(
    "§12b portal: the same invoice paid it",
    after?.status === "applied" && after.invoiceId === held?.invoiceId,
    after?.status,
  );
  await chargedOnce("§12b retry through the portal", heldId, heldDue);
}

// ── §13 · webhooks ───────────────────────────────────────────────────────────
{
  const all = await withTenant(orgId, (tx) =>
    tx
      .select({ type: events.type })
      .from(events)
      .where(
        and(
          eq(events.businessId, biz.id),
          inArray(events.type, [
            "subscription_pending_change_created",
            "subscription_pending_change_applied",
            "subscription_pending_change_expired",
          ]),
        ),
      ),
  );
  const count = (t: string) => all.filter((e) => e.type === t).length;
  ok(
    "§13 created, applied and expired events are emitted",
    count("subscription_pending_change_created") > 0 &&
      count("subscription_pending_change_applied") > 0 &&
      count("subscription_pending_change_expired") > 0,
    {
      created: count("subscription_pending_change_created"),
      applied: count("subscription_pending_change_applied"),
      expired: count("subscription_pending_change_expired"),
    },
  );
}

// ── §14 · other values unchanged ─────────────────────────────────────────────
await rules({ failed_change_charge: "revert" });
{
  const a = await signup("revert", "basic-monthly");
  await onlyCard(a, HARD);
  const r = await call("POST", `${B}/subscriptions/${a.sub}/change`, await toPro(a.sub));
  ok(
    "§14 revert: 402 without pending_change",
    r.status === 402 && r.body?.error?.code === "payment_failed" && !r.body?.pending_change,
    [r.status, r.body],
  );
  ok("§14 revert: no pending change", (await pendingRows(a.sub)).length === 0);
}
await rules({ failed_change_charge: "next_renewal" });
{
  const a = await signup("next-renewal", "basic-monthly");
  await onlyCard(a, HARD);
  const r = await call("POST", `${B}/subscriptions/${a.sub}/change`, await toPro(a.sub));
  ok(
    "§14 next_renewal: 200, the change stays",
    r.status === 200 && onPlan(await subOf(a.sub), "pro-monthly"),
    [r.status, r.body],
  );
  ok("§14 next_renewal: no pending change", (await pendingRows(a.sub)).length === 0);
}

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
await app.close();
await closeDb();
process.exit(fail === 0 ? 0 : 1);
