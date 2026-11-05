/**
 * One chargeback, many deliveries — `verify:concurrent-collect` / `verify:concurrent-refund`
 * applied to the dispute path, where the money moves without anybody calling an API.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────
 * `handleDisputeEvent` is the only money path in the codebase driven ENTIRELY by inbound
 * webhooks, and its own doc comment makes a falsifiable claim:
 *
 *   "Idempotency: the top-level provider-event dedup (handleProviderEvent) blocks exact
 *    replays; the per-dispute `fundsWithdrawn` flag + `status` guard blocks a DOUBLE
 *    clawback should a provider re-send funds_withdrawn under a new event id."
 *
 * The first half is true and is not what this file tests: `handleProviderEvent` inserts
 * `(provider_key, provider_event_id)` with `onConflictDoNothing` and returns 'duplicate',
 * so the SAME event id cannot be processed twice. That guard is a unique index — the good
 * kind.
 *
 * The second half is a READ-THEN-ACT, which is precisely the shape that produced the 0162
 * double-book. Inside one `withTenant` transaction the handler
 *
 *   1. SELECTs the dispute row,
 *   2. branches on `dispute.fundsWithdrawn` / `dispute.status` read in step 1,
 *   3. `postEntries(...)` — an INSERT into `ledger_entries`, which conflicts with nothing,
 *   4. UPDATEs the dispute row.
 *
 * Two transactions can both complete step 1 and 2 before either reaches step 4. The row
 * UPDATE in step 4 does serialize (Postgres row lock), but the CASH HAS ALREADY BEEN
 * POSTED by then — step 3 is not undone by losing the race at step 4, because nobody
 * loses: the second UPDATE simply waits and then succeeds. Both ledger postings commit.
 *
 * Nothing serialises the read: the dispute path never takes `lockCustomerBalances` (it
 * is not a customer-bucket movement) and has no claim column of its own.
 *
 * The events that race are not hypothetical replays under new ids. Stripe sends
 * `charge.dispute.funds_withdrawn` and `charge.dispute.closed` as DISTINCT events,
 * milliseconds apart when a dispute is lost quickly, and `charge.dispute.funds_reinstated`
 * alongside the won-closure. Distinct event ids, so the provider-event dedup does not
 * apply, and our webhook route processes deliveries concurrently.
 *
 * ── WHAT THIS ASSERTS ───────────────────────────────────────────────────────────
 * The LEDGER, per the lesson both sibling suites carry: a suite that counted `disputes`
 * rows would pass forever (there is exactly one row, correctly) while cash was clawed
 * back twice for a single chargeback. Concretely, for ONE dispute of `AMOUNT`:
 *
 *   - cash may be credited at most `AMOUNT` in total across the whole lifecycle,
 *   - `disputed_funds` must never go negative (more released than was ever held),
 *   - `dispute_losses` may be debited at most `AMOUNT`.
 *
 * Each scenario runs in its own organization so the sums are unambiguous.
 *
 *   tsx scripts/verify-concurrent-dispute.ts
 */
import { and, eq } from "drizzle-orm";
import { withTenant, closeDb } from "@/platform/db";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import { createSubscription } from "@/modules/subscriptions/service";
import { billSubscriptionPeriod, collectInvoice } from "@/modules/invoicing/service";
import { handleDisputeEvent } from "@/modules/disputes/service";
import { disputes, payments, ledgerEntries } from "@db/schema";
import type { NormalizedProviderEvent } from "@/providers/types";

const AMOUNT = 1500n;

const checks: [string, boolean, string][] = [];
const ok = (name: string, pass: boolean, detail = "") => checks.push([name, pass, detail]);

let seq = 0;
const nextEventId = () => `evt_race_${Date.now()}_${++seq}`;

