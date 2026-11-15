/** A running campaign, as `/api/plans` returns it. */
export interface Offer {
  name: string;
  percentOff: number;
  periods: number | null;
  intervals: Array<"month" | "year">;
  endsAt: string;
  endsOn: string;
}

/** Pages rendered per request (nuxt.config routeRules): they can read the offer on the server. */
const SERVER_RENDERED = new Set(["/pricing", "/contact"]);

/**
 * The running campaign on our plans (Black Friday first), from the catalogue. Prerendered pages
 * read it in the browser, so they show it and drop it without a rebuild; server-rendered pages
 * read it on the server, so the bar is in the first paint and does not push the page down.
 * Null when none runs, and on a self-hosted build, where `/api/plans` does not exist.
 */
export function useCampaignOffer() {
  const route = useRoute();
  const { data } = useFetch("/api/plans", {
    key: "plans-offer",
    server: SERVER_RENDERED.has(route.path),
    lazy: true,
    default: () => null,
  });
  return computed<(Offer & { headline: number }) | null>(() => {
    const o = (data.value?.offers?.[0] as Offer | undefined) ?? null;
    return o ? { ...o, headline: headlinePercent(o, data.value?.plans ?? []) } : null;
  });
}

interface PricedPlan {
  name: string;
  currency: string;
  interval: "month" | "year";
  amountMinor: number;
}

/**
 * The one number we advertise: what a covered yearly plan's first year saves against paying
 * monthly for twelve months (the yearly discount and the campaign together, e.g. 20% then 50%
 * = 60%). The lowest across plans, floored, so it never overstates a plan. Falls back to the
 * campaign's own percent when it covers no yearly plan.
 */
export function headlinePercent(o: Offer, plans: PricedPlan[]): number {
  if (!offerCovers(o, "year")) return o.percentOff;
  const saves = plans
    .filter((y) => y.interval === "year" && y.amountMinor > 0)
    .map((y) => {
      const m = plans.find(
        (p) => p.interval === "month" && p.name === y.name && p.currency === y.currency,
      );
      if (!m) return null;
      const firstYear = Math.round(y.amountMinor * (1 - o.percentOff / 100));
      return 1 - firstYear / (m.amountMinor * 12);
    })
    .filter((v): v is number => v != null);
  return saves.length ? Math.floor(Math.min(...saves) * 100) : o.percentOff;
}

/** "December 2": the offer's last day, a date in our business's timezone. */
export function offerLastDay(o: Pick<Offer, "endsOn">, month: "long" | "short" = "long"): string {
  return new Date(`${o.endsOn}T00:00:00Z`).toLocaleDateString("en-US", {
    month,
    day: "numeric",
    timeZone: "UTC",
  });
}

/** Which plans it covers, as a buyer reads it: "yearly plans", "monthly plans", "paid plans". */
export function offerPlans(o: Pick<Offer, "intervals">): string {
  if (o.intervals.length === 1) return o.intervals[0] === "year" ? "yearly plans" : "monthly plans";
  return "paid plans";
}

/** Whether the discount runs for the plan's whole first year at this interval. */
export function offerCovers(o: Offer, interval: "month" | "year"): boolean {
  return o.intervals.length === 0 || o.intervals.includes(interval);
}

/** How long the discount lasts: "your first year" for 1 yearly or 12 monthly periods. */
export function offerTerm(o: Pick<Offer, "periods" | "intervals">): string {
  if (o.periods == null) return "every bill";
  const months = o.periods * (o.intervals.length === 1 && o.intervals[0] === "year" ? 12 : 1);
  return months === 12 ? "your first year" : `your first ${months} months`;
}
