/**
 * Proves mid-period proration on plan/quantity change:
 *  - upgrade (qty 1→3) at ~50% of the period → charge the prorated difference,
 *  - downgrade (qty 3→1) at ~50% → credit the customer balance.
 *  - § D: where the proration CHARGE lands when the caller does not say — i.e. that
 *    `businesses.default_invoice_immediately` actually governs the operation its own
 *    settings row advertises.
 *
 *   pnpm verify:proration
 */
import { eq } from "drizzle-orm";
import { withTenant, closeDb } from "@/platform/db";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { assignPaymentMethodRole, vaultPaymentMethod } from "@/modules/payment-methods/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import { createSubscription } from "@/modules/subscriptions/service";
import { changeSubscription, prorateTermChange } from "@/modules/subscriptions/proration";
import { isOpenInvoiceStatus } from "@/modules/invoicing/status";
import {
  subscriptionItems,
  ledgerEntries,
  businesses,
  unbilledCharges,
  invoiceLineItems,
  creditNoteItems,
  prices,
} from "@db/schema";

/** Set by the line-naming sweep below; folded into the suite's verdict. */
let namingPass = false;

const org = await createOrganization({ name: "Proration Org" });
const orgId = org.organization.id;
const biz = await createBusiness({
  organizationId: orgId,
  name: "Biz",
  defaultCurrency: "USD",
  livemode: "test",
});
const customer = await createCustomer({
  organizationId: orgId,
  businessId: biz.id,
  email: "p@a.com",
});
await vaultPaymentMethod({
  organizationId: orgId,
  businessId: biz.id,
  customer,
  token: "tok_4242",
});
const product = await createProduct({ organizationId: orgId, businessId: biz.id, name: "Seats" });
// $10/seat/month.
const price = await createPrice({
  organizationId: orgId,
  businessId: biz.id,
  productId: product.id,
  type: "recurring",
  model: "per_unit",
  currency: "USD",
  amountMinor: 1000,
  interval: "month",
});

const sub = await createSubscription({
  organizationId: orgId,
  businessId: biz.id,
  customerId: customer.id,
  now: new Date(),
  items: [{ price, quantity: 1 }],
});
const item = sub.items[0]!;
const ps = sub.subscription.currentPeriodStart!.getTime();
const pe = sub.subscription.currentPeriodEnd!.getTime();
const mid = new Date(ps + Math.floor((pe - ps) / 2)); // ~50% through the period

function qtyOf(itemId: string) {
  return withTenant(orgId, async (tx) => {
    const [r] = await tx
      .select()
      .from(subscriptionItems)
      .where(eq(subscriptionItems.id, itemId))
      .limit(1);
    return r!.quantity;
  });
}
function balance(account: string) {
  return withTenant(orgId, async (tx) => {
    const rows = await tx.select().from(ledgerEntries);
    return rows
      .filter((r) => r.account === account)
      .reduce((s, r) => s + (r.direction === "debit" ? r.amountMinor : -r.amountMinor), 0n);
  });
}

// --- Upgrade qty 1 -> 3 at ~50%: net ≈ (3000-1000)*0.5 = +1000, charged ---
const up = await changeSubscription({
  organizationId: orgId,
  businessId: biz.id,
  subscriptionId: sub.subscription.id,
  now: mid,
  changes: [{ itemId: item.publicId, newQuantity: 3 }],
  invoiceImmediately: true,
});
const qtyAfterUp = await qtyOf(item.id);
const upTotal = up.prorationInvoice ? Number(up.prorationInvoice.totalMinor) : null;
console.log(
  `Upgrade 1->3 @50%: proration total=${upTotal} status=${up.prorationInvoice?.status} qty=${qtyAfterUp} paid_via=${up.payment?.status}`,
);

// --- Downgrade qty 3 -> 1 at ~50%: net ≈ -1000 → a REFUNDABLE CREDIT NOTE
// (ADR-009: never a negative "credited" invoice). ---
const down = await changeSubscription({
  organizationId: orgId,
  businessId: biz.id,
  subscriptionId: sub.subscription.id,
  now: mid,
  changes: [{ itemId: item.publicId, newQuantity: 1 }],
  invoiceImmediately: true,
});
const qtyAfterDown = await qtyOf(item.id);
const downCredit = down.creditNote ? Number(down.creditNote.totalMinor) : null;
// Downgrade credit lands in the refundable bucket (D1 balance split). It's a
// liability (we owe the customer): a credit balance is NEGATIVE in debit-positive
// convention. ~ -1000 = we owe $10.
const custBal = await balance("refundable_credit_balance");
console.log(
  `Downgrade 3->1 @50%: credit note total=${downCredit} status=${down.creditNote?.status} prorationInvoice=${down.prorationInvoice ? "UNEXPECTED" : "none"} qty=${qtyAfterDown} customer_balance=${custBal} (credit = we owe customer)`,
);

// --- Taxed upgrade: a separate biz/customer in a 10% VAT country ---
const { createFlatTaxRate } = await import("@/modules/tax/service");
const biz2 = await createBusiness({
  organizationId: orgId,
  name: "Taxed",
  defaultCurrency: "USD",
  livemode: "test",
});
await createFlatTaxRate({
  organizationId: orgId,
  businessId: biz2.id,
  name: "VAT",
  country: "GB",
  rateBps: 1000,
});
const cust2 = await createCustomer({
  organizationId: orgId,
  businessId: biz2.id,
  email: "tx@a.com",
  address: { line1: "1 St", city: "London", postalCode: "EC1", country: "GB" },
});
await vaultPaymentMethod({
  organizationId: orgId,
  businessId: biz2.id,
  customer: cust2,
  token: "tok_4242",
});
const prod2 = await createProduct({ organizationId: orgId, businessId: biz2.id, name: "Seats" });
const price2 = await createPrice({
  organizationId: orgId,
  businessId: biz2.id,
  productId: prod2.id,
  type: "recurring",
  model: "per_unit",
  currency: "USD",
  amountMinor: 1000,
  interval: "month",
});
const sub2 = await createSubscription({
  organizationId: orgId,
  businessId: biz2.id,
  customerId: cust2.id,
  now: new Date(),
  items: [{ price: price2, quantity: 1 }],
});
const ps2 = sub2.subscription.currentPeriodStart!.getTime(),
  pe2 = sub2.subscription.currentPeriodEnd!.getTime();
const mid2 = new Date(ps2 + Math.floor((pe2 - ps2) / 2));
// Upgrade 1->3 @50% → net ≈ +1000, + 10% VAT = total ≈ 1100.
const upTax = await changeSubscription({
  organizationId: orgId,
  businessId: biz2.id,
  subscriptionId: sub2.subscription.id,
  now: mid2,
  changes: [{ itemId: sub2.items[0]!.publicId, newQuantity: 3 }],
  invoiceImmediately: true,
});
const upTaxTotal = upTax.prorationInvoice ? Number(upTax.prorationInvoice.totalMinor) : null;
const upTaxSubtotal = upTax.prorationInvoice ? Number(upTax.prorationInvoice.subtotalMinor) : null;
console.log(
  `Taxed upgrade: subtotal=${upTaxSubtotal} total=${upTaxTotal} (expect ~1000 / ~1100) status=${upTax.prorationInvoice?.status}`,
);

// ── § D · the business default decides where an OMITTED option lands ─────────────
// Settings › Billing LogIQ › Update subscription advertises
// `default_invoice_immediately` as "Invoice plan-change charges immediately", with help
// text promising that OFF means charges "accumulate as unbilled and are billed at the
// next renewal". Until 2026-08-19 `changeSubscription` never read the column: an
// omitted option ALWAYS invoiced, so the screen described the opposite of what the
// engine did — on a money-moving setting that ships OFF.
//
// Both directions are asserted with the option OMITTED, which is the only case the
// column governs; an explicit value still wins, and every assertion above passes one.
async function omittedChangeOn(defaultInvoiceImmediately: boolean) {
  const o = await createOrganization({ name: `Proration Default ${defaultInvoiceImmediately}` });
  const oid = o.organization.id;
  const b = await createBusiness({
    organizationId: oid,
    name: "Biz",
    defaultCurrency: "USD",
    livemode: "test",
  });
  await withTenant(oid, (tx) =>
    tx.update(businesses).set({ defaultInvoiceImmediately }).where(eq(businesses.id, b.id)),
  );
  const cust = await createCustomer({
    organizationId: oid,
    businessId: b.id,
    email: `d${defaultInvoiceImmediately}@a.com`,
  });
  await vaultPaymentMethod({
    organizationId: oid,
    businessId: b.id,
    customer: cust,
    token: "tok_4242",
  });
  const prod = await createProduct({ organizationId: oid, businessId: b.id, name: "Seats" });
  const pr = await createPrice({
    organizationId: oid,
    businessId: b.id,
    productId: prod.id,
    type: "recurring",
    model: "per_unit",
    currency: "USD",
    amountMinor: 1000,
    interval: "month",
  });
  const sb = await createSubscription({
    organizationId: oid,
    businessId: b.id,
    customerId: cust.id,
    now: new Date(),
    items: [{ price: pr, quantity: 1 }],
  });
  const p0 = sb.subscription.currentPeriodStart!.getTime(),
    p1 = sb.subscription.currentPeriodEnd!.getTime();
  const res = await changeSubscription({
    organizationId: oid,
    businessId: b.id,
    subscriptionId: sb.subscription.id,
    now: new Date(p0 + Math.floor((p1 - p0) / 2)),
    changes: [{ itemId: sb.items[0]!.publicId, newQuantity: 3 }],
    // invoiceImmediately deliberately OMITTED — this is the case under test.
  });
  const queued = await withTenant(oid, (tx) =>
    tx.select().from(unbilledCharges).where(eq(unbilledCharges.subscriptionId, sb.subscription.id)),
  );
  return { res, queued };
}

const onCase = await omittedChangeOn(true);
console.log(
  `default ON  → invoice=${onCase.res.prorationInvoice?.status ?? "none"} unbilled_rows=${onCase.queued.length}`,
);
const offCase = await omittedChangeOn(false);
console.log(
  `default OFF → invoice=${offCase.res.prorationInvoice?.status ?? "none"} unbilled_rows=${offCase.queued.length}`,
);

