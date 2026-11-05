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
}

/** A plan the pricing page shows with no checkout (our Free plan): sign-up is the way in. */
interface DisplayPlan {
  name: string;
  description: string | null;
  currency: string;
  amount_minor: number | null;
  limit_minor: number | null;
}

/** The Free plan in one currency: its monthly billing band, from the catalogue. */
export interface FreePlan {
  name: string;
  currency: string;
  description: string | null;
  bandMinor: number | null;
}

export interface Plan {
  name: string;
  currency: string;
  interval: "month" | "year";
  amount: string;
  amountMinor: number;
  description: string | null;
}

/** The currency billing would charge this visitor in: India INR, the EU EUR, else USD. */
function currencyFor(country: string | undefined): string {
  if (country === "IN") return "INR";
  if (country && EU.has(country)) return "EUR";
  return "USD";
}

/** Cached for ten minutes: one catalogue read serves every visitor, whatever their currency. */
const fetchPlans = defineCachedFunction(
  async (base: string, business: string): Promise<{ plans: Plan[]; free: FreePlan[] }> => {
    const page = await $fetch<{ links: Link[]; display_plans?: DisplayPlan[] }>(
      `${base.replace(/\/+$/, "")}/checkout/v1/pricing/${encodeURIComponent(business)}`,
      { timeout: 5000 },
    );
    const free = (page.display_plans ?? [])
      .filter((p) => p.amount_minor === 0)
      .map((p) => ({
        name: p.name,
        currency: p.currency,
        description: p.description,
        bandMinor: p.limit_minor,
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
      }))
      .sort((a, b) => a.amountMinor - b.amountMinor);
    return { plans, free };
  },
  { maxAge: 600, name: "plans2", getKey: (_b: string, business: string) => business },
);

export default defineEventHandler(async (event) => {
  const { pricingApiUrl, pricingBusiness, public: pub } = useRuntimeConfig(event);
  // Cloud plans: a self-hosted docs build has no pricing page.
  if (pub.edition !== "cloud") throw createError({ statusCode: 404 });
  const country = visitorCountry(event);
  const preferred = currencyFor(country);
  const none = { available: false, preferred, plans: [] as Plan[], free: [] as FreePlan[] };
  if (!pricingApiUrl || !pricingBusiness) return none;
  try {
    const { plans, free } = await fetchPlans(pricingApiUrl, pricingBusiness);
    return { available: plans.length > 0, preferred, plans, free };
  } catch {
    return none;
  }
});
