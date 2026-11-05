import type { CurrentUsage } from "@/lib/api/current-usage";
import { fmtDate, fmtDateTime, money } from "@/lib/format";
import { formatDecimalQuantity } from "@/lib/meters";
import { PRICE_SOURCE_LABEL } from "@/lib/model-prices";

/** Name column flexes; the five numeric columns stay aligned. */
const COLS =
  "grid grid-cols-[minmax(0,1fr)_5rem_5rem_7rem_6rem_8rem] items-start gap-x-4 tabular-nums";

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
  const unpriced = Array.from(new Set(usage.items.flatMap((i) => i.unpriced_models ?? [])));
  return (
    <div className="flex flex-col gap-3 text-sm">
      {usage.window ? (
        <p className="text-muted-foreground">
          {fmtDate(usage.window.start, tz)} to {fmtDate(usage.window.end, tz)}.{" "}
          {BILLED_BY[usage.window.billed_by]}
          {usage.window.invoice ? ` (${usage.window.invoice})` : ""} Read at{" "}
          {fmtDateTime(usage.as_of, tz)}.
        </p>
      ) : null}

      {usage.items.length > 0 || usage.settled_charges.length > 0 ? (
        <div className="overflow-x-auto">
          <div className="min-w-[40rem]">
            <div className={`${COLS} border-b py-2 text-xs font-medium text-muted-foreground`}>
              <span>Item</span>
              <span className="text-right">Units</span>
              <span className="text-right">Free units</span>
              <span className="text-right">Amount</span>
              <span className="text-right">Projected units</span>
              <span className="text-right">Projected amount (estimate)</span>
            </div>
            {usage.items.map((i) => (
              <div key={i.item ?? i.name} className={`${COLS} border-b border-border/40 py-3`}>
                <div className="min-w-0">
                  <div className="truncate font-medium">{i.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {i.price} · {i.aggregation}
                    {i.minimum_amount_minor != null
                      ? ` · minimum ${money(i.minimum_amount_minor, c)}`
                      : ""}
                  </div>
                </div>
                <span className="text-right">{units(i.quantity)}</span>
                <span className="text-right">{units(i.free_quantity)}</span>
                <span className="text-right">{money(i.amount_minor, c)}</span>
                <span className="text-right">{units(i.projected_quantity)}</span>
                <span className="text-right">
                  {i.projected_amount_minor == null
                    ? "—"
                    : money(i.projected_amount_minor + (i.projected_minimum_true_up_minor ?? 0), c)}
                </span>
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
                      <div className="min-w-0 pl-3">
                        <div className="truncate font-mono text-xs">
                          {Object.values(cb.group).join(" · ") || "All usage"}
                        </div>
                        {cb.price_source && cb.price_source !== "model_price_list" ? (
                          <div className="text-xs text-muted-foreground">
                            {PRICE_SOURCE_LABEL[cb.price_source] ?? cb.price_source}
                          </div>
                        ) : null}
                      </div>
                      <span className="text-right">{formatDecimalQuantity(cb.quantity)}</span>
                      <span className="text-right">—</span>
                      <span className="text-right">{money(cb.amount_minor, c)}</span>
                      <span className="text-right">
                        {cb.projected_quantity == null
                          ? "—"
                          : formatDecimalQuantity(cb.projected_quantity)}
                      </span>
                      <span className="text-right">
                        {cb.projected_amount_minor == null
                          ? "—"
                          : money(cb.projected_amount_minor, c)}
                      </span>
                    </div>
                  ))}
                </div>
              ))}
            {usage.settled_charges.map((s) => (
              <div key={s.id ?? s.description} className={`${COLS} border-b border-border/40 py-3`}>
                <div className="min-w-0">
                  <div className="truncate font-medium">{s.name}</div>
                  <div className="text-xs text-muted-foreground">
                    Settled when the item stopped measuring
                    {s.period_end ? ` on ${fmtDate(s.period_end, tz)}` : ""}
                  </div>
                </div>
                <span className="text-right">{units(s.quantity)}</span>
                <span className="text-right">—</span>
                <span className="text-right">{money(s.amount_minor, c)}</span>
                <span className="text-right">—</span>
                <span className="text-right">{money(s.amount_minor, c)}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {usage.window ? (
        <dl className="ml-auto grid w-full max-w-sm grid-cols-[1fr_auto] gap-x-6 gap-y-1 tabular-nums">
          <dt className="text-muted-foreground">Subtotal so far</dt>
          <dd className="text-right">{money(usage.subtotal_minor, c)}</dd>
          {usage.tax_lines.map((t) => (
            <Pair key={t.label} label={t.label} value={money(t.amount_minor, c)} />
          ))}
          <dt className="font-medium">Total so far</dt>
          <dd className="text-right font-medium">{money(usage.total_minor, c)}</dd>
          <dt className="text-muted-foreground">Projected total</dt>
          <dd className="text-right text-muted-foreground">{p ? money(p.total_minor, c) : "—"}</dd>
        </dl>
      ) : null}

      {usage.trial && usage.trial.items.length > 0 ? (
        <div className="rounded-md bg-muted/50 px-3 py-2">
          <div className="font-medium">
            Usage in the trial ({fmtDate(usage.trial.start, tz)} to {fmtDate(usage.trial.end, tz)})
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
        These amounts do not include discounts or credits. Projected amounts are estimates. The
        projection rates the usage at the end of the period if it continues at the current rate.
        {usage.window && !p ? " It shows after 10% of the period." : ""}
      </p>
    </div>
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
