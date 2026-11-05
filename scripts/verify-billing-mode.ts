/**
 * Proves the three billing modes behave as specified:
 *
 *   anchor    proration    meaning
 *   instant   exact        millisecond-based (our default)
 *   instant   whole_day    day-based, sites created >= 2026-05-19
 *   day       whole_day    day-based, EARLIER definition (sites < 2026-05-19)
 *
 * Part A unit-tests the pure boundary helpers (no DB), including the worked
 * cancellation example. Part B runs each mode end-to-end: term anchoring,
 * the inclusive term end on the API surface, and the whole-day cancellation credit.
 * Part B2 covers the inclusive term end surviving a read-modify-write, and B3 the
 * trial→active conversion (both paths) landing on a local midnight. Part C proves the
 * illegal 4th combination is rejected at both the service layer and the DB CHECK
 * constraint.
 *
 *   pnpm verify:billing-mode
 */
import { eq } from "drizzle-orm";
import { withTenant, closeDb, systemDb } from "@/platform/db";
import { sql } from "drizzle-orm";
import {
  createOrganization,
  createBusiness,
  updateBusiness,
  TenancyError,
} from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import {
  createSubscription,
  cancelSubscriptionWithOptions,
  editTrialEnd,
  advancePeriod,
  calendarAnchorFor,
} from "@/modules/subscriptions/service";
import { changeBillingDate } from "@/modules/customers/service";
import { billSubscriptionPeriod } from "@/modules/invoicing/service";
import { serializeSubscription } from "@/modules/subscriptions/serialize";
import {
  alignTermStart,
  alignTrialEnd,
  prorationBoundary,
  prorationWindowStart,
  normalizeTermEnd,
  DEFAULT_BILLING_MODE,
  type BillingMode,
} from "@/modules/subscriptions/billing-mode";
import {
  businesses,
  subscriptions,
  subscriptionItems,
  invoiceLineItems,
  creditNotes,
} from "@db/schema";

let failures = 0;
function ok(label: string, cond: boolean, detail = "") {
  if (!cond) failures++;
  console.log(`${cond ? "  ✓" : "  ✗"} ${label}${detail ? ` — ${detail}` : ""}`);
}

const TZ = "Asia/Kolkata"; // +05:30, no DST — keeps the expected instants readable
const MS: BillingMode = { anchor: "instant", proration: "exact", timezone: TZ };
const DAY_NEW: BillingMode = { anchor: "instant", proration: "whole_day", timezone: TZ };
const DAY_OLD: BillingMode = { anchor: "day", proration: "whole_day", timezone: TZ };

// ---------------------------------------------------------------- Part A: helpers
console.log("\nA. boundary helpers (pure)");

// 2026-07-23 12:30 IST = 07:00Z — a 12:30 PM term start.
const termStart = new Date("2026-07-23T07:00:00.000Z");
const istMidnightOfThatDay = new Date("2026-07-22T18:30:00.000Z"); // 2026-07-23 00:00 IST

ok(
  "millisecond: term start is the exact instant",
  alignTermStart(termStart, MS).getTime() === termStart.getTime(),
);
ok(
  "day-based (new): term start is the exact instant",
  alignTermStart(termStart, DAY_NEW).getTime() === termStart.getTime(),
);
ok(
  "day-based (earlier): term start floors to local midnight",
  alignTermStart(termStart, DAY_OLD).getTime() === istMidnightOfThatDay.getTime(),
  alignTermStart(termStart, DAY_OLD).toISOString(),
);

ok(
  "millisecond: proration boundary is `now`",
  prorationBoundary(termStart, termStart, MS).getTime() === termStart.getTime(),
);

// Earlier definition: terms sit on midnights, so the boundary is the NEXT local
// midnight — the behavior the frozen fixtures were recorded against.
{
  const now = new Date("2026-08-01T09:00:00.000Z"); // 14:30 IST on Aug 1
  const expected = new Date("2026-08-01T18:30:00.000Z"); // Aug 2 00:00 IST
  ok(
    "day-based (earlier): boundary is the next local midnight",
    prorationBoundary(now, istMidnightOfThatDay, DAY_OLD).getTime() === expected.getTime(),
    prorationBoundary(now, istMidnightOfThatDay, DAY_OLD).toISOString(),
  );
}

