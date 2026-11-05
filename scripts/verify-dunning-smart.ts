/**
 * Proves SMART / decline-aware dunning (Tier-1 gaps M10 + M11).
 *
 * A business with `dunning_config = { mode: 'smart' }` distinguishes decline
 * REASONS: soft declines retry, hard-but-recoverable declines PARK (invoice stays
 * open, subscription retained), truly unrecoverable declines terminate. Parking is
 * un-parked when the customer adds a good card (collect-on-payment-method-update).
 * A fixed-mode business is unaffected (regression case 4).
 *
 *   pnpm verify:dunning-smart
 */
import { eq, and, desc } from "drizzle-orm";
import { buildApp } from "@/index";
import { Tmbilling } from "../sdk/index";
import { systemDb, withTenant, closeDb } from "@/platform/db";
import { runWithClockScope } from "@/platform/clock";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import { createSubscription } from "@/modules/subscriptions/service";
import {
  billSubscriptionPeriod,
  collectInvoice,
  collectOutstandingForNewPaymentMethod,
} from "@/modules/invoicing/service";
import {
  applyDunningFinalAction,
  runDunningPass,
  sweepExpiredParkedDunning,
  sweepParkedReminders,
} from "@/modules/subscriptions/dunning";
import { publicId } from "@/platform/ids";
import { getDunningJourney } from "@/modules/invoicing/dunning-journey";
import {
  CARD_CAP_30D,
  RAIL_LIMIT_CODE,
  RAIL_SPACING_CODE,
} from "@/modules/invoicing/representment";
import {
  resolveDunningConfig,
  planFailureRearm,
  PARKED_GRACE_DAYS,
  DUNNING_RETRY_DAYS,
} from "@/modules/subscriptions/dunning-schedule";
import {
  classifyDecline,
  MERCHANT_SIDE_PARK,
  PARK_EVEN_IN_FIXED_MODE,
  RETRY_THEN_PARK_ATTEMPTS,
} from "@/modules/subscriptions/decline-policy";
import { subscriptions, invoices, businesses, payments, paymentMethods } from "@db/schema";

// Card tokens (see src/providers/tmtest/instruments.ts):
//   4000000000009995 → insufficient_funds (soft, retriable → retry)
//   4000000000000002 → hard_decline       (code card_declined, retriable=false → retry, then park)
const SOFT = "4000000000009995";
const HARD = "4000000000000002";
// 4000000000000069 → expired_card (retriable=false → smart mode parks on the first failure)
const EXPIRED = "4000000000000069";

async function setup(
  label: string,
  token: string,
  mode: "fixed" | "smart",
  extra?: { config?: Record<string, unknown>; timezone?: string; issuerCountry?: string },
) {
  const org = await createOrganization({ name: `SmartDun ${label}` });
  const orgId = org.organization.id;
  const biz = await createBusiness({
    organizationId: orgId,
    name: "Biz",
    defaultCurrency: "USD",
    livemode: "test",
  });
  // Opt into smart dunning via dunning_config.mode (default fixed).
  await withTenant(orgId, (tx) =>
    tx
      .update(businesses)
      .set({
        // Parking is off by default; these cases exercise it, so opt in unless overridden.
        dunningConfig: { mode, park_hard_declines: true, ...extra?.config },
        ...(extra?.timezone ? { timezone: extra.timezone } : {}),
      })
      .where(eq(businesses.id, biz.id)),
  );
  const customer = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: `${label}@a.com`,
  });
  const pm = await vaultPaymentMethod({
    organizationId: orgId,
    businessId: biz.id,
    customer,
    token,
  });
  if (extra?.issuerCountry)
    await withTenant(orgId, (tx) =>
      tx
        .update(paymentMethods)
        .set({ issuerCountry: extra.issuerCountry })
        .where(eq(paymentMethods.id, pm.id)),
    );
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
  const sub = await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: customer.id,
    now: new Date(),
    items: [{ price, quantity: 1 }],
    defaultPaymentMethodId: pm.id,
  });
  const { invoice } = await billSubscriptionPeriod({
    organizationId: orgId,
    businessId: biz.id,
    subscription: sub.subscription,
    // Non-null by construction: this fixture creates a subscription with NO trial, so it
    // starts `active` with a term. A trialling subscription has none (2026-08-25).
    periodStart: sub.subscription.currentPeriodStart!,
    periodEnd: sub.subscription.currentPeriodEnd!,
  });
  // Mirror the renewal/due path: a not_paid (terminal) invoice fires the final action
  // (which may cancel the sub). A payment_due (retry or parked) invoice leaves the sub
  // active. This is exactly the production trigger for exhaustion → cancel.
  const fresh = await getInv(orgId, invoice.id);
  if (fresh.status === "not_paid") {
    const config = await withTenant(orgId, async (tx) => {
      const [b] = await tx
        .select({
          dunningRetryDays: businesses.dunningRetryDays,
          dunningConfig: businesses.dunningConfig,
        })
        .from(businesses)
        .where(eq(businesses.id, biz.id))
        .limit(1);
      return resolveDunningConfig(b);
    });
    await applyDunningFinalAction({
      organizationId: orgId,
      businessId: biz.id,
      invoicePublicId: invoice.publicId,
      subscriptionId: sub.subscription.id,
      subscriptionPublicId: sub.subscription.publicId,
      config,
    });
  }
  return { orgId, bizId: biz.id, customer, sub: sub.subscription, invoiceId: invoice.id };
}

const getInv = (orgId: string, id: string) =>
  withTenant(
    orgId,
    async (tx) => (await tx.select().from(invoices).where(eq(invoices.id, id)).limit(1))[0]!,
  );
