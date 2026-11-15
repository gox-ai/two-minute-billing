/**
 * Pure helpers for the portal's lifecycle flows (change plan, skip, coupon). No imports:
 * unit tests load this file directly, and the root typecheck does not know `@/`.
 */

export type Direction = "upgrade" | "downgrade" | "same";
export type Timing = "now" | "end_of_term";

export interface Cadenced {
  interval: string | null;
  interval_count: number;
}

export interface PlanLike extends Cadenced {
  price: string;
  name: string;
  amount_minor: number | null;
  model: string;
  current: boolean;
  /** Null when a list price cannot say which way the plan moves (a tiered price). */
  direction: Direction | null;
  /** The price's own name ("Pro Team"). Tells two prices of one product apart. */
  price_name?: string | null;
  /** Billed for what the buyer uses. */
  metered?: boolean;
}

export interface AddonLike extends Cadenced {
  price: string;
  name: string;
  amount_minor: number | null;
  model?: string;
  metered?: boolean;
  price_name?: string | null;
}

type Money = (minor: number) => string;

export const cadenceKey = (p: Cadenced) => `${p.interval_count}:${p.interval}`;

/** "every month", "every 3 months"; empty for a one-time price. */
export function cadence(interval: string | null, count: number): string {
  if (!interval) return "";
  return count > 1 ? `every ${count} ${interval}s` : `every ${interval}`;
}

/** "Monthly", "Yearly", "Every 3 months". */
export function cadenceTitle(p: Cadenced): string {
  if (!p.interval) return "One time";
  if (p.interval_count === 1 && ADJ[p.interval]) return cap(ADJ[p.interval]!);
  return cap(cadence(p.interval, p.interval_count));
}

const ADJ: Record<string, string> = {
  day: "daily",
  week: "weekly",
  month: "monthly",
  year: "yearly",
};
const cap = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

const MONTHS: Record<string, number> = { day: 12 / 365, week: 12 / 52, month: 1, year: 12 };

/** The length of one period in months. */
export const cadenceMonths = (p: Cadenced) =>
  (MONTHS[p.interval ?? "month"] ?? 1) * (p.interval_count || 1);

/** The list price per month, to compare plans. Null when the price has no single amount. */
export function monthlyMinor(p: Cadenced & { amount_minor: number | null }): number | null {
  if (p.amount_minor == null) return null;
  return p.amount_minor / cadenceMonths(p);
}

const isMetered = (p: { model?: string; metered?: boolean }) =>
  p.metered === true || p.model === "usage";

/** Cheapest first; a plan with no single price last. Ties by name. */
export function sortPlans<T extends PlanLike>(plans: readonly T[]): T[] {
  return [...plans].sort((a, b) => {
    const x = monthlyMinor(a);
    const y = monthlyMinor(b);
    if (x == null && y != null) return 1;
    if (y == null && x != null) return -1;
    if (x != null && y != null && x !== y) return x - y;
    return a.name.localeCompare(b.name);
  });
}

/** What one plan or add-on costs, in words: "$199.00 every month", "$0.50 per unit used, billed every month". */
export function priceText(p: AddonLike | PlanLike, fmt: Money): string {
  const every = cadence(p.interval, p.interval_count);
  if (isMetered(p))
    return p.amount_minor != null
      ? `${fmt(p.amount_minor)} per unit used, billed ${every}`
      : `Priced by use, billed ${every}`;
  if (p.amount_minor == null) return `Priced by quantity, billed ${every}`;
  if (p.model === "per_unit") return `${fmt(p.amount_minor)} per seat ${every}`;
  return `${fmt(p.amount_minor)} ${every}`;
}

export interface DirectionTiming {
  options: Timing[];
  default: Timing;
  blocked: { code: string; message: string } | null;
}

/**
 * The tag under a plan: current, or which way it moves and when. No direction for a plan
 * without a single price: the list price cannot say whether it costs more.
 */
export function planTag(
  p: PlanLike,
  timing: Partial<Record<"upgrade" | "downgrade", DirectionTiming>>,
): string | undefined {
  if (p.current) return "Current plan";
  if (p.amount_minor == null || p.direction == null || p.direction === "same") return undefined;
  const t = timing[p.direction];
  const word = p.direction === "upgrade" ? "Upgrade" : "Downgrade";
  if (!t) return word;
  if (t.blocked) return t.blocked.message;
  if (t.options.length !== 1) return word;
  return t.options[0] === "now" ? `${word} · starts now` : `${word} · starts at your next renewal`;
}

