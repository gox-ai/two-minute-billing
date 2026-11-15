// Pure grouping for the public pricing page. Relative imports only: test/unit imports it.
import { money } from "../../../../lib/format";

/** The fields of a pricing-page link this file reads (`PricingPageLink` in lib/checkout-api). */
export interface PricedLink {
  id: string;
  name: string;
  mode: "create" | "purchase";
  product?: { id: string; name: string };
  description: string | null;
  image_url?: string | null;
  price: {
    amount: string;
    currency?: string;
    amount_minor?: number | null;
    interval: string | null;
    interval_count: number;
    model?: string;
  };
}

/** One card: a product, with one link per cadence it is sold at. */
export interface ProductCard<L extends PricedLink = PricedLink> {
  key: string;
  name: string;
  description: string | null;
  image_url: string | null;
  /** In cadence order (monthly first). */
  options: Array<{ cadence: string; link: L }>;
}

/** `month:1`, `year:1`, `month:3` … or `once` for a one-time price. */
export function cadenceOf(link: PricedLink): string {
  return link.price.interval ? `${link.price.interval}:${link.price.interval_count}` : "once";
}

const UNIT_DAYS: Record<string, number> = { day: 1, week: 7, month: 30, year: 365 };
const rank = (cadence: string) => {
  const [unit, count] = cadence.split(":");
  return (UNIT_DAYS[unit ?? ""] ?? 1000) * Number(count ?? 1);
};

/** "Monthly", "Yearly", "Every 3 months" — the switch labels. */
export function cadenceLabel(cadence: string): string {
  const [unit, raw] = cadence.split(":");
  const count = Number(raw ?? 1);
  if (count === 1)
    return (
      { day: "Daily", week: "Weekly", month: "Monthly", year: "Yearly" }[unit ?? ""] ??
      `Every ${unit}`
    );
  return `Every ${count} ${unit}s`;
}

/** "per month", "every 3 months" — after a price. */
export function cadenceSuffix(cadence: string): string {
  if (cadence === "once") return "one time";
  const [unit, raw] = cadence.split(":");
  const count = Number(raw ?? 1);
  return count === 1 ? `per ${unit}` : `every ${count} ${unit}s`;
}

/**
 * Plans grouped by product, one card each with every cadence it is sold at, and one-time
 * products on their own. Links of one product that share a cadence stay separate cards,
 * because nothing says which of the two the switch should show.
 */
export function groupPricing<L extends PricedLink>(
  links: L[],
): { plans: ProductCard<L>[]; oneTime: ProductCard<L>[]; cadences: string[] } {
  const plans: ProductCard<L>[] = [];
  const oneTime: ProductCard<L>[] = [];
  for (const link of links) {
    const cadence = cadenceOf(link);
    const name = link.product?.name || link.name;
    const card = (key: string): ProductCard<L> => ({
      key,
      name,
      description: link.description,
      image_url: link.image_url ?? null,
      options: [{ cadence, link }],
    });
    if (cadence === "once") {
      oneTime.push(card(link.id));
      continue;
    }
    const productKey = link.product?.id ?? `name:${link.name}`;
    const home = plans.find(
      (p) =>
        p.key === productKey &&
        !p.options.some((o) => o.cadence === cadence) &&
        p.options.every((o) => o.link.price.currency === link.price.currency),
    );
    if (home) home.options.push({ cadence, link });
    else plans.push(card(plans.some((p) => p.key === productKey) ? link.id : productKey));
  }
  for (const p of plans) p.options.sort((a, b) => rank(a.cadence) - rank(b.cadence));
  const cadences = [...new Set(plans.flatMap((p) => p.options.map((o) => o.cadence)))].sort(
    (a, b) => rank(a) - rank(b),
  );
  return { plans, oneTime, cadences };
}

/** The option a card shows for the selected cadence: that one, else its shortest. */
export function optionFor<L extends PricedLink>(card: ProductCard<L>, cadence: string | null) {
  return card.options.find((o) => o.cadence === cadence) ?? card.options[0]!;
}

/**
 * What paying yearly saves over twelve monthly payments, from the two flat prices. Null
 * unless both exist as flat prices in one currency and the yearly one is cheaper.
 */
export function yearlySaving(
  card: ProductCard,
): { amountMinor: number; currency: string; percent: number } | null {
  const m = card.options.find((o) => o.cadence === "month:1")?.link.price;
  const y = card.options.find((o) => o.cadence === "year:1")?.link.price;
  if (!m || !y || m.amount_minor == null || y.amount_minor == null) return null;
  if (!m.currency || m.currency !== y.currency) return null;
  if ((m.model ?? "flat") !== "flat" || (y.model ?? "flat") !== "flat") return null;
  const twelve = m.amount_minor * 12;
  const saved = twelve - y.amount_minor;
  if (saved <= 0) return null;
  return {
    amountMinor: saved,
    currency: m.currency,
    percent: Math.floor((saved / twelve) * 100),
  };
}

/** "$58.00" — the saving in the page's money format. */
export function savingLabel(s: { amountMinor: number; currency: string }): string {
  return money(s.amountMinor, s.currency);
}

/**
 * A pricing-page offer as one sentence: "10% off any plan for the first billing period."
 * `intervals` narrows the plans ("yearly plans"); `periods` null means every period.
 */
export function offerSentence(percentOff: number, periods: number | null, intervals: string[]) {
  const words = intervals
    .map((i) => ({ day: "daily", week: "weekly", month: "monthly", year: "yearly" })[i] ?? null)
    .filter((w): w is string => w != null);
  const scope =
    words.length === 0
      ? "any plan"
      : `${words.length === 1 ? words[0] : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`} plans`;
  const duration =
    periods == null
      ? "for every billing period"
      : periods === 1
        ? "for the first billing period"
        : `for the first ${periods} billing periods`;
  return `${percentOff}% off ${scope} ${duration}.`;
}
