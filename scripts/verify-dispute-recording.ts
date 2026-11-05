/**
 * Hand-recorded disputes (0394), over real HTTP: a gateway with no dispute feed
 * (`disputeFeed: false`, tmtest stands in) lets a person record a chargeback and its outcome.
 *
 *  - § L the books match the gateway path line for line (record, won, lost)
 *  - § G refused on a gateway that reports disputes, and on a payment the gateway disputed
 *  - § A amount cap: captured less refunds and disputes not won
 *  - § I an Idempotency-Key replay books once
 *  - § P permission `payments:refund`: an ops member and a read key are refused
 *  - § T tenant isolation
 *  - § D the transaction read offers the action only where it applies; audit rows
 *  - § O `outcome_settable_by_operator`: true on an open hand-recorded dispute and on an open
 *    dispute of a gateway with no final state (Mollie), false on Stripe and once closed
 *
 *   pnpm verify:dispute-recording
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { buildApp } from "@/index";
import { withTenant, systemDb, closeDb } from "@/platform/db";
import { createOrganization, createBusiness, createApiKey } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import { createSubscription } from "@/modules/subscriptions/service";
import { billSubscriptionPeriod } from "@/modules/invoicing/service";
import { refundPayment } from "@/modules/refunds/service";
import { handleProviderEvent } from "@/modules/webhooks/inbound";
import { inviteUser, acceptInvite } from "@/modules/auth/service";
import { accountBalance } from "@/modules/ledger/service";
import { auditLogs, authTokens, disputes, ledgerEntries, payments, transactions } from "@db/schema";
import type { NormalizedProviderEvent } from "@/providers/types";
import { pinMfaMandateOff } from "./lib/mfa-policy";

pinMfaMandateOff();
const app = await buildApp({ logger: false });
const checks: [string, boolean][] = [];
const ok = (name: string, cond: boolean) => checks.push([name, cond]);
const RUN = randomUUID().slice(0, 8);

// ── Fixtures ─────────────────────────────────────────────────────────────────
const org = await createOrganization({ name: "Dispute Recording Co" });
const orgId = org.organization.id;
const biz = await createBusiness({
  organizationId: orgId,
  name: "DR Biz",
  defaultCurrency: "USD",
  livemode: "test",
});
// A test business is provisioned with the TM Test Gateway (`disputeFeed: false`).
const product = await createProduct({ organizationId: orgId, businessId: biz.id, name: "Pro" });
const price = await createPrice({
  organizationId: orgId,
  businessId: biz.id,
  productId: product.id,
  type: "recurring",
  model: "flat",
  currency: "USD",
  amountMinor: 10000,
  interval: "month",
});
const { secret: writeKey } = await createApiKey(orgId, "test");
const { secret: readKey } = await createApiKey(orgId, "test", "api", "read");

async function makePaidPayment(email: string) {
  const customer = await createCustomer({ organizationId: orgId, businessId: biz.id, email });
  await vaultPaymentMethod({
    organizationId: orgId,
    businessId: biz.id,
    customer,
    token: "tok_4242",
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
    periodStart: sub.subscription.currentPeriodStart!,
    periodEnd: sub.subscription.currentPeriodEnd!,
  });
  return payment!;
}

const PW = "Correct-Horse-Battery-9";
async function memberSession(email: string, role: string) {
  const invited = await inviteUser({ organizationId: orgId, email, role });
  const tok = `invt_${randomBytes(32).toString("base64url")}`;
  await systemDb.insert(authTokens).values({
    userId: invited.userId,
    tokenHash: createHash("sha256").update(tok).digest("hex"),
    purpose: "invite",
    expiresAt: new Date(Date.now() + 3600_000),
  });
  return (await acceptInvite(tok, PW)).token;
}

type Auth = { key: string } | { cookie: string };
const post = (auth: Auth, url: string, payload: object, idem = randomBytes(8).toString("hex")) =>
  app.inject({
    method: "POST",
    url,
    headers: {
      ...("key" in auth
        ? { authorization: `Bearer ${auth.key}` }
        : { cookie: `tmb_session=${auth.cookie}` }),
      "idempotency-key": idem,
    },
    payload,
  });
const get = (auth: Auth, url: string) =>
  app.inject({
    method: "GET",
    url,
    headers:
      "key" in auth
        ? { authorization: `Bearer ${auth.key}` }
        : { cookie: `tmb_session=${auth.cookie}` },
  });
const W: Auth = { key: writeKey };
const recordUrl = (pay: string) => `/v1/businesses/${biz.publicId}/payments/${pay}/disputes`;
const outcomeUrl = (dsp: string) => `/v1/businesses/${biz.publicId}/disputes/${dsp}/outcome`;

/** The dispute's ledger postings, one sorted line-set per ledger transaction, oldest first. */
async function postings(disputePublicId: string | undefined): Promise<string[]> {
  if (!disputePublicId) return [];
  const rows = await withTenant(orgId, (tx) =>
    tx
      .select()
      .from(ledgerEntries)
      .where(
        and(eq(ledgerEntries.sourceType, "dispute"), eq(ledgerEntries.sourceId, disputePublicId)),
      ),
  );
  const byTxn = new Map<string, { at: number; lines: string[] }>();
  for (const r of rows) {
    const t = byTxn.get(r.transactionId) ?? { at: r.createdAt.getTime(), lines: [] };
    t.lines.push(`${r.direction} ${r.account} ${r.amountMinor} ${r.currency}`);
    byTxn.set(r.transactionId, t);
  }
  return [...byTxn.entries()]
    .sort((a, b) => a[1].at - b[1].at || a[0].localeCompare(b[0]))
    .map(([, t]) => t.lines.sort().join(" | "));
}