/**
 * The plan that stays selected after the billing period changes. A hidden plan never stays
 * selected: the same product on the new period, else the current plan when it is on that
 * period, else nothing (the buyer selects one).
 */
export function planAfterPeriodSwitch(
  plans: readonly PlanLike[],
  selected: string,
  period: string,
): string {
  const on = plans.filter((p) => cadenceKey(p) === period);
  if (on.some((p) => p.price === selected)) return selected;
  const was = plans.find((p) => p.price === selected);
  const same = was ? on.filter((p) => p.name === was.name) : [];
  const pick =
    same.find((p) => p.amount_minor != null && p.model === was?.model) ??
    (same.length === 1 ? same[0] : undefined) ??
    on.find((p) => p.current);
  return pick?.price ?? "";
}

/**
 * Add-ons to offer with a plan: the ones it takes on its own billing period. One on a
 * different period is refused by the engine, so it is never offered. Held ones always show,
 * so the buyer can remove them.
 */
export function addonOffered(
  a: AddonLike & { quantity: number; rules: Record<string, unknown> },
  plan: PlanLike | undefined,
): boolean {
  if (a.quantity > 0) return true;
  if (!plan || !a.rules[plan.price]) return false;
  return cadenceKey(a) === cadenceKey(plan);
}

// ——— Preview lines ————————————————————————————————————————————————————————————