const defaultsPass =
  // ON: the historical behaviour, now because the column says so rather than by accident.
  onCase.res.prorationInvoice?.status === "paid" &&
  onCase.queued.length === 0 &&
  // OFF: what the settings help text has always promised — queued, nothing collected now.
  offCase.res.prorationInvoice === null &&
  offCase.queued.length > 0;

// ── NO PERSISTED LINE MAY PRINT A PRICE HANDLE ─────────────────────────────────
// Proration descriptions were built from `price.publicId`, so a buyer's invoice PDF read
// "Remaining time on platform-lite-v202607-INR-Monthly ×1" — an internal handle carrying a
// version stamp and a currency — where the plan's own name belongs.
//
// Two substitution layers already existed (`humanizeLineDescriptions` for the hosted
// checkout, `dashboard/lib/estimate-lines.ts` for the operator) and both cover PREVIEWS
// only. `invoice-pdf.ts` prints `line.description` straight from the row, so the one
// document the customer actually receives had no substitution at all.
//
// Fixed at the source for PERSISTED lines: they carry a `price_id` FK, so the handle was
// never needed to identify them. ESTIMATE lines still emit it deliberately — they have no
// row to point at, and both their consumers substitute (accepted-divergences.json).
//
// The WORDING stays ours ("Remaining time on X ×N" rather than "X plan - Prorated
// Charges"): it names the quantity and says which side of the proration the line is. That
// choice is deliberate; the handle never was.
{
  // Every price handle this org minted, and every description it persisted — on invoice
  // lines AND on credit note items, which carry no `price_id` to join through and so can
  // only be checked against the handle set.
  const handles = (
    await withTenant(orgId, (tx) => tx.select({ publicId: prices.publicId }).from(prices))
  ).map((p) => p.publicId);
  const invLines = await withTenant(orgId, (tx) =>
    tx.select({ description: invoiceLineItems.description }).from(invoiceLineItems),
  );
  const cnLines = await withTenant(orgId, (tx) =>
    tx.select({ description: creditNoteItems.description }).from(creditNoteItems),
  );
  const all = [...invLines, ...cnLines].map((r) => r.description);
  const leaking = all.filter((d) => handles.some((h) => d.includes(h)));

  console.log(
    `line naming: descriptions=${all.length} handles=${handles.length} leaking=${leaking.length}`,
  );
  if (leaking.length) console.log(`  first leak: "${leaking[0]}"`);
  else if (all.length) console.log(`  sample: "${all[0]}"`);
  namingPass = leaking.length === 0 && all.length > 0 && handles.length > 0;
}

// ─── MONTH-END TERM BOUNDARIES: THE ANCHOR MUST NOT ROLL ─────────────────────
// A subscription created on a day the NEXT month does not have must clamp to that
// month's last day, not roll past it. `advancePeriod` implements exactly this and says
// so — "Advance off day 1 of the LOCAL month so a 31st can't roll into the next month,
// then clamp the anchor to the target month's length" — and every renewal, resume and
// reset already uses it.
//
// `createSubscription` does NOT: it sets `billingAnchorDay` from the signup day and then
// computes its FIRST period end with `addInterval`, which is `Date.setUTCMonth(+1)` and
// rolls. So the subscription records an anchor it immediately contradicts.
//
// Measured 2026-08-31: identical term START, and a correct 2026-09-29T18:29:59Z against
// our 2026-09-30T18:29:59Z — the right answer clamps, we roll. It propagates into INVOICE
// LINE service periods, so a month-end customer's invoice states a period that was never
// billed.
//
// Seven signup days a year are affected. The worst is 31 Jan, which currently produces a
// first term ending 3 MARCH — three days of free service, and February never gets a
// renewal boundary at all.
// ⚠ ON A DAY-ANCHORED BUSINESS, which is where the defect lives. The first cut of this
// ran on the suite's default business and PASSED all five cases — proving nothing. On a
// default (instant-anchored, UTC) business `createSubscription` takes its CALENDAR-ANCHOR
// branch (`billingAnchor && billingAnchor > now`), which already clamps correctly; the
// `addInterval` branch that rolls is only reached on the other path. The business
// that exposed this is Asia/Kolkata with anchor_granularity='day', so the reproduction
// needs the same mode — a test that cannot reach the broken branch is not a test of it.
const meBiz = await createBusiness({
  organizationId: orgId,
  name: "MonthEnd Biz",
  defaultCurrency: "USD",
  livemode: "test",
  timezone: "Asia/Kolkata",
  anchorGranularity: "day",
  prorationGranularity: "whole_day",
} as never);
const mePrice = await createPrice({
  organizationId: orgId,
  businessId: meBiz.id,
  productId: (
    await createProduct({ organizationId: orgId, businessId: meBiz.id, name: "ME Seats" })
  ).id,
  type: "recurring",
  model: "per_unit",
  currency: "USD",
  amountMinor: 1000,
  interval: "month",
});
// ⚠ COMPARE THE EXCLUSIVE BOUNDARY, IN THE BUSINESS TIMEZONE — i.e. the instant the NEXT
// term begins. The stored `currentPeriodEnd` is the term's LAST instant, which for an
// IST business is 18:29:59Z on the previous UTC day; comparing its UTC date against an
// IST-intended day made the controls fail and the month-end cases look fine — the exact
// inverse of the truth. `end + 1s` rendered in Asia/Kolkata is unambiguous.
const nextTermStartsOn = (end: Date | null): string =>
  end
    ? new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Kolkata",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date(end.getTime() + 1000))
    : "null";
const monthEnd: Array<[string, Date, string]> = [
  // signup instant → the day the NEXT term must start (the anchor, clamped)
  ["31 Jan → next term 28 Feb (not 1 Mar)", new Date(Date.UTC(2026, 0, 31, 12)), "2026-02-28"],
  ["30 Jan → next term 28 Feb (not 2 Mar)", new Date(Date.UTC(2026, 0, 30, 12)), "2026-02-28"],
  ["31 Aug → next term 30 Sep (not 1 Oct)", new Date(Date.UTC(2026, 7, 31, 12)), "2026-09-30"],
  // Controls: a day every month has must be untouched by the fix.
  ["15 Jan → next term 15 Feb (control)", new Date(Date.UTC(2026, 0, 15, 12)), "2026-02-15"],
  ["28 Feb → next term 28 Mar (control)", new Date(Date.UTC(2026, 1, 28, 12)), "2026-03-28"],
];
let monthEndPass = true;
for (const [label, signup, expectedDay] of monthEnd) {
  const c = await createCustomer({
    organizationId: orgId,
    businessId: meBiz.id,
    email: `me${signup.getTime()}@a.com`,
  });
  await vaultPaymentMethod({
    organizationId: orgId,
    businessId: meBiz.id,
    customer: c,
    token: "tok_4242",
  });
  const s2 = await createSubscription({
    organizationId: orgId,
    businessId: meBiz.id,
    customerId: c.id,
    now: signup,
    items: [{ price: mePrice, quantity: 1 }],
  });
  const end = s2.subscription.currentPeriodEnd;
  // The stored end is the LAST instant of the term, so the day it names is the term's
  // final day — compare on the calendar day, not the instant.
  const got = nextTermStartsOn(end);
  const ok = got === expectedDay;
  if (!ok) monthEndPass = false;
  console.log(
    `  ${ok ? "✓" : "✗"} ${label}: anchorDay=${s2.subscription.billingAnchorDay} end=${got} (expected ${expectedDay})`,
  );
}
console.log(`month-end boundaries: ${monthEndPass ? "PASS" : "FAIL"}`);

// ─── MONTH-UNIT TRIALS CLAMP ON THE SAME CALENDAR ────────────────────────────
// A plan's `trial_period` with `trial_period_unit = 'month'` is month arithmetic and has
// to clamp exactly like a term boundary. It did not: `createSubscription` computed it with
// `addInterval`, so a 1-month trial starting 31 Jan IST ended 28 Feb 23:59:59 — an
// exclusive boundary of 1 MARCH — while the very same row recorded billingAnchorDay=31,
// which clamps to 28 Feb. `inclusiveBoundary` runs just after and does NOT rescue this; it
// backs off one second, never a day.
//
// Compare the EXCLUSIVE boundary (`nextTermStartsOn`), i.e. the day the first PAID term
// begins — same reason as the block above: the stored trial_end is 18:29:59Z on the prior
// UTC day for an IST business, so a raw UTC comparison reads the inverse of the truth.
//
// The two `trial_days` / day-unit rows are CONTROLS: day arithmetic never had this bug and
// must not move. Without them a fix that broke day trials would still pass here.
const monthTrialPrice = await createPrice({
  organizationId: orgId,
  businessId: meBiz.id,
  productId: (
    await createProduct({ organizationId: orgId, businessId: meBiz.id, name: "ME Trial Seats" })
  ).id,
  type: "recurring",
  model: "per_unit",
  currency: "USD",
  amountMinor: 1000,
  interval: "month",
  trialPeriod: 1,
  trialPeriodUnit: "month",
});
const dayTrialPrice = await createPrice({
  organizationId: orgId,
  businessId: meBiz.id,
  productId: (
    await createProduct({ organizationId: orgId, businessId: meBiz.id, name: "ME DayTrial Seats" })
  ).id,
  type: "recurring",
  model: "per_unit",
  currency: "USD",
  amountMinor: 1000,
  interval: "month",
  trialPeriod: 30,
  trialPeriodUnit: "day",
});
const trialCases: Array<[string, Date, typeof monthTrialPrice, string]> = [
  // signup instant → the day the first PAID term must start (trial_end + 1s, in IST)
  [
    "31 Jan +1mo trial → 28 Feb (not 1 Mar)",
    new Date(Date.UTC(2026, 0, 31, 12)),
    monthTrialPrice,
    "2026-02-28",
  ],
  [
    "31 Aug +1mo trial → 30 Sep (not 1 Oct)",
    new Date(Date.UTC(2026, 7, 31, 12)),
    monthTrialPrice,
    "2026-09-30",
  ],
  // Control: a day every month has.
  [
    "15 Jan +1mo trial → 15 Feb (control)",
    new Date(Date.UTC(2026, 0, 15, 12)),
    monthTrialPrice,
    "2026-02-15",
  ],
  // Control: DAY-unit trials are plain day arithmetic — 31 Jan + 30d really is 2 Mar.
  [
    "31 Jan +30d trial → 2 Mar (control)",
    new Date(Date.UTC(2026, 0, 31, 12)),
    dayTrialPrice,
    "2026-03-02",
  ],
];
let trialPass = true;
for (const [label, signup, tp, expectedDay] of trialCases) {
  const c = await createCustomer({
    organizationId: orgId,
    businessId: meBiz.id,
    email: `tr${signup.getTime()}${tp.publicId}@a.com`,
  });
  await vaultPaymentMethod({
    organizationId: orgId,
    businessId: meBiz.id,
    customer: c,
    token: "tok_4242",
  });
  const s3 = await createSubscription({
    organizationId: orgId,
    businessId: meBiz.id,
    customerId: c.id,
    now: signup,
    items: [{ price: tp, quantity: 1 }],
  });
  const got = nextTermStartsOn(s3.subscription.trialEnd);
  const ok = got === expectedDay;
  if (!ok) trialPass = false;
  console.log(
    `  ${ok ? "✓" : "✗"} ${label}: status=${s3.subscription.status} trial_end+1s=${got} (expected ${expectedDay})`,
  );
}
console.log(`month-unit trials: ${trialPass ? "PASS" : "FAIL"}`);

