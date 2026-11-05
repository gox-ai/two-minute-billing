import { PortalSectionButton, PortalSectionLink } from "./section-link";
import * as React from "react";
import { CheckCircle2, Clock, TriangleAlert } from "lucide-react";
import { Card } from "@/components/ui/card";
import { money, fmtDate } from "@/lib/format";
import type {
  PortalInvoice,
  PortalMe,
  PortalPaymentMethod,
  PortalShippingAddress,
  PortalSubscription,
} from "@/lib/portal-api";
import { invoiceContactName } from "@/lib/names";
import { Glyph, MetaField, Row, RowList, StorefrontSection, instrumentLabel } from "../../chrome";
import { paymentMarkKey } from "@/components/brand/payment-mark";
import { InstrumentMark } from "@/components/brand/instrument-mark";
import { Alert } from "@/components/ui/alert";
import { StatusChip } from "@/components/patterns/chip";
import { PortalCouponBox, PortalCouponRemove } from "./portal-coupon";
import { PortalSkipRenewal } from "./portal-skip-renewal";
import { PortalChangePlan } from "./portal-change-plan";
import { PortalLifecycle } from "./portal-lifecycle";
import { PortalUsage, PortalUsageSkeleton } from "./portal-usage";
import { PortalShipTo } from "./portal-ship-to";
import { Package } from "lucide-react";

/**
 * Portal-specific presentation. Everything generic to a hosted buyer page
 * (header, section, row list, notice card, footer) lives in `../../chrome.tsx`
 * and is shared with checkout — these are the pieces that only make sense with
 * a portal payload in hand.
 */

/**
 * What the mandate behind an instrument is actually doing right now.
 *
 * `payment_methods.status` already goes `invalid` for the statuses that KILL a mandate
 * (`applyMandateUpdate` → `DEAD_MANDATE_STATUSES`: rejected, cancelled, paused), and the
 * portal row shows that. The gap this closes is the opposite end: a netbanking e-mandate
 * is `initiated` from the moment the buyer finishes at their bank until the bank confirms
 * it — HDFC and SBI take until T+1 — and for that whole window the instrument is NOT
 * chargeable while the row looks perfectly healthy. A buyer who added a payment method
 * yesterday and sees an unpaid invoice today has no way to tell those two apart.
 *
 * Deliberately keyed on the RAIL, not on the ceiling: a ceiling is only ever reported by
 * RazorPay (INR), while a SEPA or ACH mandate has a real status and a real pending window
 * of its own. Gating this on "is there a ceiling" would hide from a German or American
 * buyer the one fact that explains why nothing has been collected yet.
 */
const MANDATE_LIVE_STATUSES = new Set(["confirmed", "active"]);

export type MandateState =
  /** Authorised and chargeable — the ordinary case, and it needs no chip. */
  | { kind: "live" }
  /** Registered, waiting on the bank. Not chargeable yet, through no one's fault. */
  | { kind: "pending" }
  /** Over: revoked at the bank, rejected, paused, or (Stripe single-use) spent. */
  | { kind: "dead"; status: string }
  /** No mandate rail at all (a plain card on file), or the provider reported no status. */
  | { kind: "none" };

/**
 * Has the mandate passed the end date the GATEWAY reported for it?
 *
 * The buyer-side twin of `mandateHasExpired` (`src/modules/payment-methods/mandate-afa.ts`),
 * and it follows the same two rules for the same reasons: null means UNKNOWN (a plain card
 * on file, a provider that reports no end date, a row vaulted before 0179) and never "no
 * expiry", and there is no grace period — the date is RazorPay's, not ours.
 *
 * It is a copy because the dashboard is a separate package whose `@/*` resolves inside
 * `dashboard/` and cannot import from the engine — the same constraint that already forces
 * the `MANDATE_LIVE_STATUSES` copy above. If you change the rule there, change it here, or
 * the portal will call an instrument live that the charge path refuses.
 */
function mandateHasExpired(expiresAt: string | null | undefined, now = Date.now()): boolean {
  if (!expiresAt) return false;
  const at = Date.parse(expiresAt);
  return Number.isFinite(at) && at <= now;
}

export function mandateState(pm: PortalPaymentMethod): MandateState {
  if (!pm.mandate?.rail) return { kind: "none" };
  const status = pm.mandate.status?.toLowerCase();
  if (!status) return { kind: "none" }; // a rail with no status reported: claim nothing
  /**
   * A revoked / rejected / paused mandate keeps its OWN word even when the end date has
   * also gone by, and the expiry check sits after it deliberately.
   *
   * The charge path answers these in the opposite order (`chargeWithMethod` checks expiry
   * before the ceiling), because there it is choosing which REMEDY to name and the
   * `mandate_ceiling_exceeded` message would otherwise promise that a smaller charge
   * works. Here nothing is being chosen: both answers are `kind: "dead"`, so the only
   * thing the order decides is which fact goes in the parenthetical the payer reads — and
   * "your bank cancelled this" is a more specific and more useful fact than "it ran out".
   */
  if (MANDATE_LIVE_STATUSES.has(status) || status === "initiated") {
    /**
     * ⚠️ This is the case that was silently wrong, and it is the common one: RazorPay
     * reports a card mandate `confirmed` and hands back an end-of-day end date that has
     * already passed — 115 of 137 card mandates measured that way on 2026-09-01. The
     * portal called every one of them live and the engine debited them. Expiry is a
     * SEPARATE AXIS from the reported status, so it has to be read separately.
     */
    if (mandateHasExpired(pm.mandate.expires_at)) return { kind: "dead", status: "expired" };
  }
  if (MANDATE_LIVE_STATUSES.has(status)) return { kind: "live" };
  if (status === "initiated") return { kind: "pending" };
  return { kind: "dead", status };
}