const getSub = (orgId: string, id: string) =>
  withTenant(
    orgId,
    async (tx) =>
      (await tx.select().from(subscriptions).where(eq(subscriptions.id, id)).limit(1))[0]!,
  );

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail: string) {
  if (ok) {
    passed++;
    console.log(`✅ ${name} — ${detail}`);
  } else {
    failed++;
    console.log(`❌ ${name} — ${detail}`);
  }
}

// ── Case 1: SMART soft decline (insufficient_funds) → retry scheduled, sub active ──
{
  const c = await setup("SoftRetry", SOFT, "smart");
  const inv = await getInv(c.orgId, c.invoiceId);
  const sub = await getSub(c.orgId, c.sub.id);
  check(
    "smart soft decline → retry",
    inv.status === "payment_due" &&
      inv.dunningStatus === "in_progress" &&
      inv.nextAttemptAt !== null &&
      sub.status === "active",
    `invoice=${inv.status}/${inv.dunningStatus} nextAttempt=${inv.nextAttemptAt !== null} sub=${sub.status}`,
  );
}

// ── Case 2: SMART generic decline (card_declined) → RETRIED first, sub still active ──
// It parks only after RETRY_THEN_PARK_ATTEMPTS failures; case 5 pins that threshold.
{
  const c = await setup("HardRetry", HARD, "smart");
  const inv = await getInv(c.orgId, c.invoiceId);
  const sub = await getSub(c.orgId, c.sub.id);
  check(
    "smart card_declined → retried on the schedule (sub retained)",
    inv.status === "payment_due" &&
      inv.dunningStatus === "in_progress" &&
      inv.nextAttemptAt !== null &&
      sub.status === "active",
    `invoice=${inv.status}/${inv.dunningStatus} nextAttempt=${inv.nextAttemptAt} sub=${sub.status}`,
  );
}

// ── Case 3: PARKED → add good card + collect-on-PM-update → paid, sub active (un-parked) ──
{
  const c = await setup("Unpark", EXPIRED, "smart");
  const inv0 = await getInv(c.orgId, c.invoiceId);
  const good = await vaultPaymentMethod({
    organizationId: c.orgId,
    businessId: c.bizId,
    customer: c.customer,
    token: "tok_4242",
  });
  const res = await collectOutstandingForNewPaymentMethod({
    organizationId: c.orgId,
    businessId: c.bizId,
    customerId: c.customer.id,
    paymentMethodPublicId: good.publicId,
  });
  const inv = await getInv(c.orgId, c.invoiceId);
  const sub = await getSub(c.orgId, c.sub.id);
  check(
    "parked → collect-on-PM-update un-parks",
    inv0.dunningStatus === "parked" &&
      inv.status === "paid" &&
      sub.status === "active" &&
      res.enabled &&
      res.collected.some((x) => x.invoice === inv.publicId && x.status === "succeeded"),
    `start=${inv0.status}/${inv0.dunningStatus} → invoice=${inv.status} sub=${sub.status} collected=${JSON.stringify(res.collected)}`,
  );
}

// ── Case 4: FIXED-mode business, SAME hard card → still cancels (regression) ──
{
  const c = await setup("FixedCancel", HARD, "fixed");
  const inv = await getInv(c.orgId, c.invoiceId);
  const sub = await getSub(c.orgId, c.sub.id);
  check(
    "fixed mode hard card → cancels (unchanged)",
    inv.status === "not_paid" && sub.status === "cancelled",
    `invoice=${inv.status}/${inv.dunningStatus} sub=${sub.status}`,
  );
}

// ── Case 5: terminate-class decline (fraud) routes to exhausted in smart mode ──
// No tmtest card yields a terminate-class code, so assert the policy + rearm directly.
{
  check(
    "classifyDecline: fraudulent → terminate; stolen_card/expired_card → park; card_declined/insufficient_funds → retry",
    classifyDecline("stolen_card") === "park" &&
      classifyDecline("fraudulent") === "terminate" &&
      classifyDecline("expired_card") === "park" &&
      classifyDecline("card_declined") === "retry" &&
      classifyDecline("insufficient_funds") === "retry" &&
      classifyDecline(undefined) === "retry",
    `stolen=${classifyDecline("stolen_card")} declined=${classifyDecline("card_declined")} insufficient=${classifyDecline("insufficient_funds")}`,
  );

  const base = {
    dunningStatus: null,
    currentNextAttemptAt: null,
    autoCollectOn: true,
    retriable: true,
    newAttemptCount: 1,
    retryDays: [1, 3, 5],
    now: new Date(),
  };
  const term = planFailureRearm({ ...base, mode: "smart", declineCode: "fraudulent" });
  const park = planFailureRearm({ ...base, mode: "smart", declineCode: "expired_card" });
  const fixedSame = planFailureRearm({ ...base, mode: "fixed", declineCode: "fraudulent" });
  check(
    "smart terminate → exhausted; smart park → parked; fixed ignores code → retry",
    term.action === "exhausted" && park.action === "parked" && fixedSame.action === "retry",
    `terminate=${term.action} park=${park.action} fixed=${fixedSame.action}`,
  );

  const generic = (n: number) =>
    planFailureRearm({
      ...base,
      retryDays: [1, 3, 5, 7],
      mode: "smart",
      declineCode: "card_declined",
      newAttemptCount: n,
    }).action;
  check(
    `smart card_declined retries, then parks on attempt ${RETRY_THEN_PARK_ATTEMPTS}`,
    generic(1) === "retry" &&
      generic(RETRY_THEN_PARK_ATTEMPTS - 1) === "retry" &&
      generic(RETRY_THEN_PARK_ATTEMPTS) === "parked",
    `1=${generic(1)} ${RETRY_THEN_PARK_ATTEMPTS - 1}=${generic(RETRY_THEN_PARK_ATTEMPTS - 1)} ${RETRY_THEN_PARK_ATTEMPTS}=${generic(RETRY_THEN_PARK_ATTEMPTS)}`,
  );
}