// ─── THE PRORATION DENOMINATOR IS A BUSINESS-CALENDAR LENGTH ─────────────────
// `prorateTermChange` prices a moved term boundary at the term's own daily rate. The
// denominator is normally the length actually BILLED for the term; when the term carries
// no invoice it falls back to the nominal interval, and that fallback used `addInterval` —
// the UTC calendar again, but here it moves MONEY, not a date.
//
// A term running 31 Oct → 30 Nov IST is 30 days. Measured from its UTC start (30 Oct
// 18:30Z) `addInterval` clamped to 30 Nov and called it 31, so a one-day extension of a
// 30000/mo plan billed 30000×1/31 = 967 instead of 30000×1/30 = 1000. The customer was
// charged a 30-day term's day at a 31-day term's rate.
//
// A FUTURE-dated start is the reachable shape: the subscription has a term but no invoice
// yet (`billedLenMs` null), so the fallback is the live path. The 31-day rows are controls —
// a term whose stored length really is 31 days must still price at 967.
const denomCases: Array<[string, Date, number]> = [
  // term start (IST) → expected charge for extending the term by exactly one day
  ["31 Oct start (30-day term) → 1000", new Date(Date.UTC(2026, 9, 31, 12)), 1000],
  ["31 Dec start (31-day term, control) → 967", new Date(Date.UTC(2026, 11, 31, 12)), 967],
  ["15 Oct start (31-day term, control) → 967", new Date(Date.UTC(2026, 9, 15, 12)), 967],
];
const denomPrice = await createPrice({
  organizationId: orgId,
  businessId: meBiz.id,
  productId: (
    await createProduct({ organizationId: orgId, businessId: meBiz.id, name: "ME Denom Seats" })
  ).id,
  type: "recurring",
  model: "per_unit",
  currency: "USD",
  amountMinor: 30000,
  interval: "month",
});
const denomNow = new Date(Date.UTC(2026, 7, 31, 12)); // before every start above
let denomPass = true;
for (const [label, start, expected] of denomCases) {
  const c = await createCustomer({
    organizationId: orgId,
    businessId: meBiz.id,
    email: `dn${start.getTime()}@a.com`,
  });
  await vaultPaymentMethod({
    organizationId: orgId,
    businessId: meBiz.id,
    customer: c,
    token: "tok_4242",
  });
  const s4 = await createSubscription({
    organizationId: orgId,
    businessId: meBiz.id,
    customerId: c.id,
    now: denomNow,
    startDate: start,
    items: [{ price: denomPrice, quantity: 1 }],
  });
  const sub4 = s4.subscription;
  const termEnd = sub4.currentPeriodEnd!;
  const storedDays = (termEnd.getTime() - sub4.currentPeriodStart!.getTime()) / 86_400_000;
  const inv = await prorateTermChange({
    organizationId: orgId,
    businessId: meBiz.id,
    subscription: sub4,
    oldPeriodEnd: termEnd,
    newPeriodEnd: new Date(termEnd.getTime() + 86_400_000),
    invoiceImmediately: false,
    now: denomNow,
    originToken: `denom-${start.getTime()}`,
  });
  const got = inv ? Number(inv.subtotalMinor) : null;
  const ok = got === expected;
  if (!ok) denomPass = false;
  console.log(
    `  ${ok ? "✓" : "✗"} ${label}: storedDays=${storedDays} 1-day extension=${got} (expected ${expected})`,
  );
}
console.log(`proration denominator: ${denomPass ? "PASS" : "FAIL"}`);

