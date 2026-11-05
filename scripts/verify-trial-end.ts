/**
 * Trial-end outcome matrix — what a trial converts INTO, and when it doesn't convert.
 *
 * The two non-converting paths (`src/modules/subscriptions/renewal.ts`,
 * `resolveTrialEndCancel`) are the point of this suite, and both are easy to
 * regress into a silent activation:
 *  - `trial_end_action = 'cancel_subscription'` — unconditional, card or not. It was
 *    settable via the API and offered in the price form for a long time while NOTHING
 *    read it, so the sub activated and billed anyway.
 *  - auto-collect ON with nothing to charge → `no_card`, and critically NO INVOICE:
 *    activating first would book MRR, post AR to the append-only ledger and email the
 *    customer twice before dunning unwound it all as involuntary churn.
 *
 * The converting cases are here as the teeth on the gate — it must NOT eat a
 * send-invoice subscription, a zero-amount one, or one whose credit balance covers
 * the bill. Those need no card and must activate.
 *
 *   pnpm verify:trial-end
 */
import { desc, eq } from "drizzle-orm";
import { systemDb, withTenant, closeDb } from "@/platform/db";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { addPromotionalCredits } from "@/modules/customers/balances";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import { createSubscription } from "@/modules/subscriptions/service";
import { runBillingClockTick } from "@/modules/subscriptions/renewal";
import { subscriptions, invoices } from "@db/schema";

const org = await createOrganization({ name: "TrialEnd" });
const orgId = org.organization.id;
const biz = await createBusiness({
  organizationId: orgId,
  name: "Biz",
  defaultCurrency: "USD",
  livemode: "test",
});
const product = await createProduct({ organizationId: orgId, businessId: biz.id, name: "Pro" });

const getSub = (id: string) =>
  withTenant(
    orgId,
    async (tx) =>
      (await tx.select().from(subscriptions).where(eq(subscriptions.id, id)).limit(1))[0]!,
  );
const invCount = (id: string) =>
  withTenant(
    orgId,
    async (tx) => (await tx.select().from(invoices).where(eq(invoices.subscriptionId, id))).length,
  );
const newestInvoice = (id: string) =>
  withTenant(
    orgId,
    async (tx) =>
      (
        await tx
          .select()
          .from(invoices)
          .where(eq(invoices.subscriptionId, id))
          .orderBy(desc(invoices.createdAt))
          .limit(1)
      )[0] ?? null,
  );

/**
 * A trialing subscription, then its trial boundary dragged into the past so the very
 * next tick converts it. `currentPeriodEnd` is what the due-scan reads; `trialEnd`
 * moves with it because the two ARE the same boundary on a trialing sub, and a
 * classifier reading one against the other must not see them disagree.
 */
async function trialingSub(opts: {
  label: string;
  amountMinor?: number;
  card?: boolean;
  autoCollection?: "on" | "off";
  trialEndAction?: "activate_subscription" | "cancel_subscription";
  promoCreditMinor?: number;
}) {
  const c = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: `${opts.label}${Math.random()}@a.com`,
  });
  const pm = opts.card
    ? await vaultPaymentMethod({
        organizationId: orgId,
        businessId: biz.id,
        customer: c,
        token: "tok_4242",
      })
    : null;
  if (opts.promoCreditMinor) {
    await addPromotionalCredits({
      organizationId: orgId,
      businessId: biz.id,
      customer: c,
      amountMinor: opts.promoCreditMinor,
      currency: "USD",
      description: "trial-end test credit",
    });
  }
  const price = await createPrice({
    organizationId: orgId,
    businessId: biz.id,
    productId: product.id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: opts.amountMinor ?? 1000,
    interval: "month",
    trialPeriod: 7,
    trialPeriodUnit: "day",
    trialEndAction: opts.trialEndAction ?? "activate_subscription",
  });
  const s = (
    await createSubscription({
      organizationId: orgId,
      businessId: biz.id,
      customerId: c.id,
      now: new Date(),
      items: [{ price, quantity: 1 }],
      trialDays: 7,
      autoCollection: opts.autoCollection,
      ...(pm ? { defaultPaymentMethodId: pm.id } : {}),
    })
  ).subscription;
  if (s.status !== "in_trial")
    throw new Error(`${opts.label}: expected in_trial at setup, got ${s.status}`);
  const past = new Date(Date.now() - 60_000);
  await systemDb
    .update(subscriptions)
    .set({ currentPeriodEnd: past, trialEnd: past })
    .where(eq(subscriptions.id, s.id));
  return s;
}

