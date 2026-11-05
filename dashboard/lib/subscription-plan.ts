import { INTERVAL_LABEL } from "@/lib/format";
import type { Subscription, SubscriptionItem } from "@/lib/api";

/**
 * The plan item, with the same fallback every list has used: a subscription whose
 * items carry no `plan` kind still has to render something, so the first item wins.
 */
export function planItem(s: Subscription): SubscriptionItem | undefined {
  return s.items?.find((i) => i.product_kind === "plan") ?? s.items?.[0];
}

/** Everything that is not the plan — what the "+N addons" badge counts. */
export function addonItems(s: Subscription): SubscriptionItem[] {
  const plan = planItem(s);
  return (s.items ?? []).filter((i) => i !== plan);
}

/** `<product> <currency> <interval>` — the label the subscriptions list is sorted and searched by. */
export function planLabel(s: Subscription): string {
  const plan = planItem(s);
  if (!plan) return s.id;
  return `${plan.product_name} ${s.currency}${plan.interval ? ` ${INTERVAL_LABEL[plan.interval] ?? plan.interval}` : ""}`;
}
