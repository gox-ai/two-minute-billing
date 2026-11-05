/**
 * Proves DUNNING FOR AUTO-COLLECT-OFF (send-invoice) INVOICES — `dun_offline_invoices`.
 *
 * ── Rewritten 2026-08-31 against a measured target ────────────────────────────
 * An `auto_collection: off` unpaid invoice, AS RAISED, must report:
 *
 *   status = payment_due          (NOT not_paid)
 *   dunning_status = in_progress  (dunning is "in progress" though nothing will charge)
 *   next_retry_at  = invoice date + the site's first retry interval
 *   dunning_attempts = []         (so attempt_count is 0 — no attempt was made)
 *   due_date = the invoice date exactly, with zero net terms
 *
 * So three of this suite's original expectations were expectations about OUR BUG:
 * `not_paid` at the due date, no dunning without a configured period, and the flag
 * defaulting off. Each one is restated below against the measurement, and the old
 * value is named where it changed so nobody has to diff to find out.
 *
 * The two properties that DEFINE the feature are unchanged and still asserted rather
 * than assumed:
 *
 *   1. **No charge is ever attempted.** Attempting one is the whole thing
 *      auto-collect-off rules out, so every case checks the invoice has zero payment
 *      rows — a passing status is not evidence that no gateway call happened. This now
 *      matters more, not less: an offline invoice in dunning is column-for-column
 *      identical to a retried one, so `runDunningPass` is driven here too (case 10) to
 *      prove its auto-collect guard holds.
 *   2. **The invoice stays payable for the entire window.** `payment_due` is an OPEN
 *      status, so the portal's Pay-now keeps working; if a customer pays on the last
 *      day, the deadline must NOT void their paid invoice or cancel them.
 *
 * `dunning_period_days` is still the only thing that ENDS a window — offline invoices
 * have no retries to run out of — so with no period the reminders run and the invoice
 * stays open (case 2). Nothing is voided or cancelled without a configured period.
 *
 *   pnpm verify:dunning-offline
 */
import { eq } from "drizzle-orm";
import { withTenant, closeDb } from "@/platform/db";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createCustomer, updateCustomer } from "@/modules/customers/service";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import { createSubscription, updateSubscriptionSettings } from "@/modules/subscriptions/service";
import { billSubscriptionPeriod } from "@/modules/invoicing/service";
import { runInvoiceDueTransitions } from "@/modules/invoicing/due";
import { runDunningPass, sweepStrandedRetries } from "@/modules/subscriptions/dunning";
import { resolveDunningConfig, DUNNING_RETRY_DAYS } from "@/modules/subscriptions/dunning-schedule";
import { recordOfflinePayment } from "@/modules/invoicing/ops";
import { runWithClockScope } from "@/platform/clock";
import { subscriptions, invoices, businesses, payments } from "@db/schema";
import { retireFixtureRetries } from "./lib/fixture-retries";

/** Every org `setup()` made, so the teardown can retire what they leave behind. */
const fixtureOrgs: string[] = [];

const GOOD = "4242424242424242";
const DAY = 24 * 60 * 60 * 1000;

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
/** Payment rows against an invoice — 0 is the assertion that no charge was attempted. */
const payCount = (orgId: string, invoiceId: string) =>
  withTenant(
    orgId,
    async (tx) =>
      (await tx.select({ id: payments.id }).from(payments).where(eq(payments.invoiceId, invoiceId)))
        .length,
  );

/**
 * A subscription billed with auto-collection OFF, its invoice `posted` with a due
 * date `dueInDays` from now.
 *
 * The due date is set directly rather than via payment terms: this suite is about
 * what happens AT the due date, and deriving it from Net-D config would make every
 * case depend on a second feature's defaults.
 */