// ── Case 6: the 2026-09-04 decision — EVERY park gets a dunning deadline ──────────
//
// Until 2026-09-04 the sweep gated on an allowlist, `PARKED_WITH_DEADLINE`, which had
// reached 4 of `PARK`'s 13 codes. `expired_card` was not one of them, so the textbook
// dunning case parked forever: no retry, no deadline, no final action, subscription
// serving on an unpaid invoice indefinitely. This block covers both the codes that
// already had a deadline and the two the removal adds — a customer-clearable card
// decline (`expired_card`) and a merchant-side one (`recurring_not_enabled`), which is
// the deliberate behaviour change and the reason the ops alert exists.
//
// `sweepExpiredParkedDunning` decides eligibility purely from the latest FAILED
// payment's `failure_code` (dunning.ts:406-411), so parking a HARD-decline invoice via
// the real fixture and then relabelling that payment's code is a faithful trace of the
// exact codepath a real mandate refusal reaches — without needing collection.ts's
// mandate pre-flight (out of this task's file boundary) to manufacture one.
async function relabelLatestFailure(orgId: string, invoiceId: string, code: string) {
  await withTenant(orgId, async (tx) => {
    const [latest] = await tx
      .select({ id: payments.id })
      .from(payments)
      .where(and(eq(payments.invoiceId, invoiceId), eq(payments.status, "failed")))
      .orderBy(desc(payments.createdAt))
      .limit(1);
    if (!latest) throw new Error("no failed payment to relabel");
    await tx.update(payments).set({ failureCode: code }).where(eq(payments.id, latest.id));
  });
}
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);

/**
 * ⚠️ SCOPED, and it must stay scoped. `sweepExpiredParkedDunning` scans EVERY parked
 * invoice in the database — that is what a clock pass is — and the cases below hand it a
 * `now` up to a YEAR ahead. Unscoped, one run of this suite exhausted the whole local
 * parked book and cancelled 41 subscriptions belonging to other data (measured
 * 2026-09-04, on a dev database, by me, while proving this very change).
 *
 * It was survivable before 2026-09-04 only by accident: the removed `PARKED_WITH_DEADLINE`
 * allowlist happened to exclude the codes the local book was parked on. Removing the gate
 * is what made the suite destructive, so the scope is part of that change, not a tidy-up.
 *
 * `runWithClockScope({ onlyBusinessId })` is the mechanism the clock already has for this:
 * every pass ANDs `scanBusinessFilter` into its top-level scan (`platform/clock.ts`).
 */
const sweepParked = (bizId: string, at: Date) =>
  runWithClockScope({ onlyBusinessId: bizId, now: at }, () => sweepExpiredParkedDunning(at));

for (const code of [
  "mandate_expired",
  "mandate_ceiling_exceeded",
  "mandate_spent",
  // Both were parked FOREVER before 2026-09-04. `expired_card` is the regression that
  // makes the old allowlist indefensible; `recurring_not_enabled` is the one the user
  // knowingly accepted, protected by an alert rather than by an exemption.
  "expired_card",
  "recurring_not_enabled",
]) {
  // 6a: classifies as `park`. There is no allowlist left to be in — that is the point.
  check(
    `${code}: classifies as park`,
    classifyDecline(code) === "park",
    `classify=${classifyDecline(code)} merchant_side=${MERCHANT_SIDE_PARK.has(code)}`,
  );

  // 6b: parked, no dunning_period_days configured (business default) — NOT a no-op.
  // `parkedDunningDeadline` never returns null; with no period it falls back to
  // `PARKED_GRACE_DAYS`, exactly like `afa_not_completed` already did. Before its
  // deadline: no-op. At/after: exhausted + the business's default final action
  // (cancel) fires.
  //
  // ⚠️ Day 7 is asserted as STILL PARKED on purpose. It was the deadline until
  // 2026-09-01, when the fallback stopped borrowing the retry schedule's tail — a
  // parked invoice has had zero charge attempts and its clock measures time for the
  // CUSTOMER to re-authorise at their bank. Reverting that constant fails here.
  {
    const c = await setup(`Deadline_${code}`, EXPIRED, "smart");
    await relabelLatestFailure(c.orgId, c.invoiceId, code);
    const parkedRow = await getInv(c.orgId, c.invoiceId);
    // The anchor assertion (0232). Every deadline below is measured from the PARK, and
    // the caller falls back to the due date when the stamp is missing — so if the real
    // park path ever stopped stamping, this suite would keep passing on the fallback
    // and say nothing. Assert the stamp itself, once, on the real codepath.
    check(
      `${code}: the park stamped dunning_parked_at`,
      parkedRow.dunningParkedAt != null,
      `parked_at=${parkedRow.dunningParkedAt?.toISOString() ?? "null"} due=${
        parkedRow.dueDate?.toISOString() ?? "null"
      }`,
    );
    const anchor = parkedRow.dunningParkedAt ?? parkedRow.dueDate!;

    // NB: `sweepExpiredParkedDunning` scans every parked invoice, not just this one
    // (it is the same tick pass a real clock runs) — other cases in this script also
    // park invoices around the same wall-clock `now`, so `out.exhausted` is a
    // GLOBAL count, not this invoice's. What proves the trace is THIS invoice's own
    // row, checked directly.
    const retryTail = DUNNING_RETRY_DAYS[DUNNING_RETRY_DAYS.length - 1]!;
    const early = await sweepParked(c.bizId, addDays(anchor, PARKED_GRACE_DAYS - 1));
    const invEarly = await getInv(c.orgId, c.invoiceId);
    check(
      `${code}: before its (fallback) deadline, sweep is a no-op`,
      invEarly.status === "payment_due" && invEarly.dunningStatus === "parked",
      `day=${PARKED_GRACE_DAYS - 1} invoice=${invEarly.status}/${invEarly.dunningStatus} (global exhausted this pass=${early.exhausted})`,
    );

    // The regression guard: the OLD fallback would have closed the window here.
    const atTail = await sweepParked(c.bizId, addDays(anchor, retryTail));
    const invTail = await getInv(c.orgId, c.invoiceId);
    check(
      `${code}: the retry schedule's tail (day ${retryTail}) is NOT the parked deadline`,
      invTail.status === "payment_due" && invTail.dunningStatus === "parked",
      `day=${retryTail} invoice=${invTail.status}/${invTail.dunningStatus} (global exhausted this pass=${atTail.exhausted})`,
    );

    const late = await sweepParked(c.bizId, addDays(anchor, PARKED_GRACE_DAYS));
    const invLate = await getInv(c.orgId, c.invoiceId);
    const subLate = await getSub(c.orgId, c.sub.id);
    check(
      `${code}: at the fallback deadline (day ${PARKED_GRACE_DAYS}, no period configured), the window closes and the default final action cancels`,
      invLate.status === "not_paid" &&
        invLate.dunningStatus === "exhausted" &&
        subLate.status === "cancelled",
      `day=${PARKED_GRACE_DAYS} invoice=${invLate.status}/${invLate.dunningStatus} sub=${subLate.status} (global exhausted this pass=${late.exhausted})`,
    );
  }
}