const disputeEv = (
  over: Partial<NormalizedProviderEvent> &
    Pick<NormalizedProviderEvent, "providerEventId" | "type" | "providerDisputeId">,
): NormalizedProviderEvent => ({
  providerChargeId: undefined,
  disputeReason: "fraudulent",
  disputeStatus: null,
  disputeAmountMinor: 10000n,
  disputeCurrency: "USD",
  evidenceDueBy: null,
  occurredAt: new Date(),
  raw: {},
  ...over,
});
async function gatewayDispute(
  chargeId: string,
  dp: string,
  types: NormalizedProviderEvent["type"][],
) {
  for (const type of types)
    await handleProviderEvent(
      "tmtest",
      disputeEv({
        providerEventId: `ev_${dp}_${type}_${RUN}`,
        type,
        providerDisputeId: dp,
        providerChargeId: chargeId,
      }),
      { businessId: biz.id },
    );
  const [row] = await withTenant(orgId, (tx) =>
    tx.select().from(disputes).where(eq(disputes.providerDisputeId, dp)).limit(1),
  );
  return row!;
}
const bal = (account: string) => accountBalance(orgId, biz.id, account, "USD");

// ── § L: the same books as the gateway path ─────────────────────────────────
{
  const gwPay = await makePaidPayment(`gw-won-${RUN}@example.com`);
  const gwWon = await gatewayDispute(gwPay.providerChargeId!, `dp_won_${RUN}`, [
    "dispute.created",
    "dispute.funds_withdrawn",
    "dispute.won",
  ]);
  const gwPay2 = await makePaidPayment(`gw-lost-${RUN}@example.com`);
  const gwLost = await gatewayDispute(gwPay2.providerChargeId!, `dp_lost_${RUN}`, [
    "dispute.created",
    "dispute.funds_withdrawn",
    "dispute.lost",
  ]);

  const held0 = await bal("disputed_funds");
  const pay = await makePaidPayment(`op-won-${RUN}@example.com`);
  const cash1 = await bal("cash");
  const r = await post(W, recordUrl(pay.publicId), {
    amount_minor: 10000,
    reason: "fraudulent",
    processor_reference: "CASE-0001",
    opened_at: Math.floor(Date.now() / 1000) - 3600,
  });
  const d = r.json() as Record<string, unknown>;
  if (r.statusCode !== 201) console.log("record refused:", r.statusCode, r.body);
  ok(
    `record: 201 (got ${r.statusCode} ${r.statusCode === 201 ? "" : r.body})`,
    r.statusCode === 201,
  );
  ok(
    "record: source operator, status under_review, funds withdrawn, reference kept",
    d.source === "operator" &&
      d.status === "under_review" &&
      d.funds_withdrawn === true &&
      d.processor_reference === "CASE-0001" &&
      d.provider_dispute_id === null &&
      d.provider_key === "tmtest",
  );
  ok("record: outcome_settable_by_operator is true", d.outcome_settable_by_operator === true);
  ok("record: cash clawed back 10000", (await bal("cash")) === cash1 - 10000n);
  ok("record: disputed_funds holds 10000", (await bal("disputed_funds")) === held0 + 10000n);
  const opRecorded = await postings(d.id as string);
  const gwRecorded = (await postings(gwWon.publicId)).slice(0, 1);
  ok(
    `record: same ledger lines as a gateway funds_withdrawn (${opRecorded.join(" / ")})`,
    opRecorded.length === 1 && opRecorded[0] === gwRecorded[0],
  );

  const w = await post(W, outcomeUrl(d.id as string), { outcome: "won" });
  const wd = w.json() as Record<string, unknown>;
  ok(`won: 200 (got ${w.statusCode})`, w.statusCode === 200);
  ok(
    "won: status won, funds back",
    wd.status === "won" && wd.funds_withdrawn === false && wd.closed_at != null,
  );
  ok("won: outcome_settable_by_operator is false", wd.outcome_settable_by_operator === false);
  ok("won: cash restored", (await bal("cash")) === cash1);
  ok("won: disputed_funds back to its baseline", (await bal("disputed_funds")) === held0);
  ok(
    "won: same ledger lines as a gateway won",
    JSON.stringify(await postings(d.id as string)) ===
      JSON.stringify(await postings(gwWon.publicId)),
  );
  const again = await post(W, outcomeUrl(d.id as string), { outcome: "lost" });
  ok(`won: a second outcome is refused 409 (got ${again.statusCode})`, again.statusCode === 409);

  const pay2 = await makePaidPayment(`op-lost-${RUN}@example.com`);
  const losses0 = await bal("dispute_losses");
  const r2 = await post(W, recordUrl(pay2.publicId), {
    amount_minor: 10000,
    reason: "product_not_received",
  });
  const d2 = r2.json() as Record<string, unknown>;
  const l = await post(W, outcomeUrl(d2.id as string), { outcome: "lost" });
  const ld = l.json() as Record<string, unknown>;
  ok(`lost: 200 (got ${l.statusCode})`, l.statusCode === 200);
  ok("lost: status lost and closed", ld.status === "lost" && ld.closed_at != null);
  ok("lost: dispute_losses +10000", (await bal("dispute_losses")) === losses0 + 10000n);
  ok(
    "lost: same ledger lines as a gateway lost",
    JSON.stringify(await postings(d2.id as string)) ===
      JSON.stringify(await postings(gwLost.publicId)),
  );
}