// ── § E — a change whose CURRENT TERM is an OPEN invoice settled from the customer's
// own credit (2026-08-31) ─────────────────────────────────────────────────────────────
//
// `creditOneInvoice`'s open branch splits the prorated credit into an ADJUSTMENT for what
// is still owed plus an OVERFLOW past it, and it used to assume the only non-cash funding
// an open invoice can carry is PROMOTIONAL credit. `refundable_credits_applied_minor` and
// `excess_payments_applied_minor` settle an open invoice too, so the whole overflow went to
// `issueRefundableCreditNote`, whose `paidMinor <= 0` guard fires BEFORE its cap: on the
// dashboard 2026-08-31 that refused a real subscription change with a 500.
//
// Three cases, hand-computed against a 31-day term (1 Aug → 1 Sep). Each downgrades on
// 16 Aug, so 16/31 of the term is unused and the amounts are chosen to divide exactly:
// PRO 3100 → 1600 credited, LITE 620 → 320 charged.
//
// E3 is the one this suite exists for. The FIRST version of the fix divided the overflow
// by `excessApplied + refundableApplied + cashAvailable` and clamped only the cashable leg,
// so the excess leg could exceed what the invoice ever drew — money POSTED to the excess
// bucket that nobody paid in. It is not hypothetical: with a prior note on the invoice
// (which subtracts from capacity AND from what is owed) the same shape restored 2400265
// against an `excessApplied` of 2000000. The overflow is now clamped before it is split,
// so neither leg can exceed its own source.
let openCreditPass = true;
const eCheck = (ok: boolean, label: string, got: unknown, want: unknown) => {
  if (!ok) openCreditPass = false;
  console.log(
    `  ${ok ? "✓" : "✗"} ${label}: ${String(got)}${ok ? "" : ` (expected ${String(want)})`}`,
  );
};
{
  const { recordExcessPayment } = await import("@/modules/customers/balances");
  const { bucketBalancesForCurrency } = await import("@/modules/customers/balances-read");
  const { issueRefundableCreditNote, issueAdjustmentCreditNote } =
    await import("@/modules/credit-notes/service");
  const { billSubscriptionPeriod } = await import("@/modules/invoicing/service");
  const { setDefaultPaymentMethod } = await import("@/modules/payment-methods/service");
  const { creditNotes, invoices } = await import("@db/schema");
  const { and } = await import("drizzle-orm");
  // Vaults fine, DECLINES on charge — the failed cash leg every case here needs.
  const DECLINE = "tok_4000000000000341";
  const openProduct = await createProduct({
    organizationId: orgId,
    businessId: biz.id,
    name: "Open-term plans",
  });
  const mkPrice = (amountMinor: number) =>
    createPrice({
      organizationId: orgId,
      businessId: biz.id,
      productId: openProduct.id,
      type: "recurring" as const,
      model: "flat" as const,
      currency: "USD",
      amountMinor,
      interval: "month" as const,
    });
  const PRO = await mkPrice(3100);
  const LITE = await mkPrice(620);
  const AUG1 = new Date("2026-08-01T00:00:00.000Z");
  const AUG16 = new Date("2026-08-16T00:00:00.000Z");

  /** Bill a fresh term for `customerId` on `plan`, WITHOUT paying it in cash. */
  async function openTerm(customerId: string, plan: typeof PRO, now: Date) {
    const s = await createSubscription({
      organizationId: orgId,
      businessId: biz.id,
      customerId,
      now,
      items: [{ price: plan, quantity: 1 }],
    });
    const b = await billSubscriptionPeriod({
      organizationId: orgId,
      businessId: biz.id,
      subscription: s.subscription,
      periodStart: s.subscription.currentPeriodStart!,
      periodEnd: s.subscription.currentPeriodEnd!,
    });
    return { sub: s, invoice: b.invoice };
  }

  /** The notes this customer's term produced, and where the buckets ended up. */
  async function notesFor(customerId: string) {
    const rows = await withTenant(orgId, (tx) =>
      tx.select().from(creditNotes).where(eq(creditNotes.customerId, customerId)),
    );
    return {
      adjustment: rows
        .filter((r) => r.kind === "adjustment")
        .reduce((s, r) => s + r.totalMinor, 0n),
      refundable: rows
        .filter((r) => r.kind === "refundable")
        .reduce((s, r) => s + r.totalMinor, 0n),
    };
  }

  /** What THIS invoice put back into the excess bucket — the leg E3 is about. */
  async function excessRestoredFor(invoicePublicId: string) {
    const rows = await withTenant(orgId, (tx) =>
      tx
        .select()
        .from(ledgerEntries)
        .where(
          and(
            eq(ledgerEntries.sourceId, invoicePublicId),
            eq(ledgerEntries.sourceType, "change_credit_restore"),
          ),
        ),
    );
    return rows
      .filter((e) => e.direction === "credit" && e.account.includes("excess"))
      .reduce((s, e) => s + e.amountMinor, 0n);
  }

  // ── E1: the term is part-funded from the customer's REFUNDABLE balance ─────────────
  // Seeding that balance needs a note on a CASH-paid invoice, so the good card goes first
  // and the declining one becomes primary only afterwards.
  const c1 = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: "open-refundable@a.com",
  });
  const good1 = await vaultPaymentMethod({
    organizationId: orgId,
    businessId: biz.id,
    customer: c1,
    token: "tok_4242",
  });
  const seed = await openTerm(c1.id, PRO, AUG1);
  await issueRefundableCreditNote({
    organizationId: orgId,
    businessId: biz.id,
    invoicePublicId: seed.invoice.publicId,
    items: [{ description: "seed refundable credit", amountMinor: 2000 }],
    reasonCode: "other",
  });
  const bad1 = await vaultPaymentMethod({
    organizationId: orgId,
    businessId: biz.id,
    customer: c1,
    token: DECLINE,
  });
  await setDefaultPaymentMethod(orgId, c1.id, bad1.publicId);
  // A non-primary card is a backup and would pay the declined leg; E1 needs it to stay open.
  await assignPaymentMethodRole(orgId, c1.id, good1.publicId, "none");
  const t1 = await openTerm(c1.id, PRO, AUG1);
  // 3100 billed, 2000 drawn from the refundable balance, the 1100 cash leg DECLINED.
  eCheck(t1.invoice.status === "payment_due", "E1 term is open", t1.invoice.status, "payment_due");
  eCheck(
    (t1.invoice.refundableCreditsAppliedMinor ?? 0n) === 2000n,
    "E1 funded from the refundable balance",
    t1.invoice.refundableCreditsAppliedMinor,
    2000n,
  );
  let e1Applied = true;
  try {
    await changeSubscription({
      organizationId: orgId,
      businessId: biz.id,
      subscriptionId: t1.sub.subscription.id,
      changes: [{ itemId: t1.sub.items[0]!.publicId, newPriceId: LITE.publicId }],
      prorate: true,
      invoiceImmediately: true,
      now: AUG16,
    });
  } catch (e) {
    e1Applied = false;
    console.log(`    ${e instanceof Error ? e.message : String(e)}`);
  }
  // THE REGRESSION: this threw "Refundable credit notes require a paid invoice".
  eCheck(e1Applied, "E1 the change applies at all", e1Applied, true);
  const n1 = await notesFor(c1.id);
  // 1600 credited − 1100 still owed = 500 overflowing past the debt, all of it sourced
  // from the 2000 of recycled refundable credit. The 2000 seed note is in the sum too.
  eCheck(
    n1.adjustment === 1100n,
    "E1 adjustment relieves exactly what was owed",
    n1.adjustment,
    1100n,
  );
  eCheck(
    n1.refundable === 2000n + 500n,
    "E1 the overflow is one cashable note (2000 seed + 500)",
    n1.refundable,
    2500n,
  );

  // ── E2: the same shape, funded from an EXCESS payment (offline money received) ──────
  const c2 = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: "open-excess@a.com",
  });
  const bad2 = await vaultPaymentMethod({
    organizationId: orgId,
    businessId: biz.id,
    customer: c2,
    token: DECLINE,
  });
  await setDefaultPaymentMethod(orgId, c2.id, bad2.publicId);
  await recordExcessPayment({
    organizationId: orgId,
    businessId: biz.id,
    customer: c2,
    amountMinor: 2000,
    currency: "USD",
  });
  const t2 = await openTerm(c2.id, PRO, AUG1);
  await changeSubscription({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId: t2.sub.subscription.id,
    changes: [{ itemId: t2.sub.items[0]!.publicId, newPriceId: LITE.publicId }],
    prorate: true,
    invoiceImmediately: true,
    now: AUG16,
  });
  const n2 = await notesFor(c2.id);
  eCheck(
    n2.adjustment === 1100n,
    "E2 adjustment relieves exactly what was owed",
    n2.adjustment,
    1100n,
  );
  // Excess-funded money must NOT become cashable — it goes back to its own bucket.
  eCheck(
    n2.refundable === 0n,
    "E2 nothing excess-funded turns into a cashable note",
    n2.refundable,
    0n,
  );
  eCheck(
    (await excessRestoredFor(t2.invoice.publicId)) === 500n,
    "E2 the overflow returns to the excess bucket",
    await excessRestoredFor(t2.invoice.publicId),
    500n,
  );
  // 500 back, then the new LITE term's 320 charge draws on it again.
  const b2 = await bucketBalancesForCurrency(orgId, c2.id, "USD");
  eCheck(b2.excess === 180n, "E2 excess balance = 500 restored − 320 re-charged", b2.excess, 180n);

  // ── E3: the overflow can EXCEED what the invoice's own funding can give back ────────
  // A prior note on the still-open invoice subtracts from `refundableCapacityForInvoice`
  // AND from what is outstanding, so it widens the overflow and narrows the funding at the
  // same time; downgrading to a near-zero plan keeps the credit near the full term. Before
  // the clamp this restored 2400265 against 2000000 ever drawn — 400265 of invented money.
  const c3 = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: "open-excess-overshoot@a.com",
  });
  const bad3 = await vaultPaymentMethod({
    organizationId: orgId,
    businessId: biz.id,
    customer: c3,
    token: DECLINE,
  });
  await setDefaultPaymentMethod(orgId, c3.id, bad3.publicId);
  await recordExcessPayment({
    organizationId: orgId,
    businessId: biz.id,
    customer: c3,
    amountMinor: 2000000,
    currency: "USD",
  });
  const BIG = await mkPrice(2791800);
  const TINY = await mkPrice(10000);
  const t3 = await openTerm(c3.id, BIG, AUG1);
  await issueAdjustmentCreditNote({
    organizationId: orgId,
    businessId: biz.id,
    invoicePublicId: t3.invoice.publicId,
    items: [{ description: "goodwill", amountMinor: 500000 }],
    reasonCode: "other",
  });
  await changeSubscription({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId: t3.sub.subscription.id,
    changes: [{ itemId: t3.sub.items[0]!.publicId, newPriceId: TINY.publicId }],
    prorate: true,
    invoiceImmediately: true,
    now: new Date("2026-08-02T00:00:00.000Z"),
  });
  const restored3 = await excessRestoredFor(t3.invoice.publicId);
  const applied3 = t3.invoice.excessPaymentsAppliedMinor ?? 0n;
  eCheck(
    restored3 <= applied3,
    "E3 the excess bucket never gets back more than it put in",
    `restored=${restored3} applied=${applied3}`,
    "restored <= applied",
  );
  eCheck(restored3 === 2000000n, "E3 restored is exactly the excess drawn", restored3, 2000000n);
  // And the invoice's own books stay sane: an open invoice cannot end up owing negative.
  const [inv3] = await withTenant(orgId, (tx) =>
    tx.select().from(invoices).where(eq(invoices.id, t3.invoice.id)),
  );
  eCheck(
    (inv3?.amountDueMinor ?? 0n) >= 0n,
    "E3 the credited invoice owes nothing negative",
    inv3?.amountDueMinor,
    ">= 0",
  );

  // ── E4: THE WORKED EXAMPLE for this shape ──────────────────────────────────────────
  // Plan quantity downgrade on a partially paid invoice:
  //
  //   monthly plan $30/unit, 1 Sep, qty 3 → invoice $90, payment received $80, due $10.
  //   Quantity reduced to 2 on 15 Sep:
  //     "Since $80 has already been paid, a refundable credit note for $80 − $75 = $5"
  //     "An adjustment credit note for the original unpaid amount of $10 is also generated"
  //
  // That is precisely the split this branch computes, from the other direction: the
  // OUTSTANDING amount goes on an adjustment note and everything past it on a refundable
  // one, against a PARTIALLY PAID invoice — the behaviour the `paidMinor <= 0` guard was
  // refusing outright. The adjustment leg reproduces the $10.00 exactly.
  //
  // The refundable leg is 3800 here, not 500, for two reasons that are NOT this split:
  //  1. DAY COUNT. The example uses the pre-May-2026 day-based convention (term floored to
  //     1 Sep 00:00 → 30 Sep 23:59:59.999, change day billed ⇒ 15 remaining days, fraction 0.5).
  //     This business is `proration_granularity = 'exact'` (millisecond-based), where a
  //     change at exactly 15 Sep 00:00 leaves 16 of 30 days.
  //  2. DOCUMENT SHAPE. With `invoiceImmediately` we credit the old line GROSS (all 3 units,
  //     4800) and re-charge the new quantity (3200) on a proration invoice, where the example
  //     issues one DELTA credit for the removed unit and no invoice. Net money agrees
  //     (4800 − 3200 = 1600 = one unit for 16/30); the number of documents does not. Filed in
  //     docs/PROGRESS.md — do NOT "fix" it by widening the price-swap shape, which the
  //     2026-08-25 entry in this module's README pins to PRICE SWAPS ONLY.
  //
  // So this case asserts the SPLIT RULE and deliberately does not freeze the shape decision
  // that sits upstream of it.
  const { recordOfflinePayment } = await import("@/modules/invoicing/ops");
  const c4 = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: "partial-paid@a.com",
  });
  const unitPrice = await createPrice({
    organizationId: orgId,
    businessId: biz.id,
    productId: openProduct.id,
    type: "recurring",
    model: "per_unit",
    currency: "USD",
    amountMinor: 3000,
    interval: "month",
  });
  const s4 = await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: c4.id,
    now: new Date("2025-09-01T00:00:00.000Z"),
    items: [{ price: unitPrice, quantity: 3 }],
  });
  const i4 = await billSubscriptionPeriod({
    organizationId: orgId,
    businessId: biz.id,
    subscription: s4.subscription,
    periodStart: s4.subscription.currentPeriodStart!,
    periodEnd: s4.subscription.currentPeriodEnd!,
  });
  eCheck(i4.invoice.totalMinor === 9000n, "E4 the $90 term invoice", i4.invoice.totalMinor, 9000n);
  // $80 of the $90 received — a PARTIALLY paid invoice, still open, $10 outstanding.
  await recordOfflinePayment({
    organizationId: orgId,
    businessId: biz.id,
    invoicePublicId: i4.invoice.publicId,
    amountMinor: 8000,
    method: "wire",
  });
  await changeSubscription({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId: s4.subscription.id,
    changes: [{ itemId: s4.items[0]!.publicId, newQuantity: 2 }],
    prorate: true,
    invoiceImmediately: true,
    now: new Date("2025-09-15T00:00:00.000Z"),
  });
  const n4 = await notesFor(c4.id);
  // The worked number, reproduced exactly: the outstanding $10 goes on the adjustment note.
  eCheck(
    n4.adjustment === 1000n,
    "E4 adjustment = the $10.00 outstanding, on a PARTIALLY paid invoice",
    n4.adjustment,
    1000n,
  );
  // ── DELTA, NOT GROSS, SINCE 2026-09-01 ────────────────────────────────────────
  // The credit is now 1600 (the removed unit) rather than 4800 (the whole term), because a
  // same-price quantity decrease emits ONE negative line for the removed units and raises
  // no invoice.
  //
  // The SPLIT this case exists for is untouched and still reproduces the worked
  // example exactly: the outstanding $10.00 goes on the adjustment note (asserted above),
  // and only what is left goes to the refundable one. This block's own comment already said
  // it "deliberately does not freeze the shape decision" — the hard-coded 4800 did exactly
  // that, which is why it had to move. The split AND the document count now both come out
  // right.
  eCheck(
    n4.refundable === 1600n - 1000n,
    "E4 refundable = the credit past the outstanding (delta credit 1600 − 1000)",
    n4.refundable,
    600n,
  );
}
console.log(`open credit-funded term: ${openCreditPass ? "PASS" : "FAIL"}`);