// 6e: a seized card is held with parking OFF, and its deadline closes the window
// WITHOUT charging the dead card again.
{
  const off = {
    dunningStatus: "in_progress",
    currentNextAttemptAt: addDays(new Date(), 2), // an armed retry must not keep it
    autoCollectOn: true,
    retriable: false,
    newAttemptCount: 1,
    retryDays: [1, 3, 5],
    now: new Date(),
    mode: "smart" as const,
    parkHardDeclines: false,
  };
  const held = ["lost_card", "stolen_card", "pickup_card"].map(
    (code) => planFailureRearm({ ...off, declineCode: code }).action,
  );
  const fixedHeld = planFailureRearm({
    ...off,
    mode: "fixed",
    dunningStatus: null,
    currentNextAttemptAt: null,
    declineCode: "pickup_card",
  }).action;
  check(
    "smart + parking off: lost/stolen/seized card → parked; fixed mode unchanged → exhausted",
    held.every((a) => a === "parked") && fixedHeld === "exhausted",
    `held=${held.join(",")} fixed=${fixedHeld}`,
  );

  const c = await setup("Deadline_HeldCard", EXPIRED, "smart");
  await relabelLatestFailure(c.orgId, c.invoiceId, "pickup_card");
  await withTenant(c.orgId, (tx) =>
    tx
      .update(businesses)
      .set({ dunningConfig: { mode: "smart", park_hard_declines: false } })
      .where(eq(businesses.id, c.bizId)),
  );
  const anchor = (await getInv(c.orgId, c.invoiceId)).dunningParkedAt!;
  const attempts = async () =>
    (
      await withTenant(c.orgId, (tx) =>
        tx.select({ id: payments.id }).from(payments).where(eq(payments.invoiceId, c.invoiceId)),
      )
    ).length;
  const before = await attempts();
  await sweepParked(c.bizId, addDays(anchor, PARKED_GRACE_DAYS - 1));
  const invEarly = await getInv(c.orgId, c.invoiceId);
  await sweepParked(c.bizId, addDays(anchor, PARKED_GRACE_DAYS));
  const invLate = await getInv(c.orgId, c.invoiceId);
  const after = await attempts();
  check(
    `pickup_card: held ${PARKED_GRACE_DAYS} days with parking off, then closes without re-presenting the card`,
    invEarly.dunningStatus === "parked" &&
      invLate.status === "not_paid" &&
      invLate.dunningStatus === "exhausted" &&
      after === before,
    `early=${invEarly.status}/${invEarly.dunningStatus} late=${invLate.status}/${invLate.dunningStatus} payments ${before}→${after}`,
  );
}

// 6c: an EXPLICIT dunning_period_days shortens the deadline to that period, not the
// `PARKED_GRACE_DAYS` fallback — same one of the three codes, different business config.
// The merchant's configured period wins in both directions.
{
  const c = await setup("Deadline_ExplicitPeriod", EXPIRED, "smart");
  await withTenant(c.orgId, (tx) =>
    tx
      .update(businesses)
      .set({ dunningConfig: { mode: "smart", dunning_period_days: 3 } })
      .where(eq(businesses.id, c.bizId)),
  );
  await relabelLatestFailure(c.orgId, c.invoiceId, "mandate_expired");
  const anchor = (await getInv(c.orgId, c.invoiceId)).dunningParkedAt!;

  await sweepParked(c.bizId, addDays(anchor, 2));
  const invEarly = await getInv(c.orgId, c.invoiceId);
  check(
    "mandate_expired: an explicit 3-day period is honoured, not the grace fallback",
    invEarly.status === "payment_due",
    `day=2 invoice=${invEarly.status}`,
  );

  await sweepParked(c.bizId, addDays(anchor, 3));
  const invLate = await getInv(c.orgId, c.invoiceId);
  check(
    `mandate_expired: …and closes at day 3, not day ${PARKED_GRACE_DAYS}`,
    invLate.status === "not_paid",
    `day=3 invoice=${invLate.status}`,
  );
}

