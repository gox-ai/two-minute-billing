import * as React from "react";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Block, KPI_LABEL, spanClass, type Span } from "@/components/analytics/layout";
import { measureValueCompact } from "@/components/analytics/format";
import { money, moneyCompact, pctFromBps } from "@/lib/format";
import { cn } from "@/lib/utils";
import { InfoTip } from "@/components/analytics/info-tip";
import type { CardInfo } from "@/components/analytics/card-info";
import { G } from "@/components/analytics/glossary";
import { DeltaChip, type DeltaDirection, type DeltaTone } from "@/components/analytics/delta-chip";
import type { AnalyticsResult, BatchEntry } from "@/lib/analytics-api";

/* ------------------------------------------------------- the page's basis */

/**
 * What every figure on this page is stated in, and when it was true.
 *
 * `currency` and the excluded list come from the BUSINESS record now, not from a payload that
 * re-derived them by scanning the whole book; `asOf`/`computedAt` come off the batch, which
 * stamps one instant across every slot so two tiles cannot disagree about when they were true.
 */
/** The dates a card's link filters its list to. `from`/`to` are business days, inclusive. */
export interface LinkWindow {
  from: string | null;
  to: string | null;
  /** The named preset, for Explore; null for a custom window. */
  range: string | null;
  next30: { from: string; to: string };
}

/** `&filter=<field>:between:<from>,<to>` for the period, or nothing when it is unknown. */
export function betweenFilter(field: string, w: LinkWindow | undefined): string {
  return w?.from && w.to ? `&filter=${field}:between:${w.from},${w.to}` : "";
}

/** An Explore link with these measures, over the period's preset when it has one. */
export function exploreHref(biz: string, measures: string[], w: LinkWindow | undefined): string {
  const qs = new URLSearchParams(measures.map((m) => ["measure", m]));
  if (w?.range) qs.set("range", w.range);
  return `/businesses/${biz}/reports/explore?${qs.toString()}`;
}

export interface Basis {
  /** The code the money figures are reported in. */
  currency: string;
  /** Whether other currencies were converted into it, rather than held apart. */
  converted: boolean;
  /** Currencies with no reporting rate — excluded from the roll-up, and named for it. */
  missingRates: string[];
  /** The instant the batch answered for. */
  asOf: string | null;
  /** When the underlying rows were computed — the freshness line. */
  computedAt: string | null;
  /** The zone the business's own calendar runs on. */
  tz: string | null;
}

/** The excluded-currency warning, or nothing when every currency has a rate. */
export function missingRatesWarning(basis: Basis): string | undefined {
  const m = basis.missingRates;
  if (m.length === 0) return undefined;
  return `${m.join(", ")} ${m.length === 1 ? "has" : "have"} no reporting rate and ${
    m.length === 1 ? "is" : "are"
  } excluded`;
}

/* ------------------------------------------------- reading a batch reply */

/** The answer in a batch slot, or null when that slot was refused. */
export function pick(batch: BatchEntry[], key: string): AnalyticsResult | null {
  const e = batch.find((x) => x.key === key);
  return e && e.object === "analytics_result" ? e : null;
}

/** The engine's own refusal sentence for a slot, to print verbatim. */
export function refusal(batch: BatchEntry[], key: string): string | null {
  const e = batch.find((x) => x.key === key);
  return e && e.object === "analytics_error" ? e.error.message : null;
}

/** One split row's total, by its dimension KEY — never by position or label. */
export function slice(r: AnalyticsResult | null, key: string): number | null {
  return r?.split?.series.find((s) => s.key === key)?.total ?? null;
}

/**
 * Every split row, widest first, with the engine's own labels.
 *
 * `other` is dropped: it names no value of the dimension, it is a remainder against the
 * unsliced total, and where that total disagrees with its parts it arrives NEGATIVE — which
 * is not a quantity a bar can draw. The rows that remain are the ones the engine attributed.
 */
export function slices(
  r: AnalyticsResult | null,
): Array<{ key: string; label: string; total: number }> {
  return (r?.split?.series ?? [])
    .filter((s) => (s.kind ?? "dimension") === "dimension" && s.total != null && s.total !== 0)
    .map((s) => ({ key: s.key, label: s.label, total: s.total! }))
    .sort((a, z) => z.total - a.total);
}

/**
 * A decline code the engine had no sentence for. It leaves the normalised key as the label,
 * which is a bug report on screen; this is the same key as a sentence. The vocabulary grows
 * with the rails, so it is cased rather than enumerated.
 */
