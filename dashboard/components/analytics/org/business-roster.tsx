import Link from "next/link";
import { Block, Head, Row, LADDER } from "@/components/analytics/layout";
import { EmptyState } from "@/components/states";
import { pctFromBps } from "@/lib/format";
import { cn } from "@/lib/utils";

export interface RosterRow {
  id: string;
  name: string;
  livemode: "live" | "test";
  /** The currency this business BILLS in — context for the row, not the figure's unit. */
  currency: string | null;
  /** Pre-formatted in the page's reporting currency; null when nothing was measured. */
  mrrLabel: string | null;
  /** The same figure as a number, for ordering. */
  mrrMinor?: number | null;
  /** Movement across the window, in basis points. Null where the engine had no base to move from. */
  changeBps: number | null;
  payingSubscriptions: number | null;
  /** Subscriptions in dunning right now; null when the engine had no reading for this business. */
  subscriptionsInDunning: number | null;
  /** True when this business's currency has no reporting rate, so it is out of the roll-up. */
  excludedFromRollup: boolean;
  /** The business's own square mark and `#RRGGBB` brand — identity on its card, nothing else. */
  iconUrl?: string | null;
  brandColor?: string | null;
}

/**
 * The organization's businesses, one row each, every figure on the page's reporting basis.
 *
 * The rows are CONVERTED, and converted the same way the headline above is — one query, one
 * basis, so a row and the total are the same arithmetic. Stating each row in its own billing
 * currency was the earlier rule and it broke on the first business that bills in more than
 * one: three currencies joined by a `+` is not a sum, and it wrapped over four lines. What a
 * business bills in stays on the row, under its name, as context.
 *
 * A currency with no rate converts to nothing: that row reads "—" and says why, rather than
 * showing a zero it does not mean.
 *
 * No sparkline column — a per-business trend is a different question, answered on Compare
 * businesses, where one query splits the measure by business.
 */
export function BusinessRoster({ rows, mode }: { rows: RosterRow[]; mode: "live" | "test" }) {
  const title = mode === "test" ? "Test businesses" : "Businesses";
  // Biggest first: which business carries the book is the question a roster answers, and
  // creation order put the one real business below ten fixtures. Businesses with no MRR yet
  // are named once at the foot instead of each taking a row of dashes.
  const earning = rows
    .filter((r) => r.mrrMinor != null && r.mrrMinor !== 0)
    .sort((a, z) => (z.mrrMinor ?? 0) - (a.mrrMinor ?? 0));
  const idle = rows.filter((r) => r.mrrMinor == null || r.mrrMinor === 0);

  if (rows.length === 0) {
    return (
      <Block span={12} title={title}>
        <EmptyState
          title="No businesses here"
          description="A business owns its own catalog, currency and payment gateway."
        />
      </Block>
    );
  }

  return (
    <Block span={12} title={title}>
      {/* Headings only over rows: with no business earning yet, a row of column titles above
          nothing reads as a table that failed to load. */}
      {earning.length > 0 ? (
        <Head>
          <span className="min-w-0 flex-1">Business</span>
          <span className={LADDER.amount}>MRR</span>
          {/* Narrow screens keep business, MRR and paying; the movement and the dunning
              count come back as the row has room for them. */}
          <span className={cn(LADDER.secondary, "hidden sm:inline")}>30 days</span>
          <span className={LADDER.count}>Paying</span>
          {/* Subscriptions in dunning, as it stands — a count from the stored reading. */}
          <span className={cn(LADDER.count, "hidden lg:inline")}>Dunning</span>
        </Head>
      ) : null}
      {earning.map((r, i) => (
        <Row key={r.id} last={i === earning.length - 1 && idle.length === 0} className="h-14">
          <div className="flex min-w-0 flex-1 flex-col">
            {/* No per-row TEST badge: the heading and the page banner already say which
                mode this list is, and eleven orange chips made the mode the loudest thing. */}
            <Link
              href={`/businesses/${r.id}`}
              className="truncate font-medium text-primary hover:underline"
            >
              {r.name}
            </Link>
            <span className="truncate text-xs text-muted-foreground">
              {r.currency ?? "No currency"}
              {r.excludedFromRollup ? (
                <span className="text-warning"> · no reporting rate, excluded</span>
              ) : null}
            </span>
          </div>
          <span className={LADDER.amount}>{r.mrrLabel ?? "—"}</span>
          <span className={cn(LADDER.secondary, "hidden sm:inline")}>
            {r.changeBps == null ? (
              <span className="text-muted-foreground">—</span>
            ) : r.changeBps === 0 ? (
              // Flat is not good news: a zero change stays neutral, with no sign.
              <span className="text-muted-foreground">0.0%</span>
            ) : (
              <span className={r.changeBps < 0 ? "text-destructive" : "text-success"}>
                {r.changeBps < 0 ? "−" : "+"}
                {pctFromBps(Math.abs(r.changeBps), 1)}
              </span>
            )}
          </span>
          <span className={LADDER.count}>
            {r.payingSubscriptions ?? <span className="text-muted-foreground">—</span>}
          </span>
          <span className={cn(LADDER.count, "hidden lg:inline")}>
            {r.subscriptionsInDunning == null ? (
              <span className="text-muted-foreground">—</span>
            ) : r.subscriptionsInDunning > 0 ? (
              r.subscriptionsInDunning.toLocaleString("en")
            ) : (
              <span className="text-muted-foreground">0</span>
            )}
          </span>
        </Row>
      ))}
      {idle.length > 0 ? (
        <p className={cn("text-sm text-muted-foreground", earning.length > 0 && "pt-3")}>
          {idle.length} with no recurring revenue yet:{" "}
          {idle.map((r, i) => (
            <span key={r.id}>
              {i > 0 ? ", " : null}
              <Link href={`/businesses/${r.id}`} className="text-primary hover:underline">
                {r.name}
              </Link>
            </span>
          ))}
        </p>
      ) : null}
    </Block>
  );
}