// 6d: the TRUE no-op is the business's master dunning switch, not the period. With
// dunning disabled, none of the three codes ever gets a cancellation through this
// sweep, no matter how much time passes.
{
  const c = await setup("Deadline_DunningOff", EXPIRED, "smart");
  await withTenant(c.orgId, (tx) =>
    tx
      .update(businesses)
      .set({ dunningConfig: { mode: "smart", enabled: false } })
      .where(eq(businesses.id, c.bizId)),
  );
  await relabelLatestFailure(c.orgId, c.invoiceId, "mandate_ceiling_exceeded");
  const anchor = (await getInv(c.orgId, c.invoiceId)).dunningParkedAt!;

  await sweepParked(c.bizId, addDays(anchor, 365));
  const inv = await getInv(c.orgId, c.invoiceId);
  const sub = await getSub(c.orgId, c.sub.id);
  check(
    "mandate_ceiling_exceeded: dunning switched OFF stays a no-op even a year later",
    inv.status === "payment_due" && inv.dunningStatus === "parked" && sub.status === "active",
    `day=365 invoice=${inv.status}/${inv.dunningStatus} sub=${sub.status}`,
  );
}

/**
 * ── The parked REMINDER ladder (0283) ────────────────────────────────────────
 *
 * A park attempts nothing, so it used to say nothing: one notice at the moment of
 * parking, then silence for the whole window, then a cancellation. These cases pin the
 * three properties that make the ladder safe rather than merely present.
 *
 * Scoped for the same reason `sweepParked` is — it is a clock pass over every parked
 * invoice in the database, and these cases hand it instants weeks ahead.
 */
{
  const remind = (bizId: string, at: Date) =>
    runWithClockScope({ onlyBusinessId: bizId, now: at }, () => sweepParkedReminders(at));

  const c = await setup("Reminders", EXPIRED, "smart");
  await relabelLatestFailure(c.orgId, c.invoiceId, "expired_card");
  const parked = await getInv(c.orgId, c.invoiceId);
  const anchor = parked.dunningParkedAt!;

  // 1. Parking ARMS the ladder. Nothing else writes this column, so an unarmed park is a
  //    park that will never speak — the defect this whole pass exists to fix.
  check(
    "reminders: parking arms the first rung",
    parked.dunningNextReminderAt != null,
    `next_reminder=${parked.dunningNextReminderAt?.toISOString() ?? "null"} parked=${anchor.toISOString()}`,
  );

  /**
   * 2. ⚠️ THE RUNG IS NOT IN `next_attempt_at`. The single most dangerous thing this
   *    feature could do is write a reminder instant where the charging pass looks: a
   *    parked invoice is auto-collect-ON, so `runDunningPass` would re-present the very
   *    debit parking exists to stop, and the expiry sweep (which scans
   *    `next_attempt_at IS NULL`) would stop seeing the row at all.
   */
  check(
    "reminders: the rung is NOT written into next_attempt_at",
    parked.nextAttemptAt === null,
    `next_attempt=${parked.nextAttemptAt?.toISOString() ?? "null"}`,
  );

  // 3. The pass advances the ladder and leaves the invoice parked — it never charges,
  //    never settles, never closes the window. Driven at the first rung.
  const firstRung = parked.dunningNextReminderAt!;
  const r1 = await remind(c.bizId, new Date(firstRung.getTime() + 1000));
  const after = await getInv(c.orgId, c.invoiceId);
  check(
    "reminders: a rung fires, and the invoice is still parked and uncharged",
    r1.reminded === 1 &&
      after.status === "payment_due" &&
      after.dunningStatus === "parked" &&
      after.attemptCount === parked.attemptCount,
    `reminded=${r1.reminded} invoice=${after.status}/${after.dunningStatus} attempts=${parked.attemptCount}→${after.attemptCount}`,
  );
  check(
    "reminders: …and the next rung is strictly later than the one just sent",
    after.dunningNextReminderAt == null ||
      after.dunningNextReminderAt.getTime() > firstRung.getTime(),
    `next=${after.dunningNextReminderAt?.toISOString() ?? "null"} fired=${firstRung.toISOString()}`,
  );

  /**
   * 4. A SECOND PASS AT THE SAME INSTANT SENDS NOTHING. The rung is advanced under a
   *    conditional update, so two overlapping ticks cannot both mail the customer — the
   *    loser matches no row. Without this the ladder would mail on every tick.
   */
  const r2 = await remind(c.bizId, new Date(firstRung.getTime() + 2000));
  check(
    "reminders: re-running the same instant does not mail again",
    r2.reminded === 0,
    `reminded=${r2.reminded}`,
  );

  /**
   * 5. THE LADDER STOPS AT THE DEADLINE, and never rings on or past it. The deadline
   *    belongs to `sweepExpiredParkedDunning`, which makes the one attempt and closes the
   *    window; a "you have until…" notice sent the day the time ran out is worse than
   *    none. Driven a year out, which is well past any window.
   */
  const r3 = await remind(c.bizId, addDays(anchor, 365));
  const late = await getInv(c.orgId, c.invoiceId);
  /**
   * ⚠️ BOTH HALVES, and the `and` is the point. Written first as an `or`, this passed
   * while a reminder DID fire a year past the deadline — "settle by <date>" delivered
   * after <date>, to a customer the same tick would cancel. The ordinary tick hides it
   * (the expiry sweep runs first and the row is no longer parked), so an `or` here would
   * have made the safety a property of the ORDER of two passes and nothing would have
   * said so.
   */
  check(
    "reminders: the ladder never rings at or past the deadline",
    r3.reminded === 0 && late.dunningNextReminderAt === null,
    `reminded=${r3.reminded} next=${late.dunningNextReminderAt?.toISOString() ?? "null"}`,
  );
}