// ── § G: refused where the gateway reports disputes ─────────────────────────
{
  // A gateway-reported dispute on this payment: a hand record would book it twice.
  const pay = await makePaidPayment(`gw-open-${RUN}@example.com`);
  const gw = await gatewayDispute(pay.providerChargeId!, `dp_open_${RUN}`, ["dispute.created"]);
  const r = await post(W, recordUrl(pay.publicId), { amount_minor: 100, reason: "general" });
  ok(`gateway dispute on the payment: 409 (got ${r.statusCode})`, r.statusCode === 409);
  const o = await post(W, outcomeUrl(gw.publicId), { outcome: "won" });
  ok(`outcome on a gateway dispute: 400 (got ${o.statusCode})`, o.statusCode === 400);
  const gr = await get(W, `/v1/businesses/${biz.publicId}/disputes/${gw.publicId}`);
  ok(
    "a gateway that sends outcomes: outcome_settable_by_operator is false",
    (gr.json() as Record<string, unknown>).outcome_settable_by_operator === false,
  );

  // A payment on a gateway that sends dispute events.
  const [cus] = await withTenant(orgId, (tx) =>
    tx.select({ id: payments.customerId }).from(payments).where(eq(payments.id, pay.id)).limit(1),
  );
  const stripePid = `pay_XXXXDR${RUN}`;
  await withTenant(orgId, (tx) =>
    tx.insert(payments).values({
      organizationId: orgId,
      businessId: biz.id,
      customerId: cus!.id,
      publicId: stripePid,
      status: "succeeded",
      amountMinor: 5000n,
      currency: "USD",
      providerKey: "stripe",
      providerChargeId: `pi_XXXXDR${RUN}`,
    }),
  );
  const s = await post(W, recordUrl(stripePid), { amount_minor: 100, reason: "general" });
  ok(`gateway with a dispute feed: 400 (got ${s.statusCode})`, s.statusCode === 400);
  const n = await post(W, recordUrl("pay_XXXXXXXXXXXX99"), {
    amount_minor: 100,
    reason: "general",
  });
  ok(`unknown payment: 404 (got ${n.statusCode})`, n.statusCode === 404);
  const bad = await post(W, recordUrl(stripePid), { amount_minor: 100, reason: "because" });
  ok(`reason outside the vocabulary: 400 (got ${bad.statusCode})`, bad.statusCode === 400);
}

