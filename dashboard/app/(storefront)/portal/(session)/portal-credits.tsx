import { Coins } from "lucide-react";
import { money, fmtDate } from "@/lib/format";
import { packCreditLabel } from "@/lib/credits";
import type { PortalCredits } from "@/lib/portal-api";
import { Glyph, Row, RowList, StorefrontSection } from "../../chrome";
import { BuyCreditsForm } from "./buy-credits";

const units = (amount: number, decimals: number, name: string, plural: string) => {
  const n = amount / 10 ** decimals;
  return `${n.toLocaleString("en-US", { maximumFractionDigits: decimals })} ${n === 1 ? name : plural}`;
};

const KIND: Record<string, string> = {
  grant: "Credit added",
  activate: "Credit added",
  draw: "Used on an invoice",
  expire: "Expired",
  void: "Removed",
  restore: "Returned",
  rollover_in: "Carried to this period",
  rollover_out: "Carried to the next period",
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
  return (
    <>
      <StorefrontSection
        title="Credits"
        description="Credit pays for your usage before we charge you."
        bodyClassName="p-0"
      >
        {credits.balances.length === 0 ? (
          <p className="m-0 px-5 py-4 text-sm text-muted-foreground">You have no credit.</p>
        ) : (
          <RowList>
            {credits.balances.map((b) => (
              <Row key={b.currency}>
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  <Glyph>
                    <Coins />
                  </Glyph>
                  <div className="min-w-0">
                    <div className="text-sm font-medium">Available in {b.currency}</div>
                    {b.units
                      .filter((u) => u.unit)
                      .map((u) => (
                        <div key={u.unit} className="mt-0.5 text-xs text-muted-foreground">
                          {units(u.available_amount, u.decimals, u.name, u.plural_name)}
                        </div>
                      ))}
                  </div>
                </div>
                <div className="text-right text-sm font-semibold tabular-nums sm:min-w-28">
                  {money(b.available_minor, b.currency)}
                </div>
              </Row>
            ))}
            {credits.grants.map((g) => (
              <Row key={g.id}>
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
            ))}
          </RowList>
        )}
      </StorefrontSection>

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
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium">{p.name}</div>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      {packCreditLabel(p)} for {money(p.amount_minor, p.currency)}
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
                  <BuyCreditsForm price={p.price} label={p.name} />
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
                <Row key={t.id}>
                  <div className="min-w-0 flex-1 text-sm">
                    {KIND[t.kind] ?? t.kind}
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      {fmtDate(t.created_at, tz)}
                      {t.invoice_number ? ` · ${t.invoice_number}` : ""}
                    </div>
                  </div>
                  <div className="text-right text-sm tabular-nums sm:min-w-28">
                    {money(t.face_minor, t.currency)}
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