const checks: Array<[string, boolean]> = [];

// ── 1. cardless + auto-collect ON + something owed → cancelled, no invoice ────────
{
  const s = await trialingSub({ label: "nocard-on", autoCollection: "on" });
  const before = await invCount(s.id);
  await runBillingClockTick(new Date());
  const after = await getSub(s.id);
  const count = await invCount(s.id);
  console.log(
    `cardless + auto-collect on → ${after.status}/${after.cancelReason}, invoices ${before}→${count}, activated_at=${after.activatedAt}`,
  );
  checks.push(["cardless auto-collect-on trial cancels", after.status === "cancelled"]);
  checks.push(["cancel reason is no_card", after.cancelReason === "no_card"]);
  // The whole point: no uncollectible invoice, so no AR to unwind later.
  checks.push(["no invoice raised for a cardless trial", count === before]);
  // This is the field that tells an engine trial-expiry from a person cancelling
  // mid-trial: NULL means the trial never converted.
  checks.push(["activated_at left NULL (trial never converted)", after.activatedAt === null]);
  checks.push(["cancelled → mrr 0", (after.mrr ?? 0n) === 0n]);
}

// ── 2. cardless + auto-collect OFF → activates (send-invoice: no card expected) ───
{
  const s = await trialingSub({ label: "nocard-off", autoCollection: "off" });
  const before = await invCount(s.id);
  await runBillingClockTick(new Date());
  const after = await getSub(s.id);
  const count = await invCount(s.id);
  const newest = await newestInvoice(s.id);
  console.log(
    `cardless + auto-collect off → ${after.status}, invoices ${before}→${count}, newest=${newest?.status}`,
  );
  checks.push(["cardless auto-collect-OFF trial activates", after.status === "active"]);
  checks.push(["send-invoice trial raised its bill", count === before + 1]);
  // `payment_due`, not `posted`: with no net term the bill is due the moment it is
  // raised. `posted` means "finalized but not yet due" and belongs to Net-D.
  checks.push(["send-invoice bill left open and owed", newest?.status === "payment_due"]);
  /**
   * Dunning IS armed — as REMINDERS. Restated 2026-08-31; the old expectation was
   * `dunningStatus === null && nextAttemptAt === null`, on the reasoning that "nothing
   * may have armed dunning against a customer who was never supposed to be
   * auto-charged". That conflates dunning with charging. A raised `auto_collection: off`
   * unpaid invoice is `payment_due` + `dunning_status: in_progress` + `next_retry_at =
   * date + the first retry interval`, with `dunning_attempts: []`.
   *
   * What must still hold is the part that actually protects the customer: no charge,
   * and no attempt booked. This case runs the WHOLE clock tick, `runDunningPass`
   * included, so `attempt_count === 0` here is evidence that the retry pass really does
   * skip auto-collect-off invoices rather than an assumption that it does.
   */
  checks.push([
    "send-invoice bill armed offline dunning (reminders)",
    newest?.dunningStatus === "in_progress" && newest?.nextAttemptAt !== null,
  ]);
  checks.push([
    "send-invoice bill was never charged (attempt_count 0 after a full tick)",
    newest?.attemptCount === 0,
  ]);
}

// ── 3. card + auto-collect ON → activates and collects (the ordinary conversion) ──
{
  const s = await trialingSub({ label: "card-on", card: true, autoCollection: "on" });
  const before = await invCount(s.id);
  await runBillingClockTick(new Date());
  const after = await getSub(s.id);
  const count = await invCount(s.id);
  const newest = await newestInvoice(s.id);
  console.log(
    `card + auto-collect on → ${after.status}, invoices ${before}→${count}, newest=${newest?.status}`,
  );
  checks.push(["carded trial converts to active", after.status === "active"]);
  checks.push(["conversion raised an invoice", count === before + 1]);
  checks.push(["conversion charged the card", newest?.status === "paid"]);
  checks.push(["converted → activated_at stamped", after.activatedAt !== null]);
  checks.push(["converted → mrr becomes real", (after.mrr ?? 0n) > 0n]);
}

