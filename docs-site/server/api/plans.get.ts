/**
 * Our Cloud plans for /pricing, read live from our own catalogue: the public pricing page of
 * the business that sells them (NUXT_PRICING_API_URL + NUXT_PRICING_BUSINESS, set on the
 * docs host). Prices are never typed into the site.
 */
import { EU, visitorCountry } from "../lib/regions";

interface Link {
  name: string;
  description: string | null;
  price: { amount: string; currency: string; amount_minor: number | null; interval: string | null };
  /** Assistant use the plan includes each month, in US cents for every currency. */
  assistant_allowance_usd_cents?: number | null;
  assistant_credits?: number | null;
}

/** A plan the pricing page shows with no checkout (our Free plan): sign-up is the way in. */
interface DisplayPlan {
  name: string;
  description: string | null;
  currency: string;
  amount_minor: number | null;
  limit_minor: number | null;
  assistant_allowance_usd_cents?: number | null;
  assistant_credits?: number | null;
}

/** The Free plan in one currency: its monthly billing band, from the catalogue. */
export interface FreePlan {
  name: string;
  currency: string;
  description: string | null;
  bandMinor: number | null;
  /** Billy use included each month, in US cents whatever the plan's currency. */
  assistantUsdCents: number | null;
  /** Billy credits a month (1 credit ≈ 1 question), as members see them. */
  assistantCredits: number | null;
}

export interface Plan {
  name: string;
  currency: string;
  interval: "month" | "year";
  amount: string;
  amountMinor: number;
  description: string | null;
  /** Billy use included each month, in US cents whatever the plan's currency. */
  assistantUsdCents: number | null;
  /** Billy credits a month (1 credit ≈ 1 question), as members see them. */
  assistantCredits: number | null;
}

/**
 * A running campaign on our plans, from the catalogue (a coupon marked for the pricing page).
 * `periods` billing periods of `intervals` plans at `percentOff` off; `endsOn` is its last day.
 */
export interface Offer {
  name: string;
  percentOff: number;
  periods: number | null;
  intervals: Array<"month" | "year">;
  endsAt: string;
  endsOn: string;
}

/** The currency billing would charge this visitor in: India INR, the EU EUR, else USD. */
function currencyFor(country: string | undefined): string {
  if (country === "IN") return "INR";
  if (country && EU.has(country)) return "EUR";
  return "USD";
}

/** Cached for ten minutes: one catalogue read serves every visitor, whatever their currency. */
const fetchPlans = defineCachedFunction(
  async (
    base: string,
    business: string,
  ): Promise<{ plans: Plan[]; free: FreePlan[]; offers: Offer[] }> => {
    const page = await $fetch<{
      links: Link[];
      display_plans?: DisplayPlan[];
      offers?: Array<{
        name: string;
        percent_off: number;
        periods: number | null;
        intervals: string[];
        ends_at: string;
        ends_on: string;
      }>;
    }>(`${base.replace(/\/+$/, "")}/checkout/v1/pricing/${encodeURIComponent(business)}`, {
      timeout: 5000,
    });
    const free = (page.display_plans ?? [])
      .filter((p) => p.amount_minor === 0)
      .map((p) => ({
        name: p.name,
        currency: p.currency,
        description: p.description,
        bandMinor: p.limit_minor,
        assistantUsdCents: p.assistant_allowance_usd_cents ?? null,
        assistantCredits: p.assistant_credits ?? null,
      }));
    const plans = page.links
      .filter(
        (l) =>
          l.price.amount_minor != null &&
          (l.price.interval === "month" || l.price.interval === "year"),
      )
      .map((l) => ({
        name: l.name,
        currency: l.price.currency,
        interval: l.price.interval as "month" | "year",
        amount: l.price.amount,
        amountMinor: l.price.amount_minor!,
        description: l.description,
        assistantUsdCents: l.assistant_allowance_usd_cents ?? null,
        assistantCredits: l.assistant_credits ?? null,
      }))
      .sort((a, b) => a.amountMinor - b.amountMinor);
    const offers = (page.offers ?? []).map((o) => ({
      name: o.name,
      percentOff: o.percent_off,
      periods: o.periods,
      intervals: o.intervals.filter((i): i is "month" | "year" => i === "month" || i === "year"),
      endsAt: o.ends_at,
      endsOn: o.ends_on,
    }));
    return { plans, free, offers };
  },
  { maxAge: 600, name: "plans5", getKey: (_b: string, business: string) => business },
);

export default defineEventHandler(async (event) => {
  const { pricingApiUrl, pricingBusiness, public: pub } = useRuntimeConfig(event);
  // Cloud plans: a self-hosted docs build has no pricing page.
  if (pub.edition !== "cloud") throw createError({ statusCode: 404 });
  const country = visitorCountry(event);
  const preferred = currencyFor(country);
  const none = {
    available: false,
    preferred,
    plans: [] as Plan[],
    free: [] as FreePlan[],
    offers: [] as Offer[],
  };
  if (!pricingApiUrl || !pricingBusiness) return none;
  try {
    const { plans, free, offers } = await fetchPlans(pricingApiUrl, pricingBusiness);
    // The catalogue read is cached, so an offer that ended since is dropped here.
    const now = Date.now();
    return {
      available: plans.length > 0,
      preferred,
      plans,
      free,
      offers: offers.filter((o) => Date.parse(o.endsAt) > now),
    };
  } catch {
    return none;
  }
});