/**
 * The one thing standing between an open invoice and the money, when the blocker is the
 * MANDATE rather than the balance — and what the payer can do about it.
 *
 * ── Why the portal needs this at all ──────────────────────────────────────────
 * A `mandate_ceiling_exceeded` or `mandate_expired` refusal is non-retriable and PARKS
 * (`decline-policy.ts`): `next_attempt_at` stays null and no dunning pass revisits the
 * invoice. It now DOES age out — `sweepExpiredParkedDunning` closes every parked window
 * at its deadline and the merchant's final action fires, which for the default config
 * cancels. (This paragraph claimed the opposite; it had been wrong since 2026-09-01,
 * when these two codes gained a deadline, and the sentence outlived the fact.) That is
 * the correct engine behaviour — retrying cannot work — but it makes the telling below
 * load-bearing rather than merely kind: the payer's re-authorisation is the only thing
 * that clears this, and there is now a clock on it. It made the failure SILENT: the audited subscription took three refusals (INV-5381, INV-5440, INV-5443) over
 * an unpayable invoice and nothing ever asked the human whose authorisation is the only
 * thing that can clear it. Parking is only defensible if somebody is told, and this is the
 * telling.
 *
 * ── It mirrors `mandateRefusal`, and must not re-derive the rule ──────────────
 * Same null-ceiling-means-unknown, same currency guard, same `<=` boundary as
 * `mandateRefusal` (`src/modules/invoicing/collection.ts`) and as `mandateShortfallFor`
 * in the estimator. A second, looser copy of that rule is how a portal starts warning
 * about charges that would have gone through.
 *
 * ── What it deliberately does NOT claim ───────────────────────────────────────
 *  - It reads only the DEFAULT instrument. The engine charges the subscription's default
 *    first and falls back to the customer's primary; the portal payload carries no
 *    per-subscription default, so an account whose subscription names a different card
 *    could be warned about a ceiling that will never be reached. Warning on the default
 *    only is the conservative half of that trade.
 *  - It says nothing when the ceiling is unknown, when the mandate is denominated in
 *    another currency, or when there is no open invoice above the ceiling. A banner that
 *    fires on a healthy account is a banner people learn to scroll past.
 *  - It offers no CONTROL of its own. The remedy is the "Payment methods" section further
 *    down this same page, which already runs the vault-setup flow that sizes a fresh
 *    ceiling from the customer's CURRENT subscriptions (`deriveMandateCeiling`) — so the
 *    upgraded plan is what the new mandate is sized for, and
 *    `collect_on_payment_method_update` (default ON) collects the parked invoice the
 *    moment it is registered. A second add-card entry point here would be a second place
 *    for the same flow to drift, which is exactly the reasoning `add-card.tsx` already
 *    applies to the billing-address form it points at instead of duplicating.
 */
export type MandateBlocker = {
  /** `expired` — the authorisation lapsed. `ceiling` — this invoice is over its limit. */
  reason: "expired" | "ceiling";
  /** The instrument that cannot carry it, for naming it to the payer. */
  method: PortalPaymentMethod;
  /** The largest open amount the mandate cannot carry, in minor units. */
  amountMinor: number;
  currency: string;
  /** The per-charge limit on the mandate, when that is the blocker. */
  ceilingMinor: number | null;
  /** The gateway-reported end date, when THAT is the blocker. */
  expiresAt: string | null;
};

export function mandateBlocker(
  methods: PortalPaymentMethod[],
  invoices: PortalInvoice[],
): MandateBlocker | null {
  const pm = methods.find((m) => m.is_default) ?? null;
  if (!pm?.mandate?.rail) return null;
  // Nothing is blocked while nothing is owed — a lapsed mandate on a paid-up account is
  // news the "Payment methods" section already carries on the row itself.
  const open = invoices.filter((i) => i.amount_due_minor > 0);
  if (open.length === 0) return null;

  const expiresAt = pm.mandate.expires_at ?? null;
  if (mandateHasExpired(expiresAt)) {
    // No currency guard: an expired authorisation carries no debit of ANY size or
    // denomination, so unlike the ceiling there is nothing to compare.
    const worst = open.reduce((a, b) => (b.amount_due_minor > a.amount_due_minor ? b : a));
    return {
      reason: "expired",
      method: pm,
      amountMinor: worst.amount_due_minor,
      currency: worst.currency,
      ceilingMinor: pm.mandate.max_amount_minor,
      expiresAt,
    };
  }

  const ceiling = pm.mandate.max_amount_minor;
  if (ceiling == null) return null; // unknown, never unlimited — `mandateRefusal`'s rule
  const cur = pm.mandate.currency;
  const comparable = cur
    ? open.filter((i) => i.currency.toUpperCase() === cur.toUpperCase())
    : open;
  const over = comparable.filter((i) => i.amount_due_minor > ceiling);
  if (over.length === 0) return null;
  const worst = over.reduce((a, b) => (b.amount_due_minor > a.amount_due_minor ? b : a));
  return {
    reason: "ceiling",
    method: pm,
    amountMinor: worst.amount_due_minor,
    currency: worst.currency,
    ceilingMinor: ceiling,
    expiresAt,
  };
}

/**
 * A vaulted wallet (PayPal) or a bank rail has no brand and no last4, so the
 * glyph follows the instrument rather than always drawing a card.
 */
export function MethodGlyph({ pm }: { pm: PortalPaymentMethod }) {
  /* The network's own mark when the gateway told us which network it is — a payer finds
     their card by the logo, not by re-reading four digits. Unrecognised brands keep the grey
     glyph rather than being guessed at (see `paymentMarkKey`).

     The CHOICE of icon now lives in `InstrumentMark`, shared with the operator screens so a
     RuPay card looks like a RuPay card on both sides of the product. Only the tile stays
     here: a payer's row is 36px and a table cell is text-height, and that difference is
     real. `bg-card` behind a mark and `bg-muted` behind a glyph is the same distinction as
     before — artwork sits on the card colour, our own glyph on the muted one. */
  const mark = paymentMarkKey({ brand: pm.brand, type: pm.type, mandateRail: pm.mandate?.rail });
  return (
    <Glyph className={mark ? "bg-card" : undefined}>
      <InstrumentMark
        brand={pm.brand}
        type={pm.type}
        mandateRail={pm.mandate?.rail}
        last4={pm.last4}
        className={mark ? undefined : "size-4"}
      />
    </Glyph>
  );
}