// New definition, the worked cancellation example: a term created at 10:00 AM has
// billing days running 10:00→10:00, so a 09:00 AM cancellation sits in the PREVIOUS
// billing day and the boundary is TODAY 10:00.
{
  const start10 = new Date("2026-09-01T04:30:00.000Z"); // 10:00 IST
  const cancel09 = new Date("2026-09-21T03:30:00.000Z"); // 09:00 IST on the 21st
  const boundary = prorationBoundary(cancel09, start10, DAY_NEW);
  ok(
    "day-based (new): 09:00 cancel on a 10:00 term → boundary is the same day 10:00 IST",
    boundary.toISOString() === "2026-09-21T04:30:00.000Z",
    boundary.toISOString(),
  );
  const windowStart = prorationWindowStart(cancel09, start10, DAY_NEW);
  ok(
    "day-based (new): its billing day STARTED the previous day at 10:00 IST",
    windowStart.toISOString() === "2026-09-20T04:30:00.000Z",
    windowStart.toISOString(),
  );

  // 11:00 AM is AFTER the 10:00 boundary → it belongs to the next billing day.
  const cancel11 = new Date("2026-09-21T05:30:00.000Z");
  ok(
    "day-based (new): 11:00 cancel rolls the boundary to the following day 10:00 IST",
    prorationBoundary(cancel11, start10, DAY_NEW).toISOString() === "2026-09-22T04:30:00.000Z",
    prorationBoundary(cancel11, start10, DAY_NEW).toISOString(),
  );
  ok(
    "day-based (new): 11:00 cancel sits in the billing day that began today 10:00 IST",
    prorationWindowStart(cancel11, start10, DAY_NEW).toISOString() === "2026-09-21T04:30:00.000Z",
  );
}

// Landing exactly ON a boundary must yield the NEXT one in BOTH day modes, so a
// customer always keeps a whole final day.
ok(
  "exactly on the boundary keeps a full day (earlier definition)",
  prorationBoundary(istMidnightOfThatDay, istMidnightOfThatDay, DAY_OLD).toISOString() ===
    "2026-07-23T18:30:00.000Z",
);
ok(
  "exactly on the boundary keeps a full day (new definition)",
  prorationBoundary(termStart, termStart, DAY_NEW).toISOString() === "2026-07-24T07:00:00.000Z",
);

// Trial end: a day-anchored trial_end sits at the last moment of its final day.
ok(
  "day-based (earlier): trial end moves to end-of-day (23:59:59 IST)",
  alignTrialEnd(termStart, DAY_OLD).toISOString() === "2026-07-23T18:29:59.000Z",
  alignTrialEnd(termStart, DAY_OLD).toISOString(),
);
ok(
  "millisecond: trial end is untouched",
  alignTrialEnd(termStart, MS).getTime() === termStart.getTime(),
);

// ------------------------------------------------------- Part B: end-to-end per mode
console.log("\nB. end-to-end per mode");

const org = await createOrganization({ name: "Billing Mode Org" });
const orgId = org.organization.id;

/** Build a business in one mode with a $120/month plan and one paid-up customer. */
async function setup(name: string, mode: Partial<BillingMode>) {
  const biz = await createBusiness({
    organizationId: orgId,
    name,
    defaultCurrency: "USD",
    livemode: "test",
    timezone: TZ,
    ...(mode.anchor ? { anchorGranularity: mode.anchor } : {}),
    ...(mode.proration ? { prorationGranularity: mode.proration } : {}),
  });
  const customer = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: `${name}@a.com`,
  });
  await vaultPaymentMethod({
    organizationId: orgId,
    businessId: biz.id,
    customer,
    token: "tok_4242",
  });
  const product = await createProduct({ organizationId: orgId, businessId: biz.id, name: "Plan" });
  const price = await createPrice({
    organizationId: orgId,
    businessId: biz.id,
    productId: product.id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 12000,
    interval: "month",
  });
  return { biz, customer, price };
}

const bizRow = (id: string) =>
  withTenant(
    orgId,
    async (tx) => (await tx.select().from(businesses).where(eq(businesses.id, id)).limit(1))[0]!,
  );