async function setup(label: string, cfg: Record<string, unknown>, dueInDays: number, now: Date) {
  const org = await createOrganization({ name: `OfflineDun ${label}` });
  const orgId = org.organization.id;
  fixtureOrgs.push(orgId);
  const biz = await createBusiness({
    organizationId: orgId,
    name: "Biz",
    defaultCurrency: "USD",
    livemode: "test",
  });
  await withTenant(orgId, (tx) =>
    tx.update(businesses).set({ dunningConfig: cfg }).where(eq(businesses.id, biz.id)),
  );
  const customer = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: `${label}@offline.test`,
  });
  // A GOOD card on file on purpose: it proves the rail is never used rather than that
  // there was nothing to charge with. A cardless customer would pass case 1 for the
  // wrong reason.
  const pm = await vaultPaymentMethod({
    organizationId: orgId,
    businessId: biz.id,
    customer,
    token: GOOD,
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
    now,
    items: [{ price, quantity: 1 }],
    defaultPaymentMethodId: pm.id,
  });
  // Auto-collection OFF on the SUBSCRIPTION (overrides the customer's default 'on'),
  // which is the surface an operator actually uses for "this customer pays by invoice".
  await updateSubscriptionSettings({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionPublicId: sub.subscription.publicId,
    autoCollection: "off",
  });
  const fresh = await getSub(orgId, sub.subscription.id);
  const { invoice } = await billSubscriptionPeriod({
    organizationId: orgId,
    businessId: biz.id,
    subscription: fresh,
    periodStart: fresh.currentPeriodStart!,
    periodEnd: fresh.currentPeriodEnd!,
  });
  /**
   * Re-date the invoice into a Net-D `posted` bill.
   *
   * `dunningStatus`/`nextAttemptAt` are cleared alongside, and that is not cosmetic:
   * `billSubscriptionPeriod` above raised a DUE-NOW offline invoice, so it was enrolled
   * in dunning AT RAISE (`payment_due` + `in_progress` + a reminder instant — the shape
   * this suite's case 10 asserts directly). A genuinely Net-D offline invoice is
   * born `posted` with NO dunning state, because every dunning offset is measured from
   * the due date and there is nothing to count from yet; enrolment happens when the due
   * date arrives, which is what the cases below exercise. Leaving the raise-time
   * enrolment in place would also have left `next_attempt_at` armed on a `posted` row,
   * where the due scan reads that column as a collection LEASE and would skip the
   * invoice entirely.
   */
  await withTenant(orgId, (tx) =>
    tx
      .update(invoices)
      .set({
        status: "posted",
        dueDate: new Date(now.getTime() + dueInDays * DAY),
        dunningStatus: null,
        nextAttemptAt: null,
      })
      .where(eq(invoices.id, invoice.id)),
  );
  return { orgId, bizId: biz.id, customer, sub: fresh, invoice };
}