// ── § F — a TERM RESET bills a differential add-on at the plan it is MOVING TO ────────
// A differential price is scoped to (add-on, plan, currency, interval), so the contracted
// rate moves with the plan (F-17). The reset's charge loop read the snapshot hundreds of
// lines before the re-rate was computed, so it billed the OUTGOING plan's rate — off by one
// change, every time, whenever `resetTerm` was set. A bare plan swap was always correct,
// which is why this hid. `scripts/probe-reset-differential-lag.ts` is the narrative version.
let diffPass = true;
const dCheck = (ok: boolean, label: string, got: unknown, want: unknown) => {
  if (!ok) diffPass = false;
  console.log(
    `  ${ok ? "✓" : "✗"} ${label}: ${String(got)}${ok ? "" : ` (expected ${String(want)})`}`,
  );
};
{
  const { setDifferentialPrice } = await import("@/modules/catalog/service");
  const { invoiceLineItems: ili, invoices: invT } = await import("@db/schema");
  const dOrg = await createOrganization({ name: "Reset differential" });
  const dOrgId = dOrg.organization.id;
  const dBiz = await createBusiness({
    organizationId: dOrgId,
    name: "Biz",
    defaultCurrency: "USD",
    livemode: "test",
  });
  const dCus = await createCustomer({
    organizationId: dOrgId,
    businessId: dBiz.id,
    email: "resetdiff@a.com",
  });
  await vaultPaymentMethod({
    organizationId: dOrgId,
    businessId: dBiz.id,
    customer: dCus,
    token: "tok_4242",
  });
  const pPro = await createProduct({
    organizationId: dOrgId,
    businessId: dBiz.id,
    name: "PRO",
    kind: "plan",
  });
  const pBus = await createProduct({
    organizationId: dOrgId,
    businessId: dBiz.id,
    name: "BUS",
    kind: "plan",
  });
  const pAdd = await createProduct({
    organizationId: dOrgId,
    businessId: dBiz.id,
    name: "Seats",
    kind: "addon",
  });
  const flat = (productId: string, amountMinor: number) =>
    createPrice({
      organizationId: dOrgId,
      businessId: dBiz.id,
      productId,
      type: "recurring" as const,
      model: "flat" as const,
      currency: "USD",
      amountMinor,
      interval: "month" as const,
    });
  const PRO_P = await flat(pPro.id, 100000);
  const BUS_P = await flat(pBus.id, 300000);
  // CAT-7 differential add-on: catalog 0, real rate per plan. PRO ⇒ 900, BUSINESS ⇒ 600.
  const ADD_P = await createPrice({
    organizationId: dOrgId,
    businessId: dBiz.id,
    productId: pAdd.id,
    type: "recurring",
    model: "per_unit",
    currency: "USD",
    amountMinor: 0,
    interval: "month",
  });
  await setDifferentialPrice({
    organizationId: dOrgId,
    businessId: dBiz.id,
    addonPublicId: pAdd.publicId,
    planPublicId: pPro.publicId,
    currency: "USD",
    interval: "month",
    amountMinor: 900,
  });
  await setDifferentialPrice({
    organizationId: dOrgId,
    businessId: dBiz.id,
    addonPublicId: pAdd.publicId,
    planPublicId: pBus.publicId,
    currency: "USD",
    interval: "month",
    amountMinor: 600,
  });
  const { billSubscriptionPeriod: bill } = await import("@/modules/invoicing/service");
  const dSub = await createSubscription({
    organizationId: dOrgId,
    businessId: dBiz.id,
    customerId: dCus.id,
    now: new Date("2026-09-01T00:00:00.000Z"),
    items: [
      { price: PRO_P, quantity: 1 },
      { price: ADD_P, quantity: 10 },
    ],
  });
  await bill({
    organizationId: dOrgId,
    businessId: dBiz.id,
    subscription: dSub.subscription,
    periodStart: dSub.subscription.currentPeriodStart!,
    periodEnd: dSub.subscription.currentPeriodEnd!,
  });
  /** The plan item's public id, whichever price it currently holds. */
  const planItemPub = async (want: string) => {
    const rows = await withTenant(dOrgId, (tx) =>
      tx
        .select()
        .from(subscriptionItems)
        .where(eq(subscriptionItems.subscriptionId, dSub.subscription.id)),
    );
    for (const r of rows) {
      const [pr] = await withTenant(dOrgId, (tx) =>
        tx.select().from(prices).where(eq(prices.id, r.priceId)),
      );
      if (pr!.publicId === want) return r.publicId;
    }
    throw new Error(`no item on ${want}`);
  };
  // resetTerm is what exposes it — a bare swap is correct either way.
  await changeSubscription({
    organizationId: dOrgId,
    businessId: dBiz.id,
    subscriptionId: dSub.subscription.id,
    changes: [{ itemId: await planItemPub(PRO_P.publicId), newPriceId: BUS_P.publicId }],
    prorate: true,
    invoiceImmediately: true,
    resetTerm: true,
    now: new Date("2026-09-02T00:00:00.000Z"),
  });
  await changeSubscription({
    organizationId: dOrgId,
    businessId: dBiz.id,
    subscriptionId: dSub.subscription.id,
    changes: [{ itemId: await planItemPub(BUS_P.publicId), newPriceId: PRO_P.publicId }],
    prorate: true,
    invoiceImmediately: true,
    resetTerm: true,
    now: new Date("2026-09-03T00:00:00.000Z"),
  });
  // Every invoice must rate the add-on at the plan named on that same invoice.
  const dInvs = await withTenant(dOrgId, (tx) =>
    tx.select().from(invT).where(eq(invT.subscriptionId, dSub.subscription.id)),
  );
  let checked = 0;
  for (const inv of dInvs) {
    const lines = await withTenant(dOrgId, (tx) =>
      tx.select().from(ili).where(eq(ili.invoiceId, inv.id)),
    );
    const seat = lines.find((l) => /seats/i.test(l.description ?? "") && l.amountMinor > 0n);
    if (!seat || !seat.quantity) continue;
    const onBusiness = lines.some((l) => /BUS/i.test(l.description ?? "") && l.amountMinor > 0n);
    const unit = seat.amountMinor / BigInt(seat.quantity);
    const want = onBusiness ? 600n : 900n;
    dCheck(
      unit === want,
      `§F ${inv.publicId.slice(0, 14)} rates the add-on at the ${onBusiness ? "BUSINESS" : "PRO"} plan on its own invoice`,
      unit,
      want,
    );
    checked++;
  }
  dCheck(
    checked >= 3,
    "§F CONTROL — all three invoices carried an add-on line to check",
    checked,
    ">= 3",
  );
}
console.log(`reset differential: ${diffPass ? "PASS" : "FAIL"}`);