export function readableKey(label: string): string {
  if (!/^[a-z0-9_]+$/.test(label)) return label;
  const words = label.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The last measured point's denominator — how many rows a ratio was folded over. */
export function ratioDenominator(r: AnalyticsResult | null): number | null {
  // A window rate's own base, when the engine computed the window — never a bucket's.
  if (r?.total_basis === "window" && r.total_denominator != null) return r.total_denominator;
  const measured = (r?.series ?? []).filter((p) => p.value != null && p.denominator != null);
  return measured.length > 0 ? (measured[measured.length - 1]!.denominator ?? null) : null;
}

/** Signed money for a movement: a loss carries its sign, nothing carries none. */
export function signedMoney(minor: number | null, currency: string): string {
  if (minor == null) return "—";
  if (minor === 0) return moneyCompact(0, currency);
  return `${minor < 0 ? "−" : "+"}${moneyCompact(Math.abs(minor), currency)}`;
}

/* ------------------------------------------------------ shared readings */

/** One horizon band of a booked-change reading; `mid` is the two disjoint bands 31–90d added. */
export function horizonBand(r: AnalyticsResult | null, band: "near" | "mid"): number | null {
  if (!r) return null;
  if (band === "near") return slice(r, "1_30");
  const a = slice(r, "31_60");
  const b = slice(r, "61_90");
  return a == null && b == null ? null : (a ?? 0) + (b ?? 0);
}

/** The booked book as rows. Downgrades and cancellations arrive as magnitudes; signed here. */
export function scheduledRows(batch: BatchEntry[]) {
  const loss = (v: number | null) => (v == null ? null : -v);
  const at = (key: string, band: "near" | "mid") => horizonBand(pick(batch, key), band);
  return [
    {
      label: "Cancellations",
      count: pick(batch, "sched_cancel_n")?.total ?? null,
      near: loss(at("sched_cancel", "near")),
      mid: loss(at("sched_cancel", "mid")),
    },
    {
      label: "Upgrades",
      count: pick(batch, "sched_up_n")?.total ?? null,
      near: at("sched_up", "near"),
      mid: at("sched_up", "mid"),
    },
    {
      label: "Downgrades",
      count: pick(batch, "sched_down_n")?.total ?? null,
      near: loss(at("sched_down", "near")),
      mid: loss(at("sched_down", "mid")),
    },
  ];
}

/**
 * The forward book: changes already booked, banded by how far off they are. The bands are
 * disjoint, so the two columns are two bands, not a running total.
 */
export function ScheduledChanges({
  span = 6,
  currency,
  rows,
  action,
}: {
  span?: Span;
  currency: string;
  rows: Array<{ label: string; count: number | null; near: number | null; mid: number | null }>;
  action?: React.ReactNode;
}) {
  const sum = (f: (r: (typeof rows)[number]) => number | null) =>
    rows.some((r) => f(r) != null) ? rows.reduce((s, r) => s + (f(r) ?? 0), 0) : null;
  const net = {
    label: "Net MRR impact",
    count: sum((r) => r.count),
    near: sum((r) => r.near),
    mid: sum((r) => r.mid),
  };
  const cell = (v: number | null) =>
    v == null || v === 0 ? (
      <span className="text-muted-foreground">—</span>
    ) : (
      <span className={v < 0 ? "text-destructive" : undefined}>{signedMoney(v, currency)}</span>
    );

  return (
    <Block
      span={span}
      title="Booked changes"
      info={G.bookedChanges}
      chip="priced at booking"
      action={action}
    >
      {/* A grid sized to its content, not the fixed ladder: this card takes a third of a row.
          Labels wrap between words; only a narrower card than that scrolls. */}
      <div className="overflow-x-auto">
        <div className="grid grid-cols-[minmax(min-content,1fr)_auto_auto_auto] items-center gap-x-4 text-sm tabular-nums">
          <div className="col-span-4 grid h-8 grid-cols-subgrid items-center border-b text-xs font-semibold tracking-wide whitespace-nowrap text-muted-foreground uppercase">
            <span>Change</span>
            <span className="text-right">Count</span>
            <span className="text-right">Next 30d</span>
            <span className="text-right">31–90d</span>
          </div>
          {[...rows, net].map((r, i) => (
            <div
              key={r.label}
              className={cn(
                "col-span-4 grid min-h-11 grid-cols-subgrid items-center py-1.5",
                i < rows.length - 1 && "border-b",
                i === rows.length && "border-t font-medium",
              )}
            >
              <span>{r.label}</span>
              <span className="text-right">
                {r.count == null ? "—" : r.count.toLocaleString("en")}
              </span>
              <span className="text-right whitespace-nowrap">{cell(r.near)}</span>
              <span className="text-right whitespace-nowrap">{cell(r.mid)}</span>
            </div>
          ))}
        </div>
      </div>
    </Block>
  );
}

/** A label/figure pair on the number ladder. The label wraps rather than truncating. */
export function Line({
  label,
  value,
  title,
  note,
  strong,
  info,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  title?: string;
  note?: React.ReactNode;
  strong?: boolean;
  info?: CardInfo;
}) {
  return (
    <div className="flex items-baseline gap-4">
      <span
        className={cn(
          "min-w-0 flex-1 text-sm",
          strong ? "font-medium text-foreground" : "text-muted-foreground",
        )}
      >
        {label}
        {info ? (
          <span className="ml-1 inline-flex align-middle">
            <InfoTip label={typeof label === "string" ? label : "This figure"} info={info} />
          </span>
        ) : null}
        {note ? <span className="ml-2 text-xs tabular-nums">{note}</span> : null}
      </span>
      <span
        className={cn(
          "shrink-0 text-right text-sm tabular-nums",
          strong ? "font-semibold" : "font-medium",
        )}
        title={title}
      >
        {value}
      </span>
    </div>
  );
}

/** Lines separated by hairlines — the list shape inside a card. */
export function Lines({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col divide-y [&>*]:py-2.5 [&>*:first-child]:pt-0 [&>*:last-child]:pb-0">
      {children}
    </div>
  );
}

/**
 * A headline tile: tracked label, 26px figure, one short qualifier. The row it sits in sets
 * its width. A tile with `href` is a way into the list behind the figure.
 */
export function Tile({
  label,
  value,
  note,
  title,
  href,
  tone,
  span,
  info,
}: {
  label: string;
  value: string;
  note?: React.ReactNode;
  title?: string;
  href?: string;
  info?: CardInfo;
  tone?: "loss";
  /** On the 12-column grid; omitted when the row sets the width itself. */
  span?: Span;
}) {
  const body = (
    <>
      <span className="flex items-center gap-1">
        <span className={KPI_LABEL}>{label}</span>
        {info ? <InfoTip label={label} info={info} /> : null}
      </span>
      <span
        className={cn(
          "mt-2 text-2xl font-semibold wrap-anywhere tabular-nums",
          tone === "loss" && "text-destructive",
        )}
        title={title}
      >
        {value}
      </span>
      {note ? (
        <span className="mt-1 text-xs text-muted-foreground tabular-nums">{note}</span>
      ) : null}
    </>
  );
  const shell = "anim-rise flex min-w-0 flex-col gap-0 p-6";
  const width = span ? spanClass(span) : undefined;
  return href ? (
    <Link href={href} className={cn("group min-w-0", width)}>
      <Card className={cn(shell, "hoverable h-full group-hover:border-primary/40")}>{body}</Card>
    </Link>
  ) : (
    <Card className={cn(shell, width)}>{body}</Card>
  );
}

/** One of the Current zone's lead figures: tracked label, 26px figure, a 14px subline. */
/**
 * A stock's movement across its own series, first measured point to last, as a Headline
 * `change`. Null when either end is missing or the start is zero (no percentage from nothing).
 */
export function seriesChange(
  r: AnalyticsResult | null,
  span: string,
  fmt: "percent" | "count" = "percent",
): HeadlineChange | null {
  const v = (r?.series ?? []).map((p) => p.value).filter((x): x is number => x != null);
  if (v.length < 2) return null;
  const first = v[0]!;
  const last = v[v.length - 1]!;
  const d = last - first;
  const direction = d > 0 ? "up" : d < 0 ? "down" : "flat";
  const tone = d > 0 ? "good" : d < 0 ? "bad" : "neutral";
  if (fmt === "count") {
    return { value: Math.abs(d).toLocaleString("en"), direction, tone, context: `in ${span}` };
  }
  if (first === 0) return null;
  return {
    value: pctFromBps(Math.round(Math.abs(d / first) * 10000), 1),
    direction,
    tone,
    context: `in ${span}`,
  };
}

/** A Headline's movement: the magnitude goes in the chip, `context` reads beside it. */
export interface HeadlineChange {
  value: string;
  direction: DeltaDirection;
  tone: DeltaTone;
  context: string;
}

// As many columns as stats, so two figures get halves rather than two thirds and a gap.
const STAT_COLS: Record<number, string> = { 1: "grid-cols-1", 2: "grid-cols-2", 3: "grid-cols-3" };

/**
 * A series as a sparkline: the line and a light wash under it, drawn from the same points
 * as the chart it summarises. A null point breaks the line — a gap, never a zero.
 */
export function Sparkline({
  values,
  className,
}: {
  values: Array<number | null>;
  className?: string;
}) {
  const W = 240;
  const H = 56;
  const PAD = 4;
  const known = values.filter((v): v is number => v != null && Number.isFinite(v));
  if (known.length < 2) return null;
  const lo = Math.min(...known);
  const hi = Math.max(...known);
  const span = hi - lo || 1;
  const x = (i: number) => (values.length < 2 ? 0 : (i / (values.length - 1)) * W);
  const y = (v: number) => PAD + (1 - (v - lo) / span) * (H - PAD * 2);
  const runs: Array<Array<[number, number]>> = [];
  values.forEach((v, i) => {
    if (v == null || !Number.isFinite(v)) return void runs.push([]);
    if (runs.length === 0) runs.push([]);
    runs[runs.length - 1]!.push([x(i), y(v)]);
  });
  const lines = runs.filter((r) => r.length > 1);
  const d = (r: Array<[number, number]>) =>
    r.map(([px, py], i) => `${i ? "L" : "M"}${px.toFixed(1)} ${py.toFixed(1)}`).join(" ");
  return (
    <svg
      aria-hidden
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      className={cn("block h-14 w-full", className)}
    >
      {lines.map((r, i) => (
        <path
          key={`a${i}`}
          d={`${d(r)} L${r.at(-1)![0].toFixed(1)} ${H} L${r[0]![0].toFixed(1)} ${H} Z`}
          className="fill-chart-1/10"
        />
      ))}
      {lines.map((r, i) => (
        <path
          key={`l${i}`}
          d={d(r)}
          fill="none"
          strokeWidth={2}
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
          className="stroke-chart-1"
        />
      ))}
    </svg>
  );
}

export function Headline({
  label,
  value,
  title,
  change,
  stats = [],
  span = 4,
  bare = false,
  info,
  icon: Icon,
  note,
  spark,
  featured = false,
}: {
  label: string;
  value: string;
  title?: string;
  /** What the card counts, behind an (i) beside the label. */
  info?: CardInfo;
  /** Movement beside the figure: a chip ("↓ 4.4%") then its context ("in 30 days"). */
  change?: HeadlineChange | null;
  /** Secondary figures, each under its own label; a null value drops the stat. */
  stats?: Array<{ label: string; value: string | null; title?: string; href?: string }>;
  span?: Span;
  /** A cell inside a surface that already draws the card (the one-business panel). */
  bare?: boolean;
  /** Leads the header row. */
  icon?: React.ComponentType<{ className?: string }>;
  /** One line under the figure: what it is made of ("6 of 180 customers"). */
  note?: React.ReactNode;
  /** The figure's own series, drawn under it. Null points are gaps. */
  spark?: Array<number | null> | null;
  /** The row's one ink card with a brand glow. */
  featured?: boolean;
}) {
  const shown = stats.filter((s) => s.value != null);
  const figure = (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
      <span className="text-2xl font-medium tracking-[-0.02em] tabular-nums" title={title}>
        {value}
      </span>
      {change ? (
        <span className={cn("flex items-center gap-2 self-center", spark && "basis-full")}>
          <DeltaChip direction={change.direction} tone={change.tone}>
            {change.value}
          </DeltaChip>
          <span className="text-xs text-muted-foreground">{change.context}</span>
        </span>
      ) : null}
    </div>
  );
  const statRow = (cls: string) =>
    shown.length > 0 ? (
      <dl className={cn("grid gap-x-2 gap-y-3", STAT_COLS[shown.length] ?? "grid-cols-3", cls)}>
        {shown.map((s) => (
          // A label that wraps keeps its figure on the row's baseline.
          <div key={s.label} className="flex min-w-0 flex-col justify-between gap-0.5">
            <dt className="text-xs text-muted-foreground">{s.label}</dt>
            <dd className="truncate text-base font-medium tabular-nums" title={s.title}>
              {s.href ? (
                <Link href={s.href} className="figure-link">
                  {s.value}
                </Link>
              ) : (
                s.value
              )}
            </dd>
          </div>
        ))}
      </dl>
    ) : null;

  if (bare) {
    return (
      <div className="flex min-w-0 flex-col gap-0 p-6">
        <span className="flex items-center gap-1">
          <span className={KPI_LABEL}>{label}</span>
          {info ? <InfoTip label={label} info={info} /> : null}
        </span>
        <div className="mt-2">{figure}</div>
        {statRow("mt-4 border-t pt-3.5")}
      </div>
    );
  }

  // Header row, body, stat row — each split by a hairline.
  return (
    <Card
      className={cn(
        "anim-rise min-w-0 gap-0 overflow-hidden py-0",
        featured && "surface-feature",
        spanClass(span),
      )}
    >
      <div className="flex items-center gap-2 border-b px-4 py-3 text-sm font-medium">
        {Icon ? (
          <Icon
            className={cn("size-4 shrink-0", featured ? "text-primary" : "text-foreground/70")}
          />
        ) : null}
        <span className="min-w-0 truncate">{label}</span>
        {info ? <InfoTip label={label} info={info} /> : null}
      </div>
      {/* Two lines in every card — figure, then its change or its note — so a row of these
          stays one height. A sparkline sits beside them, never under them. */}
      <div className="flex flex-1 items-center gap-3 px-4 pt-3.5 pb-4">
        <div className="flex min-w-0 flex-col">
          {figure}
          {note ? (
            <span className="mt-1.5 text-sm text-muted-foreground tabular-nums">{note}</span>
          ) : null}
        </div>
        {/* A set width, not flex-1: the leftover space depends on the figure's length, so
            sparklines in one row came out at different widths. */}
        {spark ? <Sparkline values={spark} className="ms-auto h-12 w-28 min-w-16 shrink" /> : null}
      </div>
      {statRow("border-t px-4 pt-3 pb-3.5")}
    </Card>
  );
}

/** A figure with its qualifier beside it — the head of a Performance card. */
export function Lead({
  value,
  note,
  title,
  tone,
}: {
  value: string;
  note?: React.ReactNode;
  title?: string;
  tone?: "loss";
}) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <span
        className={cn("text-2xl font-medium tabular-nums", tone === "loss" && "text-destructive")}
        title={title}
      >
        {value}
      </span>
      {note ? <span className="text-sm text-muted-foreground tabular-nums">{note}</span> : null}
    </div>
  );
}