// Sign up mid-afternoon so an anchored term start is visibly different from the instant.
const signup = new Date("2026-07-23T07:00:00.000Z"); // 12:30 IST

for (const [label, mode, expectStart] of [
  ["millisecond", MS, signup],
  ["day-based (new)", DAY_NEW, signup],
  ["day-based (earlier)", DAY_OLD, istMidnightOfThatDay],
] as const) {
  const { biz, customer, price } = await setup(`biz-${label.replace(/\W+/g, "-")}`, mode);
  const fresh = await bizRow(biz.id);
  ok(
    `${label}: stored axes are ${mode.anchor}/${mode.proration}`,
    fresh.anchorGranularity === mode.anchor && fresh.prorationGranularity === mode.proration,
    `${fresh.anchorGranularity}/${fresh.prorationGranularity}`,
  );

  const { subscription } = await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: customer.id,
    now: signup,
    items: [{ price, quantity: 1 }],
  });
  // These fixtures never trial, so the term is present — and asserting it explicitly is
  // itself worth something: a trialling subscription has NO term since 2026-08-25, so a
  // null here would mean the fixture drifted rather than the alignment being wrong.
  ok(`${label}: has a term at all (not trialling)`, subscription.currentPeriodStart! != null);
  ok(
    `${label}: term starts at ${expectStart.toISOString()}`,
    subscription.currentPeriodStart?.getTime() === expectStart.getTime(),
    subscription.currentPeriodStart?.toISOString() ?? "null",
  );

  // The API surface: a day-anchored term end is reported INCLUSIVELY (…23:59:59) — the
  // last instant the term covers — where we store the exclusive next boundary. Storage
  // must stay exclusive, and the back-off is a SECOND (see `inclusiveBoundary`).
  const view = serializeSubscription(subscription, fresh) as Record<string, unknown>;
  const apiEnd = view.current_period_end as Date;
  const storedEnd = subscription.currentPeriodEnd!;
  if (!storedEnd)
    throw new Error("expected a subscription with a term; got one without (in trial?)");
  if (mode.anchor === "day") {
    ok(
      `${label}: API term end is inclusive (1s before the stored boundary)`,
      apiEnd.getTime() === storedEnd.getTime() - 1000,
      apiEnd.toISOString(),
    );
    ok(
      `${label}: that lands at 23:59:59 local, on a whole second`,
      apiEnd.getTime() % 1000 === 0,
      apiEnd.toISOString(),
    );
    ok(
      `${label}: and formats as 23:59:59 local`,
      new Intl.DateTimeFormat("en-GB", {
        timeZone: TZ,
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      }).format(apiEnd) === "23:59:59",
      apiEnd.toISOString(),
    );
    ok(
      `${label}: storage is still the exclusive boundary (00:00 local)`,
      storedEnd.getTime() % 1000 === 0 && storedEnd.getTime() !== apiEnd.getTime(),
    );
  } else {
    ok(
      `${label}: API term end equals the stored boundary`,
      apiEnd.getTime() === storedEnd.getTime(),
      apiEnd.toISOString(),
    );
  }

  // Bill the term in advance so there is something to credit back, then cancel 10 days
  // and 3 hours in. The 3 hours are the discriminator: whole-day proration must ignore
  // them, exact proration must not.
  const subRow = await withTenant(
    orgId,
    async (tx) =>
      (
        await tx.select().from(subscriptions).where(eq(subscriptions.id, subscription.id)).limit(1)
      )[0]!,
  );
  await billSubscriptionPeriod({
    organizationId: orgId,
    businessId: biz.id,
    subscription: subRow,
    periodStart: subRow.currentPeriodStart!,
    periodEnd: subRow.currentPeriodEnd!,
  });
  const cancelAt = new Date(
    subscription.currentPeriodStart!.getTime() + 10 * 86_400_000 + 3 * 3_600_000,
  );
  const res = await cancelSubscriptionWithOptions({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId: subscription.id,
    cancelOption: "immediately",
    creditOptionForCurrentTermCharges: "prorate",
    now: cancelAt,
  });
  const cn = res.creditNote
    ? await withTenant(
        orgId,
        async (tx) =>
          (
            await tx
              .select()
              .from(creditNotes)
              .where(eq(creditNotes.publicId, res.creditNote!))
              .limit(1)
          )[0] ?? null,
      )
    : null;
  ok(`${label}: cancelling a billed term issues a credit note`, !!cn);
  const credit = cn ? Number(cn.totalMinor) : 0;
  const termMs = storedEnd.getTime() - subscription.currentPeriodStart!.getTime();
  const termDays = Math.round(termMs / 86_400_000);
  if (mode.proration === "whole_day") {
    // Whole-day: the customer keeps the day they cancel in, so the credit is an exact
    // number of remaining WHOLE days — never a fractional-day amount.
    const perDay = 12000 / termDays;
    const remainingDays = Math.round(credit / perDay);
    ok(
      `${label}: credit is a whole number of days (${remainingDays}/${termDays} days of $120)`,
      Math.abs(credit - remainingDays * perDay) <= 1,
      `credit=${credit} perDay=${perDay.toFixed(2)}`,
    );
    ok(
      `${label}: the cancel day itself is NOT credited`,
      remainingDays === termDays - 11,
      `remaining=${remainingDays} expected=${termDays - 11}`,
    );
  } else {
    // Exact: the 3 extra hours must show up, so the credit cannot be a whole-day figure.
    const exact = Math.round((12000 * (storedEnd.getTime() - cancelAt.getTime())) / termMs);
    ok(
      `${label}: credit is time-exact (${credit}, expected ~${exact})`,
      Math.abs(credit - exact) <= 2,
      `credit=${credit}`,
    );
  }
}

