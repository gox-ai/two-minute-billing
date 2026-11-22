/**
 * The billing models a business can have, and the shelves Stats and Explore group by.
 * Pure data: the engine decides which models a business has
 * (`GET /v1/businesses/{biz}/billing_models`) and which shelf a measure sits on (`model`).
 */
export type BillingModelId = "subscriptions" | "one_time" | "usage" | "credits";
export type ModelGroupId = "all" | BillingModelId | "payments";

export const MODEL_GROUP_ORDER: ModelGroupId[] = [
  "all",
  "subscriptions",
  "one_time",
  "usage",
  "credits",
  "payments",
];

export const MODEL_GROUP_LABELS: Record<ModelGroupId, string> = {
  all: "All models",
  subscriptions: "Subscriptions",
  one_time: "One-time sales",
  usage: "Usage",
  credits: "Credits",
  payments: "Payments",
};

/** What the business has no figures for, in a sentence: "no <noun> in the last 90 days". */
export const MODEL_NOUNS: Record<BillingModelId, string> = {
  subscriptions: "subscriptions",
  one_time: "one-time sales",
  usage: "metered usage",
  credits: "credits",
};

/**
 * Whether a business has a model. `null` (the detector did not answer) says yes: a hidden
 * page is worse than one that shows zeros.
 */
export function hasModel(models: readonly string[] | null | undefined, model: BillingModelId) {
  return models == null || models.includes(model);
}

/** A shelf is "not used" when it is a model the business does not have. */
export function groupIsAbsent(group: ModelGroupId, models: readonly string[] | null | undefined) {
  return group !== "all" && group !== "payments" && !hasModel(models, group);
}

/** Unknown future shelf ids fall under "All models". */
export function asModelGroup(v: string | undefined): ModelGroupId {
  return (MODEL_GROUP_ORDER as string[]).includes(v ?? "") ? (v as ModelGroupId) : "all";
}

/** The one fold for models the business does not use. */
export const ABSENT_MODELS_LABEL = "Not used by this business";

/** The heading a measure sits under: its model, or the one fold for an absent model. */
export function modelSection(
  raw: string | undefined,
  models: readonly string[] | null | undefined,
) {
  const group = asModelGroup(raw);
  const absent = groupIsAbsent(group, models);
  return {
    group,
    modelLabel: MODEL_GROUP_LABELS[group],
    absent,
    section: absent ? ABSENT_MODELS_LABEL : MODEL_GROUP_LABELS[group],
  };
}

/** The model each starter segment needs. A key not listed works for every business. */
export const STARTER_SEGMENT_MODEL: Record<string, BillingModelId> = {
  active: "subscriptions",
  trialing: "subscriptions",
  cancelled: "subscriptions",
  annual_plans: "subscriptions",
  high_mrr: "subscriptions",
  low_mrr: "subscriptions",
  multi_subscription: "subscriptions",
  recently_cancelled: "subscriptions",
  low_credit: "credits",
  credits_expiring: "credits",
  usage_stopped: "usage",
  repeat_buyers: "one_time",
  one_time_buyers: "one_time",
  lapsed_buyers: "one_time",
};

/** Whether a starter segment makes sense for a business with these models. */
export function starterApplies(key: string | null, models: readonly string[] | null | undefined) {
  const need = key ? STARTER_SEGMENT_MODEL[key] : undefined;
  return need == null || hasModel(models, need);
}