/** A 0–1 bar with a caption, for a figure that IS a fraction of another. */
export function Meter({ fraction, fill = "bg-chart-1" }: { fraction: number; fill?: string }) {
  return (
    <span className="block h-2 rounded-full bg-muted" aria-hidden>
      <span
        className={cn("anim-grow block h-full rounded-full", fill)}
        style={{ width: `${Math.min(100, Math.max(0, fraction * 100))}%` }}
      />
    </span>
  );
}

/**
 * The trial conversion rate's two halves — converted over ended — so a card can show the
 * figures its rate is made of. Over the window when the engine folded it, else summed per bucket.
 */
export function trialHalves(
  r:
    | Pick<AnalyticsResult, "series" | "total_basis" | "total_numerator" | "total_denominator">
    | null
    | undefined,
): {
  converted: number | null;
  ended: number | null;
} {
  const sum = (f: "numerator" | "denominator") => {
    const v = (r?.series ?? []).map((p) => p[f]).filter((x): x is number => x != null);
    return v.length ? v.reduce((a, b) => a + b, 0) : null;
  };
  return r?.total_basis === "window"
    ? { converted: r.total_numerator ?? null, ended: r.total_denominator ?? null }
    : { converted: sum("numerator"), ended: sum("denominator") };
}

/**
 * The Trials card's body, shared by Business Home and the organization's Home. Started is
 * intake; the rate is converted over ENDED — different trials, so the two never chain.
 */