// ------------------------------------- Part B2: term-end read/write round trip
// The API reports a day-anchored term end inclusively, so a client that reads it and
// writes it back must land on the SAME stored boundary. Without normalizeTermEnd each
// cycle walked the term off midnight (caught driving the dialog over CDP, 2026-07-31).
console.log("\nB2. inclusive term end survives a read-modify-write");
{
  const exclusiveMidnight = new Date("2026-08-30T18:30:00.000Z"); // 31-Aug 00:00 IST
  const inclusive = new Date(exclusiveMidnight.getTime() - 1000); // what the API reports
  ok(
    "an inclusive term end normalizes back to the stored boundary",
    normalizeTermEnd(inclusive, DAY_OLD).getTime() === exclusiveMidnight.getTime(),
    normalizeTermEnd(inclusive, DAY_OLD).toISOString(),
  );
  ok(
    "the exclusive boundary itself passes through (no extra day)",
    normalizeTermEnd(exclusiveMidnight, DAY_OLD).getTime() === exclusiveMidnight.getTime(),
  );
  // Minute-precision entry (`datetime-local` drops the seconds) must also land on midnight.
  ok(
    "23:59 local entry normalizes up to the next midnight",
    normalizeTermEnd(new Date("2026-08-30T18:29:00.000Z"), DAY_OLD).getTime() ===
      exclusiveMidnight.getTime(),
  );
  ok(
    "a mid-day instant rounds up — the customer keeps the day they are in",
    normalizeTermEnd(new Date("2026-08-30T08:00:00.000Z"), DAY_OLD).toISOString() ===
      "2026-08-30T18:30:00.000Z",
  );
  // Repeated cycles must converge, not drift.
  let t = inclusive;
  for (let i = 0; i < 5; i++)
    t = normalizeTermEnd(new Date(normalizeTermEnd(t, DAY_OLD).getTime() - 1000), DAY_OLD);
  ok(
    "five read-modify-write cycles do not drift",
    t.getTime() === exclusiveMidnight.getTime(),
    t.toISOString(),
  );
  ok(
    "instant-anchored businesses are untouched",
    normalizeTermEnd(inclusive, MS).getTime() === inclusive.getTime(),
  );
}