/** A fresh org with a collected 1500 payment — the charge a dispute can name. */
async function scenario(label: string) {
  const org = await createOrganization({ name: `Concurrent Dispute ${label}` });
  const orgId = org.organization.id;
  const biz = await createBusiness({
    defaultCurrency: "USD",
    organizationId: orgId,
    name: "Biz",
    livemode: "test",
  });
  const customer = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: `cd-${label}@a.com`,
  });
  await vaultPaymentMethod({
    organizationId: orgId,
    businessId: biz.id,
    customer,
    token: "tok_4242",
  });
  const product = await createProduct({ organizationId: orgId, businessId: biz.id, name: "Pro" });
  const price = await createPrice({
    organizationId: orgId,
    businessId: biz.id,
    productId: product.id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: Number(AMOUNT),
    interval: "month",
  });
  const sub = await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: customer.id,
    now: new Date(),
    items: [{ price, quantity: 1 }],
  });
  const { invoice } = await billSubscriptionPeriod({
    organizationId: orgId,
    businessId: biz.id,
    subscription: sub.subscription,
    periodStart: sub.subscription.currentPeriodStart!,
    periodEnd: sub.subscription.currentPeriodEnd!,
  });
  await collectInvoice({
    organizationId: orgId,
    businessId: biz.id,
    invoice,
    subscription: sub.subscription,
  });
  const [pay] = await withTenant(orgId, (tx) =>
    tx
      .select()
      .from(payments)
      .where(and(eq(payments.invoiceId, invoice.id), eq(payments.status, "succeeded")))
      .limit(1),
  );
  if (!pay?.providerChargeId)
    throw new Error(`${label}: setup failed — no succeeded payment with a gateway charge id`);
  const disputeId = `dp_${label}_${Date.now()}`;
  const ev = (type: NormalizedProviderEvent["type"]): NormalizedProviderEvent => ({
    providerEventId: nextEventId(),
    type,
    providerChargeId: pay.providerChargeId!,
    providerDisputeId: disputeId,
    disputeReason: "fraudulent",
    disputeAmountMinor: AMOUNT,
    disputeCurrency: "USD",
    occurredAt: new Date(),
    raw: { provider_key: "tmtest" },
  });
  // The context the verified gateway account hands the handler.
  const ctx = { businessId: biz.id, providerKey: "tmtest" };
  return { orgId, bizId: biz.id, disputeId, ev, ctx };
}

/** Net movement per account for `source_type='dispute'` in this org (debit − credit). */
async function disputeLedger(orgId: string): Promise<Record<string, bigint>> {
  const rows = await withTenant(orgId, (tx) =>
    tx.select().from(ledgerEntries).where(eq(ledgerEntries.sourceType, "dispute")),
  );
  const out: Record<string, bigint> = {};
  for (const r of rows) {
    out[r.account] =
      (out[r.account] ?? 0n) + (r.direction === "debit" ? r.amountMinor : -r.amountMinor);
  }
  return out;
}

/** Gross credit posted to one account for `source_type='dispute'` (cash actually clawed). */
async function grossCredit(orgId: string, account: string): Promise<bigint> {
  const rows = await withTenant(orgId, (tx) =>
    tx
      .select()
      .from(ledgerEntries)
      .where(and(eq(ledgerEntries.sourceType, "dispute"), eq(ledgerEntries.account, account))),
  );
  return rows.filter((r) => r.direction === "credit").reduce((s, r) => s + r.amountMinor, 0n);
}

async function grossDebit(orgId: string, account: string): Promise<bigint> {
  const rows = await withTenant(orgId, (tx) =>
    tx
      .select()
      .from(ledgerEntries)
      .where(and(eq(ledgerEntries.sourceType, "dispute"), eq(ledgerEntries.account, account))),
  );
  return rows.filter((r) => r.direction === "debit").reduce((s, r) => s + r.amountMinor, 0n);
}