/**
 * A vaulted wallet (PayPal) has no brand and no last4 — rendering it as
 * "paypal •••• ????" reads as a broken card. Name the wallet instead.
 */
/** Delegates to the shared formatter so the portal and the checkout name a card alike. */
export function methodLabel(pm: PortalPaymentMethod): string {
  return instrumentLabel({
    type: pm.type,
    brand: pm.brand,
    last4: pm.last4,
    mandateRail: pm.mandate?.rail,
  });
}

/** One outstanding balance per currency — a business may bill the same buyer in more than one. */
export interface DueTotal {
  currency: string;
  minor: number;
  count: number;
  /** Earliest due date across the open invoices in this currency. */
  earliest: string | null;
  overdue: boolean;
}

/**
 * What is still owed. An invoice whose payment is already in progress is left out: that money
 * is being collected, so it is neither "due" nor a reason to save a payment method.
 */
export function summarizeDue(invoices: PortalInvoice[]): DueTotal[] {
  return summarize(invoices.filter((i) => !i.payment_in_flight));
}

/** The invoices whose payment the bank or provider is still confirming. */
export function summarizeInFlight(invoices: PortalInvoice[]): DueTotal[] {
  return summarize(invoices.filter((i) => i.payment_in_flight));
}

function summarize(invoices: PortalInvoice[]): DueTotal[] {
  const now = Date.now();
  const byCurrency = new Map<string, DueTotal>();
  for (const inv of invoices) {
    if (inv.amount_due_minor <= 0) continue;
    const t = byCurrency.get(inv.currency) ?? {
      currency: inv.currency,
      minor: 0,
      count: 0,
      earliest: null,
      overdue: false,
    };
    t.minor += inv.amount_due_minor;
    t.count += 1;
    if (inv.due_date && (t.earliest === null || inv.due_date < t.earliest))
      t.earliest = inv.due_date;
    if (inv.due_date && Date.parse(inv.due_date) < now) t.overdue = true;
    byCurrency.set(inv.currency, t);
  }
  return [...byCurrency.values()].sort((a, b) => b.minor - a.minor);
}

/** Local, so the portal does not reach into `lib/api/*` for a formatter. */
function addressLines(a: PortalMe["customer"]["address"]): string[] {
  const city = [a.city, a.state, a.postal_code].filter(Boolean).join(" ");
  return [a.company, a.line1, a.line2, a.line3, city, a.country].filter((l): l is string =>
    Boolean(l && l.trim()),
  );
}

/**
 * The statement at the top of the portal: what is owed, or that nothing is. It
 * is derived entirely from the invoice list already on the page — no new
 * endpoint, and no control, so it cannot promise anything the engine will refuse.
 * "Pay now" stays on the invoice row it applies to.
 */
/** "/ month", "/ 3 months" — the cadence a line is quoted in, or nothing when it has none. */
function cadence(interval: string | null, count: number): string {
  if (!interval) return "";
  return count > 1 ? ` / ${count} ${interval}s` : ` / ${interval}`;
}

/**
 * What the buyer is subscribed to, and what will be collected next.
 *
 * The portal had neither: it opened with a balance over an invoice list, so a customer who
 * had just signed up could not see their plan, their add-ons, the amount or the date — the
 * two facts a billing portal exists to state. Placed above Invoices for that reason: what
 * you have now, then the history of what you paid.
 *
 * Amounts come from each item's FROZEN price snapshot and the next payment from
 * `estimateRenewal`, so the figures are the ones the invoice will carry — including its GST
 * split, which is why the tax rows are named rather than lumped.
 */
