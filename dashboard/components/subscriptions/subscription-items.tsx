import type { ReactNode } from "react";

import { Info, Layers } from "lucide-react";

import type { SubscriptionItem } from "@/lib/api";
import { money } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/states";

const INTERVAL_LABEL: Record<string, string> = {
  day: "daily",
  week: "weekly",
  month: "monthly",
  year: "yearly",
};

/**
 * A subscription's lines are grouped by what they are, in this order. The
 * heading is only rendered for a group that has rows, so a plan-only
 * subscription doesn't grow two empty section labels.
 */
const GROUPS = [
  { kind: "plan", label: "Plans" },
  { kind: "addon", label: "Addons" },
  { kind: "charge", label: "One-time products" },
] as const;

const KNOWN = new Set(GROUPS.map((g) => g.kind as string));

/** Name column flexes; the three numeric columns are fixed so they stay aligned. */
const COLS = "grid grid-cols-[minmax(0,1fr)_4.5rem_7rem_8rem] items-start gap-x-4";

/**
 * The subscription's line items.
 *
 * The number that matters here is `unit_price_minor`: it is the EFFECTIVE unit
 * price read from the item's frozen `price_snapshot`, not the live catalog
 * price. That distinction is the whole point of this card — a plan-scoped
 * differential add-on lists in the catalog at 0 and bills the differential, so
 * rendering the catalog price showed a real ₹475.00/mo line as ₹0.00.
 *
 * When the item departs from its list price the API sets `unit_price_overridden`
 * and returns the list price it departed from in `catalog_amount_minor`, so the
 * card can show both — the effective price, and (struck through) what it
 * replaced. Without it an operator cannot tell a genuinely-free line from an
 * overridden one.
 */