// ── § A: amount cap ─────────────────────────────────────────────────────────
{
  const pay = await makePaidPayment(`cap-${RUN}@example.com`);
  await refundPayment({
    organizationId: orgId,
    businessId: biz.id,
    paymentPublicId: pay.publicId,
    amountMinor: 3000,
  });
  const over = await post(W, recordUrl(pay.publicId), { amount_minor: 7001, reason: "duplicate" });
  ok(
    `cap: more than captured less refunds is refused 400 (got ${over.statusCode})`,
    over.statusCode === 400,
  );
  const part = await post(W, recordUrl(pay.publicId), { amount_minor: 4000, reason: "duplicate" });
  ok(`cap: a part is accepted (got ${part.statusCode})`, part.statusCode === 201);
  const rest = await post(W, recordUrl(pay.publicId), { amount_minor: 3001, reason: "duplicate" });
  ok(`cap: a second dispute counts the first (got ${rest.statusCode})`, rest.statusCode === 400);
  const exact = await post(W, recordUrl(pay.publicId), { amount_minor: 3000, reason: "duplicate" });
  ok(`cap: the exact remainder is accepted (got ${exact.statusCode})`, exact.statusCode === 201);
  // A won dispute gives its amount back to the cap.
  await post(W, outcomeUrl((part.json() as { id: string }).id), { outcome: "won" });
  const after = await post(W, recordUrl(pay.publicId), { amount_minor: 4000, reason: "duplicate" });
  ok(`cap: a won dispute frees its amount (got ${after.statusCode})`, after.statusCode === 201);
  const future = await post(W, recordUrl(pay.publicId), {
    amount_minor: 1,
    reason: "general",
    opened_at: Math.floor(Date.now() / 1000) + 86400,
  });
  ok(`date in the future is refused 400 (got ${future.statusCode})`, future.statusCode === 400);
}

// ── § I: idempotent replay ──────────────────────────────────────────────────
{
  const pay = await makePaidPayment(`idem-${RUN}@example.com`);
  const cash = await bal("cash");
  const key = `idem-${RUN}`;
  const a = await post(W, recordUrl(pay.publicId), { amount_minor: 2500, reason: "general" }, key);
  const b = await post(W, recordUrl(pay.publicId), { amount_minor: 2500, reason: "general" }, key);
  const rows = await withTenant(orgId, (tx) =>
    tx.select().from(disputes).where(eq(disputes.paymentId, pay.id)),
  );
  ok(
    `replay: same response, one row (${a.statusCode}/${b.statusCode}, rows ${rows.length})`,
    a.statusCode === 201 &&
      b.statusCode === 201 &&
      (a.json() as { id: string }).id === (b.json() as { id: string }).id &&
      rows.length === 1,
  );
  ok("replay: cash moved once", (await bal("cash")) === cash - 2500n);
}

// ── § P: permission ─────────────────────────────────────────────────────────
{
  const pay = await makePaidPayment(`perm-${RUN}@example.com`);
  const opsCookie = await memberSession(`ops-${RUN}@example.com`, "ops");
  const managerCookie = await memberSession(`mgr-${RUN}@example.com`, "manager");
  const o = await post({ cookie: opsCookie }, recordUrl(pay.publicId), {
    amount_minor: 100,
    reason: "general",
  });
  ok(`ops member (no payments:refund) is refused 403 (got ${o.statusCode})`, o.statusCode === 403);
  const rk = await post({ key: readKey }, recordUrl(pay.publicId), {
    amount_minor: 100,
    reason: "general",
  });
  ok(`read key is refused 403 (got ${rk.statusCode})`, rk.statusCode === 403);
  const m = await post({ cookie: managerCookie }, recordUrl(pay.publicId), {
    amount_minor: 100,
    reason: "general",
  });
  ok(`manager member is allowed (got ${m.statusCode})`, m.statusCode === 201);
  const mo = await post({ cookie: opsCookie }, outcomeUrl((m.json() as { id: string }).id), {
    outcome: "won",
  });
  ok(`ops member cannot set the outcome 403 (got ${mo.statusCode})`, mo.statusCode === 403);
  const [audit] = await withTenant(orgId, (tx) =>
    tx
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.action, "dispute.record"),
          eq(auditLogs.resourceId, (m.json() as { id: string }).id),
        ),
      )
      .limit(1),
  );
  ok(
    `audit: dispute.record names the operator (${audit?.actor}/${audit?.source})`,
    !!audit && audit.actor === `mgr-${RUN}@example.com`,
  );
}

