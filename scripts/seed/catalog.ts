/** Per-business catalog: plans, add-ons, charges, coupons, features, tax. */
import {
  createProduct,
  createPrice,
  setItemApplicablePlans,
  createProductGroup,
} from "@/modules/catalog/service";
import { createCoupon } from "@/modules/coupons/service";
import { createFeature, setPlanEntitlement } from "@/modules/entitlements/service";
import {
  configureIndiaGst,
  createFlatTaxRate,
  upsertTaxStateRegistration,
} from "@/modules/tax/service";
import { gstin } from "./people";

export type PlanKey = "starter" | "growth" | "pro" | "enterprise";
export const PLAN_LADDER: PlanKey[] = ["starter", "growth", "pro", "enterprise"];

/** Amounts in minor units of the business currency. */
export interface PriceBook {
  plans: Record<PlanKey, { month: number; year: number }>;
  seat: { month: number; year: number };
  /** Per 1k API calls. */
  usageUnit: number;
  setup: number;
  /** Stairstep bands: 1–10, 11–50, 51+ seats. */
  team: [number, number, number];
  /** Fixed-amount coupon, forever. */
  loyalOff: number;
}

export interface Catalog {
  /** price public ids */
  plan: Record<PlanKey, { month: string; year: string }>;
  seat: { month: string; year: string };
  usage: string;
  setup: string;
  team: string;
  coupons: { welcome: string; threeMonths: string; loyal: string; partner: string };
  partnerCap: number;
  productIds: Record<string, string>;
}

type Ctx = { organizationId: string; businessId: string };

const PLAN_NAMES: Record<PlanKey, string> = {
  starter: "Starter",
  growth: "Growth",
  pro: "Pro",
  enterprise: "Enterprise",
};

