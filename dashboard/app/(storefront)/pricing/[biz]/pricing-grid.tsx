"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { SEGMENT_TRACK, segmentItem } from "@/components/ui/segmented";
import { useDefaultState } from "@/lib/use-default-state";
import {
  cadenceLabel,
  cadenceSuffix,
  optionFor,
  savingLabel,
  yearlySaving,
  type PricedLink,
  type ProductCard,
} from "./plans";

/**
 * The plan cards with one cadence switch over them. Each card is one product; the switch
 * picks which of its prices it shows. A product not sold at the selected cadence keeps its
 * own, and its card says which.
 */
export function PlanGrid({ plans, cadences }: { plans: ProductCard[]; cadences: string[] }) {
  const [cadence, setCadence] = useDefaultState<string>(
    cadences.includes("month:1") ? "month:1" : (cadences[0] ?? ""),
  );
  const best = Math.max(0, ...plans.map((p) => yearlySaving(p)?.percent ?? 0));
  return (
    <div className="flex flex-col gap-4">
      {cadences.length > 1 ? (
        <div className="flex justify-center">
          <div role="group" aria-label="Billing period" className={SEGMENT_TRACK}>
            {cadences.map((c) => (
              <button
                key={c}
                type="button"
                aria-pressed={c === cadence}
                className={segmentItem(c === cadence)}
                onClick={() => setCadence(c)}
              >
                {cadenceLabel(c)}
                {c === "year:1" && best >= 1 ? (
                  <span className="text-xs text-muted-foreground">Save up to {best}%</span>
                ) : null}
              </button>
            ))}
          </div>
        </div>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {plans.map((p) => {
          const { cadence: shown, link } = optionFor(p, cadence);
          const saving = shown === "year:1" ? yearlySaving(p) : null;
          return (
            <ProductTile key={p.key} card={p} link={link} cadence={shown}>
              {saving ? (
                <p className="text-sm text-muted-foreground">Save {savingLabel(saving)} a year</p>
              ) : null}
            </ProductTile>
          );
        })}
      </div>
    </div>
  );
}

/** One product's card: picture, name, description, price and the button to its checkout. */
export function ProductTile({
  card,
  link,
  cadence,
  primary = true,
  children,
}: {
  card: ProductCard;
  link: PricedLink;
  cadence: string;
  /** Plans carry the filled button; one-time products the outline one. */
  primary?: boolean;
  children?: React.ReactNode;
}) {
  const price = link.price;
  const model = price.model ?? "flat";
  const fixed = price.amount_minor != null && (model === "flat" || model === "per_unit");
  return (
    <div className="flex flex-col gap-4 rounded-xl border bg-card p-5">
      {card.image_url ? (
        // eslint-disable-next-line @next/next/no-img-element -- a merchant image on our CDN
        <img
          src={card.image_url}
          alt=""
          className="aspect-4/3 w-full rounded-md border bg-muted/50 object-cover"
        />
      ) : null}
      <div className="flex flex-col gap-1">
        <h3 className="text-lg font-semibold">{card.name}</h3>
        {card.description ? (
          <p className="text-sm text-muted-foreground">{card.description}</p>
        ) : null}
      </div>
      <div className="flex flex-col gap-1">
        {fixed ? (
          <div className="flex flex-wrap items-baseline gap-x-1.5">
            <span className="text-2xl font-semibold tabular-nums">{price.amount}</span>
            <span className="text-sm text-muted-foreground">
              {model === "per_unit" ? "per unit " : ""}
              {cadenceSuffix(cadence)}
            </span>
          </div>
        ) : (
          // A metered or tiered price has no one figure: the checkout shows the real one.
          <div className="flex flex-wrap items-baseline gap-x-1.5">
            <span className="text-lg font-semibold">
              {model === "usage" ? "Price based on use" : "Price based on quantity"}
            </span>
            <span className="text-sm text-muted-foreground">{cadenceSuffix(cadence)}</span>
          </div>
        )}
        {children}
      </div>
      <Button asChild variant={primary ? "default" : "outline"} className="mt-auto">
        <a data-document-link href={`/buy/${link.id}`}>
          {link.mode === "create" ? "Subscribe" : "Buy"}
        </a>
      </Button>
    </div>
  );
}

/** One-time products under their own heading, so they do not read as a fourth plan. */
export function OneTimeGrid({ items }: { items: ProductCard[] }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-semibold">One-time purchases</h2>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {items.map((p) => {
          const { cadence, link } = optionFor(p, null);
          return <ProductTile key={p.key} card={p} link={link} cadence={cadence} primary={false} />;
        })}
      </div>
    </section>
  );
}
