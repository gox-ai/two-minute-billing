import type * as React from "react";
import { creditAmount, type CurrentUsage } from "@/lib/api/current-usage";
import { money } from "@/lib/format";
import { fmtDate, fmtDateTime, fmtRange } from "@/lib/format-date";
import { formatDecimalQuantity } from "@/lib/meters";
import { PRICE_SOURCE_LABEL } from "@/lib/model-prices";

/**
 * Name column flexes; the five numeric columns stay aligned. Below 640px a row is a block,
 * as `<Table phone="stack">` draws one: the name with the amount opposite, then each other
 * value under it with its column head as a 12px label.
 */
const COLS =
  "grid grid-cols-[minmax(0,1fr)_5rem_5rem_7rem_6rem_8rem] items-start gap-x-4 tabular-nums max-sm:grid-cols-[fit-content(40%)_minmax(0,1fr)_auto] max-sm:items-baseline max-sm:gap-x-3 max-sm:gap-y-1";
/** The name and its sub-line: the first line of a stacked row. */
const TITLE = "min-w-0 max-sm:col-[1/3] max-sm:row-start-1";
/** The column heads, which label the values of a stacked row. */
const HEAD = {
  units: "Units",
  free: "Free units",
  amount: "Amount",
  projectedUnits: "Projected units",
  projectedAmount: "Projected amount (estimate)",
} as const;

const units = (n: number | null | undefined) => (n == null ? "—" : n.toLocaleString("en-US"));

const BILLED_BY: Record<string, string> = {
  renewal: "The renewal invoice bills this usage.",
  pending_invoice: "The pending invoice bills this usage when it closes.",
  term_end_invoice: "The final invoice at term end bills this usage.",
};

/**
 * Usage so far in the window the next invoice bills, from `current_usage`. The amounts are
 * the invoice's own rating; discounts and credits are not applied.
 */