// ── 4. trial_end_action = cancel_subscription → cancels DESPITE a good card ───────
{
  const s = await trialingSub({
    label: "action-cancel",
    card: true,
    autoCollection: "on",
    trialEndAction: "cancel_subscription",
  });
  const before = await invCount(s.id);
  await runBillingClockTick(new Date());
  const after = await getSub(s.id);
  const count = await invCount(s.id);
  console.log(
    `trial_end_action=cancel (with card) → ${after.status}/${after.cancelReason}, invoices ${before}→${count}`,
  );
  checks.push(["configured trial expiry cancels", after.status === "cancelled"]);
  // NOT no_card: nobody failed to pay, so this must not land in involuntary churn
  // (metrics INVOLUNTARY_REASONS) or trigger the nonpayment email.
  checks.push(["cancel reason is trial_ended, not no_card", after.cancelReason === "trial_ended"]);
  checks.push(["configured expiry raises no invoice", count === before]);
  checks.push(["configured expiry leaves activated_at NULL", after.activatedAt === null]);
}

// ── 5. cardless but ZERO amount → activates (a free plan never needed a card) ─────
{
  const s = await trialingSub({ label: "nocard-free", autoCollection: "on", amountMinor: 0 });
  await runBillingClockTick(new Date());
  const after = await getSub(s.id);
  console.log(`cardless + zero amount → ${after.status}/${after.cancelReason ?? "-"}`);
  checks.push(["cardless zero-amount trial activates", after.status === "active"]);
}

// ── 6. cardless but CREDIT covers the bill → activates and settles from credit ────
{
  const s = await trialingSub({
    label: "nocard-credit",
    autoCollection: "on",
    amountMinor: 1000,
    promoCreditMinor: 5000,
  });
  const before = await invCount(s.id);
  await runBillingClockTick(new Date());
  const after = await getSub(s.id);
  const count = await invCount(s.id);
  const newest = await newestInvoice(s.id);
  console.log(
    `cardless + credit covering → ${after.status}/${after.cancelReason ?? "-"}, invoices ${before}→${count}, newest=${newest?.status}`,
  );
  checks.push(["cardless credit-covered trial activates", after.status === "active"]);
  checks.push(["credit-covered conversion raised its invoice", count === before + 1]);
  checks.push(["invoice settled from credit, no card needed", newest?.status === "paid"]);
}

// ── 7/8. THE SECOND CONVERSION SITE ──────────────────────────────────────────────
// A future-dated subscription whose trial fully elapsed before the clock's start pass
// ran (clock down longer than the trial). `startFutureSubscriptions` used to activate
// AND advance it to the first paid period itself — a duplicate trial conversion that
// bypassed the gate entirely, so `trial_end_action` and the cardless cancel were both
// silently skipped on this path. It now starts the sub `in_trial` on a past boundary
// and the SAME tick's renewal scan converts it through the one gate.
async function futureSubWithElapsedTrial(opts: {
  label: string;
  card?: boolean;
  billingCycles?: number;
}) {
  const c = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: `${opts.label}${Math.random()}@a.com`,
  });
  const pm = opts.card
    ? await vaultPaymentMethod({
        organizationId: orgId,
        businessId: biz.id,
        customer: c,
        token: "tok_4242",
      })
    : null;
  const price = await createPrice({
    organizationId: orgId,
    businessId: biz.id,
    productId: product.id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 1000,
    interval: "month",
    trialPeriod: 7,
    trialPeriodUnit: "day",
    ...(opts.billingCycles ? { billingCycles: opts.billingCycles } : {}),
  });
  const s = (
    await createSubscription({
      organizationId: orgId,
      businessId: biz.id,
      customerId: c.id,
      now: new Date(),
      items: [{ price, quantity: 1 }],
      startDate: new Date(Date.now() + 7 * 86_400_000),
      trialDays: 7,
      autoCollection: "on",
      ...(pm ? { defaultPaymentMethodId: pm.id } : {}),
    })
  ).subscription;
  if (s.status !== "future")
    throw new Error(`${opts.label}: expected future at setup, got ${s.status}`);
  // Drag the whole schedule into the past: the start has arrived AND the trial it
  // opened has already run out. `currentPeriodEnd` tracks `trialEnd` — that IS the
  // trial window on a trialing sub, and it is what the due-scan reads.
  const past = new Date(Date.now() - 60_000);
  await systemDb
    .update(subscriptions)
    .set({
      startDate: past,
      trialEnd: past,
      currentPeriodStart: new Date(Date.now() - 8 * 86_400_000),
      currentPeriodEnd: past,
    })
    .where(eq(subscriptions.id, s.id));
  return s;
}