export function SubscriptionItems({
  items,
  currency,
  biz,
  taxLines,
  taxMinor,
  discountMinor,
  discount,
  itemActions,
}: {
  items: SubscriptionItem[];
  /** A control under an item's name, keyed by item id (Edit price on a model price list item). */
  itemActions?: Record<string, ReactNode>;
  currency: string;
  biz: string;
  /**
   * The NEXT RENEWAL's tax rows, from `getRenewalEstimate` — `CGST (9.00%)` +
   * `SGST (9.00%)`, or a single `IGST (18.00%)`. The label carries the rate and the value
   * carries the amount, which is why no rate has to be derived here.
   *
   * ⚠️ THESE ARE NOT "TAX ON THE AMOUNTS ABOVE", and the copy below says so. Tax in this
   * engine is not a property of a subscription item: it is computed per INVOICE from the
   * customer's place of supply against the seller state snapshotted on that invoice. The
   * rows above are contracted rates and, as their own footnote says, exclude discounts —
   * so the renewal's taxable base is frequently not their sum. Presenting these as a tax
   * line under the item amounts would invite exactly the arithmetic that does not hold.
   *
   * Undefined when the estimate call failed (the page catches it and degrades), which is
   * different from tax being zero — the two render differently below.
   */
  taxLines?: Array<{ label: string; amount_minor: number }>;
  /** The renewal's total tax, which `taxLines` sums to exactly. */
  taxMinor?: number;
  /**
   * The renewal's discount, shown so the tax figure explains itself.
   *
   * Without it a reader multiplies the item amounts by the rate on screen and gets a
   * DIFFERENT number — measured on a live subscription: the rows sum to
   * ₹33,276.00, and 18% of that is ₹5,989.68 against the ₹5,390.71 actually charged,
   * because a 10% coupon takes the taxable base to ₹29,948.40. Our user hit exactly that
   * arithmetic. The footnote alone asked them to trust it; naming the discount lets them
   * see why.
   *
   * ⚠️ NOT rendered as a subtotal → discount → tax LADDER, deliberately. `subtotal_minor`
   * follows two conventions — an ITEM-level discount is already inside it while a
   * DOCUMENT-level one is applied TO it — so a ladder built from these fields is not
   * guaranteed to add up, and a ladder that does not add up is worse than a footnote. This
   * states that a discount exists and how large it is; it claims no equation.
   */
  discountMinor?: number;
  /**
   * The subscription's ONE active discount, already worded by the caller.
   *
   * This prints inside the Items card under its own heading — `Coupons`
   * for a coupon-sourced discount, `Discounts` for a manual one — and that is the
   * right place for it: the rows above are contracted rates, the footnote under
   * them says they exclude discounts, and until now the thing being excluded was
   * only nameable from the action rail on the far side of the page.
   *
   * The engine stores at most one ACTIVE discount per subscription
   * (`loadActiveDiscount` is singular), so this is an object, not a list.
   *
   * Pre-worded, and `action` is a node, so this component neither looks a coupon
   * up in the catalog nor owns a second copy of the remove control — the page
   * passes the same `ActionButton`/`removeDiscountAction` pair the rail uses, so
   * the two can never disagree about what removing a discount does.
   */
  discount?: {
    source: "coupon" | "manual";
    /** e.g. `TMRSMARTCOACH (51.55% off, Forever)` or `$426.00 off — manual discount`. */
    label: string;
    /**
     * The coupon's catalog page. Set for a coupon, absent for a manual discount —
     * which has no catalog row to open, so it renders as plain text rather than a
     * link that would 404. The item rows above link the same way.
     */
    href?: string | null;
    /** e.g. `Applicable forever`, `3 period(s) remaining`. */
    detail?: string | null;
    /** Fixed-amount discounts only. A percentage has no money figure to state here. */
    amountMinor?: number | null;
    currency?: string | null;
    action?: ReactNode;
  } | null;
}) {
  // An unrecognised kind still has to appear — this customer is being billed for
  // it, so bucket it under "Other" rather than silently dropping the row.
  const grouped = [
    ...GROUPS.map((g) => ({
      key: g.kind as string,
      label: g.label as string,
      rows: items.filter((it) => (it.product_kind ?? "plan") === g.kind),
    })),
    {
      key: "other",
      label: "Other",
      rows: items.filter((it) => !KNOWN.has(it.product_kind ?? "plan")),
    },
  ].filter((g) => g.rows.length > 0);

  return (
    <>
      <div className="mb-1 flex items-center justify-between border-b pb-3">
        <h2 className="text-sm font-bold text-foreground">Items ({items.length})</h2>
      </div>

      {items.length === 0 ? (
        <EmptyState
          icon={<Layers />}
          title="No items"
          description="This subscription has no line items."
        />
      ) : (
        // The numeric columns must not squash the name column on a narrow
        // viewport, so the card scrolls inside itself rather than the page body.
        <div className="overflow-x-auto">
          <div className="min-w-[34rem]">
            <div className={`${COLS} border-b py-2 text-xs font-medium text-muted-foreground`}>
              <span>Item</span>
              <span className="text-right">Units</span>
              <span className="text-right">Unit price</span>
              <span className="text-right">
                Amount <Info className="inline size-3 align-[-0.1em]" />
              </span>
            </div>

            {grouped.map((g) => (
              <div key={g.key}>
                <div className="pt-4 pb-1 text-xs text-muted-foreground">{g.label}</div>
                {g.rows.map((it) => {
                  const kind = it.product_kind ?? "plan";
                  const unit = it.unit_price_minor ?? null;
                  const qty = it.quantity || 1;
                  // A plan is one of itself, so it shows "—" rather than a
                  // meaningless "1". A quantity above 1 is always meaningful.
                  const showUnits = !(kind === "plan" && qty === 1);
                  const original = it.unit_price_overridden
                    ? (it.catalog_amount_minor ?? null)
                    : null;

                  return (
                    <div
                      key={it.id ?? it.price}
                      className={`${COLS} border-b border-border/40 py-3 last:border-0`}
                    >
                      <div className="min-w-0 space-y-1">
                        <a
                          href={`/businesses/${biz}/catalog/${kind === "plan" ? "plans" : "addons"}`}
                          className="block truncate text-sm font-semibold text-primary hover:underline"
                          title={it.product_name || it.price}
                        >
                          {it.product_name || it.price}
                        </a>

                        {it.id && itemActions?.[it.id] ? <div>{itemActions[it.id]}</div> : null}
                        {it.unit_price_overridden ? (
                          <Badge variant="outline" className="tracking-wide uppercase">
                            Price override set
                          </Badge>
                        ) : null}

                        <ul className="space-y-0.5 text-xs text-muted-foreground">
                          {it.interval ? (
                            <li className="flex items-center gap-1.5">
                              <span className="inline-block size-1 rounded-full bg-muted-foreground/60" />
                              <span>Billed {INTERVAL_LABEL[it.interval] ?? it.interval}</span>
                            </li>
                          ) : null}
                          {original != null ? (
                            <li className="flex items-center gap-1.5">
                              <span className="inline-block size-1 rounded-full bg-muted-foreground/60" />
                              <span>
                                Original price <s>{money(original, currency)}</s>
                              </span>
                            </li>
                          ) : null}
                          {it.free_quantity ? (
                            <li className="flex items-center gap-1.5">
                              <span className="inline-block size-1 rounded-full bg-muted-foreground/60" />
                              <span>First {it.free_quantity} free</span>
                            </li>
                          ) : null}
                        </ul>
                      </div>

                      <div className="text-right text-sm text-foreground tabular-nums">
                        {showUnits ? qty : "—"}
                      </div>
                      <div className="text-right text-sm text-foreground tabular-nums">
                        {unit != null ? money(unit, currency) : "—"}
                      </div>
                      <div className="text-right text-sm font-semibold text-foreground tabular-nums">
                        {unit != null ? `${money(unit * qty, currency)} ` : "—"}
                        {unit != null ? (
                          <span className="text-xs font-normal text-muted-foreground">
                            {currency}
                          </span>
                        ) : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            ))}

            {/*
              The discount, under its own heading like every other group.

              Deliberately NOT a row in the numeric grid's Units/Unit price columns: a
              percentage discount has neither, and rendering "—" twice next to a coupon
              reads as missing data rather than as not-applicable. Only the Amount column
              is filled, and only when the discount IS a fixed amount.
            */}
            {discount ? (
              <div>
                <div className="pt-4 pb-1 text-xs text-muted-foreground">
                  {discount.source === "coupon" ? "Coupons" : "Discounts"}
                </div>
                <div className={`${COLS} border-b border-border/40 py-3 last:border-0`}>
                  <div className="col-span-3 min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      {discount.href ? (
                        <a
                          href={discount.href}
                          className="text-sm font-semibold text-primary hover:underline"
                        >
                          {discount.label}
                        </a>
                      ) : (
                        <span className="text-sm font-semibold text-foreground">
                          {discount.label}
                        </span>
                      )}
                      {discount.action}
                    </div>
                    {discount.detail ? (
                      <ul className="space-y-0.5 text-xs text-muted-foreground">
                        <li className="flex items-center gap-1.5">
                          <span className="inline-block size-1 rounded-full bg-muted-foreground/60" />
                          <span>{discount.detail}</span>
                        </li>
                      </ul>
                    ) : null}
                  </div>
                  <div className="text-right text-sm font-semibold text-foreground tabular-nums">
                    {discount.amountMinor != null ? (
                      <>
                        {`−${money(discount.amountMinor, discount.currency ?? currency)} `}
                        <span className="text-xs font-normal text-muted-foreground">
                          {discount.currency ?? currency}
                        </span>
                      </>
                    ) : (
                      "—"
                    )}
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      )}

      <p className="mt-3 text-xs text-muted-foreground">Amount does not include discounts.</p>

      {/*
        TAX, named as what it actually is — the next renewal's, not these rows'.

        India is a COMPONENT VECTOR, not a rate: an intra-state supply prints CGST 9% + SGST
        9% as two rows and an inter-state one prints a single IGST 18%, and each component is
        rounded on its own, so the two are not interchangeable and 18% is a lossy summary of
        either. That is why this renders the engine's `tax_lines` verbatim instead of showing
        one blended figure — the same reason the portal's next-payment block does, and the
        same distinction that produced a one-paisa credit divergence in the engine on
        2026-09-02. `tax_lines` sums exactly to `taxMinor`, so nothing here re-derives money.

        GATED ON `taxMinor`, NOT ON THE ROWS. An earlier cut gated the whole block on
        `taxLines.length > 0`, which hid the tax entirely whenever the breakdown was absent —
        the opposite of the point. A MISSING estimate (undefined) says nothing at all rather
        than implying zero; a real ZERO says so out loud, because "no tax applies" is a fact a
        merchant looking at an Indian subscription wants confirmed rather than inferred from an
        absence.
      */}
      {taxMinor != null && taxMinor > 0 ? (
        <div className="mt-3 border-t pt-3">
          <div className="mb-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            Tax on the next renewal
          </div>
          <div className="flex flex-col gap-1">
            {/*
              COMPONENTS WHEN THE ESTIMATE REPORTS THEM, THE TOTAL WHEN IT DOES NOT.
              `tax_lines` is OPTIONAL on `RenewalEstimate` (`estimateRenewal` builds it from
              `taxLinesFromRows(money.invoiceTax.rows)`, and its own doc comment hedges with
              "the engine has always returned these"), so a consumer that requires it shows
              nothing at all whenever it is absent — and hiding the tax is worse than showing
              it without a breakdown. This fallback is defensive, NOT a response to a measured
              empty case: an earlier note here claimed one, and the observation behind it was
              taken from a render of stale code, so it has been removed rather than kept.
              The single row is deliberately not labeled with a rate, because on an
              intra-state Indian supply there IS no single rate: CGST 9% + SGST 9% each round
              on their own, and calling that "18%" is the lossy summary that cost a paisa in
              the credit path this week.
            */}
            {discountMinor != null && discountMinor > 0 ? (
              <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
                <span>Discount applied before tax</span>
                <span className="tabular-nums">−{money(discountMinor, currency)}</span>
              </div>
            ) : null}
            {taxLines != null && taxLines.length > 0 ? (
              taxLines.map((t, i) => (
                <div
                  key={`${t.label}-${i}`}
                  className="flex items-center justify-between gap-3 text-xs text-muted-foreground"
                >
                  <span>{t.label}</span>
                  <span className="tabular-nums">{money(t.amount_minor, currency)}</span>
                </div>
              ))
            ) : (
              <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
                <span>Tax</span>
                <span className="tabular-nums">{money(taxMinor, currency)}</span>
              </div>
            )}
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            We charge this tax at invoicing, on the discounted base of the renewal. The amounts
            above exclude discounts, so this tax is not the rate applied to those amounts.
          </p>
        </div>
      ) : taxMinor === 0 ? (
        <p className="mt-3 text-xs text-muted-foreground">No tax applies to the next renewal.</p>
      ) : null}
    </>
  );
}
