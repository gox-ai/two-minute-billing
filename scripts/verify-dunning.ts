/**
 * Proves dunning: a failed charge schedules retries; fixing the card recovers the
 * subscription; an unfixable card exhausts the schedule and cancels it.
 * Retries are days apart, so we backdate next_attempt_at to force each pass.
 *
 *   pnpm verify:dunning
 */
import { and, eq } from "drizzle-orm";
import { systemDb, withTenant, closeDb } from "@/platform/db";
import { buildApp } from "@/index";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createCustomer, updateCustomer } from "@/modules/customers/service";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import { cancelSubscription, createSubscription } from "@/modules/subscriptions/service";
import {
  billSubscriptionPeriod,
  collectOutstandingForNewPaymentMethod,
} from "@/modules/invoicing/service";
import { collectInvoiceNow, recordOfflinePayment } from "@/modules/invoicing/ops";
import {
  retryDueInvoice,
  runDunningPass,
  sweepExpiredParkedDunning,
} from "@/modules/subscriptions/dunning";
import { getDunningJourney } from "@/modules/invoicing/dunning-journey";
import { MAX_ATTEMPTS, PARKED_GRACE_DAYS } from "@/modules/subscriptions/dunning-schedule";
import { runWithClockScope } from "@/platform/clock";
import {
  auditLogs,
  subscriptions,
  invoices,
  paymentMethods,
  payments,
  businesses,
  events,
} from "@db/schema";

async function setup(
  label: string,
  token: string,
  opts: { dunningConfig?: Record<string, unknown>; excluded?: boolean } = {},
) {
  const org = await createOrganization({ name: `Dunning ${label}` });
  const orgId = org.organization.id;
  const biz = await createBusiness({
    organizationId: orgId,
    name: "Biz",
    defaultCurrency: "USD",
    livemode: "test",
  });
  // These cases exercise parking, which is off by default.
  await systemDb
    .update(businesses)
    .set({ dunningConfig: { park_hard_declines: true, ...opts.dunningConfig } })
    .where(eq(businesses.id, biz.id));
  const customer = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: "d@a.com",
    dunningExcluded: opts.excluded,
  });
  const pm = await vaultPaymentMethod({
    organizationId: orgId,
    businessId: biz.id,
    customer,
    token,
  });
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
  // First bill (bad card => fails, schedules retry). The sub stays `active` while
  // its invoice duns (no past_due sub status); dunning-exhaust cancels.
  const { invoice } = await billSubscriptionPeriod({
    organizationId: orgId,
    businessId: biz.id,
    subscription: sub.subscription,
    // Non-null by construction: this fixture creates a subscription with NO trial, so it
    // starts `active` with a term. A trialling subscription has none (2026-08-25).
    periodStart: sub.subscription.currentPeriodStart!,
    periodEnd: sub.subscription.currentPeriodEnd!,
  });
  return { orgId, bizId: biz.id, customer, sub: sub.subscription, invoiceId: invoice.id };
}

// Same as setup() but never vaults a card — auto-collection defaults ON, so the
// first bill fails with `no_payment_method` and arms dunning.
async function setupNoCard(label: string) {
  const org = await createOrganization({ name: `Dunning ${label}` });
  const orgId = org.organization.id;
  const biz = await createBusiness({
    organizationId: orgId,
    name: "Biz",
    defaultCurrency: "USD",
    livemode: "test",
  });
  // These cases exercise parking, which is off by default.
  await systemDb
    .update(businesses)
    .set({ dunningConfig: { park_hard_declines: true } })
    .where(eq(businesses.id, biz.id));
  const customer = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: "nocard@a.com",
  });
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
  return { orgId, bizId: biz.id, customer, sub: sub.subscription, invoiceId: invoice.id };
}

/**
 * A GOOD card whose MANDATE cannot carry the invoice — the ceiling is stamped on the
 * instrument before the first bill, so `mandateRefusal` refuses the debit pre-flight
 * with `mandate_ceiling_exceeded` (non-retriable) instead of the charge succeeding.
 * This is the real INR shape: a renewal that outgrew the mandate it was registered at.
 */