// ── § G — an add-on ADDED in the SAME edit as a plan change rates at the plan it MOVES TO ──
// § F above proves a term reset RE-RATES an add-on the subscription already holds. This is the
// other half, and it was open while § F was green: an add-on ATTACHED BY THE SAME CALL that
// swaps the plan was rated against the plan being replaced.
//
// FOUND IN THE FIELD, not by reading. Three screenshots of the change screen for
// `sub_XXXXXXXXXXXXXXXXXXXXXX01` (LITE → PRO, 10 additional-connections added in one edit) show
// the screen contradicting itself: the Line Items table quotes ₹752.00 × 10 = ₹7,520.00 and the
// proration panel beside it charges ₹940.00 × 10 = ₹9,400.00. `differential_prices` for that
// add-on holds 752 under PRO — the plan the edit moves TO — and 940 under LITE, the plan it moves
// FROM, with a catalog list price of 0. The dashboard resolved against the edited plan line and
// was right; the engine resolved against the stored one. ₹1,880 + 18% GST = ₹2,218.40, and it
// RECURS, because the same resolver freezes the item's contracted rate.
//
// THE MECHANISM is a one-line asymmetry inside a single branch:
//   changed lines → `resolveDifferentialAgainstPlanTx(tx, postPlanProductId, …)`
//                   (proration.ts :2799 :2931 · estimate.ts :1191 :1279)
//   ADDED lines   → `effectiveAddSnapshotTx(tx, sub.id, …)` → `resolveDifferentialForAddTx`,
//                   which SELECTs the plan product from `subscription_items` — still the old
//                   plan at that point in the transaction (proration.ts :3010 · estimate.ts :1357)
// `items.ts:110-114` states the rule the adds branch breaks, in its own docblock. The same branch
// is already post-change-aware for CADENCE (it validates against `postCycle` a few lines up), so
// the edit was post-change for the cycle and pre-change for the plan.
//
// WHY THE ASSERTIONS ARE SHAPED THIS WAY. Both figures checked here are CONTRACTED rates, not
// prorated amounts: the item's frozen `price_snapshot.amountMinor`, and the renewal preview's
// full-term line. Proration would make the expectation a fraction that has to be re-derived
// whenever the fixture's dates move, and a test that computes its own expected value from the
// code under test cannot fail. The two directions (to the CHEAPER differential and to the
// DEARER one) are both asserted, so a fix that always picks the lower rate does not pass, and
// the no-plan-change CONTROL keeps the whole section from going green on a fixture where the
// differentials were never wired at all.
let addDiffPass = true;
const gCheck = (ok: boolean, label: string, got: unknown, want: unknown) => {
  if (!ok) addDiffPass = false;
  console.log(
    `  ${ok ? "✓" : "✗"} ${label}: ${String(got)}${ok ? "" : ` (expected ${String(want)})`}`,
  );
};
{
  const { setDifferentialPrice } = await import("@/modules/catalog/service");
  const { estimateChange } = await import("@/modules/subscriptions/estimate");
  const { invoiceLineItems: gIli, subscriptions: gSubs } = await import("@db/schema");
  const { billSubscriptionPeriod: gBill } = await import("@/modules/invoicing/service");
  const gOrg = await createOrganization({ name: "Add differential" });
  const gOrgId = gOrg.organization.id;
  const gBiz = await createBusiness({
    organizationId: gOrgId,
    name: "Biz",
    defaultCurrency: "USD",
    livemode: "test",
  });
  const gPro = await createProduct({
    organizationId: gOrgId,
    businessId: gBiz.id,
    name: "PRO",
    kind: "plan",
  });
  const gBus = await createProduct({
    organizationId: gOrgId,
    businessId: gBiz.id,
    name: "BUS",
    kind: "plan",
  });
  const gAdd = await createProduct({
    organizationId: gOrgId,
    businessId: gBiz.id,
    name: "Seats",
    kind: "addon",
  });
  const gFlat = (productId: string, amountMinor: number) =>
    createPrice({
      organizationId: gOrgId,
      businessId: gBiz.id,
      productId,
      type: "recurring" as const,
      model: "flat" as const,
      currency: "USD",
      amountMinor,
      interval: "month" as const,
    });
  const G_PRO = await gFlat(gPro.id, 100000);
  const G_BUS = await gFlat(gBus.id, 300000);
  // CAT-7 differential add-on, same shape as § F: catalog 0, the real rate held per plan.
  // PRO ⇒ 900, BUSINESS ⇒ 600 — deliberately NOT in plan-price order, so "rated at the dearer
  // plan" and "rated at the dearer add-on" are different answers and the test can tell them apart.
  const G_ADD = await createPrice({
    organizationId: gOrgId,
    businessId: gBiz.id,
    productId: gAdd.id,
    type: "recurring",
    model: "per_unit",
    currency: "USD",
    amountMinor: 0,
    interval: "month",
  });
  for (const [plan, amountMinor] of [
    [gPro, 900],
    [gBus, 600],
  ] as const) {
    await setDifferentialPrice({
      organizationId: gOrgId,
      businessId: gBiz.id,
      addonPublicId: gAdd.publicId,
      planPublicId: plan.publicId,
      currency: "USD",
      interval: "month",
      amountMinor,
    });
  }

  const G_START = new Date("2026-09-01T00:00:00.000Z");
  const G_NOW = new Date("2026-09-15T00:00:00.000Z");

  /**
   * Subscribe to `from`, then run ONE edit that adds 10 Seats and — when `to` is given —
   * swaps the plan in the same call. Returns the three places the rate lands: the preview's
   * full-term renewal line, the item's frozen contract, and the invoice line's contracted rate.
   */
  const addInOneEdit = async (email: string, from: typeof G_PRO, to?: typeof G_PRO) => {
    const cus = await createCustomer({
      organizationId: gOrgId,
      businessId: gBiz.id,
      email,
    });
    await vaultPaymentMethod({
      organizationId: gOrgId,
      businessId: gBiz.id,
      customer: cus,
      token: "tok_4242",
    });
    const s = await createSubscription({
      organizationId: gOrgId,
      businessId: gBiz.id,
      customerId: cus.id,
      now: G_START,
      items: [{ price: from, quantity: 1 }],
    });
    const subId = s.subscription.id;
    const itemsOf = () =>
      withTenant(gOrgId, (tx) =>
        tx.select().from(subscriptionItems).where(eq(subscriptionItems.subscriptionId, subId)),
      );
    const planItem = (await itemsOf()).find((r) => r.priceId === from.id)!;
    const edit = {
      changes: to ? [{ itemId: planItem.publicId, newPriceId: to.publicId }] : [],
      adds: [{ priceId: G_ADD.publicId, quantity: 10 }],
    };
    // Previewed BEFORE booking, from the same inputs — the operator's screen and the invoice
    // have to name the same rate, and estimate.ts carries its own copy of the resolution.
    const est = await estimateChange({
      organizationId: gOrgId,
      businessId: gBiz.id,
      subscriptionId: subId,
      now: G_NOW,
      ...edit,
    });
    await changeSubscription({
      organizationId: gOrgId,
      businessId: gBiz.id,
      subscriptionId: subId,
      now: G_NOW,
      ...edit,
      prorate: true,
      invoiceImmediately: true,
    });
    const addItem = (await itemsOf()).find((r) => r.priceId === G_ADD.id);
    const snapshot = (addItem?.priceSnapshot ?? null) as { amountMinor?: number | null } | null;
    // The renewal preview rates the POST-change composition over a FULL term, so the add-on's
    // line is quantity × the contracted rate with no proration fraction in it. Matched on the
    // price's public id, which is what the composition names the line: these fixture prices are
    // auto-slugged (`usd-month-per_unit ×10`), so matching the PRODUCT name finds nothing and
    // the assertion would read `null` for every case — including a case the fix has repaired.
    const previewLine = (est.next_renewal?.lines ?? []).find((l) =>
      l.description.startsWith(G_ADD.publicId),
    );
    // The money that RECURS. Deliberately not the change invoice's prorated line: that line's
    // `unit_amount_minor` falls back to amount ÷ quantity (the proration path passes no rate —
    // see `InvoiceLineInput.unitAmountMinor`), so it reads 480 for a 900 contract at 16/30 of a
    // term and cannot be compared to a differential. The NEXT term's invoice charges the
    // contracted rate flat, which is the figure the customer keeps paying.
    const [fresh] = await withTenant(gOrgId, (tx) =>
      tx.select().from(gSubs).where(eq(gSubs.id, subId)),
    );
    const renewal = await gBill({
      organizationId: gOrgId,
      businessId: gBiz.id,
      subscription: fresh!,
      periodStart: fresh!.currentPeriodEnd!,
      periodEnd: new Date("2026-11-01T00:00:00.000Z"),
    });
    const renewalLines = await withTenant(gOrgId, (tx) =>
      tx.select().from(gIli).where(eq(gIli.invoiceId, renewal.invoice.id)),
    );
    const renewalAddon = renewalLines.find((l) => l.priceId === G_ADD.id);
    return {
      snapRate: snapshot?.amountMinor ?? null,
      previewFullTerm: previewLine?.amount_minor ?? null,
      renewalCharge: renewalAddon?.amountMinor ?? null,
    };
  };

  // CONTROL — no plan change in the edit. The stored plan IS the post-change plan, so both
  // resolvers agree and this must be 900 whatever the fix does. If it ever reads 600, the
  // fixture's differentials are crossed and every other check below is meaningless.
  const ctl = await addInOneEdit("adddiff-control@a.com", G_PRO);
  gCheck(
    ctl.snapRate === 900,
    "§G CONTROL add with NO plan change contracts at PRO",
    ctl.snapRate,
    900,
  );
  gCheck(
    ctl.previewFullTerm === 9000,
    "§G CONTROL the preview's full term quotes 10 × 900",
    ctl.previewFullTerm,
    9000,
  );

  // THE DEFECT — one edit, plan PRO → BUS and the add-on attached together.
  const down = await addInOneEdit("adddiff-down@a.com", G_PRO, G_BUS);
  gCheck(
    down.snapRate === 600,
    "§G PRO → BUS in one edit contracts the added add-on at BUS",
    down.snapRate,
    600,
  );
  gCheck(
    down.previewFullTerm === 6000,
    "§G the PREVIEW of that edit quotes BUS's rate too (estimate.ts carries its own copy)",
    down.previewFullTerm,
    6000,
  );
  gCheck(
    down.renewalCharge === 6000n,
    "§G and the NEXT term bills 10 × 600 — the over-charge recurs, so this is the money",
    down.renewalCharge,
    6000n,
  );

  // THE OTHER DIRECTION, so a fix that simply prefers the cheaper differential fails here.
  const up = await addInOneEdit("adddiff-up@a.com", G_BUS, G_PRO);
  gCheck(
    up.snapRate === 900,
    "§G BUS → PRO in one edit contracts the added add-on at PRO",
    up.snapRate,
    900,
  );
  gCheck(
    up.previewFullTerm === 9000,
    "§G the PREVIEW of the reverse edit quotes PRO's rate",
    up.previewFullTerm,
    9000,
  );
  gCheck(
    up.renewalCharge === 9000n,
    "§G the reverse edit's next term bills 10 × 900",
    up.renewalCharge,
    9000n,
  );
}
console.log(`add-in-same-edit differential: ${addDiffPass ? "PASS" : "FAIL"}`);