/**
 * ── The park window cannot be restarted (Phase 1) ────────────────────────────
 *
 * `dunning_parked_at` was written on EVERY park, so anything that re-parked an
 * already-parked invoice reset its thirty-day clock: a portal Pay-now that failed, a
 * customer adding a second bad card, any manual collect. The window
 * `sweepExpiredParkedDunning` exists to close could be pushed out indefinitely by a
 * customer who never paid.
 */
{
  const c = await setup("ReparkClock", EXPIRED, "smart");
  const before = await getInv(c.orgId, c.invoiceId);
  check(
    "re-park: the first park stamped an anchor and a reminder rung",
    before.dunningStatus === "parked" && before.dunningParkedAt != null,
    `status=${before.dunningStatus} parked_at=${before.dunningParkedAt?.toISOString() ?? "null"}`,
  );

  // A second failed attempt on the SAME invoice — the shape a failed portal Pay-now or a
  // manual "Collect now" produces. It re-parks, and must not move the clock.
  await collectInvoice({
    organizationId: c.orgId,
    businessId: c.bizId,
    invoice: before,
    subscription: c.sub,
    manualAttempt: true,
  });
  const after = await getInv(c.orgId, c.invoiceId);
  check(
    "re-park: a second failure does NOT restart the park window",
    after.dunningStatus === "parked" &&
      after.dunningParkedAt?.getTime() === before.dunningParkedAt?.getTime(),
    `before=${before.dunningParkedAt?.toISOString()} after=${after.dunningParkedAt?.toISOString()}`,
  );
  check(
    "re-park: …and does not replay the reminder ladder from the top",
    after.dunningNextReminderAt?.getTime() === before.dunningNextReminderAt?.getTime(),
    `before=${before.dunningNextReminderAt?.toISOString() ?? "null"} after=${after.dunningNextReminderAt?.toISOString() ?? "null"}`,
  );
}

/**
 * ── A customer with NO instrument parks, rather than burning a ladder ────────
 *
 * `no_payment_method` was unclassified and `retriable`, so the population that most
 * obviously has to act got the SHORTEST rope: the full ladder against an instrument that
 * does not exist, then cancellation in about a week, while a merely-declined card parked
 * for thirty days. Every rung was a charge refused before a gateway was asked.
 */
{
  check(
    "no_payment_method: classifies as park, in both modes",
    classifyDecline("no_payment_method") === "park" &&
      PARK_EVEN_IN_FIXED_MODE.has("no_payment_method"),
    `classify=${classifyDecline("no_payment_method")} fixed=${PARK_EVEN_IN_FIXED_MODE.has("no_payment_method")}`,
  );
  // …and it is the customer's to clear, so it must NOT raise the merchant-side alert.
  check(
    "no_payment_method: is not a merchant-side park",
    !MERCHANT_SIDE_PARK.has("no_payment_method"),
    `merchant_side=${MERCHANT_SIDE_PARK.has("no_payment_method")}`,
  );
}

// ── Adaptive retry timing, through the real failure writer ──────────────────────────
// insufficient_funds on a card, smart + adaptive_timing, business in Asia/Kolkata: the
// retry lands on a payday (1st / 15th / month end) at 10:00 IST, at least a day out.
{
  const startedAt = Date.now();
  const c = await setup("Adaptive", SOFT, "smart", {
    config: { adaptive_timing: true },
    timezone: "Asia/Kolkata",
  });
  const inv = await getInv(c.orgId, c.invoiceId);
  const next = inv.nextAttemptAt;
  const local = next
    ? (Object.fromEntries(
        new Intl.DateTimeFormat("en-CA", {
          timeZone: "Asia/Kolkata",
          hourCycle: "h23",
          year: "numeric",
          month: "numeric",
          day: "numeric",
          hour: "numeric",
          minute: "numeric",
        })
          .formatToParts(next)
          .filter((p) => p.type !== "literal")
          .map((p) => [p.type, Number(p.value)]),
      ) as Record<"year" | "month" | "day" | "hour" | "minute", number>)
    : null;
  const lastDay = local ? new Date(Date.UTC(local.year, local.month, 0)).getUTCDate() : 0;
  check(
    "adaptive timing: insufficient funds retries on a payday at 10:00 local",
    inv.dunningStatus === "in_progress" &&
      local !== null &&
      local.hour === 10 &&
      local.minute === 0 &&
      [1, 15, lastDay].includes(local.day) &&
      next!.getTime() >= startedAt + 24 * 3600 * 1000,
    `status=${inv.dunningStatus} next=${next?.toISOString() ?? "null"} local=${JSON.stringify(local)}`,
  );
}

// ── …and aims at the card's country, not the business's ────────────────────────────
// A UK-issued card on the same Asia/Kolkata business: 10:00 London, read through the
// seeded `countries.timezones`.
{
  const c = await setup("AdaptiveUk", SOFT, "smart", {
    config: { adaptive_timing: true },
    timezone: "Asia/Kolkata",
    issuerCountry: "GB",
  });
  const next = (await getInv(c.orgId, c.invoiceId)).nextAttemptAt;
  const london = next
    ? new Intl.DateTimeFormat("en-GB", {
        timeZone: "Europe/London",
        hourCycle: "h23",
        hour: "2-digit",
        minute: "2-digit",
      }).format(next)
    : null;
  check(
    "adaptive timing: a UK card retries at 10:00 London",
    london === "10:00",
    `next=${next?.toISOString() ?? "null"} london=${london}`,
  );
}

// ── Network rules: a decline code never blocks a card; attempts are capped per card ──
const presented = (orgId: string, invoiceId: string) =>
  withTenant(
    orgId,
    async (tx) =>
      (
        await tx
          .select({ key: payments.providerKey })
          .from(payments)
          .where(eq(payments.invoiceId, invoiceId))
      ).filter((p) => p.key !== "none").length,
  );