export async function createCatalog(ctx: Ctx, currency: string, book: PriceBook): Promise<Catalog> {
  const cur = currency.toLowerCase();
  const plansGroup = await createProductGroup({
    ...ctx,
    name: "Plans",
    id: "plans",
    description: "Recurring subscription plans",
  });
  const extrasGroup = await createProductGroup({
    ...ctx,
    name: "Add-ons & services",
    id: "extras",
    description: "Seats, usage and one-off services",
  });

  const productIds: Record<string, string> = {};
  const plan = {} as Catalog["plan"];
  for (const key of PLAN_LADDER) {
    const p = await createProduct({
      ...ctx,
      name: PLAN_NAMES[key],
      kind: "plan",
      id: key,
      productGroupPublicId: plansGroup.publicId,
    });
    productIds[key] = p.id;
    // Self-serve plans advertise a 14-day trial; signups always pass trial_days explicitly.
    const trial =
      key === "starter" || key === "growth"
        ? { trialPeriod: 14, trialPeriodUnit: "day" as const }
        : {};
    const month = await createPrice({
      ...ctx,
      productId: p.id,
      id: `${key}-monthly-${cur}`,
      name: `${PLAN_NAMES[key]} Monthly`,
      type: "recurring",
      model: "flat",
      currency,
      amountMinor: book.plans[key].month,
      interval: "month",
      ...trial,
    });
    const year = await createPrice({
      ...ctx,
      productId: p.id,
      id: `${key}-yearly-${cur}`,
      name: `${PLAN_NAMES[key]} Yearly`,
      type: "recurring",
      model: "flat",
      currency,
      amountMinor: book.plans[key].year,
      interval: "year",
    });
    plan[key] = { month: month.publicId, year: year.publicId };
  }
  // Stairstep: a flat price per seat band, on the Pro plan.
  const team = await createPrice({
    ...ctx,
    productId: productIds.pro!,
    id: `pro-team-${cur}`,
    name: "Pro Team (tiered)",
    type: "recurring",
    model: "stairstep",
    currency,
    interval: "month",
    tiers: [
      { upToMinor: 10, flatAmountMinor: book.team[0] },
      { upToMinor: 50, flatAmountMinor: book.team[1] },
      { upToMinor: null, flatAmountMinor: book.team[2] },
    ],
  });

  const seats = await createProduct({
    ...ctx,
    name: "Extra Seats",
    kind: "addon",
    id: "seats",
    productGroupPublicId: extrasGroup.publicId,
  });
  productIds.seats = seats.id;
  const seatM = await createPrice({
    ...ctx,
    productId: seats.id,
    id: `seats-monthly-${cur}`,
    name: "Per seat, monthly",
    type: "recurring",
    model: "per_unit",
    currency,
    amountMinor: book.seat.month,
    interval: "month",
  });
  const seatY = await createPrice({
    ...ctx,
    productId: seats.id,
    id: `seats-yearly-${cur}`,
    name: "Per seat, yearly",
    type: "recurring",
    model: "per_unit",
    currency,
    amountMinor: book.seat.year,
    interval: "year",
  });

  const api = await createProduct({
    ...ctx,
    name: "API Calls",
    kind: "addon",
    id: "api-calls",
    productGroupPublicId: extrasGroup.publicId,
  });
  productIds.api = api.id;
  const usage = await createPrice({
    ...ctx,
    productId: api.id,
    id: `api-calls-${cur}`,
    name: "Per 1k calls",
    type: "recurring",
    model: "usage",
    currency,
    amountMinor: book.usageUnit,
    interval: "month",
    usageAggregation: "sum",
  });

  const onboarding = await createProduct({
    ...ctx,
    name: "Onboarding",
    kind: "charge",
    id: "onboarding",
    productGroupPublicId: extrasGroup.publicId,
  });
  const setup = await createPrice({
    ...ctx,
    productId: onboarding.id,
    id: `onboarding-${cur}`,
    name: "One-time setup",
    type: "one_time",
    model: "flat",
    currency,
    amountMinor: book.setup,
  });

  for (const addon of ["seats", "api-calls"]) {
    await setItemApplicablePlans({
      ...ctx,
      itemPublicId: addon,
      planPublicIds: ["growth", "pro", "enterprise"],
    });
  }

  // Coupons: percent once, percent for 3 months, fixed forever, capped partner code.
  const partnerCap = 12;
  await createCoupon({
    ...ctx,
    code: "WELCOME10",
    name: "Welcome 10%",
    kind: "percentage",
    percentOffBps: 1000,
    durationType: "once",
  });
  await createCoupon({
    ...ctx,
    code: "SAVE15X3",
    name: "15% off for 3 months",
    kind: "percentage",
    percentOffBps: 1500,
    durationType: "repeating",
    durationInPeriods: 3,
  });
  await createCoupon({
    ...ctx,
    code: "LOYAL",
    name: "Loyalty discount",
    kind: "fixed_amount",
    amountOffMinor: book.loyalOff,
    currency,
    durationType: "forever",
  });
  await createCoupon({
    ...ctx,
    code: "PARTNER50",
    name: "Partner launch 50%",
    kind: "percentage",
    percentOffBps: 5000,
    durationType: "once",
    maxRedemptions: partnerCap,
  });

  // Features + plan entitlements.
  const calls = await createFeature({
    ...ctx,
    key: "api_calls",
    name: "API calls",
    type: "quota",
    unit: "calls/mo",
  });
  const sso = await createFeature({ ...ctx, key: "sso", name: "SSO", type: "switch" });
  const support = await createFeature({
    ...ctx,
    key: "priority_support",
    name: "Priority support",
    type: "switch",
  });
  const quota: Record<PlanKey, string> = {
    starter: "10000",
    growth: "100000",
    pro: "1000000",
    enterprise: "10000000",
  };
  for (const key of PLAN_LADDER) {
    await setPlanEntitlement({
      ...ctx,
      productId: productIds[key]!,
      featureId: calls.id,
      value: quota[key],
    });
  }
  for (const key of ["pro", "enterprise"] as const) {
    await setPlanEntitlement({
      ...ctx,
      productId: productIds[key]!,
      featureId: sso.id,
      value: "true",
    });
  }
  await setPlanEntitlement({
    ...ctx,
    productId: productIds.enterprise!,
    featureId: support.id,
    value: "true",
  });

  return {
    plan,
    seat: { month: seatM.publicId, year: seatY.publicId },
    usage: usage.publicId,
    setup: setup.publicId,
    team: team.publicId,
    coupons: {
      welcome: "WELCOME10",
      threeMonths: "SAVE15X3",
      loyal: "LOYAL",
      partner: "PARTNER50",
    },
    partnerCap,
    productIds,
  };
}

export type TaxSetup = "us" | "in" | "eu";

export async function createTax(ctx: Ctx, setup: TaxSetup): Promise<void> {
  if (setup === "us") {
    await createFlatTaxRate({
      ...ctx,
      name: "US-CA Sales Tax",
      country: "US",
      state: "CA",
      rateBps: 725,
    });
    await createFlatTaxRate({
      ...ctx,
      name: "US-NY Sales Tax",
      country: "US",
      state: "NY",
      rateBps: 400,
    });
    await createFlatTaxRate({
      ...ctx,
      name: "US-TX Sales Tax",
      country: "US",
      state: "TX",
      rateBps: 625,
    });
    return;
  }
  if (setup === "eu") {
    const vat: Array<[string, number]> = [
      ["DE", 1900],
      ["FR", 2000],
      ["NL", 2100],
      ["SE", 2500],
      ["ES", 2100],
    ];
    for (const [country, rateBps] of vat) {
      await createFlatTaxRate({ ...ctx, name: `${country} VAT`, country, rateBps });
    }
    return;
  }
  // India GST — the one regime that splits by place of supply: intra-state (CGST+SGST)
  // for Tamil Nadu customers, inter-state (IGST) for everyone else.
  const region = await configureIndiaGst({
    ...ctx,
    homeStateCode: "TN",
    cgstBps: 900,
    sgstBps: 900,
    registrationNumber: gstin("33", "AAACN0000X"),
  });
  await upsertTaxStateRegistration({
    ...ctx,
    regionPublicId: region.region.publicId,
    stateCode: "KA",
    stateName: "Karnataka",
    registrationNumber: gstin("29", "AAACN0000X"),
  });
}