// ── § H — a quantity CUT credits the removed units, across the invoices that billed them ──
// Written 2026-09-01 to hold the money while a DOCUMENT-SHAPE question is undecided, so that
// accepting either shape cannot swallow a real drift.
//
// Two shapes measured on the same fixture (add-on ×1, raised to ×4, cut to ×2):
//   alt   ONE credit note, 221840 — two whole units at the current rate, one document
//   ours  TWO credit notes, 55460 + 166380 = 221840 — 50% of EACH invoice that billed connections
//       (INV-6718 billed one unit: 470 + 84.60 tax; INV-6719 billed three: 1410 + 253.80)
// Identical money, different documents, and ours attributes each note to the invoice whose
// supply it reverses — which is the provenance an India GST credit note wants — at the cost of
// crediting half a unit's value from one invoice and one and a half from the other.
//
// WHICH SHAPE IS RIGHT IS NOT ESTABLISHED, and this section deliberately does not decide it. It
// pins the two things that must hold under EITHER answer:
//   · the CUT raises no new invoice (the price-swap gross shape is what 54f0c633 removed), and
//   · the notes SUM to exactly the removed units at their contracted rate — no more, no less.
// The 50/50 split itself is NOT asserted: that is the undecided policy, and pinning a number
// nobody has argued for would make this suite an obstacle to the decision rather than a guard
// on the money. What it does assert is that every note names a DISTINCT source invoice, because
// a note that credits an invoice which never billed the item is wrong on any theory.
let qtyCutPass = true;
const hCheck = (ok: boolean, label: string, got: unknown, want: unknown) => {
  if (!ok) qtyCutPass = false;
  console.log(
    `  ${ok ? "✓" : "✗"} ${label}: ${String(got)}${ok ? "" : ` (expected ${String(want)})`}`,
  );
};
{
  const { invoiceLineItems: hIli, invoices: hInv, creditNotes: hCn } = await import("@db/schema");
  const { billSubscriptionPeriod: hBill } = await import("@/modules/invoicing/service");
  const hOrg = await createOrganization({ name: "Quantity cut" });
  const hOrgId = hOrg.organization.id;
  const hBiz = await createBusiness({
    organizationId: hOrgId,
    name: "Biz",
    defaultCurrency: "USD",
    livemode: "test",
  });
  const hCus = await createCustomer({
    organizationId: hOrgId,
    businessId: hBiz.id,
    email: "qtycut@a.com",
  });
  await vaultPaymentMethod({
    organizationId: hOrgId,
    businessId: hBiz.id,
    customer: hCus,
    token: "tok_4242",
  });
  const hPlanProd = await createProduct({
    organizationId: hOrgId,
    businessId: hBiz.id,
    name: "PLAN",
    kind: "plan",
  });
  const hAddProd = await createProduct({
    organizationId: hOrgId,
    businessId: hBiz.id,
    name: "Seats",
    kind: "addon",
  });
  const H_PLAN = await createPrice({
    organizationId: hOrgId,
    businessId: hBiz.id,
    productId: hPlanProd.id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 100000,
    interval: "month",
  });
  // A PLAIN per-unit price, not a differential one: the arithmetic here is about quantity, and
  // a catalog-0 differential add-on would make every expected figure depend on a second table.
  const RATE = 940;
  const H_ADD = await createPrice({
    organizationId: hOrgId,
    businessId: hBiz.id,
    productId: hAddProd.id,
    type: "recurring",
    model: "per_unit",
    currency: "USD",
    amountMinor: RATE,
    interval: "month",
  });
  const hSub = await createSubscription({
    organizationId: hOrgId,
    businessId: hBiz.id,
    customerId: hCus.id,
    now: new Date("2026-09-01T00:00:00.000Z"),
    items: [
      { price: H_PLAN, quantity: 1 },
      { price: H_ADD, quantity: 1 },
    ],
  });
  const hSubId = hSub.subscription.id;
  await hBill({
    organizationId: hOrgId,
    businessId: hBiz.id,
    subscription: hSub.subscription,
    periodStart: hSub.subscription.currentPeriodStart!,
    periodEnd: hSub.subscription.currentPeriodEnd!,
  });
  const addItemPub = async (): Promise<string> => {
    const rows = await withTenant(hOrgId, (tx) =>
      tx.select().from(subscriptionItems).where(eq(subscriptionItems.subscriptionId, hSubId)),
    );
    const row = rows.find((r) => r.priceId === H_ADD.id);
    if (!row) throw new Error("no add-on item on the subscription");
    return row.publicId;
  };
  const invoiceCount = async (): Promise<number> =>
    (
      await withTenant(hOrgId, (tx) =>
        tx.select().from(hInv).where(eq(hInv.subscriptionId, hSubId)),
      )
    ).length;
  const cutQuantity = async (to: number, at: string) =>
    changeSubscription({
      organizationId: hOrgId,
      businessId: hBiz.id,
      subscriptionId: hSubId,
      changes: [{ itemId: await addItemPub(), newQuantity: to }],
      prorate: true,
      invoiceImmediately: true,
      now: new Date(at),
    });

  // The INCREASE first, so the removed units are spread over TWO invoices — which is what makes
  // the allocator's behaviour observable at all. One invoice, and any shape looks the same.
  await cutQuantity(4, "2026-09-08T00:00:00.000Z");
  const afterRaise = await invoiceCount();
  hCheck(
    afterRaise === 2,
    "§H the increase billed the added units on its own invoice",
    afterRaise,
    2,
  );

  const beforeCut = await invoiceCount();
  await cutQuantity(2, "2026-09-15T00:00:00.000Z");
  const afterCut = await invoiceCount();
  hCheck(
    afterCut === beforeCut,
    "§H the CUT raises NO new invoice (54f0c633 — not the price-swap gross shape)",
    `${beforeCut} → ${afterCut}`,
    `${beforeCut} → ${beforeCut}`,
  );

  const notes = await withTenant(hOrgId, (tx) =>
    tx.select().from(hCn).where(eq(hCn.customerId, hCus.id)),
  );
  const noteSum = notes.reduce((n, c) => n + c.totalMinor, 0n);
  // Two units removed at the contracted rate, prorated over the SAME window for both — the
  // fraction cancels only if it is identical, so this is derived from the engine's own figures
  // rather than re-deriving a day count here: whatever fraction it used, twice one unit's credit
  // must equal the two-unit credit. Expressed as the exact expectation for this fixture: the cut
  // runs at the same instant for both units, so the total is 2 × RATE × (remaining/period).
  // ⚠ THIS ASSERTION WAS WRITTEN VACUOUSLY THE FIRST TIME, and the first version passed:
  // `noteSum === (noteSum / 2n) * 2n` is true of every even number, so it tested divisibility
  // by two and nothing else. Replaced with an INDEPENDENT expectation, reimplemented here on
  // purpose — importing the engine's own proration would make the figure a tautology again.
  // Term 2026-09-01 → 2026-10-01 is 30 days; the cut runs on 09-15, leaving 16; two units at
  // the contracted rate over that fraction, integer division flooring exactly as the engine's
  // does: 940 × 2 × 16 / 30 = 1002. A ±1 drift here is not noise to widen a tolerance for — it
  // means the per-note rounding changed, which is precisely what this section exists to notice.
  const DAYS_IN_TERM = 30n;
  const DAYS_REMAINING = 16n;
  const expectedCut = (BigInt(RATE) * 2n * DAYS_REMAINING) / DAYS_IN_TERM;
  hCheck(
    noteSum === expectedCut,
    "§H the notes SUM to exactly two units' credit for the remaining term, nothing stranded",
    noteSum,
    expectedCut,
  );
  hCheck(
    noteSum <= BigInt(RATE) * 2n,
    "§H and never MORE than two whole units at the contracted rate",
    noteSum,
    `<= ${RATE * 2}`,
  );
  const against = notes.map((c) => c.invoiceId).filter((v): v is string => v != null);
  hCheck(
    new Set(against).size === against.length,
    "§H every note names a DISTINCT source invoice — none credits an invoice twice",
    `${against.length} notes, ${new Set(against).size} distinct invoices`,
    "all distinct",
  );
  // The invoices a note may credit are exactly those that billed the add-on. A note against the
  // plan-only invoice would be wrong under either shape, and is the failure this catches.
  const billedAddon = new Set<string>();
  for (const inv of await withTenant(hOrgId, (tx) =>
    tx.select().from(hInv).where(eq(hInv.subscriptionId, hSubId)),
  )) {
    const lines = await withTenant(hOrgId, (tx) =>
      tx.select().from(hIli).where(eq(hIli.invoiceId, inv.id)),
    );
    if (lines.some((l) => l.priceId === H_ADD.id && l.amountMinor > 0n)) billedAddon.add(inv.id);
  }
  hCheck(
    against.every((id) => billedAddon.has(id)),
    "§H and each names an invoice that actually BILLED the add-on",
    `${against.length} notes against ${billedAddon.size} add-on-billing invoices`,
    "every note on an add-on invoice",
  );
}
console.log(`quantity-cut credit: ${qtyCutPass ? "PASS" : "FAIL"}`);

// ── § I — auto-collection OFF means the CHANGE invoice is not charged either ──────────
// CP-1 says "'off' → leave the invoice open (send-invoice), don't attempt a charge", in the
// first line of `isAutoCollectOn`'s own docblock. Until 2026-09-01 `createInvoiceFromLines`
// implemented the first half and not the second: it computed `offlineHere`, used it to enrol
// the invoice in offline dunning, and then collected anyway whenever the caller passed
// `collect: true` — which the change path does unconditionally.
//
// The old code said so, and said why it was safe: an offline invoice "walks into
// `collectInvoice`, finds no chargeable instrument and records a failed payment", which
// `planFailureRearm` absorbs. That holds only while an auto-collect-off customer has NO usable
// card. "Pays by invoice, card on file for backup" is an ordinary configuration, and then the
// charge SUCCEEDS: 20,184.00 was taken from a customer who had opted out of automatic
// collection, where the invoice should have stayed payment_due.
//
// SO THE FIXTURE HERE VAULTS A CARD ON PURPOSE. A version of this test without one passes
// against the broken code — the charge fails for lack of an instrument and the invoice stays
// open, which looks exactly like the correct outcome. That is precisely how the gap survived:
// other cases cover auto-collection off at SIGNUP, and nothing put a usable card behind it
// at a CHANGE. An assertion that cannot distinguish "refused to charge" from "tried and
// failed" is not evidence about CP-1.
let offCollectPass = true;
const iCheck = (ok: boolean, label: string, got: unknown, want: unknown) => {
  if (!ok) offCollectPass = false;
  console.log(
    `  ${ok ? "✓" : "✗"} ${label}: ${String(got)}${ok ? "" : ` (expected ${String(want)})`}`,
  );
};
{
  const { invoices: iInv, payments: iPay } = await import("@db/schema");
  const { billSubscriptionPeriod: iBill } = await import("@/modules/invoicing/service");
  const iOrg = await createOrganization({ name: "Offline collect" });
  const iOrgId = iOrg.organization.id;
  const iBiz = await createBusiness({
    organizationId: iOrgId,
    name: "Biz",
    defaultCurrency: "USD",
    livemode: "test",
  });
  const iCus = await createCustomer({
    organizationId: iOrgId,
    businessId: iBiz.id,
    email: "offcollect@a.com",
  });
  // THE LOAD-BEARING LINE. A chargeable instrument, on a subscription that has opted out of
  // being charged — without it this section proves nothing.
  await vaultPaymentMethod({
    organizationId: iOrgId,
    businessId: iBiz.id,
    customer: iCus,
    token: "tok_4242",
  });
  const iProd = await createProduct({
    organizationId: iOrgId,
    businessId: iBiz.id,
    name: "PLAN",
    kind: "plan",
  });
  const iFlat = (amountMinor: number) =>
    createPrice({
      organizationId: iOrgId,
      businessId: iBiz.id,
      productId: iProd.id,
      type: "recurring" as const,
      model: "flat" as const,
      currency: "USD",
      amountMinor,
      interval: "month" as const,
    });
  const I_SMALL = await iFlat(100000);
  const I_BIG = await iFlat(300000);
  const iSub = await createSubscription({
    organizationId: iOrgId,
    businessId: iBiz.id,
    customerId: iCus.id,
    now: new Date("2026-09-01T00:00:00.000Z"),
    items: [{ price: I_SMALL, quantity: 1 }],
    autoCollection: "off",
  });
  const iSubId = iSub.subscription.id;
  await iBill({
    organizationId: iOrgId,
    businessId: iBiz.id,
    subscription: iSub.subscription,
    periodStart: iSub.subscription.currentPeriodStart!,
    periodEnd: iSub.subscription.currentPeriodEnd!,
  });
  const planItem = (
    await withTenant(iOrgId, (tx) =>
      tx.select().from(subscriptionItems).where(eq(subscriptionItems.subscriptionId, iSubId)),
    )
  ).find((r) => r.priceId === I_SMALL.id)!;

  await changeSubscription({
    organizationId: iOrgId,
    businessId: iBiz.id,
    subscriptionId: iSubId,
    changes: [{ itemId: planItem.publicId, newPriceId: I_BIG.publicId }],
    prorate: true,
    invoiceImmediately: true,
    now: new Date("2026-09-15T00:00:00.000Z"),
  });

  const iInvoices = await withTenant(iOrgId, (tx) =>
    tx.select().from(iInv).where(eq(iInv.subscriptionId, iSubId)),
  );
  // Invoices carry no paid-amount column, so "was it charged" is asked of the STATUS here and
  // of the payments table below. The change is an upgrade with no credit behind it, so a
  // `paid` invoice on this fixture can only mean the engine took money.
  const settled = iInvoices.filter((v) => v.status === "paid");
  iCheck(
    settled.length === 0,
    "§I no invoice on an auto-collect-off subscription was settled by the engine",
    `${settled.length} of ${iInvoices.length} invoices read paid`,
    0,
  );
  const succeeded = (
    await withTenant(iOrgId, (tx) => tx.select().from(iPay).where(eq(iPay.customerId, iCus.id)))
  ).filter((p) => p.status === "succeeded");
  iCheck(
    succeeded.length === 0,
    "§I and no payment SUCCEEDED against the card it has on file",
    succeeded.length,
    0,
  );
  // The other half of CP-1, so a fix that simply stopped raising the invoice would fail here:
  // the money is still owed, it is just not taken automatically.
  const openTotal = iInvoices
    .filter((v) => isOpenInvoiceStatus(v.status))
    .reduce((n, v) => n + (v.amountDueMinor ?? 0n), 0n);
  iCheck(
    openTotal > 0n,
    "§I the change still RAISED what is owed — suppressed collection, not a free change",
    openTotal,
    "> 0",
  );
}
console.log(`auto-collect-off change: ${offCollectPass ? "PASS" : "FAIL"}`);