const newestPayment = (orgId: string, invoiceId: string) =>
  withTenant(
    orgId,
    async (tx) =>
      (
        await tx
          .select()
          .from(payments)
          .where(eq(payments.invoiceId, invoiceId))
          .orderBy(desc(payments.createdAt))
          .limit(1)
      )[0]!,
  );
{
  // A manual Collect presents a card whatever its last decline code said.
  const c = await setup("RepresentByHand", EXPIRED, "smart");
  const before = await presented(c.orgId, c.invoiceId);
  await collectInvoice({
    organizationId: c.orgId,
    businessId: c.bizId,
    invoice: await getInv(c.orgId, c.invoiceId),
    subscription: c.sub,
    manualAttempt: true,
  });
  const after = await presented(c.orgId, c.invoiceId);
  const newest = await newestPayment(c.orgId, c.invoiceId);
  check(
    "network rules: an expired card is presented again by hand",
    after === before + 1 && newest.providerKey !== "none",
    `presented ${before}→${after} newest=${newest.providerKey}/${newest.failureCode}`,
  );
}
{
  // The park's deadline attempt presents the card too, then the window closes.
  const c = await setup("RepresentDeadline", EXPIRED, "smart");
  const before = await presented(c.orgId, c.invoiceId);
  const anchor = (await getInv(c.orgId, c.invoiceId)).dunningParkedAt!;
  await sweepParked(c.bizId, addDays(anchor, 365));
  const inv = await getInv(c.orgId, c.invoiceId);
  const after = await presented(c.orgId, c.invoiceId);
  check(
    "network rules: the deadline attempt presents an expired card, and still closes",
    after === before + 1 && inv.status === "not_paid" && inv.dunningStatus === "exhausted",
    `presented ${before}→${after} invoice=${inv.status}/${inv.dunningStatus}`,
  );
}
{
  // Parking off (the default): the same hard decline stays on the retry schedule.
  const c = await setup("ParkOff", EXPIRED, "smart", {
    config: { park_hard_declines: false, dunning_period_days: 10 },
  });
  const inv = await getInv(c.orgId, c.invoiceId);
  const sub = await getSub(c.orgId, c.sub.id);
  check(
    "park_hard_declines off: an expired card retries on the schedule instead of parking",
    inv.status === "payment_due" &&
      inv.dunningStatus === "in_progress" &&
      inv.nextAttemptAt != null &&
      inv.dunningParkedAt == null &&
      sub.status === "active",
    `invoice=${inv.status}/${inv.dunningStatus} next=${inv.nextAttemptAt?.toISOString() ?? "null"} sub=${sub.status}`,
  );
}
// ── NPCI rail rules: a mandate is never presented past its cap or inside NACH's gap ──
const onRail = async (label: string, rail: string) => {
  const c = await setup(label, SOFT, "smart");
  const first = await newestPayment(c.orgId, c.invoiceId);
  await withTenant(c.orgId, (tx) =>
    tx
      .update(paymentMethods)
      .set({ mandateRail: rail, mandateMaxAmountMinor: 99_999_999n, mandateCurrency: "USD" })
      .where(eq(paymentMethods.id, first.paymentMethodId!)),
  );
  return { ...c, first };
};
const collectByHand = async (c: Awaited<ReturnType<typeof setup>>) =>
  collectInvoice({
    organizationId: c.orgId,
    businessId: c.bizId,
    invoice: await getInv(c.orgId, c.invoiceId),
    subscription: c.sub,
    manualAttempt: true,
  });
const backdatePresentations = (orgId: string, invoiceId: string, days: number) =>
  withTenant(orgId, (tx) =>
    tx
      .update(payments)
      .set({ createdAt: new Date(Date.now() - days * 86_400_000) })
      .where(eq(payments.invoiceId, invoiceId)),
  );
{
  // UPI Autopay: 1 execution + 3 retries. A 5th presentation is refused before the network.
  const c = await onRail("UpiCap", "upi");
  const inv0 = await getInv(c.orgId, c.invoiceId);
  await withTenant(c.orgId, async (tx) => {
    for (let i = 0; i < 3; i++)
      await tx.insert(payments).values({
        organizationId: c.orgId,
        businessId: c.bizId,
        customerId: inv0.customerId,
        invoiceId: c.invoiceId,
        paymentMethodId: c.first.paymentMethodId,
        publicId: publicId("pay"),
        status: "failed",
        amountMinor: 5000n,
        currency: "USD",
        providerKey: c.first.providerKey,
        failureCode: "insufficient_funds",
        createdAt: new Date(Date.now() - (i + 2) * 86_400_000),
      });
  });
  const before = await presented(c.orgId, c.invoiceId);
  await collectByHand(c);
  const after = await presented(c.orgId, c.invoiceId);
  const newest = await newestPayment(c.orgId, c.invoiceId);
  check(
    "NPCI: a UPI mandate at 1 + 3 presentations is not presented again, even by hand",
    after === before && newest.providerKey === "none" && newest.failureCode === RAIL_LIMIT_CODE,
    `presented ${before}→${after} newest=${newest.providerKey}/${newest.failureCode}`,
  );
}
{
  // NACH: no re-presentation within 3 days of a return; allowed after it.
  const c = await onRail("NachGap", "nach");
  const before = await presented(c.orgId, c.invoiceId);
  await collectByHand(c);
  const early = await newestPayment(c.orgId, c.invoiceId);
  const afterEarly = await presented(c.orgId, c.invoiceId);
  check(
    "NPCI: a NACH debit is not re-presented within 3 days of its return",
    afterEarly === before &&
      early.providerKey === "none" &&
      early.failureCode === RAIL_SPACING_CODE,
    `presented ${before}→${afterEarly} newest=${early.providerKey}/${early.failureCode}`,
  );
  await backdatePresentations(c.orgId, c.invoiceId, 4);
  await collectByHand(c);
  const afterGap = await presented(c.orgId, c.invoiceId);
  check(
    "NPCI: …and is presented once the 3 days have passed",
    afterGap === afterEarly + 1,
    `presented ${afterEarly}→${afterGap}`,
  );
}
{
  // Per-card cap: a card already at its 30-day limit is not retried; the retry waits.
  const c = await setup("CardCap", SOFT, "smart");
  const inv0 = await getInv(c.orgId, c.invoiceId);
  const first = await newestPayment(c.orgId, c.invoiceId);
  const now = new Date();
  await withTenant(c.orgId, async (tx) => {
    for (let i = 0; i < CARD_CAP_30D; i++)
      await tx.insert(payments).values({
        organizationId: c.orgId,
        businessId: c.bizId,
        customerId: inv0.customerId,
        invoiceId: null,
        paymentMethodId: first.paymentMethodId,
        publicId: publicId("pay"),
        status: "failed",
        amountMinor: 5000n,
        currency: "USD",
        providerKey: first.providerKey,
        failureCode: "insufficient_funds",
        createdAt: new Date(now.getTime() - (i + 2) * 86_400_000),
      });
    await tx
      .update(invoices)
      .set({ nextAttemptAt: new Date(now.getTime() - 60_000) })
      .where(eq(invoices.id, c.invoiceId));
  });
  const before = await presented(c.orgId, c.invoiceId);
  await runWithClockScope({ onlyBusinessId: c.bizId, now }, () => runDunningPass(now));
  const inv = await getInv(c.orgId, c.invoiceId);
  const after = await presented(c.orgId, c.invoiceId);
  check(
    "network rules: a card at its 30-day attempt limit is not retried; the retry is deferred",
    after === before && inv.nextAttemptAt != null && inv.nextAttemptAt > now,
    `presented ${before}→${after} next=${inv.nextAttemptAt?.toISOString() ?? "null"}`,
  );
}