// ── § T: tenant isolation ───────────────────────────────────────────────────
{
  const pay = await makePaidPayment(`iso-${RUN}@example.com`);
  const other = await createOrganization({ name: "Other Co" });
  const otherBiz = await createBusiness({
    organizationId: other.organization.id,
    name: "Other",
    defaultCurrency: "USD",
    livemode: "test",
  });
  const { secret: otherKey } = await createApiKey(other.organization.id, "test");
  const a = await post({ key: otherKey }, recordUrl(pay.publicId), {
    amount_minor: 100,
    reason: "general",
  });
  ok(`another org on this business: 404 (got ${a.statusCode})`, a.statusCode === 404);
  const b = await post(
    { key: otherKey },
    `/v1/businesses/${otherBiz.publicId}/payments/${pay.publicId}/disputes`,
    { amount_minor: 100, reason: "general" },
  );
  ok(
    `another org naming this payment from its own business: 404 (got ${b.statusCode})`,
    b.statusCode === 404,
  );
  const mine = await post(W, recordUrl(pay.publicId), { amount_minor: 100, reason: "general" });
  const c = await post(
    { key: otherKey },
    `/v1/businesses/${otherBiz.publicId}/disputes/${(mine.json() as { id: string }).id}/outcome`,
    { outcome: "won" },
  );
  ok(`another org setting this dispute's outcome: 404 (got ${c.statusCode})`, c.statusCode === 404);
}

// ── § D: the transaction read and the list filter ───────────────────────────
{
  const pay = await makePaidPayment(`detail-${RUN}@example.com`);
  const txnFor = async (paymentId: string) =>
    (
      await withTenant(orgId, (tx) =>
        tx
          .select({ publicId: transactions.publicId })
          .from(transactions)
          .where(and(eq(transactions.paymentId, paymentId), eq(transactions.type, "payment")))
          .limit(1),
      )
    )[0]?.publicId;
  const t = await get(W, `/v1/businesses/${biz.publicId}/transactions/${await txnFor(pay.id)}`);
  const dr = (
    t.json() as { dispute_recording: { payment: string; available_minor: number } | null }
  ).dispute_recording;
  ok(
    `transaction offers dispute_recording with the cap (${JSON.stringify(dr)})`,
    dr?.payment === pay.publicId && dr?.available_minor === 10000,
  );
  await post(W, recordUrl(pay.publicId), { amount_minor: 1500, reason: "general" });
  const t2 = await get(W, `/v1/businesses/${biz.publicId}/transactions/${await txnFor(pay.id)}`);
  ok(
    "after a record the cap goes down",
    (t2.json() as { dispute_recording: { available_minor: number } }).dispute_recording
      ?.available_minor === 8500,
  );
  const gwPay = await makePaidPayment(`detail-gw-${RUN}@example.com`);
  await gatewayDispute(gwPay.providerChargeId!, `dp_detail_${RUN}`, ["dispute.created"]);
  const t3 = await get(W, `/v1/businesses/${biz.publicId}/transactions/${await txnFor(gwPay.id)}`);
  ok(
    "a payment the gateway disputed offers nothing",
    (t3.json() as { dispute_recording: unknown }).dispute_recording === null,
  );
  const list = await get(W, `/v1/businesses/${biz.publicId}/disputes?payment=${pay.publicId}`);
  const data = (list.json() as { data: Array<{ source: string }> }).data;
  ok(
    `list ?payment= returns that payment's dispute (${data.length})`,
    data.length === 1 && data[0]!.source === "operator",
  );
  const none = await get(W, `/v1/businesses/${biz.publicId}/disputes?payment=pay_XXXXXXXXXXXX99`);
  ok(
    "list ?payment= with an unknown id is empty",
    (none.json() as { data: unknown[] }).data.length === 0,
  );
}