export function TrialsFunnel({
  started,
  rate,
}: {
  started: number | null;
  rate: AnalyticsResult | null;
}) {
  const { converted, ended } = trialHalves(rate);
  const count = (n: number | null) => (n == null ? "—" : n.toLocaleString("en"));
  const won = converted ?? 0;
  const pct = rate?.total == null ? null : pctFromBps(rate.total, 1);
  // The ring is the rate itself, so it is drawn only when there is one.
  const C = 2 * Math.PI * 15;
  const arc = rate?.total == null ? null : Math.max(0, Math.min(1, rate.total / 10000)) * C;
  return (
    <>
      <div className="flex items-center gap-4">
        {arc != null ? (
          <svg
            role="img"
            aria-label={`${pct} of ended trials converted`}
            viewBox="0 0 36 36"
            className="size-18 shrink-0 -rotate-90"
          >
            <circle cx="18" cy="18" r="15" fill="none" strokeWidth="5" className="stroke-muted" />
            <circle
              cx="18"
              cy="18"
              r="15"
              fill="none"
              strokeWidth="5"
              strokeLinecap={arc > 0 ? "round" : "butt"}
              strokeDasharray={`${arc.toFixed(1)} ${C.toFixed(1)}`}
              className="stroke-chart-1"
            />
          </svg>
        ) : null}
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-xs text-muted-foreground">Conversion rate</span>
          <span className="text-2xl font-medium tabular-nums">{pct ?? "—"}</span>
          {ended ? (
            <span className="text-sm text-muted-foreground tabular-nums">
              {count(won)} of {count(ended)} ended trials
            </span>
          ) : null}
        </div>
      </div>
      <div className="mt-4 grid grid-cols-3 gap-2 border-t pt-3">
        {[
          { label: "Started", value: started },
          { label: "Ended", value: ended },
          { label: "Converted", value: converted },
        ].map((f) => (
          <span key={f.label} className="flex min-w-0 flex-col gap-1">
            <span className="text-xs text-muted-foreground">{f.label}</span>
            <span className="text-lg font-medium tabular-nums">{count(f.value)}</span>
          </span>
        ))}
      </div>
    </>
  );
}