export interface BuyerLine {
  label: string;
  /** What the line covers, for the sub-line under it. */
  span: "rest_of_period" | "unused" | "new_term" | "full" | null;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The engine prices a change in operator words ("pro-yearly-usd ×1 (new term)", "Remaining
 * time on Pro Monthly ×1"). This names each line for the buyer: price ids become product
 * names, and the period goes to `span`. Text it cannot read passes through unchanged.
 */
export function buyerLine(description: string, names: ReadonlyMap<string, string>): BuyerLine {
  const keys = [...names.keys()].filter(Boolean).sort((a, b) => b.length - a.length);
  const swap = (s: string) =>
    keys.length
      ? s.replace(new RegExp(keys.map(escapeRe).join("|"), "g"), (m) => names.get(m) ?? m)
      : s;
  const qty = (n: string | undefined) => (n && Number(n) > 1 ? ` × ${n}` : "");
  let m: RegExpMatchArray | null;
  if ((m = description.match(/^Unused time on (.+?)(?: ×\s*(\d+))?$/)))
    return { label: `Credit for unused time on ${swap(m[1]!)}${qty(m[2])}`, span: "unused" };
  if ((m = description.match(/^(.+?) — prorated credit for unused time$/)))
    return { label: `Credit for unused time on ${swap(m[1]!)}`, span: "unused" };
  if ((m = description.match(/^Remaining time on (.+?)(?: ×\s*(\d+))?$/)))
    return { label: `${swap(m[1]!)}${qty(m[2])}`, span: "rest_of_period" };
  if ((m = description.match(/^(.+?) - Prorated Charges(?: ×\s*(\d+))?$/)))
    return { label: `${swap(m[1]!)}${qty(m[2])}`, span: "rest_of_period" };
  if ((m = description.match(/^(.+?)(?: ×\s*(\d+))? \(new term\)$/)))
    return { label: `${swap(m[1]!)}${qty(m[2])}`, span: "new_term" };
  if ((m = description.match(/^(.+?) ×\s*(\d+)$/)))
    return { label: `${swap(m[1]!)}${qty(m[2])}`, span: "full" };
  return { label: swap(description), span: null };
}

/** Price id → "Pro, yearly" (and the price's own name → the same, when known). */
export function lineNames(items: ReadonlyArray<AddonLike | PlanLike>): Map<string, string> {
  const out = new Map<string, string>();
  for (const p of items) {
    const name = p.interval ? `${p.name}, ${cadenceTitle(p).toLowerCase()}` : p.name;
    out.set(p.price, name);
    if (p.price_name && !out.has(p.price_name)) out.set(p.price_name, name);
  }
  return out;
}

/** A line that adds a new term changes the term end, so the next invoice is not at the old one. */
export const startsNewTerm = (lines: ReadonlyArray<{ description: string }>) =>
  lines.some((l) => / \(new term\)$/.test(l.description));

// ——— Errors in buyer words ————————————————————————————————————————————————————

/** Ids, slugs and field names: text written for an operator. */
const OPERATOR_TEXT =
  /\b(?:price|sub|cus|item|inv|si|addr)_[A-Za-z0-9]{6,}\b|\b[a-z0-9]+(?:-[a-z0-9]+)+-(?:[a-z]{3})\b|\b[a-z]+_[a-z_]+\b|Billing period mismatch|\bprice [a-z0-9-]+\b/;

/**
 * An engine refusal for the buyer: "We could not <verb> <thing>. <Reason>." Refusals already
 * written for buyers keep their reason; operator text is replaced, never shown.
 */
export function buyerChangeError(
  message: string | null | undefined,
  lead: string,
  fallback = "Select a different change, or contact us.",
): string {
  const m = (message ?? "").trim();
  if (/^Billing period mismatch/.test(m))
    return `${lead} An add-on that you selected bills on a different period from the plan. Select add-ons on the same billing period as the plan.`;
  if (!m || OPERATOR_TEXT.test(m)) return `${lead} ${fallback}`;
  if (/^We could not /.test(m)) return m;
  return `${lead} ${m.endsWith(".") ? m : `${m}.`}`;
}

/** A coupon refusal in buyer words. The engine's own text is matched by code elsewhere. */
export function buyerCouponError(message: string | null | undefined): string {
  const lead = "We could not apply this code.";
  const m = (message ?? "").trim();
  if (/^We could not /.test(m)) return m;
  if (/^No (?:such|active) coupon/i.test(m) || /not found/i.test(m))
    return `${lead} Check the code and try again.`;
  if (/redemption limit|expired|no longer/i.test(m)) return `${lead} It is no longer available.`;
  if (/already applied/i.test(m)) return `${lead} It is already on this plan.`;
  if (/currency/i.test(m)) return `${lead} It is not valid for the currency of this plan.`;
  if (/^You can enter \d+ coupon code/.test(m) || /^A discount is already applied/.test(m))
    return `${lead} ${m.endsWith(".") ? m : `${m}.`}`;
  if (OPERATOR_TEXT.test(m) || !m) return `${lead} Check the code, or contact us.`;
  return `${lead} ${m.endsWith(".") ? m : `${m}.`}`;
}

// ——— Pause ———————————————————————————————————————————————————————————————————

export interface PauseTerms {
  starts: "now" | "end_of_term";
  resume_charge: "now" | "next_invoice";
}

/**
 * What a portal pause does, one sentence per fact. A portal pause has no end date (the
 * route sends none) and refunds nothing. When it starts and how a late resume bills come
 * from the business's pause settings; unknown, they are stated only as far as both hold.
 */
export function pauseCopy(
  terms: PauseTerms | null | undefined,
  periodEnd: string | null,
): string[] {
  const out: string[] = [];
  if (terms?.starts === "now") out.push("Your subscription pauses today.");
  else if (terms?.starts === "end_of_term")
    out.push(
      periodEnd
        ? `Your subscription stays active until ${periodEnd}. Then it pauses.`
        : "Your subscription stays active until the end of this period. Then it pauses.",
    );
  out.push("It stays paused until you resume it here. There is no end date.");
  out.push("We do not charge your plan while it is paused.");
  const charge =
    terms?.resume_charge === "next_invoice"
      ? "we add its charge to your next invoice"
      : terms?.resume_charge === "now"
        ? "we charge you for it on that day"
        : "we charge you for it";
  if (terms?.starts === "end_of_term") {
    out.push(`When you resume, a new period starts on that day and ${charge}.`);
    return out;
  }
  if (periodEnd) {
    out.push(`We do not refund the rest of your current period, which ends on ${periodEnd}.`);
    out.push(
      `If you resume before ${periodEnd}, your plan continues and we do not charge it again until ${periodEnd}.`,
    );
    out.push(`If you resume after that date, a new period starts on that day and ${charge}.`);
  } else out.push(`When you resume, a new period starts on that day and ${charge}.`);
  return out;
}

// ——— Restart —————————————————————————————————————————————————————————————————

/** "a new month", "a new year", "a new 3-month term". */
export function termName(interval: string, count: number): string {
  return count > 1 ? `a new ${count}-${interval} term` : `a new ${interval}`;
}

// ——— Skip renewal ————————————————————————————————————————————————————————————

/** How many renewals the skip dialog lists before "Show later dates". */
export const SKIP_SHORT_LIST = 3;

/** The renewals to list: skippable ones first in date order, cut to a short list. */
export function skipChoices<T extends { skipped: boolean }>(
  rows: readonly T[],
  showAll: boolean,
): { shown: T[]; more: number } {
  const open = rows.filter((r) => !r.skipped);
  if (showAll || open.length <= SKIP_SHORT_LIST + 1) return { shown: open, more: 0 };
  return { shown: open.slice(0, SKIP_SHORT_LIST), more: open.length - SKIP_SHORT_LIST };
}