// ── § J — a quantity cut credits the NEWEST supply first, in whole units ──────────────
// The rule, measured 2026-09-02 and adopted by decision the same day.
//
// TWO ARMS WERE MEASURED, and the second is the one that establishes the rule:
//   A. add-on ×1 → ×4 → ×2. Removed units 1880.00, newest invoice holds 2820.00.
//      ONE note, qty 2, entirely against the NEWEST invoice. The older invoice — which
//      billed one of the four units — is not touched.
//   B. add-on ×4 → ×5 → ×1. Removed units 3760.00, newest invoice holds only 940.00.
//      TWO notes — 940.00 qty 1 against the newest, 2820.00 qty 3 against the older.
//      Nothing withheld, and no invoice asked to give back more than it took.
// So the newest invoice is filled to its capacity and SPILLS to older ones as needed, one
// note per invoice, each referencing that invoice's own line. Arm A alone would not have
// shown it: with room to spare, "newest first" and "the newest invoice only" are
// indistinguishable.
//
// OURS DISTRIBUTED PRO RATA instead — `distributeCreditAcrossInvoices` weights each invoice by
// the base it carries, so a 2-of-4 cut took 50% from EACH invoice: half a unit's value from the
// one that billed one unit, one and a half from the one that billed three. Same total, same
// per-invoice attribution, same document model — a different distribution of the same money,
// and fractional units on a document that should print whole ones.
//
// WHAT THIS SECTION PINS, and deliberately not more: the ORDER. It does not assert the note
// count (that follows from the order and the capacities), and it does not assert a fraction —
// the whole point of the change is that no fraction is taken while a newer invoice has room.
let cutOrderPass = true;
const jCheck = (ok: boolean, label: string, got: unknown, want: unknown) => {
  if (!ok) cutOrderPass = false;
  console.log(
    `  ${ok ? "✓" : "✗"} ${label}: ${String(got)}${ok ? "" : ` (expected ${String(want)})`}`,
  );
};
{
  const { invoices: jInv, creditNotes: jCn } = await import("@db/schema");
  const { billSubscriptionPeriod: jBill } = await import("@/modules/invoicing/service");
  const jOrg = await createOrganization({ name: "Cut order" });
  const jOrgId = jOrg.organization.id;
  const jBiz = await createBusiness({
    organizationId: jOrgId,
    name: "Biz",
    defaultCurrency: "USD",
    livemode: "test",
  });
  const jCus = await createCustomer({
    organizationId: jOrgId,
    businessId: jBiz.id,
    email: "cutorder@a.com",
  });
  await vaultPaymentMethod({
    organizationId: jOrgId,
    businessId: jBiz.id,
    customer: jCus,
    token: "tok_4242",
  });
  const jPlanProd = await createProduct({
    organizationId: jOrgId,
    businessId: jBiz.id,
    name: "PLAN",
    kind: "plan",
  });
  const jAddProd = await createProduct({
    organizationId: jOrgId,
    businessId: jBiz.id,
    name: "Seats",
    kind: "addon",
  });
  const J_PLAN = await createPrice({
    organizationId: jOrgId,
    businessId: jBiz.id,
    productId: jPlanProd.id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 100000,
    interval: "month",
  });
  const J_RATE = 940;
  const J_ADD = await createPrice({
    organizationId: jOrgId,
    businessId: jBiz.id,
    productId: jAddProd.id,
    type: "recurring",
    model: "per_unit",
    currency: "USD",
    amountMinor: J_RATE,
    interval: "month",
  });
  const jSub = await createSubscription({
    organizationId: jOrgId,
    businessId: jBiz.id,
    customerId: jCus.id,
    now: new Date("2026-09-01T00:00:00.000Z"),
    items: [
      { price: J_PLAN, quantity: 1 },
      { price: J_ADD, quantity: 1 },
    ],
  });
  const jSubId = jSub.subscription.id;
  await jBill({
    organizationId: jOrgId,
    businessId: jBiz.id,
    subscription: jSub.subscription,
    periodStart: jSub.subscription.currentPeriodStart!,
    periodEnd: jSub.subscription.currentPeriodEnd!,
  });
  const jAddItem = async (): Promise<string> => {
    const rows = await withTenant(jOrgId, (tx) =>
      tx.select().from(subscriptionItems).where(eq(subscriptionItems.subscriptionId, jSubId)),
    );
    return rows.find((r) => r.priceId === J_ADD.id)!.publicId;
  };
  const jQty = async (to: number, at: string) =>
    changeSubscription({
      organizationId: jOrgId,
      businessId: jBiz.id,
      subscriptionId: jSubId,
      changes: [{ itemId: await jAddItem(), newQuantity: to }],
      prorate: true,
      invoiceImmediately: true,
      now: new Date(at),
    });

  // Arm A's shape: the FIRST invoice bills one unit, the increase bills three more on a SECOND
  // invoice, and the cut removes two — which the newest invoice can absorb by itself.
  await jQty(4, "2026-09-08T00:00:00.000Z");
  await jQty(2, "2026-09-15T00:00:00.000Z");

  const jInvoices = await withTenant(jOrgId, (tx) =>
    tx.select().from(jInv).where(eq(jInv.subscriptionId, jSubId)),
  );
  const byId = new Map(jInvoices.map((v) => [v.id, v]));
  const oldest = [...jInvoices].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0]!;
  const notes = await withTenant(jOrgId, (tx) =>
    tx.select().from(jCn).where(eq(jCn.customerId, jCus.id)),
  );
  const total = notes.reduce((n, c) => n + c.totalMinor, 0n);
  const onOldest = notes
    .filter((c) => c.invoiceId === oldest.id)
    .reduce((n, c) => n + c.totalMinor, 0n);

  console.log(
    `  §J notes: ${notes.map((c) => `${c.totalMinor} on ${byId.get(c.invoiceId ?? "")?.publicId ?? "?"}`).join(", ")}`,
  );
  // The whole credit belongs on the newest invoice, because it billed three of the four units
  // and only two are being removed. Under the pro-rata allocator this is where a share lands on
  // the oldest invoice instead — which is exactly the behaviour being replaced.
  jCheck(
    onOldest === 0n,
    "§J the oldest invoice is untouched while a newer one still has the supply",
    `${onOldest} credited against ${oldest.publicId}`,
    0,
  );
  jCheck(
    notes.length === 1,
    "§J so one note, not one per invoice — the count FOLLOWS from the order",
    notes.length,
    1,
  );
  // Independent of the ordering question: the total must not move. 940 × 2 over the remaining
  // 16 of 30 days, integer division flooring as the engine's does — the same derivation § H
  // uses, reimplemented rather than imported.
  const expected = (BigInt(J_RATE) * 2n * 16n) / 30n;
  jCheck(total === expected, "§J and the money is unchanged by the reordering", total, expected);
}
console.log(`quantity-cut order: ${cutOrderPass ? "PASS" : "FAIL"}`);

// Allow ±2 minor units for integer-division rounding at the midpoint.
const near = (a: number | null, b: number) => a != null && Math.abs(a - b) <= 2;
const pass =
  near(upTotal, 1000) &&
  up.prorationInvoice?.status === "paid" &&
  qtyAfterUp === 3 &&
  up.payment?.status === "succeeded" &&
  near(downCredit, 1000) &&
  down.creditNote?.status === "refund_due" &&
  !down.prorationInvoice &&
  qtyAfterDown === 1 &&
  custBal <= -998n &&
  near(upTaxSubtotal, 1000) &&
  near(upTaxTotal, 1100) &&
  upTax.prorationInvoice?.status === "paid" &&
  defaultsPass &&
  namingPass &&
  monthEndPass &&
  trialPass &&
  denomPass &&
  openCreditPass &&
  diffPass &&
  addDiffPass &&
  qtyCutPass &&
  offCollectPass &&
  cutOrderPass;

console.log("");
console.log(pass ? "✅ PRORATION: PASS" : "❌ PRORATION: FAIL");
await closeDb();
process.exit(pass ? 0 : 1);