// ══ POSITIVE CONTROL ═══════════════════════════════════════════════════════════
// Before asserting any refusal, prove the happy path books the money correctly —
// otherwise a handler that silently did nothing would sail through every cap below.
{
  const s = await scenario("control");
  await handleDisputeEvent(s.ev("dispute.created"), s.ctx);
  await handleDisputeEvent(s.ev("dispute.funds_withdrawn"), s.ctx);
  await handleDisputeEvent(s.ev("dispute.lost"), s.ctx);
  const net = await disputeLedger(s.orgId);
  const rows = await withTenant(s.orgId, (tx) => tx.select().from(disputes));
  ok(
    "CONTROL: sequential created → funds_withdrawn → lost books exactly one clawback and one realized loss",
    net.cash === -AMOUNT &&
      (net.disputed_funds ?? 0n) === 0n &&
      net.dispute_losses === AMOUNT &&
      rows.length === 1 &&
      rows[0]!.status === "lost",
    `cash ${net.cash}, disputed_funds ${net.disputed_funds ?? 0n}, dispute_losses ${net.dispute_losses ?? 0n}, ${rows.length} dispute row(s) status=${rows[0]?.status}`,
  );
}

// ══ A. the clawback, re-sent under new event ids ════════════════════════════════
// The exact case the doc comment claims the `fundsWithdrawn` flag covers.
{
  const s = await scenario("withdraw");
  await handleDisputeEvent(s.ev("dispute.created"), s.ctx);
  const N = 5;
  const res = await Promise.allSettled(
    Array.from({ length: N }, () => handleDisputeEvent(s.ev("dispute.funds_withdrawn"), s.ctx)),
  );
  const errored = res.filter((r) => r.status === "rejected");
  const cashClawed = await grossCredit(s.orgId, "cash");
  const rows = await withTenant(s.orgId, (tx) => tx.select().from(disputes));
  ok(
    `A: LEDGER — ${N} concurrent funds_withdrawn claw back at most the disputed ${AMOUNT} in cash`,
    cashClawed <= AMOUNT,
    `cash credited ${cashClawed} (${cashClawed / AMOUNT}x the chargeback), ${rows.length} dispute row(s), ${errored.length} handler error(s)`,
  );
  ok(
    "A: exactly one dispute row exists (the unique index on (org, provider_dispute_id) holds)",
    rows.length === 1,
    `${rows.length} row(s)`,
  );
}

// ══ B. won + funds_reinstated, concurrently ═════════════════════════════════════
// Stripe sends both. Each reverses the clawback if `fundsWithdrawn === 'true'`, read
// before either writes — so both can debit cash back.
{
  const s = await scenario("reinstate");
  await handleDisputeEvent(s.ev("dispute.created"), s.ctx);
  await handleDisputeEvent(s.ev("dispute.funds_withdrawn"), s.ctx);
  await Promise.allSettled([
    handleDisputeEvent(s.ev("dispute.won"), s.ctx),
    handleDisputeEvent(s.ev("dispute.funds_reinstated"), s.ctx),
  ]);
  const net = await disputeLedger(s.orgId);
  const reinstated = await grossDebit(s.orgId, "cash");
  ok(
    `B: LEDGER — a won dispute reinstates at most the ${AMOUNT} that was clawed back`,
    reinstated <= AMOUNT,
    `cash debited back ${reinstated}`,
  );
  ok(
    "B: LEDGER — `disputed_funds` never goes negative (never release more than was held)",
    (net.disputed_funds ?? 0n) >= 0n,
    `disputed_funds net ${net.disputed_funds ?? 0n} (negative = we released cash we never held)`,
  );
}

