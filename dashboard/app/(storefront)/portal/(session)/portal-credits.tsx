import { money } from "@/lib/format";
import { fmtDate } from "@/lib/format-date";
import { packCreditLabel } from "@/lib/credits";
import type { PortalCredits } from "@/lib/portal-api";
import {
  autoTopupLines,
  creditRows,
  historyAmount,
  historyLabel,
  unitPartLines,
} from "@/lib/portal-credits-view";
import { Row, RowList, StorefrontSection } from "../../chrome";
import { BuyCreditsForm } from "./buy-credits";
import { AutoTopupSwitch } from "./portal-auto-topup";

const units = (amount: number, decimals: number, name: string, plural: string) => {
  const n = amount / 10 ** decimals;
  return `${n.toLocaleString("en-US", { maximumFractionDigits: decimals })} ${Math.abs(n) === 1 ? name : plural}`;
};

/**
 * The buyer's credit: what is available, each grant with its expiry, the last movements,
 * and the business's credit packs. Renders nothing for a business without credits.
 */
export function PortalCreditsSection({
  credits,
  tz,
}: {
  credits: PortalCredits;
  tz: string | null;
}) {
  const limits = credits.top_up_limits;
  // A zero balance with nothing to buy or spend says nothing: hide it.
  const hasCredit =
    credits.balances.some(
      (b) => b.available_minor > 0 || b.units.some((u) => u.available_amount > 0),
    ) || credits.grants.length > 0;
  const showBalance = hasCredit || credits.packs.length > 0;
  return (
    <>
      {showBalance ? (
        <StorefrontSection
          title="Credits"
          description="Credit pays for your usage before we charge you."
          bodyClassName="p-0"
        >
          {credits.balances.length === 0 ? (
            <p className="m-0 px-5 py-4 text-sm text-muted-foreground">You have no credit.</p>
          ) : (
            <RowList>
              {creditRows(credits).map((row) => {
                if (row.kind === "money") {
                  const b = row.balance;
                  return (
                    <Row key={b.currency} className="flex-row items-center gap-3">
                      <div className="flex min-w-0 flex-1 items-center gap-3">
                        <div className="min-w-0">
                          <div className="text-sm font-medium">Available in {b.currency}</div>
                          {b.units
                            .filter((u) => u.unit && u.rated !== false)
                            .map((u) => (
                              <div key={u.unit} className="mt-0.5 text-xs text-muted-foreground">
                                {units(u.available_amount, u.decimals, u.name, u.plural_name)}
                              </div>
                            ))}
                        </div>
                      </div>
                      <div className="shrink-0 text-right text-sm font-semibold tabular-nums">
                        {money(b.available_minor, b.currency)}
                      </div>
                    </Row>
                  );
                }
                // Credit with no money value: its own row, followed by its own grants.
                if (row.kind === "unit") {
                  const u = row.unit;
                  return (
                    <Row
                      key={`${row.balance.currency}:${u.unit}`}
                      className="flex-row items-center gap-3"
                    >
                      <div className="flex min-w-0 flex-1 items-center gap-3">
                        <div className="min-w-0">
                          <div className="text-sm font-medium">Available {u.plural_name}</div>
                          {unitPartLines(u).map((line) => (
                            <div key={line} className="mt-0.5 text-xs text-muted-foreground">
                              {line}
                            </div>
                          ))}
                        </div>
                      </div>
                      <div className="shrink-0 text-right text-sm font-semibold tabular-nums">
                        {units(u.available_amount, u.decimals, u.name, u.plural_name)}
                      </div>
                    </Row>
                  );
                }
                const g = row.grant;
                return (
                  <Row key={g.id} className="flex-row items-center gap-3">
                    <div className="min-w-0 flex-1 pl-12 text-sm">
                      {g.unit
                        ? units(g.remaining_amount, g.decimals, g.unit_name, g.unit_plural_name)
                        : money(g.remaining_face_minor, g.currency)}
                      <span className="text-muted-foreground">
                        {" "}
                        · {g.category === "paid" ? "Bought" : "Given to you"}
                      </span>
                    </div>
                    <div className="text-right text-xs text-muted-foreground sm:min-w-28">
                      {g.renews_at
                        ? `Renews ${fmtDate(g.renews_at, tz)}`
                        : g.expires_at
                          ? `Expires ${fmtDate(g.expires_at, tz)}`
                          : "No expiry"}
                    </div>
                  </Row>
                );
              })}
            </RowList>
          )}
        </StorefrontSection>
      ) : null}

      {(credits.auto_topups ?? []).length > 0 ? (
        <StorefrontSection
          title="Automatic top-up"
          description="We buy credit for you automatically and charge your payment method. Each top-up below shows when we buy."
          bodyClassName="p-0"
        >
          <RowList>
            {(credits.auto_topups ?? []).map((t) => {
              const lines = autoTopupLines(t);
              return (
                // Stacks on a phone; beside the button, the text keeps a real basis and the
                // button wraps under it where the column is narrow.
                <Row key={t.unit} className="items-start sm:flex-wrap sm:items-center">
                  <div className="flex w-full min-w-0 items-center gap-3 sm:w-auto sm:flex-[1_1_14rem]">
                    <div className="min-w-0">
                      <div className="text-sm font-medium">{lines.title}</div>
                      <div className="mt-0.5 text-xs text-muted-foreground">{lines.detail}</div>
                      {lines.problem ? (
                        <div className="mt-0.5 text-xs text-destructive">{lines.problem}</div>
                      ) : null}
                    </div>
                  </div>
                  <AutoTopupSwitch unit={t.unit} enabled={t.status === "active"} />
                </Row>
              );
            })}
          </RowList>
        </StorefrontSection>
      ) : null}

      {credits.packs.length > 0 ? (
        <StorefrontSection
          title="Buy credits"
          description="Select a credit pack. We add the credit when you pay."
          bodyClassName="p-0"
        >
          <RowList>
            {credits.packs.map((p) => {
              const l = limits[p.currency];
              return (
                <Row key={p.price}>
                  {/* Titled by what tells packs apart: the credit and the price. Packs of one
                      product share its name. */}
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium tabular-nums">
                      {packCreditLabel(p)} for {money(p.amount_minor, p.currency)}
                    </div>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      {p.name}
                      {l && (l.min_minor != null || l.max_minor != null)
                        ? ` · Each purchase must be ${[
                            l.min_minor != null
                              ? `at least ${money(l.min_minor, p.currency)}`
                              : null,
                            l.max_minor != null
                              ? `at most ${money(l.max_minor, p.currency)}`
                              : null,
                          ]
                            .filter(Boolean)
                            .join(" and ")}`
                        : ""}
                    </div>
                  </div>
                  <BuyCreditsForm
                    price={p.price}
                    label={`${packCreditLabel(p)} for ${money(p.amount_minor, p.currency)}`}
                    amountMinor={p.amount_minor}
                    currency={p.currency}
                    allowCoupon={credits.allow_coupons === true}
                  />
                </Row>
              );
            })}
          </RowList>
        </StorefrontSection>
      ) : null}

      {credits.transactions.length > 0 ? (
        <StorefrontSection title="Credit history" bodyClassName="p-0">
          <div
            className={
              credits.transactions.length > 8 ? "max-h-[28rem] overflow-y-auto" : undefined
            }
          >
            <RowList>
              {credits.transactions.map((t) => (
                <Row key={t.id} className="flex-row items-center gap-3">
                  <div className="min-w-0 flex-1 text-sm">
                    {historyLabel(t)}
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      {fmtDate(t.created_at, tz)}
                      {t.invoice_number ? ` · ${t.invoice_number}` : ""}
                    </div>
                  </div>
                  <div className="text-right text-sm tabular-nums sm:min-w-28">
                    {historyAmount(t)}
                  </div>
                </Row>
              ))}
            </RowList>
          </div>
        </StorefrontSection>
      ) : null}
    </>
  );
}