export interface AttentionItem {
  key: string;
  label: string;
  value: string;
  title?: string;
  note?: string;
  href: string;
  tone: "attention" | "warning" | "neutral";
  info?: CardInfo;
}

/**
 * The queues that want a person, as one card split into linked cells. The caller passes only
 * the cells with something in them; an empty strip renders nothing.
 */
export function AttentionStrip({ items }: { items: AttentionItem[] }) {
  if (items.length === 0) return null;
  return (
    // Cells wrap at a 12rem floor and a short last row grows to fill it, so no width leaves
    // a cell too narrow for its label or a half-empty row. The 1px gap over the border colour
    // draws the rules between cells wherever they wrap.
    <section
      aria-label="Needs attention"
      className="anim-rise flex flex-wrap gap-px overflow-hidden rounded-xl border bg-border shadow-sm"
    >
      {items.map((it) => (
        <div
          key={it.key}
          className="group relative flex min-w-0 flex-[1_1_12rem] items-center gap-2 bg-card px-4 py-3.5 hover:bg-linear-to-r hover:from-muted/50 hover:to-muted/50"
        >
          <span className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span
                aria-hidden
                className={cn(
                  "size-1.5 shrink-0 rounded-full",
                  it.tone === "attention"
                    ? "bg-destructive"
                    : it.tone === "warning"
                      ? "bg-warning"
                      : "bg-muted-foreground/40",
                )}
              />
              <Link href={it.href} className="after:absolute after:inset-0">
                {it.label}
              </Link>
              {it.info ? <InfoTip label={it.label} info={it.info} /> : null}
            </span>
            <span className="flex flex-wrap items-baseline gap-x-2">
              <span className="text-lg font-medium tabular-nums" title={it.title}>
                {it.value}
              </span>
              {it.note ? (
                <span className="text-xs text-muted-foreground tabular-nums">{it.note}</span>
              ) : null}
            </span>
          </span>
          <ChevronRight
            aria-hidden
            className="size-4 shrink-0 text-muted-foreground group-hover:text-foreground"
          />
        </div>
      ))}
    </section>
  );
}

/**
 * Rows of a whole as bars against the widest. Labels size their own column and wrap, never
 * truncate. Rows of nothing, and negative remainders, are left out.
 */