export function CurrentUsageCard({ usage, tz }: { usage: CurrentUsage; tz?: string | null }) {
  const c = usage.currency;
  const p = usage.projection;
  const credit = usage.credit_usage ?? [];
  const unpriced = Array.from(new Set(usage.items.flatMap((i) => i.unpriced_models ?? [])));
  return (
    <div className="flex flex-col gap-3 text-sm">
      {usage.window ? (
        <p className="text-muted-foreground">
          {fmtRange(usage.window.start, usage.window.end, tz)}. {BILLED_BY[usage.window.billed_by]}
          {usage.window.invoice ? ` (${usage.window.invoice})` : ""} Read at{" "}
          {fmtDateTime(usage.as_of, tz)}.
        </p>
      ) : null}

      {usage.items.length > 0 || usage.settled_charges.length > 0 || credit.length > 0 ? (
        <div className="sm:overflow-x-auto">
          <div className="sm:min-w-[40rem]">
            <div
              className={`${COLS} border-b py-2 text-xs font-medium text-muted-foreground max-sm:hidden`}
            >
              <span>Item</span>
              <span className="text-right">{HEAD.units}</span>
              <span className="text-right">{HEAD.free}</span>
              <span className="text-right">{HEAD.amount}</span>
              <span className="text-right">{HEAD.projectedUnits}</span>
              <span className="text-right">{HEAD.projectedAmount}</span>
            </div>
            {usage.items.map((i) => (
              <div key={i.item ?? i.name} className={`${COLS} border-b border-border/40 py-3`}>
                <div className={TITLE}>
                  <div className="truncate font-medium">{i.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {i.price} · {i.aggregation}
                    {i.minimum_amount_minor != null
                      ? ` · minimum ${money(i.minimum_amount_minor, c)}`
                      : ""}
                  </div>
                </div>
                <Value label={HEAD.units}>{units(i.quantity)}</Value>
                <Value label={HEAD.free}>{units(i.free_quantity)}</Value>
                <Value aside>{money(i.amount_minor, c)}</Value>
                <Value label={HEAD.projectedUnits}>{units(i.projected_quantity)}</Value>
                <Value label={HEAD.projectedAmount}>
                  {i.projected_amount_minor == null
                    ? "—"
                    : money(i.projected_amount_minor + (i.projected_minimum_true_up_minor ?? 0), c)}
                </Value>
              </div>
            ))}
            {usage.items
              .filter((i) => i.combinations?.length)
              .map((i) => (
                <div key={`combos-${i.item ?? i.name}`} className="border-b border-border/40 pb-2">
                  <div className="pt-2 pb-1 text-xs text-muted-foreground">
                    {i.name}, by group value
                  </div>
                  {i.combinations!.map((cb, k) => (
                    <div key={k} className={`${COLS} py-1.5`}>
                      <div className={`${TITLE} pl-3`}>
                        <div className="truncate font-mono text-xs">
                          {Object.values(cb.group).join(" · ") || "All usage"}
                        </div>
                        {cb.price_source && cb.price_source !== "model_price_list" ? (
                          <div className="text-xs text-muted-foreground">
                            {PRICE_SOURCE_LABEL[cb.price_source] ?? cb.price_source}
                          </div>
                        ) : null}
                      </div>
                      <Value label={HEAD.units}>{formatDecimalQuantity(cb.quantity)}</Value>
                      <Value placeholder>—</Value>
                      <Value aside>{money(cb.amount_minor, c)}</Value>
                      <Value label={HEAD.projectedUnits}>
                        {cb.projected_quantity == null
                          ? "—"
                          : formatDecimalQuantity(cb.projected_quantity)}
                      </Value>
                      <Value label={HEAD.projectedAmount}>
                        {cb.projected_amount_minor == null
                          ? "—"
                          : money(cb.projected_amount_minor, c)}
                      </Value>
                    </div>
                  ))}
                </div>
              ))}
            {usage.settled_charges.map((s) => (
              <div key={s.id ?? s.description} className={`${COLS} border-b border-border/40 py-3`}>
                <div className={TITLE}>
                  <div className="truncate font-medium">{s.name}</div>
                  <div className="text-xs text-muted-foreground">
                    Settled when the item stopped measuring
                    {s.period_end ? ` on ${fmtDate(s.period_end, tz)}` : ""}
                  </div>
                </div>
                <Value label={HEAD.units}>{units(s.quantity)}</Value>
                <Value placeholder>—</Value>
                <Value aside>{money(s.amount_minor, c)}</Value>
                <Value placeholder>—</Value>
                <Value label={HEAD.projectedAmount}>{money(s.amount_minor, c)}</Value>
              </div>
            ))}
            {credit.map((m) => (
              <div key={`credit-${m.meter}`} className="contents">
                {Number(m.paid_quantity) > 0 ? (
                  <div className={`${COLS} border-b border-border/40 py-3`}>
                    <div className={TITLE}>
                      <div className="truncate font-medium">{m.name}</div>
                      <div className="text-xs text-muted-foreground">
                        Paid with credits: {creditAmount(m.paid_units, m)}.
                      </div>
                    </div>
                    <Value label={HEAD.units}>{formatDecimalQuantity(m.paid_quantity)}</Value>
                    <Value placeholder>—</Value>
                    <Value aside>{money(0, c)}</Value>
                    <Value placeholder>—</Value>
                    <Value placeholder>—</Value>
                  </div>
                ) : null}
                {Number(m.below_zero_quantity ?? 0) > 0 ? (
                  <div className={`${COLS} border-b border-border/40 py-3`}>
                    <div className={TITLE}>
                      <div className="truncate font-medium">{m.name}</div>
                      <div className="text-xs text-muted-foreground">
                        Used with no credit left. Not settled yet.
                      </div>
                    </div>
                    <Value label={HEAD.units}>
                      {formatDecimalQuantity(m.below_zero_quantity!)}
                    </Value>
                    <Value placeholder>—</Value>
                    <Value aside>—</Value>
                    <Value placeholder>—</Value>
                    <Value placeholder>—</Value>
                  </div>
                ) : null}
                {m.billed.map((b, k) => (
                  <div key={k} className={`${COLS} border-b border-border/40 py-3`}>
                    <div className={TITLE}>
                      <div className="truncate font-medium">{m.name}</div>
                      <div className="text-xs text-muted-foreground">
                        Usage past the credit balance. The next invoice bills it.
                      </div>
                    </div>
                    <Value label={HEAD.units}>{formatDecimalQuantity(b.quantity)}</Value>
                    <Value placeholder>—</Value>
                    <Value aside>{money(b.amount_minor, c)}</Value>
                    <Value placeholder>—</Value>
                    <Value placeholder>—</Value>
                  </div>
                ))}
                {Number(m.overshoot_units) > 0 ? (
                  <div className={`${COLS} border-b border-border/40 py-3`}>
                    <div className={TITLE}>
                      <div className="truncate font-medium first-letter:uppercase">
                        {m.unit_plural_name}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        Negative balance: {creditAmount(m.overshoot_units, m)}. Not billed. Credits
                        that the customer buys pay it first.
                      </div>
                    </div>
                    <Value placeholder>—</Value>
                    <Value placeholder>—</Value>
                    <Value aside>—</Value>
                    <Value placeholder>—</Value>
                    <Value placeholder>—</Value>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {usage.window || credit.some((m) => m.billed_amount_minor > 0) ? (
        <dl className="ml-auto grid w-full max-w-sm grid-cols-[1fr_auto] gap-x-6 gap-y-1 tabular-nums">
          <dt className="text-muted-foreground">Subtotal so far</dt>
          <dd className="text-right">{money(usage.subtotal_minor, c)}</dd>
          {usage.tax_lines.map((t) => (
            <Pair key={t.label} label={t.label} value={money(t.amount_minor, c)} />
          ))}
          <dt className="font-medium">Total so far</dt>
          <dd className="text-right font-medium">{money(usage.total_minor, c)}</dd>
          {/* Only metered items project; credit rows count at their amount so far. */}
          {usage.items.length > 0 ? (
            <>
              <dt className="text-muted-foreground">Projected total</dt>
              <dd className="text-right text-muted-foreground">
                {p ? money(p.total_minor, c) : "—"}
              </dd>
            </>
          ) : null}
        </dl>
      ) : null}

      {usage.trial && usage.trial.items.length > 0 ? (
        <div className="rounded-md bg-muted/50 px-3 py-2">
          <div className="font-medium">
            Usage in the trial ({fmtRange(usage.trial.start, usage.trial.end, tz)})
          </div>
          <ul className="mt-1 flex flex-col gap-0.5 text-muted-foreground">
            {usage.trial.items.map((t) => (
              <li key={t.name} className="flex justify-between gap-4 tabular-nums">
                <span>{t.name}</span>
                <span>{units(t.quantity)} units</span>
              </li>
            ))}
          </ul>
          <p className="mt-1 text-xs text-muted-foreground">
            No invoice bills usage that is recorded during a trial.
          </p>
        </div>
      ) : null}

      {unpriced.length ? (
        <p className="text-xs text-muted-foreground">
          {unpriced.length === 1 ? "This model has" : "These models have"} no price, so we bill the
          default rate: {unpriced.join(", ")}.
        </p>
      ) : null}

      <p className="text-xs text-muted-foreground">
        These amounts are before discounts and account credit. Usage paid with credits costs no
        money, so its amount is {money(0, c)}.
        {usage.items.length > 0
          ? " Projected amounts are estimates: the usage at the end of the period if it continues at the current rate. Usage past the credit balance is not projected. It shows its amount so far."
          : ""}
        {usage.items.length > 0 && usage.window && !p
          ? " The projection shows after 10% of the period."
          : ""}
      </p>
    </div>
  );
}

/**
 * A right-aligned figure in the desktop grid. Below 640px: `aside` sits opposite the name,
 * a `label`led value takes a row under it, and a `placeholder` (a dash no row can fill) hides.
 */
function Value({
  label,
  aside,
  placeholder,
  children,
}: {
  label?: string;
  aside?: boolean;
  placeholder?: boolean;
  children: React.ReactNode;
}) {
  if (aside || placeholder)
    return (
      <span
        className={
          aside
            ? "text-right max-sm:col-start-3 max-sm:row-start-1 max-sm:whitespace-nowrap"
            : "text-right max-sm:hidden"
        }
      >
        {children}
      </span>
    );
  return (
    <span className="text-right max-sm:contents">
      <span className="text-xs text-muted-foreground max-sm:col-start-1 sm:hidden">{label}</span>
      <span className="max-sm:col-[2/-1] max-sm:min-w-0 max-sm:text-left">{children}</span>
    </span>
  );
}

function Pair({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right text-muted-foreground">{value}</dd>
    </>
  );
}