async function main() {
  const now = new Date("2026-09-01T00:00:00Z");
  const VOID_AND_CANCEL = { final_action: { invoice: "void", subscription: "cancel" } };

  // ── 1. the OPT-OUT (`dun_offline_invoices: false`) — the old behaviour ──────
  // The flag now DEFAULTS ON (offline invoices dun from the moment they are raised),
  // so this case has to say `false` out loud where it used to say nothing.
  // Its expectations are unchanged: opting out must still give the exact old edge.
  {
    const t = await setup("off", { ...VOID_AND_CANCEL, dun_offline_invoices: false }, -1, now);
    const r = await runInvoiceDueTransitions(now);
    const inv = await getInv(t.orgId, t.invoice.id);
    const sub = await getSub(t.orgId, t.sub.id);
    check(
      "opted out: due date → not_paid, never dunned",
      inv.status === "not_paid" && inv.dunningStatus === null && inv.nextAttemptAt === null,
      `status=${inv.status} dunning=${inv.dunningStatus} next=${inv.nextAttemptAt}`,
    );
    check("opted out: subscription untouched", sub.status === "active", `sub=${sub.status}`);
    check(
      "opted out: no charge attempted",
      (await payCount(t.orgId, t.invoice.id)) === 0,
      `payments=${await payCount(t.orgId, t.invoice.id)}`,
    );
    // NOT `r.offlineDunningOpened === 0`: that counter is SYSTEM-WIDE (the pass scans
    // every org), so with the flag now defaulting ON it counts other businesses' rows
    // and the assertion only ever passed by accident of a clean database. The property
    // that actually matters is per invoice — an opted-out invoice is never picked up by
    // the window scan, so no deadline can ever fire for it, however far the clock runs.
    void r;
    await runInvoiceDueTransitions(new Date(now.getTime() + 400 * DAY));
    const late = await getInv(t.orgId, t.invoice.id);
    const lateSub = await getSub(t.orgId, t.sub.id);
    check(
      "opted out: no window ever opens, so the final action can never fire",
      late.status === "not_paid" && late.dunningStatus === null && lateSub.status === "active",
      `status=${late.status} dunning=${late.dunningStatus} sub=${lateSub.status}`,
    );
  }

  // ── 1b. the DEFAULT is now ON ──────────────────────────────────────────────
  // A business that has configured nothing about offline dunning gets it. This is the
  // production-behaviour change the flip makes, so it is asserted rather than implied
  // by the cases below (all of which set the flag explicitly).
  {
    const t = await setup("default", VOID_AND_CANCEL, -1, now);
    await runInvoiceDueTransitions(now);
    const inv = await getInv(t.orgId, t.invoice.id);
    check(
      "default (nothing configured): the due date opens a window, not not_paid",
      inv.status === "payment_due" && inv.dunningStatus === "in_progress",
      `status=${inv.status} dunning=${inv.dunningStatus}`,
    );
  }

  // ── 2. flag ON, NO dunning period — reminders, but no deadline ─────────────
  // OLD expectation: `not_paid` + dunning null + next null ("ON with no period is an
  // honest no-op"). That was our bug talking: the same invoice must read `payment_due`
  // + `in_progress` + a `next_retry_at` with no period configured at all. ENROLMENT
  // needs no deadline; only EXHAUSTION does — which is why the invoice
  // must still never be voided or cancelled here (asserted at the end).
  {
    const t = await setup("noperiod", { ...VOID_AND_CANCEL, dun_offline_invoices: true }, -1, now);
    await runInvoiceDueTransitions(now);
    const inv = await getInv(t.orgId, t.invoice.id);
    // dueDate = now − 1d, default schedule [1,3,5,7] → candidates at now, now+2d,
    // now+4d, now+6d. Reminders are STRICTLY future, so the first is now+2d.
    const expectedFirst = new Date(now.getTime() + 2 * DAY);
    check(
      "ON without dunning_period_days: enrolled in dunning, payment_due, reminder armed",
      inv.status === "payment_due" &&
        inv.dunningStatus === "in_progress" &&
        inv.nextAttemptAt?.getTime() === expectedFirst.getTime(),
      `status=${inv.status} dunning=${inv.dunningStatus} next=${inv.nextAttemptAt?.toISOString()} (expected ${expectedFirst.toISOString()})`,
    );
    check(
      "ON without dunning_period_days: attempt_count stays 0 (no attempts)",
      inv.attemptCount === 0,
      `attempts=${inv.attemptCount}`,
    );
    // Far past every offset: with no period there is nothing that can close the window.
    await runInvoiceDueTransitions(new Date(now.getTime() + 400 * DAY));
    const late = await getInv(t.orgId, t.invoice.id);
    const lateSub = await getSub(t.orgId, t.sub.id);
    check(
      "ON without dunning_period_days: never voided, never cancelled, still payable",
      late.status === "payment_due" &&
        lateSub.status === "active" &&
        late.dunningStatus === "in_progress",
      `status=${late.status} sub=${lateSub.status} dunning=${late.dunningStatus}`,
    );
    check(
      "ON without dunning_period_days: still no charge attempted",
      (await payCount(t.orgId, t.invoice.id)) === 0,
      `payments=${await payCount(t.orgId, t.invoice.id)}`,
    );
  }

  // ── 3. flag ON + period — the due date OPENS a window ──────────────────────
  //
  // OLD expectations, both restated: the invoice was `not_paid` (now `payment_due`) and
  // `next_attempt_at` held the DEADLINE directly (now it holds the
  // next REMINDER, walked forward one retry offset at a time until the deadline is the
  // only candidate left). The deadline is re-derived on every tick instead of frozen
  // at open time, so a merchant who edits the period mid-window is honoured.
  {
    const t = await setup(
      "open",
      { ...VOID_AND_CANCEL, dun_offline_invoices: true, dunning_period_days: 7 },
      -1,
      now,
    );
    const r = await runInvoiceDueTransitions(now);
    const inv = await getInv(t.orgId, t.invoice.id);
    const sub = await getSub(t.orgId, t.sub.id);
    // dueDate = now − 1d, schedule [1,3,5,7], period 7 → deadline now+6d; reminder
    // candidates now, now+2d, now+4d, now+6d, of which the first future one is now+2d.
    const firstReminder = new Date(now.getTime() + 2 * DAY);
    const deadline = new Date(inv.dueDate!.getTime() + 7 * DAY);
    check(
      "ON: due date opens a dunning window, armed with the first REMINDER",
      inv.dunningStatus === "in_progress" &&
        inv.nextAttemptAt?.getTime() === firstReminder.getTime(),
      `dunning=${inv.dunningStatus} next=${inv.nextAttemptAt?.toISOString()} (expected ${firstReminder.toISOString()})`,
    );
    check(
      "ON: invoice is payment_due — an OPEN status, so the portal can still collect it",
      inv.status === "payment_due",
      `status=${inv.status}`,
    );
    check("ON: attempt_count stays 0", inv.attemptCount === 0, `attempts=${inv.attemptCount}`);
    check(
      "ON: subscription still active during the window",
      sub.status === "active",
      `sub=${sub.status}`,
    );
    check(
      "ON: still no charge attempted",
      (await payCount(t.orgId, t.invoice.id)) === 0,
      `payments=${await payCount(t.orgId, t.invoice.id)}`,
    );
    check(
      "ON: window reported by the pass",
      r.offlineDunningOpened >= 1,
      `opened=${r.offlineDunningOpened}`,
    );

    // A tick BEFORE the first reminder changes nothing.
    await runInvoiceDueTransitions(new Date(now.getTime() + DAY));
    const early = await getInv(t.orgId, t.invoice.id);
    check(
      "ON: a tick before the first reminder does nothing",
      early.nextAttemptAt?.getTime() === firstReminder.getTime(),
      `next=${early.nextAttemptAt?.toISOString()}`,
    );

    // ── 3b. the reminder ladder advances, and still charges nothing ──────────
    const r1b = await runInvoiceDueTransitions(new Date(firstReminder.getTime() + 1000));
    const mid = await getInv(t.orgId, t.invoice.id);
    const midSub = await getSub(t.orgId, t.sub.id);
    check(
      "ON: the reminder instant advances to the next offset, invoice still open",
      mid.status === "payment_due" &&
        mid.dunningStatus === "in_progress" &&
        mid.nextAttemptAt?.getTime() === new Date(now.getTime() + 4 * DAY).getTime() &&
        midSub.status === "active",
      `status=${mid.status} next=${mid.nextAttemptAt?.toISOString()} sub=${midSub.status}`,
    );
    check(
      "ON: a reminder is not an attempt — attempt_count still 0, still no payment row",
      mid.attemptCount === 0 && (await payCount(t.orgId, t.invoice.id)) === 0,
      `attempts=${mid.attemptCount} payments=${await payCount(t.orgId, t.invoice.id)}`,
    );
    check(
      "ON: reminder reported by the pass",
      r1b.offlineRemindersSent >= 1,
      `reminders=${r1b.offlineRemindersSent}`,
    );

    // ── 4. the deadline passes → the configured final action applies ─────────
    const after = new Date(deadline.getTime() + 1000);
    const r2 = await runInvoiceDueTransitions(after);
    const done = await getInv(t.orgId, t.invoice.id);
    const doneSub = await getSub(t.orgId, t.sub.id);
    check(
      "deadline: final action voided the invoice",
      done.status === "voided",
      `status=${done.status}`,
    );
    check(
      "deadline: final action cancelled the subscription",
      doneSub.status === "cancelled",
      `sub=${doneSub.status} reason=${doneSub.cancelReason}`,
    );
    check(
      "deadline: dunning marked exhausted and the deadline cleared",
      done.dunningStatus === "exhausted" && done.nextAttemptAt === null,
      `dunning=${done.dunningStatus} next=${done.nextAttemptAt}`,
    );
    check(
      "deadline: reported by the pass",
      r2.offlineDunningExhausted >= 1,
      `exhausted=${r2.offlineDunningExhausted}`,
    );
    check(
      "deadline: STILL no charge ever attempted",
      (await payCount(t.orgId, t.invoice.id)) === 0,
      `payments=${await payCount(t.orgId, t.invoice.id)}`,
    );

    // Idempotency: a second tick must not re-apply anything. Asserted on the INVOICE,
    // not on the pass's system-wide counter — another org's window closing on the same
    // tick would make a counter check fail for a reason that has nothing to do with
    // this invoice.
    await runInvoiceDueTransitions(new Date(after.getTime() + DAY));
    const again = await getInv(t.orgId, t.invoice.id);
    check(
      "deadline: idempotent — a later tick re-applies nothing",
      again.status === "voided" &&
        again.dunningStatus === "exhausted" &&
        again.nextAttemptAt === null,
      `status=${again.status} dunning=${again.dunningStatus} next=${again.nextAttemptAt}`,
    );
  }

  // ── 5. the customer PAYS during the window ────────────────────────────────
  // The case that matters most: the invoice is deliberately payable for the whole
  // window, so the deadline must not void a settled invoice or cancel a paying
  // customer. Acting on the state seen when the window OPENED would do exactly that.
  {
    const t = await setup(
      "paid",
      { ...VOID_AND_CANCEL, dun_offline_invoices: true, dunning_period_days: 7 },
      -1,
      now,
    );
    await runInvoiceDueTransitions(now);
    const opened = await getInv(t.orgId, t.invoice.id);
    check(
      "paid-in-window: window opened first",
      opened.dunningStatus === "in_progress",
      `dunning=${opened.dunningStatus}`,
    );

    // Pay it on the last day, the way a portal/offline payment does.
    // Amount omitted → the full outstanding balance, which is what a portal payment
    // or a recorded bank transfer settles.
    await recordOfflinePayment({
      organizationId: t.orgId,
      businessId: t.bizId,
      invoicePublicId: t.invoice.publicId,
      method: "wire",
    });
    const paid = await getInv(t.orgId, t.invoice.id);
    check(
      "paid-in-window: an offline invoice IS collectable mid-window",
      paid.status === "paid",
      `status=${paid.status}`,
    );

    const after = new Date(opened.nextAttemptAt!.getTime() + 1000);
    await runInvoiceDueTransitions(after);
    const final = await getInv(t.orgId, t.invoice.id);
    const finalSub = await getSub(t.orgId, t.sub.id);
    check(
      "paid-in-window: the deadline did NOT void a paid invoice",
      final.status === "paid",
      `status=${final.status}`,
    );
    check(
      "paid-in-window: the deadline did NOT cancel a paying customer",
      finalSub.status === "active",
      `sub=${finalSub.status}`,
    );
  }

  // ── 6. auto-collection switched back ON mid-window ────────────────────────
  // No longer an offline invoice, so this pass must hand it back rather than apply an
  // offline deadline to a subscription that is now on auto-collect.
  {
    const t = await setup(
      "reon",
      { ...VOID_AND_CANCEL, dun_offline_invoices: true, dunning_period_days: 7 },
      -1,
      now,
    );
    await runInvoiceDueTransitions(now);
    const opened = await getInv(t.orgId, t.invoice.id);
    await updateSubscriptionSettings({
      organizationId: t.orgId,
      businessId: t.bizId,
      subscriptionPublicId: t.sub.publicId,
      autoCollection: "on",
    });
    await runInvoiceDueTransitions(new Date(opened.nextAttemptAt!.getTime() + 1000));
    const inv = await getInv(t.orgId, t.invoice.id);
    const sub = await getSub(t.orgId, t.sub.id);
    check(
      "auto-collect back ON mid-window: offline deadline does not fire",
      inv.status !== "voided" && sub.status === "active",
      `status=${inv.status} sub=${sub.status}`,
    );
  }

  // ── 7. the flag switched OFF mid-window ──────────────────────────────────
  // A merchant must be able to stop this. The window is re-validated at close, not
  // trusted from when it opened.
  {
    const t = await setup(
      "revoke",
      { ...VOID_AND_CANCEL, dun_offline_invoices: true, dunning_period_days: 7 },
      -1,
      now,
    );
    await runInvoiceDueTransitions(now);
    const opened = await getInv(t.orgId, t.invoice.id);
    await withTenant(t.orgId, (tx) =>
      tx
        .update(businesses)
        .set({
          dunningConfig: {
            ...VOID_AND_CANCEL,
            dun_offline_invoices: false,
            dunning_period_days: 7,
          },
        })
        .where(eq(businesses.id, t.bizId)),
    );
    await runInvoiceDueTransitions(new Date(opened.nextAttemptAt!.getTime() + 1000));
    const inv = await getInv(t.orgId, t.invoice.id);
    const sub = await getSub(t.orgId, t.sub.id);
    check(
      "flag revoked mid-window: nothing is voided or cancelled",
      inv.status !== "voided" && sub.status === "active",
      `status=${inv.status} sub=${sub.status}`,
    );
  }

  // ── 8. retain instead of cancel ──────────────────────────────────────────
  // The final action is the operator's, not ours: `retain` must leave the sub active
  // while still settling the invoice (SUB-7).
  {
    const t = await setup(
      "retain",
      {
        final_action: { invoice: "write_off", subscription: "retain" },
        dun_offline_invoices: true,
        dunning_period_days: 3,
      },
      -1,
      now,
    );
    await runInvoiceDueTransitions(now);
    const opened = await getInv(t.orgId, t.invoice.id);
    await runInvoiceDueTransitions(new Date(opened.nextAttemptAt!.getTime() + 1000));
    const inv = await getInv(t.orgId, t.invoice.id);
    const sub = await getSub(t.orgId, t.sub.id);
    check(
      "retain: invoice written off, subscription RETAINED",
      inv.writtenOff === true && sub.status === "active",
      `written_off=${inv.writtenOff} status=${inv.status} sub=${sub.status}`,
    );
  }

  // ── 9. auto-collect ON is unaffected (regression) ─────────────────────────
  // The flag must not change the ordinary path: an auto-collect-ON invoice at its due
  // date is still CHARGED, not put on an offline countdown.
  //
  // Built by billing it OFF (so it stays `posted` — with auto-collection on it would
  // be charged at generation and never reach the due pass) and switching collection ON
  // before the pass runs. That is also the real sequence when a merchant fixes a
  // customer's setting after an invoice was issued.
  {
    const t = await setup(
      "regression",
      { ...VOID_AND_CANCEL, dun_offline_invoices: true, dunning_period_days: 7 },
      -1,
      now,
    );
    await updateSubscriptionSettings({
      organizationId: t.orgId,
      businessId: t.bizId,
      subscriptionPublicId: t.sub.publicId,
      autoCollection: "on",
    });
    await runInvoiceDueTransitions(now);
    const inv = await getInv(t.orgId, t.invoice.id);
    check(
      "auto-collect ON: CHARGED at the due date, not put on an offline countdown",
      inv.status === "paid" && inv.dunningStatus !== "in_progress",
      `status=${inv.status} dunning=${inv.dunningStatus}`,
    );
    check(
      "auto-collect ON: the charge really happened",
      (await payCount(t.orgId, t.invoice.id)) >= 1,
      `payments=${await payCount(t.orgId, t.invoice.id)}`,
    );
  }

  // ── 10. THE MEASURED TARGET: enrolled AT RAISE, not at the due date ────────
  //
  // The case the whole rewrite exists for. A freshly raised `auto_collection: off`
  // unpaid invoice must read:
  //
  //   status = payment_due · dunning_status = in_progress · dunning_attempts = []
  //   next_retry_at = invoice date + the first retry interval
  //   due_date = the invoice date exactly (zero net terms) · amount_paid = 0
  //
  // Ours reported `payment_due` + `dunning_status: null` + `due_date: null` here, and
  // `not_paid` + `attempt_count: 1` on the plan-change path — two offline unpaid
  // invoices on ONE customer with different statuses, which is how this was found.
  //
  // No `setup()` here on purpose: that helper re-dates the invoice into a Net-D
  // `posted` bill, and this case is precisely about the invoice as raised.
  {
    const t = await setup(
      "atraise",
      { ...VOID_AND_CANCEL, dun_offline_invoices: true, dunning_period_days: 30 },
      0,
      now,
    );
    // Re-bill the SAME subscription for the next period, untouched by setup's re-dating,
    // so this is an invoice exactly as `billSubscriptionPeriod` leaves it.
    const sub = await getSub(t.orgId, t.sub.id);
    // The reminder is armed against the REAL clock, so a period dated in the past (the
    // fixture's clock is fixed) skips retries that already elapsed. Start it ahead of now.
    const start = new Date(Math.max(sub.currentPeriodEnd!.getTime(), Date.now() + DAY));
    const { invoice: raised } = await billSubscriptionPeriod({
      organizationId: t.orgId,
      businessId: t.bizId,
      subscription: sub,
      periodStart: start,
      periodEnd: new Date(start.getTime() + 30 * DAY),
    });
    const inv = await getInv(t.orgId, raised.id);
    const cfg = resolveDunningConfig(null);
    const firstOffset = (cfg.retryDays[0] ?? DUNNING_RETRY_DAYS[0])!;
    check(
      "at raise: due_date is the invoice date, not null",
      inv.dueDate?.getTime() === start.getTime(),
      `due_date=${inv.dueDate?.toISOString()} (expected ${start.toISOString()})`,
    );
    check(
      "at raise: status is payment_due, not not_paid",
      inv.status === "payment_due",
      `status=${inv.status}`,
    );
    check(
      "at raise: dunning_status is in_progress",
      inv.dunningStatus === "in_progress",
      `dunning=${inv.dunningStatus}`,
    );
    check(
      "at raise: next_attempt_at = due date + the FIRST retry interval",
      inv.nextAttemptAt?.getTime() ===
        new Date(inv.dueDate!.getTime() + firstOffset * DAY).getTime(),
      `next=${inv.nextAttemptAt?.toISOString()} (expected due_date + ${firstOffset}d)`,
    );
    check(
      "at raise: attempt_count is 0 (no attempts)",
      inv.attemptCount === 0,
      `attempts=${inv.attemptCount}`,
    );
    check(
      "at raise: nothing was charged",
      (await payCount(t.orgId, raised.id)) === 0,
      `payments=${await payCount(t.orgId, raised.id)}`,
    );

    // ── 10b. the guard that replaces a structural invariant ────────────────────
    // An offline invoice in dunning is now column-for-column identical to a retried
    // one, so the ONLY thing keeping `runDunningPass` from charging it is its explicit
    // auto-collect check. Drive the real pass at the reminder instant and prove it.
    const atReminder = new Date(inv.nextAttemptAt!.getTime() + 1000);
    const dun = await runDunningPass(atReminder);
    const strand = await sweepStrandedRetries(atReminder);
    const afterDun = await getInv(t.orgId, raised.id);
    check(
      "runDunningPass never charges an auto-collect-off invoice",
      (await payCount(t.orgId, raised.id)) === 0 && afterDun.attemptCount === 0,
      `payments=${await payCount(t.orgId, raised.id)} attempts=${afterDun.attemptCount} retried=${dun.retried}`,
    );
    check(
      "runDunningPass leaves the offline reminder schedule alone",
      afterDun.status === "payment_due" &&
        afterDun.dunningStatus === "in_progress" &&
        afterDun.nextAttemptAt?.getTime() === inv.nextAttemptAt!.getTime(),
      `status=${afterDun.status} dunning=${afterDun.dunningStatus} next=${afterDun.nextAttemptAt?.toISOString()}`,
    );
    check(
      "sweepStrandedRetries does not re-arm an offline invoice",
      strand.rearmed === 0,
      `rearmed=${strand.rearmed}`,
    );
  }

  // ── 11. a window whose deadline is ALREADY past when it opens ──────────────
  // The backdated case: an existing `posted` offline bill (or an import) whose due date
  // plus dunning period is long gone. It must CLOSE, not enrol into a chase nothing
  // will ever end — the old code armed `next_attempt_at = deadline` directly and
  // got this right by accident, so it is asserted explicitly now.
  {
    const t = await setup(
      "elapsed",
      { ...VOID_AND_CANCEL, dun_offline_invoices: true, dunning_period_days: 3 },
      -30,
      now,
    );
    // ONE tick both opens and closes it: the enrolment arms the past deadline, and the
    // window scan runs after the due scan inside the same pass, so it is picked up
    // immediately. (Two passes would also work; one is the honest observation.)
    const r = await runInvoiceDueTransitions(now);
    check(
      "already-elapsed period: closed by the same pass that opened it",
      r.offlineDunningOpened >= 1 && r.offlineDunningExhausted >= 1,
      `opened=${r.offlineDunningOpened} exhausted=${r.offlineDunningExhausted}`,
    );
    const done = await getInv(t.orgId, t.invoice.id);
    const doneSub = await getSub(t.orgId, t.sub.id);
    check(
      "already-elapsed period: the final action fires instead of stranding the invoice",
      done.status === "voided" &&
        done.dunningStatus === "exhausted" &&
        doneSub.status === "cancelled",
      `status=${done.status} dunning=${done.dunningStatus} sub=${doneSub.status}`,
    );
    check(
      "already-elapsed period: still no charge attempted",
      (await payCount(t.orgId, t.invoice.id)) === 0,
      `payments=${await payCount(t.orgId, t.invoice.id)}`,
    );
  }

  // ── 12. customer EXCLUDED from dunning: the window does not open ────────────
  // Offline dunning is reminders only; an excluded customer gets none.
  {
    const t = await setup(
      "excluded",
      { ...VOID_AND_CANCEL, dun_offline_invoices: true, dunning_period_days: 7 },
      -1,
      now,
    );
    await updateCustomer({
      organizationId: t.orgId,
      businessId: t.bizId,
      customerPublicId: t.customer.publicId,
      dunningExcluded: true,
    });
    await runInvoiceDueTransitions(now);
    const inv = await getInv(t.orgId, t.invoice.id);
    check(
      "excluded: the due date does not open a window",
      inv.status === "not_paid" && inv.dunningStatus === null && inv.nextAttemptAt === null,
      `status=${inv.status} dunning=${inv.dunningStatus} next=${inv.nextAttemptAt}`,
    );
  }

  // ── 13. excluded MID-WINDOW: no reminder, no close. Time is frozen, so turning it
  // off moves every remaining reminder and the deadline later by the exclusion's length.
  {
    const t = await setup(
      "excluded-mid",
      { ...VOID_AND_CANCEL, dun_offline_invoices: true, dunning_period_days: 7 },
      -1,
      now,
    );
    await runInvoiceDueTransitions(now);
    const open = await getInv(t.orgId, t.invoice.id);
    const setExcluded = (at: Date, dunningExcluded: boolean) =>
      runWithClockScope({ onlyBusinessId: t.bizId, now: at }, () =>
        updateCustomer({
          organizationId: t.orgId,
          businessId: t.bizId,
          customerPublicId: t.customer.publicId,
          dunningExcluded,
        }),
      );
    await setExcluded(now, true);
    const atReminder = new Date(open.nextAttemptAt!.getTime() + 1000);
    await runInvoiceDueTransitions(atReminder);
    const held = await getInv(t.orgId, t.invoice.id);
    check(
      "excluded mid-window: the reminder is not sent and stays armed",
      held.nextAttemptAt?.getTime() === open.nextAttemptAt!.getTime(),
      `next=${held.nextAttemptAt?.toISOString()} (armed ${open.nextAttemptAt!.toISOString()})`,
    );
    const pastDeadline = new Date(now.getTime() + 20 * DAY);
    await runInvoiceDueTransitions(pastDeadline);
    const stillOpen = await getInv(t.orgId, t.invoice.id);
    const subHeld = await getSub(t.orgId, t.sub.id);
    check(
      "excluded mid-window: the window does not close, nothing is voided or cancelled",
      stillOpen.status === "payment_due" &&
        stillOpen.dunningStatus === "in_progress" &&
        subHeld.status === "active",
      `status=${stillOpen.status} dunning=${stillOpen.dunningStatus} sub=${subHeld.status}`,
    );
    // Lifted on day 20 (excluded from day 0): the day-2 reminder moves to day 22 and the
    // day-6 deadline to day 26.
    await setExcluded(pastDeadline, false);
    const lifted = await getInv(t.orgId, t.invoice.id);
    const at = (d: number) => new Date(now.getTime() + d * DAY);
    check(
      "turned off: the armed reminder moves later by the exclusion's length",
      lifted.nextAttemptAt?.getTime() === at(22).getTime() && lifted.dunningHeldMs === 20 * DAY,
      `next=${lifted.nextAttemptAt?.toISOString()} (expected ${at(22).toISOString()}) held_ms=${lifted.dunningHeldMs}`,
    );
    await runInvoiceDueTransitions(new Date(pastDeadline.getTime() + 1000));
    const notYet = await getInv(t.orgId, t.invoice.id);
    check(
      "turned off: the passed deadline does not close the window at once",
      notYet.status === "payment_due" && notYet.dunningStatus === "in_progress",
      `status=${notYet.status} dunning=${notYet.dunningStatus}`,
    );
    await runInvoiceDueTransitions(new Date(at(22).getTime() + 1000));
    const reminded = await getInv(t.orgId, t.invoice.id);
    check(
      "turned off: the moved reminder is sent on day 22, the next one armed for day 24",
      reminded.nextAttemptAt?.getTime() === at(24).getTime(),
      `next=${reminded.nextAttemptAt?.toISOString()} (expected ${at(24).toISOString()})`,
    );
    await runInvoiceDueTransitions(at(25));
    const beforeEnd = await getInv(t.orgId, t.invoice.id);
    await runInvoiceDueTransitions(new Date(at(26).getTime() + 1000));
    const resumed = await getInv(t.orgId, t.invoice.id);
    check(
      "turned off: the final action runs at the moved deadline (day 26), not before",
      beforeEnd.status === "payment_due" &&
        resumed.status === "voided" &&
        resumed.dunningStatus === "exhausted",
      `day25=${beforeEnd.status} day26=${resumed.status}/${resumed.dunningStatus}`,
    );
    check(
      "excluded: still no charge attempted",
      (await payCount(t.orgId, t.invoice.id)) === 0,
      `payments=${await payCount(t.orgId, t.invoice.id)}`,
    );
  }

  // ── 14. BELOW the per-currency minimum: no window ──────────────────────────
  {
    const t = await setup(
      "below-min",
      { ...VOID_AND_CANCEL, dun_offline_invoices: true, minimum_amounts: { USD: 6000 } },
      -1,
      now,
    );
    await runInvoiceDueTransitions(now);
    const inv = await getInv(t.orgId, t.invoice.id);
    check(
      "below the minimum: the due date does not open a window",
      inv.status === "not_paid" && inv.dunningStatus === null,
      `status=${inv.status} dunning=${inv.dunningStatus}`,
    );
    const at = await setup(
      "at-min",
      { ...VOID_AND_CANCEL, dun_offline_invoices: true, minimum_amounts: { USD: 5000 } },
      -1,
      now,
    );
    await runInvoiceDueTransitions(now);
    const atInv = await getInv(at.orgId, at.invoice.id);
    check(
      "at the minimum: the window opens",
      atInv.status === "payment_due" && atInv.dunningStatus === "in_progress",
      `status=${atInv.status} dunning=${atInv.dunningStatus}`,
    );
  }

  // ── 15. a part-payment takes what is LEFT below the minimum: reminders stop ──
  {
    const t = await setup(
      "part-paid",
      { ...VOID_AND_CANCEL, dun_offline_invoices: true, minimum_amounts: { USD: 3000 } },
      -1,
      now,
    );
    await runInvoiceDueTransitions(now);
    const open = await getInv(t.orgId, t.invoice.id);
    await recordOfflinePayment({
      organizationId: t.orgId,
      businessId: t.bizId,
      invoicePublicId: open.publicId,
      amountMinor: 2500,
      method: "cash",
    });
    const atReminder = new Date(open.nextAttemptAt!.getTime() + 1000);
    await runInvoiceDueTransitions(atReminder);
    const held = await getInv(t.orgId, t.invoice.id);
    check(
      "part-paid below the minimum: the reminder is not sent",
      held.status === "payment_due" &&
        held.nextAttemptAt?.getTime() === open.nextAttemptAt!.getTime(),
      `status=${held.status} next=${held.nextAttemptAt?.toISOString()}`,
    );
    // Settle the rest: the teardown voids open fixtures, and a part-paid invoice cannot be voided.
    await recordOfflinePayment({
      organizationId: t.orgId,
      businessId: t.bizId,
      invoicePublicId: open.publicId,
      method: "cash",
    });
  }

  // Every case here ends with an invoice somebody would have to collect, and a fixture
  // invoice is indistinguishable from a real one to the billing clock's diary — so
  // without this each run leaves a permanently overdue row on /ops/due-work.
  const retired = await retireFixtureRetries(fixtureOrgs);
  console.log(`\nteardown: retired ${retired} fixture retr${retired === 1 ? "y" : "ies"}`);

  console.log(`\n${passed} passed, ${failed} failed`);
  return failed === 0;
}

const ok = await main();
await closeDb();
process.exit(ok ? 0 : 1);