{
  const s = await futureSubWithElapsedTrial({ label: "future-elapsed-nocard" });
  const before = await invCount(s.id);
  await runBillingClockTick(new Date());
  const after = await getSub(s.id);
  const count = await invCount(s.id);
  console.log(
    `future + elapsed trial + cardless → ${after.status}/${after.cancelReason}, invoices ${before}→${count}`,
  );
  checks.push(["future-start elapsed trial reaches the gate", after.status === "cancelled"]);
  checks.push(["future-start elapsed trial cancels no_card", after.cancelReason === "no_card"]);
  checks.push(["future-start elapsed trial raises no invoice", count === before]);
}

{
  // The G review blocker the deleted duplicate was guarding: billing_cycles = 1 plus a
  // trial plus clock downtime once billed TWO paid cycles. With the conversion no longer
  // duplicated, exactly one paid cycle may be billed and the cap must land on 0 — a
  // decrement in BOTH places would instead bill one cycle short.
  const s = await futureSubWithElapsedTrial({
    label: "future-elapsed-card",
    card: true,
    billingCycles: 1,
  });
  const seeded = await getSub(s.id);
  const before = await invCount(s.id);
  await runBillingClockTick(new Date());
  const after = await getSub(s.id);
  const count = await invCount(s.id);
  const newest = await newestInvoice(s.id);
  console.log(
    `future + elapsed trial + card → ${after.status}, cycles ${seeded.remainingBillingCycles}→${after.remainingBillingCycles}, invoices ${before}→${count}, newest=${newest?.status}`,
  );
  checks.push(["future-start elapsed trial with card converts", after.status === "active"]);
  checks.push(["converted exactly once", count === before + 1 && newest?.status === "paid"]);
  checks.push([
    "one paid cycle consumed, not two",
    seeded.remainingBillingCycles === 1 && after.remainingBillingCycles === 0,
  ]);
}

// ── 9. FUTURE START, NO TRIAL — the sibling hole, closed 2026-08-19 ──────────────
// Same root cause as § 1, different boundary. Create-time gating refuses a cardless
// auto-collect-ON subscription that charges immediately, and exempts future starts —
// reasonably, since the merchant has until the start date to add a card. Nothing owned
// that exemption at the boundary it deferred to: `startFutureSubscriptions` activated
// and called `billSubscriptionPeriod` with no card check, so the invoice failed
// `no_payment_method` and only died ~4 dunning retries later, having booked MRR and AR
// in between.
//
// The remedy differs from the trial's ON PURPOSE. A trial expiring cardless is a
// customer who never subscribed → cancel. A future-dated start is one the merchant
// scheduled → activate, but raise no invoice, and bill it as soon as a card exists.
async function futureSubNoTrial(opts: {
  label: string;
  card?: boolean;
  autoCollection?: "on" | "off";
  amountMinor?: number;
}) {
  const c = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: `${opts.label}${Math.random()}@a.com`,
  });
  const pm = opts.card
    ? await vaultPaymentMethod({
        organizationId: orgId,
        businessId: biz.id,
        customer: c,
        token: "tok_4242",
      })
    : null;
  const price = await createPrice({
    organizationId: orgId,
    businessId: biz.id,
    productId: product.id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: opts.amountMinor ?? 1000,
    interval: "month",
  });
  const s = (
    await createSubscription({
      organizationId: orgId,
      businessId: biz.id,
      customerId: c.id,
      now: new Date(),
      items: [{ price, quantity: 1 }],
      // No trialDays: this starts straight into a PAID period, which is what makes it
      // the uncovered case — § 7/8 above start `in_trial` and reach the trial gate.
      startDate: new Date(Date.now() + 7 * 86_400_000),
      autoCollection: opts.autoCollection ?? "on",
      ...(pm ? { defaultPaymentMethodId: pm.id } : {}),
    })
  ).subscription;
  if (s.status !== "future")
    throw new Error(`${opts.label}: expected future at setup, got ${s.status}`);
  // The start date has arrived. The period bounds move with it so the first period is
  // the one now beginning, exactly as a real future start would look at its boundary.
  const past = new Date(Date.now() - 60_000);
  await systemDb
    .update(subscriptions)
    .set({
      startDate: past,
      currentPeriodStart: past,
      currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000),
    })
    .where(eq(subscriptions.id, s.id));
  return { sub: s, customer: c };
}