// --------------------------------- Part B3: a trial converting stays on local midnight
// The trial end IS the next term's start, so both trial-end paths owe the day-anchored
// alignment. Neither did: "end trial now" stamped the wall-clock instant (a term starting
// 22:26 IST, and — because `billing_anchor_day` came from the ALIGNED create start — a
// renewal a DAY EARLY), and a natural conversion inherited the trial's 23:59:59 landing.
console.log("\nB3. a trial converting keeps day-anchored terms on local midnight");
{
  const fmt = (opts: Intl.DateTimeFormatOptions) => (d: Date) =>
    new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour12: false, ...opts }).format(d);
  const localTime = fmt({
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
  });
  const localDate = fmt({ year: "numeric", month: "2-digit", day: "2-digit" });
  // 21:19 IST on 3-Aug — late enough in the local day that an unaligned boundary is
  // unmistakable, and (being past 18:30 IST) on the PREVIOUS UTC day.
  const signupLate = new Date("2026-08-03T15:49:00.000Z");

  // (a) "end trial now", 22:26 IST the next day — the exact case reported 2026-08-04.
  {
    const { biz, customer, price } = await setup("biz-trial-end-now", DAY_OLD);
    const { subscription } = await createSubscription({
      organizationId: orgId,
      businessId: biz.id,
      customerId: customer.id,
      now: signupLate,
      trialDays: 7,
      items: [{ price, quantity: 1 }],
    });
    ok(
      "a day-anchored trial ends at 23:59:59 local (unchanged)",
      localTime(subscription.trialEnd!) === "23:59:59.000",
      localTime(subscription.trialEnd!),
    );

    const endedAt = new Date("2026-08-04T16:56:52.893Z"); // 22:26:52.893 IST on 4-Aug
    const { subscription: live } = await editTrialEnd({
      organizationId: orgId,
      businessId: biz.id,
      subscriptionId: subscription.id, // the "…ByPublicId" lookup actually keys on the uuid
      now: endedAt,
      immediately: true,
    });
    ok(
      "end-trial-now: the trial ends at local midnight, not at the click instant",
      localTime(live.trialEnd!) === "00:00:00.000",
      localTime(live.trialEnd!),
    );
    ok(
      "end-trial-now: on the day the trial was ended (4-Aug IST)",
      localDate(live.trialEnd!) === "04/08/2026",
      localDate(live.trialEnd!),
    );
    ok(
      "end-trial-now: the new term starts on that same boundary",
      live.currentPeriodStart!.getTime() === live.trialEnd!.getTime(),
      live.currentPeriodStart!.toISOString(),
    );
    ok(
      "end-trial-now: the instant of the click is INSIDE the term it opened",
      live.currentPeriodStart! <= endedAt && endedAt < live.currentPeriodEnd!,
    );
    ok(
      "end-trial-now: the next billing lands on a local midnight",
      localTime(live.currentPeriodEnd!) === "00:00:00.000",
      localTime(live.currentPeriodEnd!),
    );
    // The calendar anchor is the 3rd locally (the create-time term start), so the first
    // paid term runs 4-Aug → 3-Sept. What matters is that it does NOT land on the 2nd —
    // the day-early renewal an unaligned start produced via `billing_anchor_day`.
    ok(
      "end-trial-now: it renews on the anchored calendar day, not a day early",
      localDate(live.currentPeriodEnd!) === "03/09/2026",
      localDate(live.currentPeriodEnd!),
    );
    ok("end-trial-now: the sub is active and the first term is billed", live.status === "active");
  }

  // (b) natural conversion: the clock fires at the trial end (23:59:59 local).
  {
    const { biz, customer, price } = await setup("biz-trial-natural", DAY_OLD);
    const { subscription } = await createSubscription({
      organizationId: orgId,
      businessId: biz.id,
      customerId: customer.id,
      now: signupLate,
      trialDays: 7,
      items: [{ price, quantity: 1 }],
    });
    const { renewSubscription } = await import("@/modules/subscriptions/renewal");
    await renewSubscription(orgId, subscription.id, subscription.trialEnd!);
    const after = await withTenant(
      orgId,
      async (tx) =>
        (
          await tx
            .select()
            .from(subscriptions)
            .where(eq(subscriptions.id, subscription.id))
            .limit(1)
        )[0]!,
    );
    // A 7-day trial must actually last 7 days. This assertion is the one that was
    // missing: every check below is about the CONVERSION boundary, and all of them
    // passed while a `trialDays: 7` trial ran 8 days. `createSubscription` computed
    // the exclusive boundary (aligned start + 7d, already a local midnight) and then
    // sent it through `alignTrialEnd`, which advances to the NEXT local midnight
    // before backing off a second — so the trial gained a whole day. Signup is
    // 3-Aug 21:19 IST, so the term starts 3-Aug 00:00 IST and day 7 is 9-Aug.
    // A 14-day trial from 23-Aug 00:00 IST ends 05-Sep 23:59:59 IST, i.e.
    // next_billing_at is 06-Sep 00:00.
    // trial_end is stored INCLUSIVELY (…23:59:59), so the span is +1s wide.
    const trialSpanDays =
      (subscription.trialEnd!.getTime() + 1000 - subscription.trialStart!.getTime()) / 86_400_000;
    ok(
      "natural trial end: a 7-day trial lasts exactly 7 days",
      trialSpanDays === 7,
      `${trialSpanDays.toFixed(4)} days`,
    );
    ok(
      "natural trial end: it ends on the 7th day locally, not the 8th",
      localDate(subscription.trialEnd!) === "09/08/2026",
      localDate(subscription.trialEnd!),
    );
    ok(
      "natural trial end: at the last moment of that day",
      localTime(subscription.trialEnd!) === "23:59:59.000",
      localTime(subscription.trialEnd!),
    );
    ok(
      "natural trial end: the converted term starts at the next local midnight",
      localTime(after.currentPeriodStart!) === "00:00:00.000",
      localTime(after.currentPeriodStart!),
    );
    ok(
      "natural trial end: that is one second after the 23:59:59 trial end",
      after.currentPeriodStart!.getTime() === subscription.trialEnd!.getTime() + 1000,
    );
    ok(
      "natural trial end: its term end is a local midnight too",
      localTime(after.currentPeriodEnd!) === "00:00:00.000",
      localTime(after.currentPeriodEnd!),
    );
    ok("natural trial end: the sub activated", after.status === "active");
  }

  // (c) an INSTANT-anchored business must keep exact instants through both paths.
  {
    const { biz, customer, price } = await setup("biz-trial-instant", MS);
    const { subscription } = await createSubscription({
      organizationId: orgId,
      businessId: biz.id,
      customerId: customer.id,
      now: signupLate,
      trialDays: 7,
      items: [{ price, quantity: 1 }],
    });
    const endedAt = new Date("2026-08-04T16:56:52.893Z");
    const { subscription: live } = await editTrialEnd({
      organizationId: orgId,
      businessId: biz.id,
      subscriptionId: subscription.id, // the "…ByPublicId" lookup actually keys on the uuid
      now: endedAt,
      immediately: true,
    });
    ok(
      "millisecond: end-trial-now still ends the trial at the exact instant",
      live.trialEnd!.getTime() === endedAt.getTime(),
      live.trialEnd!.toISOString(),
    );
    ok(
      "millisecond: the term starts at that instant",
      live.currentPeriodStart!.getTime() === endedAt.getTime(),
    );
  }
}