// ── Dunning journey: the attempt so far, then the engine's own forecast ──
{
  const c = await setup("Journey", SOFT, "smart", { config: { dunning_period_days: 10 } });
  const bizRow = await withTenant(
    c.orgId,
    async (tx) =>
      (await tx.select().from(businesses).where(eq(businesses.id, c.bizId)).limit(1))[0]!,
  );
  const inv = await getInv(c.orgId, c.invoiceId);
  const j = await getDunningJourney({
    organizationId: c.orgId,
    business: bizRow,
    invoicePublicId: inv.publicId,
  });
  const attempts = j?.history.filter((h) => h.kind === "attempt") ?? [];
  const steps = j?.projection ?? [];
  check(
    "journey: the failed charge is on the record with its transaction and refusal",
    attempts.length === 1 &&
      attempts[0]!.kind === "attempt" &&
      attempts[0]!.transaction != null &&
      attempts[0]!.failureCode === "insufficient_funds" &&
      attempts[0]!.presented,
    JSON.stringify(
      attempts.map((a) => a.kind === "attempt" && [a.status, a.failureCode, a.transaction]),
    ),
  );
  check(
    "journey: the forecast starts at the armed retry and ends in the final action",
    steps.length >= 2 &&
      steps[0]!.at.getTime() === inv.nextAttemptAt?.getTime() &&
      steps.at(-1)!.kind === "final_action",
    steps.map((s) => `${s.kind}@${s.at.toISOString()}`).join(" "),
  );
}

// ── Adaptive retry timing survives the settings API ─────────────────────────────────
// The route assigns dunning_config whole and strips undeclared keys; an undeclared
// `adaptive_timing` would vanish on every settings save.
{
  const app = await buildApp({ logger: false });
  await app.listen({ port: 0, host: "127.0.0.1" });
  try {
    const port = (app.server.address() as { port: number }).port;
    const org = await createOrganization({ name: "SmartDun AdaptiveApi" });
    const tmb = new Tmbilling({ apiKey: org.secret, baseUrl: `http://127.0.0.1:${port}` });
    const biz = await tmb.businesses.create({
      name: "Adaptive API",
      default_currency: "USD",
      livemode: "test",
    });
    const on = (await tmb.businesses.update(biz.id, {
      dunning_config: { mode: "smart", adaptive_timing: true },
    } as never)) as { dunning_config?: { adaptive_timing?: boolean } | null };
    const off = (await tmb.businesses.update(biz.id, {
      dunning_config: { mode: "smart" },
    } as never)) as { dunning_config?: Record<string, unknown> | null };
    const park = (await tmb.businesses.update(biz.id, {
      dunning_config: { mode: "smart", park_hard_declines: true },
    } as never)) as { dunning_config?: { park_hard_declines?: boolean } | null };
    check(
      "park_hard_declines: stored through the settings API, and off when omitted",
      park.dunning_config?.park_hard_declines === true &&
        resolveDunningConfig({ dunningConfig: off.dunning_config }).parkHardDeclines === false,
      `on=${JSON.stringify(park.dunning_config)}`,
    );
    check(
      "adaptive timing: stored through the settings API, and off when omitted",
      on.dunning_config?.adaptive_timing === true &&
        resolveDunningConfig({ dunningConfig: off.dunning_config }).adaptiveTiming === false,
      `on=${JSON.stringify(on.dunning_config)} off=${JSON.stringify(off.dunning_config)}`,
    );
  } finally {
    await app.close();
  }
}

console.log("");
console.log(`${passed} passed, ${failed} failed`);
await closeDb();
process.exit(failed === 0 ? 0 : 1);