async function setupCeilingBound(label: string) {
  const org = await createOrganization({ name: `Dunning ${label}` });
  const orgId = org.organization.id;
  const biz = await createBusiness({
    organizationId: orgId,
    name: "Biz",
    defaultCurrency: "USD",
    livemode: "test",
  });
  // These cases exercise parking, which is off by default.
  await systemDb
    .update(businesses)
    .set({ dunningConfig: { park_hard_declines: true } })
    .where(eq(businesses.id, biz.id));
  const customer = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: "ceiling@a.com",
  });
  const pm = await vaultPaymentMethod({
    organizationId: orgId,
    businessId: biz.id,
    customer,
    token: "tok_4242",
  });
  await withTenant(orgId, (tx) =>
    tx
      .update(paymentMethods)
      .set({ mandateMaxAmountMinor: 1000n, mandateCurrency: "USD", mandateRail: "card" })
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
  return {
    orgId,
    bizId: biz.id,
    customer,
    sub: sub.subscription,
    invoiceId: invoice.id,
    pmId: pm.id,
  };
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
// Backdate the scheduled retry so the next dunning pass picks it up.
const backdate = (id: string) =>
  systemDb
    .update(invoices)
    .set({ nextAttemptAt: new Date(Date.now() - 60_000) })
    .where(eq(invoices.id, id));

// ---- Case A: recovery (bad card 0002 -> swap to good card -> recover) ----
{
  const a = await setup("Recover", "4000000000009995");
  const inv0 = await getInv(a.orgId, a.invoiceId);
  const sub0 = await getSub(a.orgId, a.sub.id);
  console.log(
    `A start: invoice=${inv0.status} attempts=${inv0.attemptCount} sub=${sub0.status} retry_scheduled=${inv0.nextAttemptAt !== null}`,
  );

  // Swap the customer's card to a good one, then run a dunning pass.
  await vaultPaymentMethod({
    organizationId: a.orgId,
    businessId: a.bizId,
    customer: a.customer,
    token: "tok_4242",
  });
  // Point the subscription's default PM at the new good card.
  const goodPm = await withTenant(a.orgId, async (tx) =>
    (
      await tx.select().from(paymentMethods).where(eq(paymentMethods.customerId, a.customer.id))
    ).find((p) => p.last4 === "4242")!,
  );
  await withTenant(a.orgId, (tx) =>
    tx
      .update(subscriptions)
      .set({ defaultPaymentMethodId: goodPm.id })
      .where(eq(subscriptions.id, a.sub.id)),
  );

  await backdate(a.invoiceId);
  const r = await runDunningPass(new Date());
  const invA = await getInv(a.orgId, a.invoiceId);
  const subA = await getSub(a.orgId, a.sub.id);
  console.log(`A after pass: ${JSON.stringify(r)} invoice=${invA.status} sub=${subA.status}`);
  var recoverPass = invA.status === "paid" && subA.status === "active" && r.recovered === 1;
}

// ---- Case B: exhaustion (bad card throughout -> canceled) ----
{
  const b = await setup("Exhaust", "4000000000009995");
  let passes = 0;
  let subB = await getSub(b.orgId, b.sub.id);
  // Keep backdating + running passes until canceled (bounded by MAX_ATTEMPTS).
  for (let i = 0; i < MAX_ATTEMPTS + 2 && subB.status !== "cancelled"; i++) {
    await backdate(b.invoiceId);
    await runDunningPass(new Date());
    subB = await getSub(b.orgId, b.sub.id);
    passes++;
  }
  const invB = await getInv(b.orgId, b.invoiceId);
  console.log(
    `B: after ${passes} passes invoice=${invB.status} sub=${subB.status} attempts=${invB.attemptCount}`,
  );
  var exhaustPass = invB.status === "not_paid" && subB.status === "cancelled";
}

/**
 * ---- Case C: no card on file -> PARKED, then cancelled with reason `no_card` ----
 *
 * ⚠️ THE ROUTE CHANGED ON 2026-09-21, THE ENDING DID NOT. `no_payment_method` used to be
 * `retriable` and unclassified, so a customer with NO instrument ran the whole retry
 * ladder — every rung a charge refused before a gateway was asked — and was cancelled in
 * about a week, while a customer whose card merely DECLINED parked for thirty days. The
 * population that most obviously had to act got the shortest rope.
 *
 * It parks now, which is where the recovery machinery lives: the reminder ladder asks for
 * an instrument and `collect_on_payment_method_update` charges the moment one arrives.
 * The window still CLOSES and the final action still fires with the same reason — so this
 * case asserts the same ending, reached through `sweepExpiredParkedDunning` rather than
 * through `runDunningPass`, which cannot see a parked row at all.
 */
{
  const c = await setupNoCard("NoCard");
  // The retry ladder must now be a NO-OP for this invoice: nothing to present, so nothing
  // is scheduled and the pass cannot reach it.
  for (let i = 0; i < MAX_ATTEMPTS + 2; i++) {
    await backdate(c.invoiceId);
    await runDunningPass(new Date());
  }
  const parkedC = await getInv(c.orgId, c.invoiceId);
  const subMid = await getSub(c.orgId, c.sub.id);
  console.log(
    `C: no-card parks invoice=${parkedC.status}/${parkedC.dunningStatus} sub=${subMid.status} ladder_noop=${parkedC.nextAttemptAt === null}`,
  );
  const noCardParks =
    parkedC.status === "payment_due" &&
    parkedC.dunningStatus === "parked" &&
    subMid.status === "active";

  /**
   * Past the window, the park closes and the final action cancels.
   *
   * ⚠️ SCOPED. `sweepExpiredParkedDunning` scans every parked invoice in the database and
   * this call hands it an instant a month ahead; unscoped, one run of a suite doing this
   * cancelled 41 subscriptions belonging to other data (2026-09-04).
   */
  const anchor = parkedC.dunningParkedAt ?? parkedC.dueDate ?? parkedC.createdAt;
  const past = new Date(anchor.getTime() + (PARKED_GRACE_DAYS + 1) * 86_400_000);
  await runWithClockScope({ onlyBusinessId: c.bizId, now: past }, () =>
    sweepExpiredParkedDunning(past),
  );
  const invC = await getInv(c.orgId, c.invoiceId);
  const subC = await getSub(c.orgId, c.sub.id);
  console.log(
    `C: …then the window closes invoice=${invC.status}/${invC.dunningStatus} sub=${subC.status} reason=${subC.cancelReason}`,
  );
  var noCardReasonPass =
    noCardParks && subC.status === "cancelled" && subC.cancelReason === "no_card";
}

// ---- Case D: collect-on-payment-method-update recovers a dunning invoice ----
{
  const d = await setup("CollectOnUpdate", "4000000000009995"); // failing card -> payment_due
  const inv0 = await getInv(d.orgId, d.invoiceId);
  // Add a GOOD card, then fire the Billing LogIQ collect-on-update hook.
  const good = await vaultPaymentMethod({
    organizationId: d.orgId,
    businessId: d.bizId,
    customer: d.customer,
    token: "tok_4242",
  });
  const res = await collectOutstandingForNewPaymentMethod({
    organizationId: d.orgId,
    businessId: d.bizId,
    customerId: d.customer.id,
    paymentMethodPublicId: good.publicId,
  });
  const invD = await getInv(d.orgId, d.invoiceId);
  console.log(
    `D: start=${inv0.status} -> after add-card=${invD.status} collected=${JSON.stringify(res.collected)}`,
  );
  var collectOnUpdatePass =
    inv0.status === "payment_due" &&
    invD.status === "paid" &&
    res.enabled &&
    res.collected.some((x) => x.invoice === invD.publicId && x.status === "succeeded");
}

// ---- Case E: a hard decline the CUSTOMER can clear PARKS, it does not cancel ----
//
// The one case neither B nor C covers: a refusal that is non-retriable AND
// recoverable. Driven through the REAL path rather than a synthetic decline — a
// mandate ceiling below the amount due, so `mandateRefusal` refuses the debit
// before it reaches the gateway with `mandate_ceiling_exceeded`, exactly as an
// INR card mandate does when a renewal outgrows its ₹15,000 cap.
//
// Before this branch existed the invoice exhausted on the first pass and the
// subscription was CANCELLED, for a customer whose card works fine.
{
  // The ceiling has to be on the instrument BEFORE the first bill — `setup()` bills
  // inside itself, and a good card with no ceiling simply pays.
  const e = await setupCeilingBound("ParkNotCancel");

  let subE = await getSub(e.orgId, e.sub.id);
  for (let i = 0; i < MAX_ATTEMPTS + 2 && subE.status !== "cancelled"; i++) {
    await backdate(e.invoiceId);
    await runDunningPass(new Date());
    subE = await getSub(e.orgId, e.sub.id);
  }
  const invE = await getInv(e.orgId, e.invoiceId);
  console.log(
    `E: ceiling refusal invoice=${invE.status} dunning=${invE.dunningStatus} ` +
      `sub=${subE.status} no_next_attempt=${invE.nextAttemptAt === null}`,
  );

  // Now the customer re-authorizes at a ceiling that covers it — the parked invoice
  // must collect immediately, which is what makes parking safe rather than a leak.
  await withTenant(e.orgId, (tx) =>
    tx
      .update(paymentMethods)
      .set({ mandateMaxAmountMinor: 500_000n })
      .where(eq(paymentMethods.customerId, e.customer.id)),
  );
  const pmE = await withTenant(
    e.orgId,
    async (tx) =>
      (
        await tx.select().from(paymentMethods).where(eq(paymentMethods.customerId, e.customer.id))
      )[0]!,
  );
  const resE = await collectOutstandingForNewPaymentMethod({
    organizationId: e.orgId,
    businessId: e.bizId,
    customerId: e.customer.id,
    paymentMethodPublicId: pmE.publicId,
  });
  const invE2 = await getInv(e.orgId, e.invoiceId);
  console.log(
    `E: after re-authorize invoice=${invE2.status} collected=${JSON.stringify(resE.collected)}`,
  );

  var parkNotCancelPass =
    // Survived every pass a cancellation would have needed.
    subE.status === "active" &&
    invE.status === "payment_due" &&
    invE.dunningStatus === "parked" &&
    // Parked means waiting for the customer, not for a timer.
    invE.nextAttemptAt === null &&
    // And the wait ends the moment they fix it.
    invE2.status === "paid";
}

// ---- Case F: a manual "Collect now" must not burn a dunning attempt (M12) ----
//
// `attempt_count` is the INDEX into the retry schedule, so a manual attempt that bumps
// it silently spends one of the customer's scheduled retries. Click Collect now three
// times on a 1/3/5 schedule and the invoice is exhausted without the clock ever running.
{
  const f = await setup("ManualCollect", "4000000000009995"); // fails every time
  const before = await getInv(f.orgId, f.invoiceId);
  for (let i = 0; i < 3; i++) {
    // Each one fails; we only care what it does to the counter and the schedule.
    await collectInvoiceNow(f.orgId, f.bizId, before.publicId).catch(() => {});
  }
  const after = await getInv(f.orgId, f.invoiceId);
  const subF = await getSub(f.orgId, f.sub.id);
  const attemptsHeld = after.attemptCount === before.attemptCount;
  // The schedule must also be untouched — not merely un-advanced.
  const scheduleHeld =
    (before.nextAttemptAt?.getTime() ?? null) === (after.nextAttemptAt?.getTime() ?? null);
  // …and the attempts must still be VISIBLE as payments, just not as dunning attempts.
  const failures = await withTenant(
    f.orgId,
    async (tx) =>
      (await tx.select().from(payments).where(eq(payments.invoiceId, f.invoiceId))).filter(
        (p) => p.status === "failed",
      ).length,
  );
  console.log(
    `F: 3 manual collects — attempts ${before.attemptCount}→${after.attemptCount} ` +
      `next_attempt_held=${scheduleHeld} failed_payments=${failures} sub=${subF.status}`,
  );
  var manualCollectPass = attemptsHeld && scheduleHeld && failures >= 3 && subF.status === "active";
}

// ---- Case G: a ceiling refusal on a business WITH a dunning period ----
//
// The counterpart to E. E has no period and parks indefinitely, which is right when the
// business set no deadline. When it DID set one — "6 days, then act" — an invoice must
// not opt out of it: nothing is retried inside the window (the customer can Pay now),
// there is ONE attempt on the deadline, and the final action follows if that fails.
// Without this the deadline branch is unit-tested only, and it is the direction that
// makes subscriptions get CANCELLED that previously never did.
{
  const org = await createOrganization({ name: "Dunning PeriodDeadline" });
  const orgId = org.organization.id;
  const biz = await createBusiness({
    organizationId: orgId,
    name: "Biz",
    defaultCurrency: "USD",
    livemode: "test",
  });
  // `createBusiness` takes no dunning config; set it the way Settings → Dunning would.
  await systemDb
    .update(businesses)
    .set({
      dunningConfig: {
        retries: [{ after_days: 1 }, { after_days: 3 }],
        dunning_period_days: 6,
        final_action: { invoice: "not_paid", subscription: "cancel" },
        skip_retries_for_hard_failures: true,
        park_hard_declines: true,
      },
    })
    .where(eq(businesses.id, biz.id));
  const customer = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: "deadline@a.com",
  });
  const pm = await vaultPaymentMethod({
    organizationId: orgId,
    businessId: biz.id,
    customer,
    token: "tok_4242",
  });
  await withTenant(orgId, (tx) =>
    tx
      .update(paymentMethods)
      .set({ mandateMaxAmountMinor: 1000n, mandateCurrency: "USD", mandateRail: "card" })
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
  // The period is measured from the DUE DATE, so the invoice needs one.
  const dueDate = new Date();
  const { invoice } = await billSubscriptionPeriod({
    organizationId: orgId,
    businessId: biz.id,
    subscription: sub.subscription,
    // Non-null by construction: this fixture creates a subscription with NO trial, so it
    // starts `active` with a term. A trialling subscription has none (2026-08-25).
    periodStart: sub.subscription.currentPeriodStart!,
    periodEnd: sub.subscription.currentPeriodEnd!,
  });
  await withTenant(orgId, (tx) =>
    tx.update(invoices).set({ dueDate }).where(eq(invoices.id, invoice.id)),
  );
  // Re-run the failure now that a due date exists, so the plan can see the deadline.
  await backdate(invoice.id);
  await runDunningPass(new Date());

  const during = await getInv(orgId, invoice.id);
  const subDuring = await getSub(orgId, sub.subscription.id);
  const deadline = new Date(dueDate.getTime() + 6 * 86_400_000);
  const scheduledAtDeadline =
    during.nextAttemptAt != null &&
    Math.abs(during.nextAttemptAt.getTime() - deadline.getTime()) < 90_000;
  console.log(
    `G: inside the window invoice=${during.status} sub=${subDuring.status} ` +
      `next_attempt=${during.nextAttemptAt?.toISOString().slice(0, 10) ?? "null"} at_deadline=${scheduledAtDeadline}`,
  );

  // Now the deadline passes and the last attempt fails: the final action must apply.
  for (let i = 0; i < 3; i++) {
    await systemDb
      .update(invoices)
      .set({ nextAttemptAt: new Date(Date.now() - 60_000) })
      .where(eq(invoices.id, invoice.id));
    await systemDb
      .update(invoices)
      .set({ dueDate: new Date(Date.now() - 7 * 86_400_000) })
      .where(eq(invoices.id, invoice.id));
    await runDunningPass(new Date());
  }
  const after = await getInv(orgId, invoice.id);
  const subAfter = await getSub(orgId, sub.subscription.id);
  console.log(
    `G: past the deadline invoice=${after.status} dunning=${after.dunningStatus} sub=${subAfter.status}`,
  );

  var periodDeadlinePass =
    // Inside the window: open, not cancelled, and waiting for the deadline — NOT parked
    // with no attempt at all, which is what silently opted out of the period.
    during.status === "payment_due" &&
    subDuring.status === "active" &&
    scheduledAtDeadline &&
    // Past it: the business's configured final action actually fires.
    after.status === "not_paid" &&
    subAfter.status === "cancelled";
}