// ------------------------------- Part B4: calendar billing anchors are LOCAL midnights
// "Bill me on the 15th" is a date in the BUSINESS's zone. Built as 00:00 UTC it landed at
// 05:30 IST, and because `advancePeriod` carries the time of day, every renewal after it
// did too — so a day-anchored business's terms sat off midnight for life and its
// whole-day proration credits stopped being whole days.
console.log("\nB4. calendar billing anchors sit on local midnight");
{
  const localTime = (d: Date) =>
    new Intl.DateTimeFormat("en-GB", {
      timeZone: TZ,
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      fractionalSecondDigits: 3,
    }).format(d);
  const localDate = (d: Date) =>
    new Intl.DateTimeFormat("en-GB", {
      timeZone: TZ,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(d);

  // Pure: the anchor itself, and the advance off it.
  const anchor = calendarAnchorFor(new Date("2026-08-04T12:00:00.000Z"), 15, TZ);
  ok(
    "the anchor is local midnight on the 15th (18:30Z the day before)",
    anchor.toISOString() === "2026-08-14T18:30:00.000Z",
    anchor.toISOString(),
  );
  ok(
    "advancing off it stays on local midnight, one month on",
    advancePeriod(anchor, "month", 1, 15, DAY_OLD).toISOString() === "2026-09-14T18:30:00.000Z",
    advancePeriod(anchor, "month", 1, 15, DAY_OLD).toISOString(),
  );
  // A day-31 anchor still clamps to a short month and then RE-ALIGNS (CUST-5), now on the
  // local calendar: 31-Jan → 28-Feb → 31-Mar, each at 00:00 IST.
  const jan31 = calendarAnchorFor(new Date("2026-01-05T00:00:00.000Z"), 31, TZ);
  const feb = advancePeriod(jan31, "month", 1, 31, DAY_OLD);
  const mar = advancePeriod(feb, "month", 1, 31, DAY_OLD);
  ok(
    "a day-31 anchor clamps to 28-Feb locally, then re-aligns to 31-Mar",
    localDate(feb) === "28/02/2026" && localDate(mar) === "31/03/2026",
    `${localDate(feb)} → ${localDate(mar)}`,
  );
  ok(
    "both of those are local midnights",
    localTime(feb) === "00:00:00.000" && localTime(mar) === "00:00:00.000",
  );
  // A UTC business (the default) must be untouched by all of this.
  ok(
    "on a UTC business the anchor is still 00:00Z on the day asked for",
    calendarAnchorFor(new Date("2026-08-04T12:00:00.000Z"), 15, "UTC").toISOString() ===
      "2026-08-15T00:00:00.000Z",
  );
  ok(
    "and its anchored advance is still plain UTC arithmetic",
    advancePeriod(
      new Date("2026-01-31T00:00:00.000Z"),
      "month",
      1,
      31,
      DEFAULT_BILLING_MODE,
    ).toISOString() === "2026-02-28T00:00:00.000Z",
  );

  // End-to-end: a customer with billing_date = 15 on a day-anchored IST business.
  const { biz, customer, price } = await setup("biz-anchor-day", DAY_OLD);
  await changeBillingDate(orgId, biz.id, customer.publicId, {
    billingDate: 15,
    billingDateMode: "manually_set",
  });
  const { subscription } = await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: customer.id,
    now: new Date("2026-08-04T07:00:00.000Z"),
    items: [{ price, quantity: 1 }],
  });
  ok(
    "a manually-set billing date anchors the first term end at local midnight",
    localTime(subscription.currentPeriodEnd!) === "00:00:00.000",
    localTime(subscription.currentPeriodEnd!),
  );
  ok(
    "on the 15th, in the business timezone",
    localDate(subscription.currentPeriodEnd!) === "15/08/2026",
    localDate(subscription.currentPeriodEnd!),
  );
  ok(
    "the persisted anchor day is the LOCAL day of the month",
    subscription.billingAnchorDay === 15,
    String(subscription.billingAnchorDay),
  );
  // The renewal after it must stay on the anchor, at midnight — the drift that made the
  // UTC-built anchor permanent rather than a one-off.
  const next = advancePeriod(
    subscription.currentPeriodEnd!,
    "month",
    1,
    subscription.billingAnchorDay,
    DAY_OLD,
  );
  ok(
    "and the following renewal is 15-Sept 00:00 IST, not 05:30",
    localDate(next) === "15/09/2026" && localTime(next) === "00:00:00.000",
    `${localDate(next)} ${localTime(next)}`,
  );
}

