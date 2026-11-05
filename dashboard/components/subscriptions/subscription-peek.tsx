"use client";

import * as React from "react";
import Link from "next/link";
import { StatusChip } from "@/components/patterns/chip";
import { PeekBadge } from "@/components/patterns/list-cells";
import { money } from "@/lib/format";
import { planLabel } from "@/lib/subscription-plan";
import type { Subscription, SubscriptionItem } from "@/lib/api";

/**
 * "+2 addons", naming the two on hover. The count on its own sent the reader into
 * the subscription to find out which addons those were.
 */
export function AddonPeek({
  items,
  currency,
}: {
  items: SubscriptionItem[];
  currency: string | null | undefined;
}) {
  if (items.length === 0) return null;
  return (
    <PeekBadge
      label={`+${items.length} addon${items.length > 1 ? "s" : ""}`}
      title={`Addons (${items.length})`}
    >
      {items.map((a, i) => (
        <span key={a.id ?? `${a.price}-${i}`} className="flex items-baseline gap-2">
          <span className="text-sm">{a.product_name ?? a.price}</span>
          {a.quantity > 1 ? (
            <span className="text-xs text-muted-foreground tabular-nums">×{a.quantity}</span>
          ) : null}
          {a.unit_price_minor != null && currency ? (
            <span className="ml-auto text-xs text-muted-foreground tabular-nums">
              {money(a.unit_price_minor * (a.quantity || 1), currency)}
            </span>
          ) : null}
        </span>
      ))}
    </PeekBadge>
  );
}

/**
 * "+2 more" on a customer row whose Subscription Info column can only show one.
 * Each line is the real subscription — its status and a link — because the point of
 * knowing a customer has three is being able to open the one you meant.
 */
export function MoreSubscriptionsPeek({ biz, subs }: { biz: string; subs: Subscription[] }) {
  if (subs.length === 0) return null;
  return (
    <PeekBadge label={`+${subs.length} more`} title={`Other subscriptions (${subs.length})`}>
      {subs.map((s) => (
        <span key={s.id} className="flex items-center gap-2">
          <StatusChip status={s.status} />
          <Link
            href={`/businesses/${biz}/subscriptions/${s.id}`}
            className="max-w-56 truncate text-sm text-primary hover:underline"
            title={planLabel(s)}
          >
            {planLabel(s)}
          </Link>
        </span>
      ))}
    </PeekBadge>
  );
}