export function PlanCard({
  subs,
  tz,
  /** `me.business.allow_customer_coupons` (0238) — gates the coupon box below. */
  allowCoupons = false,
  /**
   * The rails the buyer can ACTUALLY choose in Payment methods, unioned across this
   * business's gateway accounts. Needed only to stop the shortfall alert naming one
   * that is not on offer — see the note at its use.
   */
  offeredRails = [],
  /** Live shipping addresses; absent when the account has no shipping (0360). */
  shippingAddresses,
}: {
  subs: PortalSubscription[];
  tz?: string | null;
  allowCoupons?: boolean;
  offeredRails?: string[];
  shippingAddresses?: PortalShippingAddress[];
}) {
  if (subs.length === 0) return null;
  return (
    <>
      {subs.map((sub) => (
        /* `hideTitle`: only the single-subscription title is redundant with the tab
           above it. With several, the plan's name tells the cards apart; the
           subscription id is an internal key and never a buyer-facing label. */
        <StorefrontSection
          key={sub.id}
          title={
            subs.length > 1
              ? (sub.items.find((it) => it.kind === "plan")?.name ?? "Your plan")
              : "Your plan"
          }
          hideTitle={subs.length === 1}
          description="Your subscription and the next payment that we collect."
          bodyClassName="p-0"
          action={<StatusChip status={sub.status} />}
        >
          <RowList>
            {sub.items.map((item, i) => (
              <Row key={`${item.name}-${i}`}>
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  <Glyph>
                    <Package />
                  </Glyph>
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">
                      {item.name}
                      {item.quantity > 1 ? (
                        <span className="text-muted-foreground"> × {item.quantity}</span>
                      ) : null}
                    </div>
                    <div className="mt-0.5 text-xs text-muted-foreground capitalize">
                      {item.kind}
                    </div>
                  </div>
                </div>
                {/* The LINE amount (unit × quantity), because that is what the invoice will
                    show for it. A tiered or metered item has no single rate to quote, so it
                    says so rather than rendering a misleading zero. */}
                <div className="shrink-0 text-sm tabular-nums">
                  {item.amount_minor != null ? (
                    `${money(item.amount_minor, sub.currency)}${cadence(item.interval, item.interval_count)}`
                  ) : (
                    <span className="text-muted-foreground">Usage-based</span>
                  )}
                </div>
              </Row>
            ))}
            {/* 0243 hide_zero_value_lines: every item on this plan priced at zero. A real
                subscription always has at least one item, so an empty list here means they
                were all suppressed, not that there is nothing to show. */}
            {sub.items.length === 0 ? (
              <li className="px-5 py-4 text-sm text-muted-foreground">
                Every line on this plan is free of charge.
              </li>
            ) : null}
          </RowList>

          {sub.has_metered_items ? (
            <React.Suspense fallback={<PortalUsageSkeleton />}>
              <PortalUsage subscription={sub.id} tz={tz} />
            </React.Suspense>
          ) : null}

          <div className="border-t px-5 py-4">
            {sub.next_payment &&
            !sub.next_payment.after_scheduled_change &&
            sub.plan_change?.scheduled &&
            (!sub.next_payment.at ||
              Date.parse(sub.plan_change.scheduled.effective_at) <=
                Date.parse(sub.next_payment.at)) ? (
              /* A change runs before this payment but the figure is not priced after it (an
                 older engine): its amount would be the old plan's, so state no amount. */
              <>
                <div className="mb-2 text-xs font-medium tracking-widest text-muted-foreground uppercase">
                  Next payment
                </div>
                <div className="text-sm text-muted-foreground">
                  {sub.next_payment.at ? fmtDate(sub.next_payment.at, tz) : "On renewal"}. Your plan
                  changes first, so this payment is for your new plan.
                </div>
              </>
            ) : sub.next_payment ? (
              <>
                <div className="mb-2 text-xs font-medium tracking-widest text-muted-foreground uppercase">
                  Next payment
                </div>
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-sm text-muted-foreground">
                    {sub.next_payment.at ? fmtDate(sub.next_payment.at, tz) : "On renewal"}
                    {sub.status === "in_trial" ? " · when your trial ends" : ""}
                  </span>
                  <span className="text-lg font-semibold tabular-nums">
                    {money(sub.next_payment.total_minor, sub.next_payment.currency)}
                  </span>
                </div>
                {sub.next_payment.after_scheduled_change ? (
                  <div className="mt-1 text-sm text-muted-foreground">
                    Your plan changes first, so this payment is for your new plan.
                  </div>
                ) : null}
                {/*
                  DISCOUNTS FIRST, because they explain a SHORTFALL the buyer can see.
                  The plan lines above sum to the undiscounted subtotal and this figure is
                  already net of the discount, so the two disagreed by exactly the discount
                  with nothing on the page admitting one existed — reported as "coupon not
                  shown in portal". Above the tax rows, matching the order the invoice
                  states (subtotal → discounts → tax → total).
                */}
                {(sub.next_payment.discount_lines ?? []).length > 0 ? (
                  <div className="mt-2 flex flex-col gap-1">
                    {(sub.next_payment.discount_lines ?? []).map((d, i) => {
                      /* Remove sits ON the line it changes (0238). Only for the line that
                         IS the buyer-removable coupon — a manual discount and any other
                         line render as plain text. */
                      const match = (sub.discounts ?? (sub.discount ? [sub.discount] : [])).find(
                        (x) =>
                          x.removable &&
                          x.coupon != null &&
                          d.label.toLowerCase().includes(x.coupon.toLowerCase()),
                      );
                      const removable = allowCoupons && match != null;
                      return (
                        <div
                          key={`${d.label}-${i}`}
                          className="flex items-center justify-between gap-3 text-xs text-muted-foreground"
                        >
                          <span className="flex flex-wrap items-center gap-2">
                            <span>includes {d.label}</span>
                            {removable ? (
                              <PortalCouponRemove subscription={sub.id} coupon={match!.coupon!} />
                            ) : null}
                          </span>
                          <span className="tabular-nums">
                            −{money(d.amount_minor, sub.next_payment!.currency)}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                ) : null}
                {/* Itemised as the invoice itemises it — an Indian buyer is sent CGST and
                    SGST lines, so quoting a lump figure here leaves them unable to match the
                    two. Shown only when there is tax to name. */}
                {sub.next_payment.tax_lines.length > 0 ? (
                  <div className="mt-2 flex flex-col gap-1">
                    {sub.next_payment.tax_lines.map((t, i) => (
                      <div
                        key={`${t.label}-${i}`}
                        className="flex items-center justify-between gap-3 text-xs text-muted-foreground"
                      >
                        <span>includes {t.label}</span>
                        <span className="tabular-nums">
                          {money(t.amount_minor, sub.next_payment!.currency)}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : null}
                {/* Credit already on the account changes what is actually taken, and a buyer
                    comparing this figure with their bank statement needs to know that. */}
                {sub.next_payment.amount_due_minor !== sub.next_payment.total_minor ? (
                  <div className="mt-2 text-xs text-muted-foreground">
                    {money(sub.next_payment.amount_due_minor, sub.next_payment.currency)} to pay
                    after your account credit.
                  </div>
                ) : null}
              </>
            ) : sub.next_payment_unpriced?.type === "change" ? (
              <>
                <div className="mb-2 text-xs font-medium tracking-widest text-muted-foreground uppercase">
                  Next payment
                </div>
                <div className="text-sm text-muted-foreground">
                  {fmtDate(sub.next_payment_unpriced.at, tz)}. Your plan changes first, so this
                  payment is for your new plan.
                </div>
              </>
            ) : sub.next_payment_unpriced?.type === "pause" ? (
              <div className="text-sm text-muted-foreground">
                Your subscription pauses on {fmtDate(sub.next_payment_unpriced.at, tz)}. No payments
                while it is paused.
              </div>
            ) : /* No next payment is a real answer, not missing data: a cancelling
                 subscription must not be shown a date it will never be billed on. Neutral,
                 not a warning — this is the normal end of a subscription. */
            sub.status === "paused" ? (
              /* Paused is not "will not renew": it continues when the pause ends. */
              <div className="text-sm text-muted-foreground">
                {sub.paused?.resumes_at
                  ? `Paused. Your subscription resumes on ${fmtDate(sub.paused.resumes_at, tz)}. No payments until then.`
                  : "Paused. No payments while it is paused."}
              </div>
            ) : (
              <div className="text-sm text-muted-foreground">
                This plan will not renew
                {sub.cancels_at
                  ? `. It ends on ${fmtDate(sub.cancels_at, tz)}.`
                  : sub.current_period_end
                    ? `. It ends on ${fmtDate(sub.current_period_end, tz)}.`
                    : "."}
              </div>
            )}
          </div>

          {shippingAddresses ? (
            <PortalShipTo
              subscription={sub.id}
              shipTo={sub.shipping_address ?? null}
              shipToId={sub.shipping_address_id ?? null}
              addresses={shippingAddresses}
              changeable={sub.status !== "cancelled"}
            />
          ) : null}

          {/* 0238 — only when the merchant allows customer coupon entry, and only on a
              subscription that will actually be billed again: a discount on a plan that
              will not renew changes nothing, so the box would take a code and appear to
              do nothing with it. The question shows while the buyer has codes left
              (`coupon_codes_left`, 0495); at 0 it renders the live discount and its Remove. */}
          {allowCoupons && sub.next_payment ? (
            <PortalCouponBox
              subscription={sub.id}
              discount={sub.discount}
              codesLeft={sub.coupon_codes_left ?? (sub.discount ? 0 : 1)}
              /* The estimate above already itemises the discount by name ("includes
                 TMRSMARTCOACH"), so repeating the code below it printed it twice on one
                 card. When it is named there the box carries the action alone. A
                 consumed `once` discount has no line in the NEXT estimate, and then the
                 box is the only thing that names it — hence the check rather than
                 dropping the name outright. */
              namedAbove={(sub.next_payment.discount_lines ?? []).some((d) =>
                sub.discount?.coupon
                  ? d.label.toLowerCase().includes(sub.discount.coupon.toLowerCase())
                  : false,
              )}
            />
          ) : null}

          {/* Plan, seats and add-ons (Phase 2), and a change already scheduled. */}
          {sub.plan_change ? (
            <PortalChangePlan
              subscription={sub.id}
              allowed={sub.plan_change.allowed}
              scheduled={sub.plan_change.scheduled}
              tz={tz}
            />
          ) : null}

          {/* Only when the business offers skipping AND this subscription can skip. */}
          {sub.skip_renewal && sub.skip_renewal.upcoming.length > 0 ? (
            <PortalSkipRenewal
              subscription={sub.id}
              limitPerYear={sub.skip_renewal.limit_per_year}
              renewals={sub.skip_renewal.upcoming.map((u) => ({
                ...u,
                label: fmtDate(u.renewal_at, tz),
              }))}
            />
          ) : null}

          {/* Cancel, pause, resume, keep: only the ones the business offers in this state. */}
          {sub.actions ? (
            <PortalLifecycle
              subscription={sub.id}
              actions={sub.actions}
              periodEndLabel={
                sub.cancels_at
                  ? fmtDate(sub.cancels_at, tz)
                  : sub.current_period_end
                    ? fmtDate(sub.current_period_end, tz)
                    : null
              }
              resumeStartsNewPeriod={
                sub.status === "paused" &&
                sub.current_period_end != null &&
                Date.parse(sub.current_period_end) <= Date.now()
              }
            />
          ) : null}

          {/* The auto-debit on file cannot carry that next payment. This is the "unless
              necessary" case — a real break rather than a nudge — and it costs nothing to
              detect, because the estimate above already answered it. */}
          {sub.mandate_shortfall ? (
            <div className="border-t px-5 py-4">
              <Alert tone="warning" title="Your auto-debit limit is too low for this plan">
                <p>
                  Your bank approved automatic payments of up to{" "}
                  <span className="font-medium tabular-nums">
                    {money(sub.mandate_shortfall.ceiling_minor, sub.mandate_shortfall.currency)}
                  </span>{" "}
                  per charge. This plan&apos;s next payment is{" "}
                  <span className="font-medium tabular-nums">
                    {money(sub.mandate_shortfall.amount_minor, sub.mandate_shortfall.currency)}
                  </span>
                  . Your bank would decline it.
                </p>
                <p className="mt-2">
                  {/* Named and clickable, never "below": payment methods is a separate
                      column on a desktop and a separate tab on a phone. */}
                  Authorize a new payment method in{" "}
                  <PortalSectionLink section="methods">Payment methods</PortalSectionLink> to
                  approve the new amount
                  {/* ONLY WHEN THAT RAIL IS ON OFFER. "choosing Bank account (Netbanking
                      e-Mandate)" names an option in the Payment methods pane by its exact
                      label — so on a gateway whose `method_types` lack `bank_transfer` it
                      sends the buyer to pick something that is not there. Same defect as
                      checkout's version of this sentence, fixed 2026-09-15. The rest of
                      the alert still stands: re-authorising is the fix either way. */}
                  {sub.mandate_shortfall.needs_authentication_even_if_raised &&
                  offeredRails.includes("bank_transfer")
                    ? ". If you select Bank account (Netbanking e-Mandate), you also do not have to approve each payment"
                    : ""}
                  .
                </p>
              </Alert>
            </div>
          ) : null}
        </StorefrontSection>
      ))}
    </>
  );
}

export function BalanceCard({
  me,
  invoices,
  methods,
  /**
   * The name the PAGE HEADER is already showing (`accountHolderName`). Passed in so the
   * strip below can tell whether its "Billed to" adds anything — see `showBilledTo`.
   */
  holder,
}: {
  me: PortalMe;
  invoices: PortalInvoice[];
  methods: PortalPaymentMethod[];
  holder: string | null;
}) {
  const due = summarizeDue(invoices);
  const inFlight = summarizeInFlight(invoices);
  const inFlightCount = inFlight.reduce((n, d) => n + d.count, 0);
  const inFlightText = `${inFlightCount} payment${inFlightCount === 1 ? "" : "s"} in progress`;
  const defaultMethod = methods.find((m) => m.is_default) ?? null;
  const openCount = due.reduce((n, d) => n + d.count, 0);
  // Most recent settled invoice, for the "all paid up" reassurance line.
  // A payment that actually MOVED money: a zero-value invoice settles itself, and
  // "Last payment ₹0.00 on 07-Sept-2026" is the same defect as the zero next payment
  // in `SetupCard` — a figure that makes the card look broken.
  const lastPaid = invoices
    .filter((i) => i.paid_at && i.amount_paid_minor > 0)
    .sort((a, b) => (a.paid_at! < b.paid_at! ? 1 : -1))[0];
  const earliest = due.reduce<string | null>(
    (acc, d) => (d.earliest && (acc === null || d.earliest < acc) ? d.earliest : acc),
    null,
  );
  const overdue = due.some((d) => d.overdue);
  const address = addressLines(me.customer.address);
  const billedTo = invoiceContactName(me.customer);
  /* The mandate blocker, if there is one — see `mandateBlocker` for why the portal has
     to say this out loud: both refusals park permanently and nothing else asks the
     payer. It sits in the statement card rather than beside the instrument because the
     fact it explains is the BALANCE ("why has this not been collected"), and a payer
     looking at an unpaid invoice does not scroll to a card row to find out. */
  const blocker = mandateBlocker(methods, invoices);
  /** No history at all, as opposed to a history that is settled — see the tick below. */
  const neverBilled = invoices.length === 0;
  /*
    THE STRIP HAS TO SAY SOMETHING THE PAGE DOES NOT ALREADY SAY.

    Its two fields have different claims to the space. The primary payment method is
    named nowhere else on the page, so it always earns its place. "Billed to" only does
    when the invoice identity DIFFERS from the account holder — the case the header's own
    note is about (a buyer whose invoices go to their finance team). When they are the
    same string, the strip repeated the header verbatim, and a third copy sat one click
    away in Billing details, which renders it with the full address and owns editing it.
    On the reported screen all three said `Pat Payer / trial@a.com`.

    With neither, the whole bar goes: an orphaned half-width field in a full-width grey
    band reads as something that failed to load.
  */
  const showBilledTo = billedTo != null && billedTo !== holder;
  const showMeta = showBilledTo || defaultMethod != null;

  return (
    <Card className="gap-0 overflow-hidden py-0">
      <div className="px-5 py-5 sm:px-6">
        {due.length === 0 && inFlightCount > 0 ? (
          // Not "Everything is paid": it is not paid until the bank confirms it.
          <div className="flex items-start gap-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
              <Clock className="size-5" />
            </span>
            <div className="min-w-0">
              <div className="text-base font-semibold tracking-tight">Payment in progress</div>
              <p className="mt-0.5 text-sm text-muted-foreground">
                Your bank is still confirming{" "}
                <span className="font-medium tabular-nums">
                  {inFlight.map((d) => money(d.minor, d.currency)).join(" and ")}
                </span>
                . You do not have to do anything.
              </p>
            </div>
          </div>
        ) : due.length === 0 ? (
          <div className="flex items-start gap-3">
            {/* NEVER BILLED IS NOT AN ACHIEVEMENT. `due.length === 0` covers two very
                different accounts — one that has paid everything, and one that has no
                history at all — and the second was getting a green tick and "You're all
                paid up" over an empty ledger, with no last-payment line to back it up.
                Terminal-and-fine states render neutral; the success tone is kept for the
                buyer who actually settled something. */}
            <span
              className={
                neverBilled
                  ? "flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground"
                  : "flex size-9 shrink-0 items-center justify-center rounded-full bg-success-soft text-success"
              }
            >
              <CheckCircle2 className="size-5" />
            </span>
            <div className="min-w-0">
              <div className="text-base font-semibold tracking-tight">
                {neverBilled ? "Nothing due" : "Everything is paid"}
              </div>
              <p className="mt-0.5 text-sm text-muted-foreground">
                {/* Says nothing about INVOICES: the empty state in the card directly
                    below is already "No invoices yet", and the first version of this
                    branch headlined the same three words — one fact, stated twice,
                    twelve pixels apart. This one is about the BALANCE, which is what
                    the card is for. */}
                {neverBilled ? (
                  "You have no balance due."
                ) : (
                  <>
                    No balance due.
                    {lastPaid
                      ? ` Last payment ${money(lastPaid.amount_paid_minor, lastPaid.currency)} on ${fmtDate(lastPaid.paid_at, me.business.timezone)}.`
                      : ""}
                  </>
                )}
              </p>
            </div>
          </div>
        ) : (
          <div>
            <div className="text-xs font-medium tracking-widest text-muted-foreground uppercase">
              Amount due
            </div>
            {due.length === 1 ? (
              <div className="mt-1.5 text-3xl font-semibold tracking-tight tabular-nums">
                {money(due[0].minor, due[0].currency)}
              </div>
            ) : (
              <div className="mt-1.5 flex flex-col gap-1">
                {due.map((d) => (
                  <div
                    key={d.currency}
                    className="text-xl font-semibold tracking-tight tabular-nums"
                  >
                    {money(d.minor, d.currency)}
                  </div>
                ))}
              </div>
            )}
            <p className="mt-1.5 text-sm text-muted-foreground">
              {openCount} open invoice{openCount === 1 ? "" : "s"}
              {inFlightCount > 0 ? ` · ${inFlightText}` : ""}
              {earliest ? (
                overdue ? (
                  <>
                    {" · "}
                    <span className="font-medium text-warning">
                      Overdue since {fmtDate(earliest, me.business.timezone)}
                    </span>
                  </>
                ) : (
                  ` · due ${fmtDate(earliest, me.business.timezone)}`
                )
              ) : (
                ""
              )}
            </p>
          </div>
        )}
      </div>
      {blocker ? (
        <div className="border-t px-5 pt-4 pb-5 sm:px-6">
          {/* `warning`, not `error`: nothing is broken and nobody was refused — the
              authorisation is simply too small or too old to carry this bill, and the
              payer can clear it in a minute. `error` is for a failure they cannot act on. */}
          <Alert tone="warning" title="We cannot collect this balance automatically">
            <p>
              {blocker.reason === "expired" ? (
                <>
                  The auto-debit authorization on{" "}
                  <span className="font-medium">{methodLabel(blocker.method)}</span>
                  {blocker.expiresAt ? (
                    <> expired on {fmtDate(blocker.expiresAt, me.business.timezone)}</>
                  ) : (
                    <> is expired</>
                  )}
                  . We cannot charge it now. This includes the{" "}
                  {money(blocker.amountMinor, blocker.currency)} that is due.
                </>
              ) : (
                <>
                  Your {money(blocker.amountMinor, blocker.currency)} balance is more than the{" "}
                  {money(
                    blocker.ceilingMinor ?? 0,
                    blocker.method.mandate?.currency ?? blocker.currency,
                  )}{" "}
                  per-charge limit approved for{" "}
                  <span className="font-medium">{methodLabel(blocker.method)}</span>. You agreed
                  this limit with your bank when you gave the authorization. You cannot increase the
                  limit on the existing authorization.
                </>
              )}
            </p>
            {/* Says what re-authorising BUYS, and that retrying does not. The engine sizes
                the fresh mandate from the customer's current subscriptions, so this is a
                true promise rather than an encouragement — see `mandateBlocker`. */}
            <p className="mt-2">
              Authorize a payment method again in{" "}
              <PortalSectionLink section="methods">Payment methods</PortalSectionLink>. The new
              authorization covers your current plan. We collect this balance when the new
              authorization is active. Until then, we do not retry automatically because the retries
              cannot succeed.
            </p>
          </Alert>
        </div>
      ) : null}
      {showMeta ? (
        <div className="grid gap-4 border-t bg-muted/40 px-5 py-4 sm:grid-cols-2 sm:px-6">
          {/* Identity only, NOT the full address. This strip is a summary of what the
            sections below manage — its sibling names the primary payment method
            without reprinting the card's details, and the address follows the same
            rule now that "Billing details" renders it in full and owns editing it.
            Printing the same six-line address twice on one short page is how a
            screen teaches people to stop reading it. */}
          {/* "Billed to" means the invoice identity, so it resolves through the same
            chain the document does — the billing contact first. That makes it agree
            with the identical line in "Billing details" below and with the PDF; it is
            deliberately NOT the account-holder name used in the page header. */}
          {showBilledTo ? (
            <MetaField label="Billed to">
              <div className="truncate font-medium">{billedTo ?? me.customer.email ?? "—"}</div>
              {/* `invoiceContactName` FALLS BACK TO THE EMAIL (lib/names.ts), so on a customer
              with no name on file the resolved "name" IS the email — and a bare
              `billedTo && email` guard is satisfied by the same string, printing it
              twice, once at 14px and once at 12px grey. The sub-line only earns its
              place when it says something the line above does not. */}
              {billedTo && me.customer.email && billedTo !== me.customer.email ? (
                <div className="truncate text-xs text-muted-foreground">{me.customer.email}</div>
              ) : null}
              {address.length === 0 ? (
                <div className="mt-0.5 text-xs text-muted-foreground">
                  No billing address on file
                </div>
              ) : null}
            </MetaField>
          ) : null}
          {/* "Primary", matching the chip on the row below and the operator dashboard.
            One word for one role across both surfaces (2026-09-14). */}
          {/* Only when there IS one. "None on file" was a grey meta line stating the
            single most consequential fact on the page — nothing can be collected —
            in the quietest type on it, while `SetupCard` above now says it with the
            consequence and the button attached. Two statements of one fact teach the
            buyer to read neither, and the weaker one was winning the position. */}
          {defaultMethod ? (
            <MetaField label="Primary payment method">
              {defaultMethod ? (
                /* The same tile the saved rows below wear, so the instrument named up here in
               the statement and the row that manages it are recognisably one thing. */
                <div className="flex items-center gap-2.5">
                  <MethodGlyph pm={defaultMethod} />
                  <div className="flex min-w-0 items-baseline gap-2">
                    <span className="truncate font-medium">{methodLabel(defaultMethod)}</span>
                    {defaultMethod.exp_month && defaultMethod.exp_year ? (
                      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                        {String(defaultMethod.exp_month).padStart(2, "0")}/{defaultMethod.exp_year}
                      </span>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </MetaField>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}

/** One step of the setup sequence — number, what it is, and (on the live one) the control. */
function SetupStep({
  n,
  active,
  label,
  children,
}: {
  n: number;
  active: boolean;
  label: string;
  children?: React.ReactNode;
}) {
  return (
    /* STACKED below `sm`, and `flex-wrap` was not enough on its own: it kept the label
       and the control on one line and let the LABEL wrap instead. Measured at 360px the
       label had ~87px beside a 151px button and ran to three lines, turning a 36px row
       into 68–84px. The number stays inline with the label it numbers; the control drops
       to its own line. */
    <li className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-3">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <span
          aria-hidden
          className={
            active
              ? "flex size-6 shrink-0 items-center justify-center rounded-full bg-foreground text-xs font-medium text-background"
              : "flex size-6 shrink-0 items-center justify-center rounded-full border bg-muted text-xs font-medium text-muted-foreground"
          }
        >
          {n}
        </span>
        <span className={active ? "text-sm font-medium" : "text-sm text-muted-foreground"}>
          {label}
        </span>
      </div>
      {/* INDENTED TO THE LABEL'S AXIS when stacked (`pl-9` = the 24px number + its 12px
          gap), and left to size itself. As a bare flex-column item the control stretched
          to the card's full width — which made step 1's button read as the CARD's footer
          action rather than as that step's control — and step 2's caption sat at the
          card's left edge under the NUMBER, reading as a stray line rather than as part
          of the step. Both are the same missing indent. */}
      {children ? <div className="pl-9 sm:pl-0">{children}</div> : null}
    </li>
  );
}

/**
 * WHAT THE BUYER STILL HAS TO DO — the two things a portal exists for, hoisted out of
 * the tabs and into the one region both layouts always show.
 *
 * The facts were all on the page already and none of them were connected. A customer in
 * trial with nothing on file read a green "You're all paid up" tick, a grey "None on
 * file" meta line, and a renewal date in the other column — three statements, three
 * places, no consequence drawn between them. Nothing told her the renewal would simply
 * fail. Worse, the one control that fixed it was two clicks away behind a tab, and the
 * tab opened on a REFUSAL (`add-card.tsx` gated on the billing address) rather than a
 * form, so the page's primary job was a dead end from its own landing state.
 *
 * So this states the consequence in the buyer's own numbers — the balance we cannot
 * collect, or the trial date and the amount due at it — and carries the button. It sits
 * in `portal-pinned`, above the balance: an account that cannot be charged outranks a
 * statement of what it owes, and on a narrow screen the pinned region is the only thing
 * guaranteed to be on screen before the section filter.
 *
 * ⚠️ IT RENDERS NOTHING WHEN THERE IS NOTHING TO DO. A permanent "all set" card is a
 * banner people learn to skip, which is exactly what costs this one its urgency the day
 * something IS wrong.
 *
 * The two-step form is shown only when BOTH are missing, and step 2 deliberately carries
 * neither a control nor a caption: billing details are a hard precondition for vaulting an
 * instrument, so a button there would land on the same refusal this card exists to remove
 * — and the number plus the muted row already say it comes second, so explaining the
 * absence in words was the layout restated as prose.
 */
export function SetupCard({
  me,
  methods,
  invoices,
  subs,
  tz,
}: {
  me: PortalMe;
  methods: PortalPaymentMethod[];
  invoices: PortalInvoice[];
  subs: PortalSubscription[];
  tz?: string | null;
}) {
  const needsDetails = !me.customer.billing_details_complete;
  // Only when a saved method would collect something: a subscription that has not ended, or
  // money owed. A one-time buyer with nothing due has no reason to save one.
  const needsMethod =
    methods.length === 0 &&
    (subs.some((s) => s.status !== "cancelled") || summarizeDue(invoices).length > 0);
  if (!needsDetails && !needsMethod) return null;

  /* The consequence, in this buyer's own figures. Every branch reads data already
     fetched for the panes — an unpaid balance, or the renewal estimate the plan card
     renders — so nothing here is a guess and nothing costs an extra round trip. */
  const due = summarizeDue(invoices);
  const owed = due[0] ?? null;
  /*
    A next payment of ZERO is not a reason to add a card. Reported from the live portal
    2026-09-15: "Your next payment of ₹0.00 is due 07-Nov-2026. Without a saved payment
    method it will not be collected automatically" — an amount there is nothing to
    collect, an urgency that does not exist, and a figure that makes the card look
    broken. A fully-discounted or zero-rated plan is a real state
    (`hide_zero_value_lines` exists for it), so this falls through to the generic line
    rather than inventing urgency.
  */
  const sub = subs.find((s) => (s.next_payment?.total_minor ?? 0) > 0) ?? null;
  const next = sub?.next_payment ?? null;

  let title: string;
  let consequence: string;
  if (!needsMethod) {
    title = "Add your billing address";
    consequence =
      "We print this name and address on your invoices. They also set the tax on your invoices.";
  } else {
    title = needsDetails ? "Complete your billing setup" : "Add a payment method";
    consequence = owed
      ? `We cannot collect the ${money(owed.minor, owed.currency)} due on this account until you save a payment method.`
      : next && next.at && sub?.status === "in_trial"
        ? `Your trial ends ${fmtDate(next.at, tz)}. Then ${money(next.total_minor, next.currency)} is due. If you do not save a payment method, we cannot collect it and your subscription will not renew.`
        : next && next.at
          ? `Your next payment of ${money(next.total_minor, next.currency)} is due ${fmtDate(next.at, tz)}. If you do not save a payment method, we cannot collect it automatically.`
          : "We cannot collect invoice payments automatically until you save a payment method.";
  }

  return (
    <Card className="gap-0 overflow-hidden py-0">
      <div className="flex items-start gap-3 px-5 py-5 sm:px-6">
        <span
          aria-hidden
          className="flex size-9 shrink-0 items-center justify-center rounded-full bg-warning-soft text-warning"
        >
          <TriangleAlert className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold tracking-tight">{title}</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">{consequence}</p>

          {needsDetails && needsMethod ? (
            <ol className="mt-4 flex flex-col gap-3">
              <SetupStep n={1} active label="Your name and billing address">
                <PortalSectionButton section="details">Add billing details</PortalSectionButton>
              </SetupStep>
              {/* No caption. It read "Once your address is saved", which is what the
                  numbering and the muted row already say — prose restating the layout.
                  Step 2 still carries no CONTROL, for the reason in the docblock above. */}
              <SetupStep n={2} active={false} label="A payment method" />
            </ol>
          ) : (
            <div className="mt-4">
              <PortalSectionButton section={needsDetails ? "details" : "methods"}>
                {needsDetails ? "Add billing details" : "Add a payment method"}
              </PortalSectionButton>
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}