// ── § O: outcome_settable_by_operator on gateway disputes ───────────────────
{
  /** An open, funds-withdrawn dispute that `gateway` reported on a paid payment. */
  async function disputeOn(gateway: string, tag: string) {
    const pay = await makePaidPayment(`${tag}-${RUN}@example.com`);
    await withTenant(orgId, (tx) =>
      tx.update(payments).set({ providerKey: gateway }).where(eq(payments.id, pay.id)),
    );
    const dp = `dp_${tag}_${RUN}`;
    for (const type of ["dispute.created", "dispute.funds_withdrawn"] as const)
      await handleProviderEvent(
        gateway,
        disputeEv({
          providerEventId: `ev_${dp}_${type}`,
          type,
          providerDisputeId: dp,
          providerChargeId: pay.providerChargeId!,
        }),
        { businessId: biz.id },
      );
    const [row] = await withTenant(orgId, (tx) =>
      tx.select().from(disputes).where(eq(disputes.providerDisputeId, dp)).limit(1),
    );
    return row!;
  }
  const read = async (dsp: string) =>
    (await get(W, `/v1/businesses/${biz.publicId}/disputes/${dsp}`)).json() as Record<
      string,
      unknown
    >;

  // Mollie sends a chargeback but never its result (`disputeFinalState: false`).
  const mollie = await disputeOn("mollie", "mollie");
  const m = await read(mollie.publicId);
  ok(
    `mollie open dispute: source gateway, funds withdrawn (${m.status}/${m.funds_withdrawn})`,
    m.source === "gateway" && m.provider_key === "mollie" && m.funds_withdrawn === true,
  );
  ok(
    "mollie open dispute: outcome_settable_by_operator is true",
    m.outcome_settable_by_operator === true,
  );
  const listed = (
    (await get(W, `/v1/businesses/${biz.publicId}/disputes?limit=200`)).json() as {
      data: Array<Record<string, unknown>>;
    }
  ).data.find((d) => d.id === mollie.publicId);
  ok("mollie: the list carries the same field", listed?.outcome_settable_by_operator === true);

  const losses0 = await bal("dispute_losses");
  const held0 = await bal("disputed_funds");
  const l = await post(W, outcomeUrl(mollie.publicId), { outcome: "lost" });
  const ld = l.json() as Record<string, unknown>;
  ok(
    `mollie: mark lost 200 (got ${l.statusCode} ${l.statusCode === 200 ? "" : l.body})`,
    l.statusCode === 200,
  );
  ok("mollie: lost closes the dispute", ld.status === "lost" && ld.closed_at != null);
  ok(
    "mollie: held funds move to dispute_losses",
    (await bal("dispute_losses")) === losses0 + 10000n &&
      (await bal("disputed_funds")) === held0 - 10000n,
  );
  ok(
    "mollie closed: outcome_settable_by_operator is false",
    ld.outcome_settable_by_operator === false,
  );
  const again = await post(W, outcomeUrl(mollie.publicId), { outcome: "won" });
  ok(
    `mollie closed: a second outcome is refused 409 (got ${again.statusCode})`,
    again.statusCode === 409,
  );

  // Stripe reports the result itself.
  const stripe = await disputeOn("stripe", "stripe");
  const s = await read(stripe.publicId);
  ok(
    `stripe open dispute: outcome_settable_by_operator is false (${s.status})`,
    s.source === "gateway" &&
      s.status !== "won" &&
      s.status !== "lost" &&
      s.outcome_settable_by_operator === false,
  );
  const so = await post(W, outcomeUrl(stripe.publicId), { outcome: "lost" });
  ok(`stripe: the outcome route refuses 400 (got ${so.statusCode})`, so.statusCode === 400);
}

// ── Every posted ledger transaction balances ─────────────────────────────────
{
  const all = await withTenant(orgId, (tx) => tx.select().from(ledgerEntries));
  const net = new Map<string, bigint>();
  for (const e of all)
    net.set(
      `${e.transactionId}:${e.currency}`,
      (net.get(`${e.transactionId}:${e.currency}`) ?? 0n) +
        (e.direction === "debit" ? e.amountMinor : -e.amountMinor),
    );
  ok(
    `every ledger transaction balances (${net.size})`,
    [...net.values()].every((v) => v === 0n),
  );
}

await app.close();
let pass = true;
for (const [n, c] of checks) {
  console.log(` ${c ? "✓" : "✗"} ${n}`);
  if (!c) pass = false;
}
console.log("");
console.log(pass ? "✅ DISPUTE RECORDING: PASS" : "❌ DISPUTE RECORDING: FAIL");
await closeDb();
process.exit(pass ? 0 : 1);