// ---- Case H: a debit the RAIL pauses for the buyer's authentication ----
// RBI/NPCI stop an INR mandate debit above ₹15,000 and wait for the payer. The
// gateway reports that identically to an ordinary slow settlement (RazorPay says
// `created` for both), so nothing downstream can tell them apart by asking — the
// engine has to know from the amount and the rail, and TELL THE CUSTOMER. Nothing
// else in the system will: the invoice parks with no next attempt, which is correct
// and completely silent.
//
// The three rows below are the whole discrimination. Netbanking is the control that
// matters most: it authenticates once at registration and debits unattended
// (measured, ₹66,025 on a real HDFC mandate), so notifying there would be a lie.
{
  // `4000000000000101` returns a LIVE pending — distinct from `…077` (timeout), which
  // books "outcome unknown" and must not notify. Using the wrong one here is how the
  // first version of this check passed while the real path emitted nothing.
  const ASYNC_PENDING = "4000000000000101";

  const oneCase = async (label: string, rail: string, amountMinor: number) => {
    const org = await createOrganization({ name: `AFA ${label}` });
    const orgId = org.organization.id;
    const biz = await createBusiness({
      organizationId: orgId,
      name: "Biz",
      defaultCurrency: "INR",
      livemode: "test",
    });
    // These cases exercise parking, which is off by default.
    await systemDb
      .update(businesses)
      .set({ dunningConfig: { park_hard_declines: true } })
      .where(eq(businesses.id, biz.id));
    const customer = await createCustomer({
      organizationId: orgId,
      businessId: biz.id,
      email: "afa@a.com",
    });
    const pm = await vaultPaymentMethod({
      organizationId: orgId,
      businessId: biz.id,
      customer,
      token: ASYNC_PENDING,
    });
    // Stamp the mandate the way a RazorPay vault would (0179 columns). The ceiling is
    // deliberately huge: this case is about the RBI threshold, not about the mandate's
    // own cap, and a ceiling refusal would short-circuit the charge before the rail.
    await withTenant(orgId, (tx) =>
      tx
        .update(paymentMethods)
        .set({ mandateRail: rail, mandateMaxAmountMinor: 99_999_999n, mandateCurrency: "INR" })
        .where(eq(paymentMethods.id, pm.id)),
    );
    const product = await createProduct({
      organizationId: orgId,
      businessId: biz.id,
      name: "Plan",
    });
    const price = await createPrice({
      organizationId: orgId,
      businessId: biz.id,
      productId: product.id,
      type: "recurring",
      model: "flat",
      currency: "INR",
      amountMinor,
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
    const evs = await withTenant(orgId, (tx) =>
      tx.select({ type: events.type }).from(events).where(eq(events.businessId, biz.id)),
    );
    const inv = await getInv(orgId, invoice.id);
    return {
      notified: evs.some((e) => e.type === "payment_authentication_required"),
      parked: inv.status === "payment_due" && inv.nextAttemptAt === null,
    };
  };

  const cardAbove = await oneCase("card above", "card", 5_671_500);
  const bankAbove = await oneCase("emandate above", "emandate", 5_671_500);
  const cardBelow = await oneCase("card below", "card", 1_387_000);

  console.log(`H: card ₹56,715 notified=${cardAbove.notified} parked=${cardAbove.parked}`);
  console.log(
    `H: netbanking ₹56,715 notified=${bankAbove.notified} (must be false — it debits unattended)`,
  );
  console.log(
    `H: card ₹13,870 notified=${cardBelow.notified} (must be false — under the threshold)`,
  );

  var afaNoticePass =
    cardAbove.notified && cardAbove.parked && !bankAbove.notified && !cardBelow.notified;
}

// ---- Case I: a lapsed MANDATE parks; it never reaches a cancellation reason (2026-09-02) ----
/**
 * The customer holds a card valid to 2099 and only its MANDATE has ended.
 *
 * THIS CASE WAS WRITTEN TO CATCH A REASON STRING AND MEASURED SOMETHING BETTER. `no_card` was
 * derived from `payment_methods.status !== 'expired'`, and the C6 sweep writes `expired` for a
 * lapsed MANDATE as well as a lapsed card — so on paper a Visa valid to 2099 cancels as
 * "Cancelled – No Card". The predicate really was wrong and is fixed. But the SYMPTOM does not
 * occur: measured here, the invoice exhausts all 9 attempts and PARKS
 * (`payment_due`, `nextAttemptAt: null`), the subscription stays `active`, and no cancellation
 * reason is derived at all.
 *
 * So this asserts the PARK, which is the real behaviour and worth a gate of its own — an
 * instrument that cannot be charged must not silently cancel a paying customer's subscription.
 * The reason-string decision is asserted where it can actually fail, in
 * `test/unit/dunning-no-card-reason.test.ts` (mutation-checked: reverting the predicate reddens
 * exactly one assertion). Case C above still covers the genuine no-card cancellation, unchanged.
 */
{
  // A card that FAILS RETRIABLY, so dunning actually exhausts and reaches its final action.
  // The first cut of this case used a no-card fixture with a demoted instrument and the
  // subscription never cancelled at all — it PARKED, which is a different deliberate path and
  // meant the assertion could not see the reason it was written to check. Measured, not guessed.
  const i = await setup("MandateLapsed", "4000000000009995");
  const [pmRow] = await withTenant(i.orgId, (tx) =>
    tx
      .select({ id: paymentMethods.id })
      .from(paymentMethods)
      .where(eq(paymentMethods.customerId, i.customer.id)),
  );
  // The state the C6 sweep really leaves: status `expired` because the MANDATE ended, while the
  // card's printed expiry is years away. `status` alone cannot tell those apart, which was the bug.
  await withTenant(i.orgId, (tx) =>
    tx
      .update(paymentMethods)
      .set({
        status: "expired",
        expMonth: 1,
        expYear: 2099,
        mandateStatus: "confirmed",
        mandateExpiresAt: new Date(Date.now() - 30 * 86_400_000),
      })
      .where(eq(paymentMethods.id, pmRow!.id)),
  );
  let subI = await getSub(i.orgId, i.sub.id);
  for (let n = 0; n < MAX_ATTEMPTS + 3 && subI.status !== "cancelled"; n++) {
    await backdate(i.invoiceId);
    await runDunningPass(new Date());
    subI = await getSub(i.orgId, i.sub.id);
  }
  const invI = await getInv(i.orgId, i.invoiceId);
  console.log(
    `I: lapsed mandate, card good to 2099 -> sub=${subI.status} reason=${subI.cancelReason ?? "none"} inv=${invI.status} attempts=${invI.attemptCount} nextAttempt=${invI.nextAttemptAt === null ? "null(parked)" : "armed"}`,
  );
  var mandateReasonPass =
    subI.status === "active" &&
    subI.cancelReason === null &&
    invI.status === "payment_due" &&
    invI.nextAttemptAt === null;
}

// ---- Case J: collecting after a cancellation does not revive the subscription ----
// An operator cancels while the renewal invoice is still in dunning; a later retry succeeds.
// The money is collected — the subscription stays cancelled, at a rate of 0, with no revival
// the ledger never hears about.
{
  const j = await setup("CancelledMidDunning", "4000000000009995");
  await cancelSubscription({
    organizationId: j.orgId,
    businessId: j.bizId,
    subscriptionId: j.sub.id,
    atPeriodEnd: false,
    now: new Date(),
  });
  await vaultPaymentMethod({
    organizationId: j.orgId,
    businessId: j.bizId,
    customer: j.customer,
    token: "tok_4242",
  });
  const goodPm = await withTenant(j.orgId, async (tx) =>
    (
      await tx.select().from(paymentMethods).where(eq(paymentMethods.customerId, j.customer.id))
    ).find((p) => p.last4 === "4242")!,
  );
  await withTenant(j.orgId, (tx) =>
    tx
      .update(subscriptions)
      .set({ defaultPaymentMethodId: goodPm.id })
      .where(eq(subscriptions.id, j.sub.id)),
  );
  await backdate(j.invoiceId);
  await runDunningPass(new Date());
  const subJ = await getSub(j.orgId, j.sub.id);
  const invJ = await getInv(j.orgId, j.invoiceId);
  console.log(
    `J: cancelled mid-dunning, retry -> invoice=${invJ.status} sub=${subJ.status} mrr=${subJ.mrr}`,
  );
  var cancelledStaysPass = subJ.status === "cancelled" && subJ.mrr === 0n;
}

// ---- Case K: a customer excluded from dunning ----
const payCount = (orgId: string, invoiceId: string) =>
  withTenant(
    orgId,
    async (tx) =>
      (await tx.select({ id: payments.id }).from(payments).where(eq(payments.invoiceId, invoiceId)))
        .length,
  );
// Scoped to the case's business, so the passes never touch other data.
const scopedPass = (bizId: string, now = new Date()) =>
  runWithClockScope({ onlyBusinessId: bizId, now }, () => runDunningPass(now));
const holdChecks: Array<[string, boolean, string]> = [];
const hold = (name: string, ok: boolean, detail: string) => {
  holdChecks.push([name, ok, detail]);
  console.log(`${ok ? "✅" : "❌"} ${name} — ${detail}`);
};
{
  // K1: excluded before the bill. The first collection still runs; dunning does not start.
  const k = await setup("ExcludedFirst", "4000000000009995", { excluded: true });
  const inv = await getInv(k.orgId, k.invoiceId);
  hold(
    "K1 excluded: first automatic collection still runs",
    (await payCount(k.orgId, k.invoiceId)) === 1,
    `payments=${await payCount(k.orgId, k.invoiceId)}`,
  );
  hold(
    "K1 excluded: the failure does not start dunning",
    inv.status === "not_paid" && inv.dunningStatus === null && inv.nextAttemptAt === null,
    `status=${inv.status} dunning=${inv.dunningStatus} next=${inv.nextAttemptAt}`,
  );

  // K2: excluded mid-dunning. No retry while excluded; time is frozen, so lifting it moves
  // the remaining steps later by the exclusion's length.
  const m = await setup("ExcludedMid", "4000000000009995");
  const armed = await getInv(m.orgId, m.invoiceId);
  hold(
    "K2 baseline: not excluded, so dunning starts",
    armed.status === "payment_due" &&
      armed.dunningStatus === "in_progress" &&
      !!armed.nextAttemptAt,
    `status=${armed.status} dunning=${armed.dunningStatus}`,
  );
  const DAY = 86_400_000;
  const E = new Date(); // the exclusion starts
  const asOf = <T>(now: Date, fn: () => Promise<T>) =>
    runWithClockScope({ onlyBusinessId: m.bizId, now }, fn);
  await asOf(E, () =>
    updateCustomer({
      organizationId: m.orgId,
      businessId: m.bizId,
      customerPublicId: m.customer.publicId,
      dunningExcluded: true,
    }),
  );
  // The next retry is 2 days into the exclusion.
  await systemDb
    .update(invoices)
    .set({ nextAttemptAt: new Date(E.getTime() + 2 * DAY) })
    .where(eq(invoices.id, m.invoiceId));
  const due = await getInv(m.orgId, m.invoiceId);
  const day3 = new Date(E.getTime() + 3 * DAY);
  await scopedPass(m.bizId, day3);
  const viaPump = await asOf(day3, () =>
    retryDueInvoice(
      { id: m.invoiceId, organizationId: m.orgId, businessId: m.bizId, subscriptionId: m.sub.id },
      day3,
    ),
  );
  const held = await getInv(m.orgId, m.invoiceId);
  hold(
    "K2 excluded: the pass and the pump make no retry",
    (await payCount(m.orgId, m.invoiceId)) === 1 && viaPump === null && held.attemptCount === 1,
    `payments=${await payCount(m.orgId, m.invoiceId)} pump=${viaPump} attempts=${held.attemptCount}`,
  );
  hold(
    "K2 excluded: the schedule is kept as it was",
    held.status === "payment_due" &&
      held.dunningStatus === "in_progress" &&
      held.nextAttemptAt?.getTime() === due.nextAttemptAt?.getTime(),
    `status=${held.status} dunning=${held.dunningStatus} next=${held.nextAttemptAt?.toISOString()}`,
  );
  const journey = await getDunningJourney({
    organizationId: m.orgId,
    business: { id: m.bizId, dunningConfig: { park_hard_declines: true } },
    invoicePublicId: held.publicId,
  });
  hold(
    "K2 excluded: the journey says why nothing is planned",
    journey?.projection === null && journey?.projectionNote === "customer_excluded",
    `note=${journey?.projectionNote}`,
  );
  const [audit] = await withTenant(m.orgId, (tx) =>
    tx
      .select({ before: auditLogs.before, after: auditLogs.after })
      .from(auditLogs)
      .where(
        and(eq(auditLogs.action, "customer.update"), eq(auditLogs.resourceId, m.customer.publicId)),
      )
      .limit(1),
  );
  hold(
    "K2 excluded: the change is on the customer's audit trail",
    (audit?.before as Record<string, unknown> | null)?.dunning_excluded === false &&
      (audit?.after as Record<string, unknown> | null)?.dunning_excluded === true,
    `before=${JSON.stringify(audit?.before)} after=${JSON.stringify(audit?.after)}`,
  );
  // Lifted on day 25: the day-2 retry moves to day 27.
  const day25 = new Date(E.getTime() + 25 * DAY);
  await asOf(day25, () =>
    updateCustomer({
      organizationId: m.orgId,
      businessId: m.bizId,
      customerPublicId: m.customer.publicId,
      dunningExcluded: false,
    }),
  );
  const shifted = await getInv(m.orgId, m.invoiceId);
  const day27 = E.getTime() + 27 * DAY;
  hold(
    "K2 turned off: the retry moves later by the exclusion's length",
    shifted.nextAttemptAt?.getTime() === day27 && shifted.dunningHeldMs === 25 * DAY,
    `next=${shifted.nextAttemptAt?.toISOString()} (expected ${new Date(day27).toISOString()}) held_ms=${shifted.dunningHeldMs}`,
  );
  await scopedPass(m.bizId, new Date(day25.getTime() + 1000));
  hold(
    "K2 turned off: nothing runs at once on lift",
    (await payCount(m.orgId, m.invoiceId)) === 1,
    `payments=${await payCount(m.orgId, m.invoiceId)}`,
  );
  await scopedPass(m.bizId, new Date(day27 + 1000));
  const resumed = await getInv(m.orgId, m.invoiceId);
  hold(
    "K2 turned off: the retry runs at its moved time",
    (await payCount(m.orgId, m.invoiceId)) === 2 && resumed.attemptCount === 2,
    `payments=${await payCount(m.orgId, m.invoiceId)} attempts=${resumed.attemptCount}`,
  );
}

// ---- Case L: per-currency minimum before dunning (outstanding, not total) ----
{
  // L1: 50.00 owed, minimum 60.00 → below: dunning does not start.
  const l = await setup("BelowMin", "4000000000009995", {
    dunningConfig: { minimum_amounts: { USD: 6000 } },
  });
  const inv = await getInv(l.orgId, l.invoiceId);
  hold(
    "L1 below the minimum: first collection runs, dunning does not start",
    (await payCount(l.orgId, l.invoiceId)) === 1 &&
      inv.status === "not_paid" &&
      inv.dunningStatus === null &&
      inv.nextAttemptAt === null,
    `payments=${await payCount(l.orgId, l.invoiceId)} status=${inv.status} dunning=${inv.dunningStatus}`,
  );

  // L2: equal to the minimum is not below it; another currency's minimum does not apply.
  const eq2 = await setup("AtMin", "4000000000009995", {
    dunningConfig: { minimum_amounts: { USD: 5000, INR: 99999999 } },
  });
  const atMin = await getInv(eq2.orgId, eq2.invoiceId);
  hold(
    "L2 at the minimum: dunning starts",
    atMin.status === "payment_due" && atMin.dunningStatus === "in_progress",
    `status=${atMin.status} dunning=${atMin.dunningStatus}`,
  );

  // L3: total 50.00 is above 30.00, but 25.00 is paid → 25.00 left → held mid-dunning.
  const pp = await setup("PartPaid", "4000000000009995", {
    dunningConfig: { minimum_amounts: { USD: 3000 } },
  });
  const pp0 = await getInv(pp.orgId, pp.invoiceId);
  await recordOfflinePayment({
    organizationId: pp.orgId,
    businessId: pp.bizId,
    invoicePublicId: pp0.publicId,
    amountMinor: 2500,
    method: "cash",
  });
  await backdate(pp.invoiceId);
  const ppDue = await getInv(pp.orgId, pp.invoiceId);
  await scopedPass(pp.bizId);
  const ppAfter = await getInv(pp.orgId, pp.invoiceId);
  const ppCharges = await withTenant(pp.orgId, async (tx) =>
    (
      await tx
        .select({ provider: payments.providerKey })
        .from(payments)
        .where(eq(payments.invoiceId, pp.invoiceId))
    ).filter((p) => !p.provider.startsWith("offline")),
  );
  hold(
    "L3 partly paid below the minimum: no retry, schedule kept",
    ppDue.status === "payment_due" &&
      ppCharges.length === 1 &&
      ppAfter.attemptCount === ppDue.attemptCount &&
      ppAfter.nextAttemptAt?.getTime() === ppDue.nextAttemptAt?.getTime(),
    `status=${ppDue.status} charges=${ppCharges.length} attempts=${ppDue.attemptCount}->${ppAfter.attemptCount}`,
  );
}

// ---- Case M: the API surface for both settings ----
{
  const org = await createOrganization({ name: "Dunning hold API" });
  const biz = await createBusiness({
    organizationId: org.organization.id,
    name: "Biz",
    defaultCurrency: "USD",
    livemode: "test",
  });
  const app = await buildApp({ logger: false });
  let n = 0;
  const call = async (method: "GET" | "POST" | "PATCH", url: string, payload?: object) => {
    const res = await app.inject({
      method,
      url: `/v1/businesses/${biz.publicId}${url}`,
      headers: {
        authorization: `Bearer ${org.secret}`,
        "idempotency-key": `dun-hold-${Date.now()}-${n++}`,
      },
      ...(payload ? { payload } : {}),
    });
    return { status: res.statusCode, body: JSON.parse(res.body || "null") };
  };
  const plain = await call("POST", "/customers", { email: "plain@example.com" });
  const excl = await call("POST", "/customers", {
    email: "excl@example.com",
    dunning_excluded: true,
  });
  hold(
    "M customer create: dunning_excluded defaults false and can be set",
    plain.body?.dunning_excluded === false && excl.body?.dunning_excluded === true,
    `plain=${plain.status}/${plain.body?.dunning_excluded} excl=${excl.status}/${excl.body?.dunning_excluded}`,
  );
  const off = await call("PATCH", `/customers/${excl.body?.id}`, { dunning_excluded: false });
  const read = await call("GET", `/customers/${excl.body?.id}`);
  hold(
    "M customer update/read: dunning_excluded round-trips",
    off.status === 200 && read.body?.dunning_excluded === false,
    `patch=${off.status} read=${read.body?.dunning_excluded}`,
  );
  const bad = await call("PATCH", "", { dunning_config: { minimum_amounts: { usd: 500 } } });
  const zero = await call("PATCH", "", { dunning_config: { minimum_amounts: { USD: 0 } } });
  const good = await call("PATCH", "", { dunning_config: { minimum_amounts: { USD: 500 } } });
  hold(
    "M business: minimum_amounts takes upper-case codes and positive minor units",
    bad.status === 400 &&
      zero.status === 400 &&
      good.status === 200 &&
      good.body?.dunning_config?.minimum_amounts?.USD === 500,
    `lower=${bad.status} zero=${zero.status} good=${good.status}/${JSON.stringify(good.body?.dunning_config?.minimum_amounts)}`,
  );
  await app.close();
}
const holdPass = holdChecks.every(([, ok]) => ok);

console.log("");
const pass =
  holdPass &&
  recoverPass &&
  cancelledStaysPass &&
  exhaustPass &&
  noCardReasonPass &&
  collectOnUpdatePass &&
  parkNotCancelPass &&
  manualCollectPass &&
  periodDeadlinePass &&
  afaNoticePass &&
  mandateReasonPass;
console.log(pass ? "✅ DUNNING: PASS" : "❌ DUNNING: FAIL");
await closeDb();
process.exit(pass ? 0 : 1);