// ------------------------------------------------- Part C: the illegal 4th combination
// ---------------------------------------------------------- Part B5: change window
console.log("\nB5. a mid-term CHANGE prorates from the CURRENT billing day");
{
  // The change day counts as still-to-be-served. At day 16 of a 31-day term (08-Aug →
  // 08-Sep, a per-unit add-on 10→12): one delta line, qty 2, period 23-Aug → 07-Sep,
  // ₹776.26 = 1504 × 16/31. We used `prorationBoundary`
  // (the start of the NEXT billing day) and produced 1504 × 15/31 — one day short on
  // every immediate upgrade.
  //
  // Asserted MID-TERM on purpose: on the term's first day the answer is 31/31 either way,
  // which is precisely why the original audit could not tell the two apart.
  // Only meaningful on a whole-day business — with `exact` proration both windows are `now`.
  const { biz, customer, price } = await setup("biz-change-window", DAY_OLD);
  const seatProd = await createProduct({
    organizationId: orgId,
    businessId: biz.id,
    name: "WinSeats",
    kind: "addon",
  });
  const seatPrice = await createPrice({
    organizationId: orgId,
    businessId: biz.id,
    productId: seatProd.id,
    type: "recurring",
    model: "per_unit",
    currency: "USD",
    amountMinor: 500,
    interval: "month",
  });
  const { subscription } = await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: customer.id,
    now: new Date("2026-08-07T18:30:00.000Z"),
    trialDays: 0,
    items: [
      { price, quantity: 1 },
      { price: seatPrice, quantity: 10 },
    ],
  });
  const seatItem = (
    await withTenant(orgId, async (tx) =>
      tx
        .select()
        .from(subscriptionItems)
        .where(eq(subscriptionItems.subscriptionId, subscription.id)),
    )
  ).find((i) => i.priceId === seatPrice.id)!;
  const { changeSubscription } = await import("@/modules/subscriptions/proration");
  const r = await changeSubscription({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId: subscription.id,
    now: new Date("2026-08-23T04:30:00.000Z"), // 23-Aug 10:00 IST — day 16 of 31
    changes: [{ itemId: seatItem.publicId, newQuantity: 12 }],
    invoiceImmediately: true,
  });
  const total = r.prorationInvoice ? Number(r.prorationInvoice.totalMinor) : null;
  // 2 extra seats × $5.00 = 1000, over 16 of 31 days = 516. Excluding the change day: 484.
  ok(
    "change window: 2 extra units over 16/31 days, counting the change day",
    total === 516,
    `${total} (16/31 = 516; 15/31 would be 484)`,
  );
  const lines = r.prorationInvoice
    ? await withTenant(orgId, async (tx) =>
        tx
          .select()
          .from(invoiceLineItems)
          .where(eq(invoiceLineItems.invoiceId, r.prorationInvoice!.id)),
      )
    : [];
  // Found by PRICE, not by wording. This used to hunt for a description starting
  // "Remaining time" and reported `no line` once a quantity increase stopped emitting the
  // credit/charge pair: there is now ONE row for what you gained
  // ("WinSeats - Prorated Charges"). The money assertion above never moved — only the
  // lookup was pinned to a shape that was deliberately replaced. `price_id` is the line's
  // durable identity, so this survives the next wording change too.
  const seatLine = lines.find((l) => l.priceId === seatPrice.id);
  const dayOf = (d: Date) =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: TZ,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(d);
  ok(
    "change window: the line period STARTS on the change day, not the next one",
    seatLine?.periodStart != null && dayOf(seatLine.periodStart) === "2026-08-23",
    seatLine?.periodStart
      ? dayOf(seatLine.periodStart)
      : `no line for the seat price (got ${lines.map((l) => l.description).join(" | ") || "none"})`,
  );
}