{
  const { sub: s, customer } = await futureSubNoTrial({ label: "future-notrial-nocard" });
  const before = await invCount(s.id);
  await runBillingClockTick(new Date());
  const after = await getSub(s.id);
  const count = await invCount(s.id);
  console.log(`future + no trial + cardless → ${after.status}, invoices ${before}→${count}`);
  // It ACTIVATES: the merchant scheduled this and the term is genuinely running.
  checks.push(["cardless future start still activates", after.status === "active"]);
  // …and raises NO invoice — the whole point. An uncollectible invoice here is AR in an
  // append-only ledger plus two emails plus four dunning retries, all fictional.
  checks.push(["cardless future start raises NO invoice", count === before]);
  // The heal pass must not undo the skip one tick later — it re-probes.
  await runBillingClockTick(new Date());
  checks.push(["a second tick does not raise it either", (await invCount(s.id)) === before]);

  // Now the card arrives. The deferral is a deferral: the next tick bills it, with no
  // manual step and no re-activation.
  const pm = await vaultPaymentMethod({
    organizationId: orgId,
    businessId: biz.id,
    customer,
    token: "tok_4242",
  });
  await withTenant(orgId, (tx) =>
    tx
      .update(subscriptions)
      .set({ defaultPaymentMethodId: pm.id })
      .where(eq(subscriptions.id, s.id)),
  );
  await runBillingClockTick(new Date());
  const healed = await invCount(s.id);
  const newest = await newestInvoice(s.id);
  console.log(`  …then a card is added → invoices ${count}→${healed}, newest=${newest?.status}`);
  checks.push(["once a card exists the first period bills", healed === before + 1]);
  checks.push(["…and it collects", newest?.status === "paid"]);
}

{
  // The teeth: auto-collect OFF is the send-invoice model, where no card is EXPECTED.
  // It must still be invoiced — that invoice IS the bill.
  const { sub: s } = await futureSubNoTrial({
    label: "future-notrial-offline",
    autoCollection: "off",
  });
  const before = await invCount(s.id);
  await runBillingClockTick(new Date());
  const after = await getSub(s.id);
  const count = await invCount(s.id);
  console.log(
    `future + no trial + auto-collect OFF → ${after.status}, invoices ${before}→${count}`,
  );
  checks.push(["send-invoice future start activates", after.status === "active"]);
  checks.push(["send-invoice future start IS invoiced", count === before + 1]);
}

{
  // The other tooth: a ZERO-amount period never needed a card, so gating on card
  // presence alone would strand every free plan.
  const { sub: s } = await futureSubNoTrial({ label: "future-notrial-zero", amountMinor: 0 });
  const before = await invCount(s.id);
  await runBillingClockTick(new Date());
  const after = await getSub(s.id);
  const count = await invCount(s.id);
  console.log(`future + no trial + zero amount → ${after.status}, invoices ${before}→${count}`);
  checks.push(["zero-amount future start activates", after.status === "active"]);
  checks.push(["zero-amount future start IS invoiced", count === before + 1]);
}

let pass = true;
for (const [n, ok] of checks) {
  console.log(`  ${ok ? "✓" : "✗"} ${n}`);
  if (!ok) pass = false;
}
console.log("");
console.log(pass ? "✅ TRIAL END: PASS" : "❌ TRIAL END: FAIL");
await closeDb();
process.exit(pass ? 0 : 1);
