"use client";

import * as React from "react";
import { useState } from "react";
import Link from "next/link";
import type { ItemConstraint } from "@/lib/api/coupons";
import { periodSuffix } from "@/lib/coupon-scope";

const KIND_LABEL: Record<string, string> = { plan: "plans", addon: "add-ons", charge: "charges" };

/**
 * One Discount-Details row per item kind for an `each_specified_item` coupon: what the
 * coupon is scoped to, and — for `specific` — a disclosure listing the products by name.
 *
 * A kind with NO constraint row reads "None", not "All": the engine's `couponMatchesLine`
 * requires a matching row and treats absence as an implicit none.
 */
export function CouponScopeRow({
  kind,
  constraint,
  names,
  changeHref,
  facts,
}: {
  kind: "plan" | "addon" | "charge";
  constraint?: ItemConstraint;
  /** Product or price id → display name, for the ids stored on a `specific` constraint. */
  names: Record<string, string>;
  /** Omitted once the coupon has been redeemed — the engine refuses the change, so
   *  offering the link would be a control that does nothing. */
  changeHref?: string;
  /** Render as a bare dt/dd pair for a record page's `Facts` grid. */
  facts?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const plural = KIND_LABEL[kind];
  const type = constraint?.constraint_type ?? "none";
  const ids = [...(constraint?.product_ids ?? []), ...(constraint?.price_ids ?? [])];
  const nProducts = constraint?.product_ids?.length ?? 0;
  const nPrices = constraint?.price_ids?.length ?? 0;
  const periods = type === "none" ? "" : periodSuffix(constraint?.billing_periods ?? []);

  const Wrap = facts ? React.Fragment : "div";
  return (
    <Wrap>
      <dt
        className={
          facts
            ? "text-muted-foreground first-letter:uppercase"
            : "text-xs font-medium text-muted-foreground first-letter:uppercase"
        }
      >
        {plural}
      </dt>
      <dd
        className={
          facts
            ? "m-0 flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1"
            : "mt-0.5 flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm"
        }
      >
        <span>
          {type === "all"
            ? `All ${plural} are applicable${periods}`
            : type === "specific"
              ? `Specific ${plural} are applicable${periods}`
              : "None"}
        </span>
        {changeHref ? (
          <Link href={changeHref} className="text-primary hover:underline">
            Change
          </Link>
        ) : null}
        {type === "specific" ? (
          <span className="basis-full">
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              className="text-xs text-primary hover:underline"
              aria-expanded={open}
            >
              {[
                nProducts
                  ? `${nProducts} ${nProducts === 1 ? plural.replace(/s$/, "") : plural}`
                  : null,
                nPrices ? `${nPrices} ${nPrices === 1 ? "price" : "prices"}` : null,
              ]
                .filter(Boolean)
                .join(" and ") || `0 ${plural}`}{" "}
              added
            </button>
            {open ? (
              <span className="mt-1 flex flex-wrap gap-1.5">
                {ids.length === 0 ? (
                  <span className="text-xs text-muted-foreground">
                    Nothing is selected. This coupon does not discount any {plural}.
                  </span>
                ) : (
                  ids.map((id) => (
                    <span
                      key={id}
                      className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-xs"
                      // A stored id whose product is gone still shows the id, rather
                      // than an empty chip that hides what the coupon is scoped to.
                      title={
                        names[id]
                          ? id
                          : constraint?.price_ids?.includes(id)
                            ? "Price"
                            : "This catalog does not have this product"
                      }
                    >
                      {names[id] ?? id}
                    </span>
                  ))
                )}
              </span>
            ) : null}
          </span>
        ) : null}
      </dd>
    </Wrap>
  );
}