export function BarList({
  rows,
  format,
  fill = "bg-chart-1",
  share = true,
}: {
  rows: Array<{
    key: string;
    label: React.ReactNode;
    total: number;
    href?: string | null;
    title?: string;
  }>;
  format: (n: number) => string;
  fill?: string;
  /** Show each row's share of the rows' sum. */
  share?: boolean;
}) {
  const shown = rows.filter((r) => r.total > 0);
  const widest = Math.max(...shown.map((r) => r.total), 1);
  const whole = shown.reduce((s, r) => s + r.total, 0);
  return (
    <div
      className={cn(
        "grid items-center gap-x-4 gap-y-2.5 text-sm",
        share
          ? "grid-cols-[minmax(0,max-content)_minmax(3rem,1fr)_auto_auto]"
          : "grid-cols-[minmax(0,max-content)_minmax(3rem,1fr)_auto]",
      )}
    >
      {shown.map((r) => (
        <React.Fragment key={r.key}>
          {r.href ? (
            <Link href={r.href} className="wrap-break-word hover:underline">
              {r.label}
            </Link>
          ) : (
            <span className="wrap-break-word">{r.label}</span>
          )}
          <span className="h-2 rounded-md bg-muted" aria-hidden>
            <span
              className={cn("anim-grow block h-full rounded-md", fill)}
              style={{ width: `${Math.min(100, (r.total / widest) * 100)}%` }}
            />
          </span>
          <span className="text-right tabular-nums" title={r.title}>
            {format(r.total)}
          </span>
          {share ? (
            <span className="w-10 text-right text-muted-foreground tabular-nums">
              {whole > 0 ? pctFromBps(Math.round((r.total / whole) * 10000), 0) : ""}
            </span>
          ) : null}
        </React.Fragment>
      ))}
    </div>
  );
}

export { SegmentBar } from "@/components/charts/segment-bar";

/* ---------------------------------------------------------- dates on Home */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function partsIn(iso: string, tz: string | null) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  try {
    const out: Record<string, string> = {};
    for (const p of new Intl.DateTimeFormat("en-GB", {
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZone: tz ?? "UTC",
    }).formatToParts(d))
      out[p.type] = p.value;
    return out;
  } catch {
    return null;
  }
}

/** `28 Sep, 14:05` in the business zone. */
export function asAtLabel(iso: string | null, tz: string | null): string | null {
  const p = iso ? partsIn(iso, tz) : null;
  if (!p) return null;
  return `${Number(p.day)} ${MONTHS[Number(p.month) - 1]}, ${p.hour}:${p.minute}`;
}

/** A calendar date, or the business-zone date of an instant, as `YYYY-MM-DD`. */
export function localYmd(s: string, tz: string | null): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const p = partsIn(s, tz);
  return p ? `${p.year}-${p.month!.padStart(2, "0")}-${p.day!.padStart(2, "0")}` : s.slice(0, 10);
}

/** `30 Aug – 28 Sep`, with years only when the window crosses one. */
export function rangeLabel(start: string, end: string): string {
  const fmt = (ymd: string, year: boolean) =>
    `${Number(ymd.slice(8, 10))} ${MONTHS[Number(ymd.slice(5, 7)) - 1]}${year ? ` ${ymd.slice(0, 4)}` : ""}`;
  const crosses = start.slice(0, 4) !== end.slice(0, 4);
  return `${fmt(start, crosses)} – ${fmt(end, crosses)}`;
}

/** Days in an inclusive calendar window. */
export function daysIn(start: string, end: string): number {
  return Math.round((Date.parse(end) - Date.parse(start)) / 86_400_000) + 1;
}

/** A measure's total, formatted from the answer itself so the unit is never guessed. */
export function total(r: AnalyticsResult | null, fallbackCurrency: string): string {
  if (!r) return "—";
  return measureValueCompact(r.total, r.unit, r.currency ?? fallbackCurrency);
}

/**
 * The currency basis, without the excluded currencies — `PageNote` names those separately so a
 * missing rate reads as something to fix rather than as a parenthesis.
 */
export function currencyBasis(b: Basis): string {
  return b.converted ? `reported in ${b.currency}, converted` : `all figures in ${b.currency}`;
}

/* ---------------------------------------------- the last complete month */

/**
 * The MRR movement the engine measured over the window the rates were folded on.
 *
 * Every flow is asked for in its own slot and read here by key, so a missing one stays null
 * rather than becoming a zero the waterfall would draw as "nothing moved". Losses arrive as
 * positive magnitudes — the sign is applied where they are drawn, never read off the value.
 */
export interface Movement {
  label: string;
  /** The window the engine actually measured, as it stated it. */
  window: { start: string; end: string } | null;
  opening: number | null;
  newMrr: number | null;
  expansion: number | null;
  reactivation: number | null;
  contraction: number | null;
  churn: number | null;
  paused: number | null;
  /** Rate drift on a converted answer (`mrr_fx_impact`); 0 in a single-currency one. */
  fx: number | null;
  /** MRR at the window's edges, read off the stock — what the waterfall runs between. */
  book: { opening: number | null; closing: number | null };
  grossBps: number | null;
  netBps: number | null;
  /** A plain multiple, not basis points — the engine publishes this one as a ratio. */
  quickRatio: number | null;
  netGrowthBps: number | null;
  /** The engine's `gross_mrr_churn_rate`: churn and contraction over the whole-book opening. */
  churnRateBps: number | null;
}