console.log("\nC. day + exact is rejected (not a valid mode)");

const guardBiz = await createBusiness({
  organizationId: orgId,
  name: "guard",
  defaultCurrency: "USD",
  livemode: "test",
  timezone: TZ,
});
let serviceRejected = false;
try {
  await updateBusiness(orgId, guardBiz.publicId, {
    anchorGranularity: "day",
    prorationGranularity: "exact",
  });
} catch (e) {
  serviceRejected = e instanceof TenancyError;
}
ok("updateBusiness rejects day + exact", serviceRejected);

// Patching ONE axis into an illegal pair must be caught too — the service validates the
// RESULTING pair, not just the field it was handed.
await updateBusiness(orgId, guardBiz.publicId, {
  anchorGranularity: "day",
  prorationGranularity: "whole_day",
});
let halfPatchRejected = false;
try {
  await updateBusiness(orgId, guardBiz.publicId, { prorationGranularity: "exact" });
} catch (e) {
  halfPatchRejected = e instanceof TenancyError;
}
ok("patching only proration_granularity into an illegal pair is rejected", halfPatchRejected);

let dbRejected = false;
try {
  await systemDb.execute(
    sql`update businesses set anchor_granularity='day', proration_granularity='exact' where id=${guardBiz.id}`,
  );
} catch {
  dbRejected = true;
}
ok("the DB CHECK constraint rejects it too (defence in depth)", dbRejected);

console.log("");
console.log(
  failures === 0 ? "✅ BILLING MODE: PASS" : `❌ BILLING MODE: FAIL (${failures} check(s))`,
);
await closeDb();
process.exit(failures === 0 ? 0 : 1);
