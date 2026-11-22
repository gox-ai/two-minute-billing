import Link from "next/link";
import { Alert } from "@/components/ui/alert";
import { RecordCard } from "@/components/patterns/record-page";
import { money } from "@/lib/format";
import { plural } from "@/lib/labels";
import type { Notification, NotificationSummary } from "@/lib/api/notifications";

/** `notification_digests.parts`, as `src/modules/notifications/digest.ts` stores it. */
interface Money {
  count: number;
  totals: Record<string, number>;
}
export interface DigestParts {
  version: 1;
  business: { id: string; name: string; timezone: string };
  period: "daily" | "weekly";
  start: string;
  end: string;
  needs_action: Array<{ kind: string; count: number; totals: Record<string, number>; url: string }>;
  figures: {
    collected: Money & { previous: Money };
    failed: Money & { previous: Money };
    refunded: Money & { previous: Money };
    recovered?: Money;
    new_subscriptions: { count: number; previous: number };
    cancelled: { count: number; previous: number; reasons: Record<string, number> };
    mrr: { change: Record<string, number>; by_reason: Record<string, Record<string, number>> };
  };
  coming_up: {
    renewals: number;
    trials_ending: number;
    invoices_due: Money;
    cards_expiring: number;
  };
  active: boolean;
}

const amounts = (totals: Record<string, number>) =>
  Object.entries(totals)
    .filter(([, v]) => v !== 0)
    .map(([cur, v]) => money(v, cur))
    .join(" · ");

/** "▲ 8% vs last Sun" — against the same weekday last week, or the week before. */
function change(now: number, before: number, period: "daily" | "weekly"): string | null {
  if (before === 0) return null;
  const pct = Math.round(((now - before) / before) * 100);
  const vs = period === "daily" ? "the same day last week" : "the week before";
  if (pct === 0) return `No change vs ${vs}`;
  return `${pct > 0 ? "▲" : "▼"} ${Math.abs(pct)}% vs ${vs}`;
}

function Figure({ label, value, note }: { label: string; value: string; note?: string | null }) {
  return (
    <div className="flex min-w-0 flex-[1_1_12rem] flex-col gap-1 bg-card px-4 py-3.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-xl font-semibold wrap-anywhere tabular-nums">{value || "—"}</span>
      {note ? <span className="text-xs text-muted-foreground">{note}</span> : null}
    </div>
  );
}

const signed = (totals: Record<string, number>) =>
  Object.entries(totals)
    .filter(([, v]) => v !== 0)
    .map(([cur, v]) => `${v > 0 ? "+" : "−"}${money(Math.abs(v), cur)}`)
    .join(" · ");

/** One business's part: needs action, figures, the member's summary events, coming up. */
export function SummaryPart({
  summary,
  labels,
}: {
  summary: NotificationSummary;
  labels: Record<string, string>;
}) {
  const p = summary.parts as DigestParts;
  const f = p.figures;
  const label = (kind: string) => labels[kind] ?? kind.replace(/_/g, " ");
  const byKind = new Map<string, Notification[]>();
  for (const n of summary.items) byKind.set(n.kind, [...(byKind.get(n.kind) ?? []), n]);
  const coming = [
    p.coming_up.renewals ? `Renewals: ${p.coming_up.renewals}` : null,
    p.coming_up.trials_ending ? `Trials that end: ${p.coming_up.trials_ending}` : null,
    p.coming_up.invoices_due.count
      ? `Invoices that fall due: ${p.coming_up.invoices_due.count} · ${amounts(p.coming_up.invoices_due.totals)}`
      : null,
    p.coming_up.cards_expiring
      ? `Cards that expire this month or next: ${p.coming_up.cards_expiring}`
      : null,
  ].filter(Boolean) as string[];

  return (
    <RecordCard title={summary.business.name} flush>
      <div className="flex flex-col gap-4 px-5 py-4">
        {p.needs_action.length ? (
          <Alert
            tone="warning"
            title={`Needs action · ${p.needs_action.reduce((n, a) => n + a.count, 0)}`}
          >
            <ul className="m-0 flex list-none flex-col gap-1 p-0">
              {p.needs_action.map((a) => (
                <li key={a.kind}>
                  <Link href={a.url}>
                    {label(a.kind)} · {a.count}
                    {amounts(a.totals) ? ` · ${amounts(a.totals)}` : ""}
                  </Link>
                </li>
              ))}
            </ul>
          </Alert>
        ) : null}

        <div className="flex flex-wrap gap-px overflow-hidden rounded-xl border bg-border">
          <Figure
            label="Collected"
            value={amounts(f.collected.totals)}
            note={[
              plural(f.collected.count, "payment"),
              change(f.collected.count, f.collected.previous.count, p.period),
            ]
              .filter(Boolean)
              .join(" · ")}
          />
          <Figure
            label="Failed"
            value={amounts(f.failed.totals)}
            note={plural(f.failed.count, "payment")}
          />
          {f.recovered ? (
            <Figure
              label="Recovered by retries"
              value={amounts(f.recovered.totals)}
              note={plural(f.recovered.count, "payment")}
            />
          ) : null}
          <Figure
            label="Refunded"
            value={amounts(f.refunded.totals)}
            note={plural(f.refunded.count, "refund")}
          />
          <Figure
            label="New subscriptions"
            value={String(f.new_subscriptions.count)}
            note={change(f.new_subscriptions.count, f.new_subscriptions.previous, p.period)}
          />
          <Figure label="Cancelled" value={String(f.cancelled.count)} />
          <Figure label="MRR change" value={signed(f.mrr.change)} />
        </div>

        {[...byKind.entries()].map(([kind, rows]) => {
          const top = [...rows]
            .sort((a, b) => (b.amount_minor ?? 0) - (a.amount_minor ?? 0))
            .slice(0, 5);
          return (
            <section key={kind} className="flex flex-col gap-1.5">
              <h3 className="m-0 text-sm font-medium">
                {label(kind)} · {rows.length}
              </h3>
              <ul className="m-0 flex list-none flex-col divide-y rounded-xl border p-0">
                {top.map((n) => (
                  <li key={n.id} className="flex items-baseline gap-3 px-4 py-2.5 text-sm">
                    {n.url ? (
                      <Link href={n.url} className="min-w-0 flex-1 text-primary hover:underline">
                        {n.title}
                      </Link>
                    ) : (
                      <span className="min-w-0 flex-1">{n.title}</span>
                    )}
                    {n.amount_minor != null && n.currency ? (
                      <span className="shrink-0 tabular-nums">
                        {money(n.amount_minor, n.currency)}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
              {rows.length > top.length ? (
                <p className="m-0 text-xs text-muted-foreground">
                  and {rows.length - top.length} more
                </p>
              ) : null}
            </section>
          );
        })}

        {coming.length ? (
          <section className="flex flex-col gap-1.5">
            <h3 className="m-0 text-sm font-medium">Coming up in 7 days</h3>
            <ul className="m-0 flex list-none flex-col gap-1 p-0 text-sm text-muted-foreground">
              {coming.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </RecordCard>
  );
}