export function readMovement(batch: BatchEntry[]): Movement {
  const grr = pick(batch, "grr");
  const flow = (key: string) => pick(batch, key)?.total ?? null;
  // The opening MRR is the denominator the retention rate was divided by, not a second
  // reading of the book: a card whose base differed from the rate beside it would be two
  // answers to one question.
  const opening = ratioDenominator(grr) ?? ratioDenominator(pick(batch, "nrr"));
  const churn = flow("m_churn");
  const period = grr?.series?.[grr.series.length - 1];
  const stock = pick(batch, "m_book");
  return {
    label: period?.label ?? grr?.range?.name ?? "the last complete month",
    window: grr ? { start: grr.range.start, end: grr.range.end } : null,
    opening,
    newMrr: flow("m_new"),
    expansion: flow("m_expansion"),
    reactivation: flow("m_reactivation"),
    contraction: flow("m_contraction"),
    churn,
    paused: flow("m_paused"),
    fx: flow("m_fx"),
    book: { opening: stock?.compare?.previous_total ?? null, closing: stock?.total ?? null },
    grossBps: grr?.total ?? null,
    netBps: pick(batch, "nrr")?.total ?? null,
    quickRatio: pick(batch, "quick")?.total ?? null,
    netGrowthBps: pick(batch, "net_growth")?.total ?? null,
    // Asked for, not divided here: all churned MRR over the COHORT opening mixed two bases.
    churnRateBps: pick(batch, "churn_rate")?.total ?? null,
  };
}

/** Whether the engine answered any part of the movement at all. */
export function hasMovement(m: Movement): boolean {
  return [m.opening, m.newMrr, m.expansion, m.reactivation, m.contraction, m.churn].some(
    (v) => v != null,
  );
}

/** What the waterfall and the net-new row say about the movement no flow measure counts. */
export const OTHER_MOVEMENT_HINT = "Movement that no flow measure counts, such as a resumed pause";

/** One part of net new MRR, signed as it moved the book. */
export interface NetNewPart {
  label: string;
  value: number | null;
  hint?: string;
}

/**
 * Whether answers cover the same periods, so a difference between them is movement rather
 * than a period one of them has no stored figure for. A missing answer is not comparable.
 */
export function sameCoverage(results: Array<AnalyticsResult | null>): boolean {
  const gaps = results.map((r) => (r ? JSON.stringify(r.coverage?.missing_periods ?? []) : null));
  return gaps.every((g) => g != null && g === gaps[0]);
}

/**
 * Net new MRR split into parts that add up to it.
 *
 * `net_new_mrr` signs every ledger reason, so beside the four flows it also carries pause
 * (a loss, shown as Paused) and resume and anything else no flow counts (shown as Other, the
 * remainder). Other is unknown ("—") unless every part is known over the same periods
 * (`comparable`, see `sameCoverage`): a remainder across a coverage gap is not movement. FX
 * is deliberately absent: it moves the converted stock, not the ledger, so it is in
 * opening → closing but never in net new MRR.
 */
export function netNewParts(
  f: Pick<Movement, "newMrr" | "expansion" | "reactivation" | "contraction" | "churn" | "paused">,
  net: number | null,
  comparable: boolean,
): NetNewPart[] {
  const gains =
    f.expansion == null && f.reactivation == null
      ? null
      : (f.expansion ?? 0) + (f.reactivation ?? 0);
  // `0 -`, not unary minus: a loss of nothing is 0, never -0 ("-$0.00" in the tooltip).
  const losses =
    f.churn == null && f.contraction == null ? null : 0 - ((f.churn ?? 0) + (f.contraction ?? 0));
  const paused = f.paused == null ? null : 0 - f.paused;
  const parts: NetNewPart[] = [
    { label: "New", value: f.newMrr },
    { label: "Expansion + reactivation", value: gains },
    { label: "Churn + contraction", value: losses },
  ];
  if (paused) parts.push({ label: "Paused", value: paused });
  const known = [f.newMrr, f.expansion, f.reactivation, f.contraction, f.churn, f.paused].every(
    (v) => v != null,
  );
  if (net != null && !(known && comparable)) {
    parts.push({
      label: "Other",
      value: null,
      hint: "Some periods have no stored figure, so we cannot calculate this part",
    });
  } else if (net != null) {
    const other = net - (f.newMrr! + gains! + losses! + paused!);
    if (other !== 0) parts.push({ label: "Other", value: other, hint: OTHER_MOVEMENT_HINT });
  }
  return parts;
}

/**
 * What moved recurring revenue over the period, as a waterfall from opening to closing MRR.
 *
 * Each step floats from the running total before it to the one after. The axis is fitted to
 * the totals, not zero, so a 1% month is visible; the opening and closing bars stand on that
 * floor. Steps of nothing are left out. When the edges come from the MRR stock, FX (rate drift
 * on a converted answer) and Other (what no flow measures) close the gap, so the bars add up.
 */