// ══ C. funds_withdrawn + lost, concurrently ═════════════════════════════════════
// The worst shape: `dispute.lost` reading a stale `fundsWithdrawn='false'` takes the
// "funds were never withdrawn separately" branch and books the loss STRAIGHT AGAINST
// CASH — on top of the clawback the concurrent funds_withdrawn is posting. One
// chargeback, cash credited twice, and `disputed_funds` left holding a phantom asset.
{
  const s = await scenario("lostrace");
  await handleDisputeEvent(s.ev("dispute.created"), s.ctx);
  await Promise.allSettled([
    handleDisputeEvent(s.ev("dispute.funds_withdrawn"), s.ctx),
    handleDisputeEvent(s.ev("dispute.lost"), s.ctx),
  ]);
  const net = await disputeLedger(s.orgId);
  const cashClawed = await grossCredit(s.orgId, "cash");
  const losses = await grossDebit(s.orgId, "dispute_losses");
  ok(
    `C: LEDGER — funds_withdrawn racing lost credits cash at most once (${AMOUNT})`,
    cashClawed <= AMOUNT,
    `cash credited ${cashClawed}`,
  );
  ok(
    `C: LEDGER — the realized loss is at most the disputed amount (${AMOUNT})`,
    losses <= AMOUNT,
    `dispute_losses debited ${losses}`,
  );
  ok(
    "C: LEDGER — `disputed_funds` is left flat (nothing held once the case is closed)",
    (net.disputed_funds ?? 0n) === 0n,
    `disputed_funds net ${net.disputed_funds ?? 0n} (nonzero = a phantom asset or an over-release)`,
  );
}

// ══ E. lost, THEN a late funds_withdrawn — ZERO concurrency ═════════════════════
// Serializing scenario C (see `lockDispute`) did not make it green, which is the tell:
// what is left is not a race but an ORDERING bug the race merely surfaced. Webhook
// deliveries are not ordered, and a quick loss can deliver `charge.dispute.closed`
// before `charge.dispute.funds_withdrawn`.
//
// The `lost` branch guards against 'won' and 'lost'. The `funds_withdrawn` branch guards
// only on `fundsWithdrawn !== 'true'` — nothing about the dispute already being TERMINAL.
// So a loss that took the "funds were never withdrawn separately" path (booking the loss
// straight against cash, which is the whole economic outcome) is then followed by a
// clawback posting the SAME cash a second time, and parking a phantom `disputed_funds`
// asset for a case that is already closed.
//
// Run strictly sequentially, awaited: if this fails, no scheduler was involved.
{
  const s = await scenario("lateorder");
  await handleDisputeEvent(s.ev("dispute.created"), s.ctx);
  await handleDisputeEvent(s.ev("dispute.lost"), s.ctx);
  await handleDisputeEvent(s.ev("dispute.funds_withdrawn"), s.ctx);
  const net = await disputeLedger(s.orgId);
  const cashClawed = await grossCredit(s.orgId, "cash");
  ok(
    `E: LEDGER — a funds_withdrawn arriving AFTER the loss books no second clawback (cash credited once, ${AMOUNT})`,
    cashClawed <= AMOUNT,
    `cash credited ${cashClawed} for one ${AMOUNT} chargeback, sequentially`,
  );
  ok(
    "E: LEDGER — a closed dispute holds no `disputed_funds`",
    (net.disputed_funds ?? 0n) === 0n,
    `disputed_funds net ${net.disputed_funds ?? 0n}`,
  );
}

// ══ D. funds_reinstated with no clawback (positive control on the other side) ════
// Proves the guards are not simply "post nothing, ever": a reinstatement with no prior
// withdrawal must move NO cash, and the dispute must still close as won.
{
  const s = await scenario("nowithdraw");
  await handleDisputeEvent(s.ev("dispute.created"), s.ctx);
  await handleDisputeEvent(s.ev("dispute.won"), s.ctx);
  const net = await disputeLedger(s.orgId);
  const rows = await withTenant(s.orgId, (tx) => tx.select().from(disputes));
  ok(
    "CONTROL: winning a dispute whose funds were never withdrawn moves no cash, and still closes as won",
    (net.cash ?? 0n) === 0n && rows[0]?.status === "won",
    `cash net ${net.cash ?? 0n}, status ${rows[0]?.status}`,
  );
}

let failed = 0;
for (const [name, pass, detail] of checks) {
  if (pass) console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ""}`);
  else {
    failed++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
console.log(
  failed === 0
    ? `\n✅ CONCURRENT DISPUTE: PASS (${checks.length} checks)`
    : `\n❌ CONCURRENT DISPUTE: FAIL — ${failed} of ${checks.length}`,
);
await closeDb();
process.exit(failed === 0 ? 0 : 1);