export function MovementWaterfall({
  movement,
  currency,
}: {
  movement: Movement;
  currency: string;
}) {
  const steps: Array<{ label: string; delta: number; neutral?: boolean; hint?: string }> = [
    { label: "New", delta: movement.newMrr ?? 0 },
    { label: "Expansion", delta: movement.expansion ?? 0 },
    { label: "Reactivation", delta: movement.reactivation ?? 0 },
    { label: "Contraction", delta: -(movement.contraction ?? 0) },
    { label: "Churn", delta: -(movement.churn ?? 0) },
    { label: "Paused", delta: -(movement.paused ?? 0) },
    {
      label: "FX",
      delta: movement.fx ?? 0,
      neutral: true,
      hint: "Exchange-rate drift on MRR held in other currencies",
    },
  ];
  const book = movement.book;
  const measured = book.opening != null && book.closing != null;
  const known = measured || movement.opening != null;
  const opening = measured ? book.opening! : (movement.opening ?? 0);
  if (measured) {
    const drawn = steps.reduce((s, x) => s + x.delta, opening);
    steps.push({
      label: "Other",
      delta: book.closing! - drawn,
      neutral: true,
      hint: OTHER_MOVEMENT_HINT,
    });
  }

  let running = opening;
  const bars = steps
    // FX and Other are residues: under 0.1% of the book they are rounding, not movement.
    .filter((s) => s.delta !== 0 && !(s.neutral && Math.abs(s.delta) < Math.abs(opening) / 1000))
    .map((s) => {
      const from = running;
      running += s.delta;
      return { ...s, from, to: running };
    });
  // The stated closing, not the drawn one: a residue left out above is still in it.
  const closing = measured ? book.closing! : running;

  const totals = [opening, closing, ...bars.map((b) => b.to)];
  const hi = Math.max(...totals);
  const lo = Math.min(...totals);
  // The floor sits below the lowest total by the swing again, so the edges read as levels.
  const swing = hi - lo || Math.abs(hi) * 0.05 || 1;
  const floor = known ? Math.max(0, lo - swing) : Math.min(0, lo);
  const top = hi + swing * 0.1;
  const H = 180;
  const y = (v: number) => ((v - floor) / (top - floor || 1)) * H;

  const sign = (v: number) => (v > 0 ? "+" : v < 0 ? "−" : "");
  const columns = [
    ...(known
      ? [
          {
            key: "open",
            label: "Opening MRR",
            amount: opening,
            from: floor,
            to: opening,
            fill: "bg-muted-foreground/40",
            edge: true,
            loss: false,
            hint: undefined as string | undefined,
          },
        ]
      : []),
    ...bars.map((b) => ({
      key: b.label,
      label: b.label,
      amount: b.delta,
      from: b.from,
      to: b.to,
      // FX and Other are not customer movement: neutral, never loss-red.
      fill: b.neutral ? "bg-muted-foreground/25" : b.delta < 0 ? "bg-chart-5" : "bg-chart-1",
      edge: false,
      loss: !b.neutral && b.delta < 0,
      hint: b.hint,
    })),
    ...(known
      ? [
          {
            key: "close",
            label: "Closing MRR",
            amount: closing,
            from: floor,
            to: closing,
            fill: "bg-foreground",
            edge: true,
            loss: false,
            hint: undefined as string | undefined,
          },
        ]
      : []),
  ];
  const grid = { gridTemplateColumns: `repeat(${columns.length}, minmax(0, 1fr))` };

  return (
    <div className="flex flex-col gap-3">
      <div className="relative" style={{ height: H }}>
        <div className="absolute inset-x-0 bottom-0 border-t" />
        <div className="absolute inset-0 grid gap-3" style={grid}>
          {columns.map((c) => {
            const bottom = y(Math.min(c.from, c.to));
            const height = Math.max(2, Math.abs(y(c.to) - y(c.from)));
            return (
              <div key={c.key} className="relative">
                <div
                  className={cn("absolute inset-x-1 rounded-sm", c.fill)}
                  style={{ bottom, height }}
                />
              </div>
            );
          })}
        </div>
      </div>
      <div className="grid gap-3" style={grid}>
        {columns.map((c) => (
          <div key={c.key} className="flex min-w-0 flex-col items-center gap-0.5 text-center">
            <span
              className={cn("text-sm font-medium tabular-nums", c.loss && "text-destructive")}
              title={money(Math.abs(c.amount), currency)}
            >
              {c.edge ? "" : sign(c.amount)}
              {moneyCompact(Math.abs(c.amount), currency)}
            </span>
            <span className="text-xs wrap-break-word text-muted-foreground" title={c.hint}>
              {c.label}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** A country code as its English name; the code itself when the runtime has no name for it. */
export function countryName(code: string): string {
  if (!/^[A-Z]{2}$/.test(code)) return code;
  try {
    return new Intl.DisplayNames(["en"], { type: "region" }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** Due in the next 30 days plus already past its date — the renewal book's near edge. */
export function nearBand(r: AnalyticsResult | null): number | null {
  const near = slice(r, "1_30");
  const late = slice(r, "overdue");
  return near == null && late == null ? null : (near ?? 0) + (late ?? 0);
}

/**
 * "N open · next deadline 3 Oct" (or "deadline passed 26 Sep"). Without a dated deadline it
 * falls back to the horizon split: "M overdue" / "M due within 30 days".
 */
export function disputeNote(
  r: AnalyticsResult | null,
  open: number,
  nextDeadline?: string | null,
  tz?: string | null,
): string {
  const n = (v: number) => v.toLocaleString("en");
  const overdue = slice(r, "overdue") ?? 0;
  const soon = slice(r, "1_30") ?? 0;
  const deadline = nextDeadline
    ? `${Date.parse(nextDeadline) < Date.now() ? "deadline passed" : "next deadline"} ${new Date(
        nextDeadline,
      ).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: tz ?? "UTC" })}`
    : null;
  return [
    `${n(open)} open`,
    deadline ??
      (overdue > 0 ? `${n(overdue)} overdue` : soon > 0 ? `${n(soon)} due within 30 days` : null),
  ]
    .filter(Boolean)
    .join(" · ");
}
