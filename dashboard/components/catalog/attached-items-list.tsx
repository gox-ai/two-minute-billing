"use client";

import * as React from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { ActionButton } from "@/components/action-button";
import { AttachAddonModal } from "@/components/catalog/attach-addon-modal";
import { detachItemFromPlanAction } from "@/app/(dashboard)/businesses/[biz]/catalog/products/[prod]/actions";
import type { AttachedItemConfig, Product } from "@/lib/api";

/**
 * WHY an item is applicable to this plan. It is not decoration: it decides which
 * controls we are allowed to render, because only ONE of the three is backed by an
 * `attached_items` row that Detach can delete.
 *
 * - `attached`     — a real `attached_items` row. Edit and Detach both write.
 * - `all_plans`    — the addon carries `products.addon_applies_to_all`, so it applies
 *                    to every plan with no row at all. Detach rewrites the row set,
 *                    which cannot clear that flag — it used to redirect with
 *                    "Item detached" while the row stayed put.
 * - `differential` — implied by a plan-specific differential price (the engine treats
 *                    a differential as applicability; see
 *                    `listItemApplicablePlans` in src/modules/catalog/service.ts).
 *                    Deleting the row set leaves the implication intact, so Detach is
 *                    a no-op here too.
 */
export type AttachedVia = "attached" | "all_plans" | "differential";

export interface AttachedRow {
  item: Product;
  /**
   * The config the READ path reports for this plan, or null when nothing is stored
   * (an `all_plans` item with no row). Null renders NO config badges — the previous
   * version substituted `{optional, subscription_creation, false, 1, null}` client-side,
   * so the row asserted stored config that was not stored anywhere.
   */
  config: AttachedItemConfig | null;
  via: AttachedVia;
  /**
   * Does a quantity mean anything for this item's pricing (`quantityAppliesByProduct`)?
   * False for a flat-fee item, whose Default-quantity field is omitted from the
   * config modal — the engine ignores quantity when rating a flat price and refuses
   * any value but 1 at subscription-create time.
   */
  quantityApplies: boolean;
}

const CHARGE_EVENT_LABELS: Record<string, string> = {
  subscription_creation: "On creation",
  trial_start: "On trial start",
  activation: "On activation",
  on_demand: "On demand",
};

/**
 * A plan's applicable items are split into separate **Addons** and **Charges**
 * sub-lists, each with its own "Search for ID / Name" box and a "Showing 1 – N of N"
 * count. Both lists are bounded (a business's catalog is tens of items, and the parent
 * already fetched them all), so search and counting are client-side — the §6 list
 * policy only mandates a server cursor for lists that can plausibly reach thousands of
 * rows.
 */
export function AttachedItemsList({
  biz,
  plan,
  rows,
}: {
  biz: string;
  plan: string;
  rows: AttachedRow[];
}) {
  const addons = rows.filter((r) => (r.item.kind ?? "addon") !== "charge");
  const charges = rows.filter((r) => r.item.kind === "charge");
  return (
    <div className="space-y-8">
      <ItemSection
        biz={biz}
        plan={plan}
        title="Addons"
        rows={addons}
        empty="No addons apply to this plan. Add one to this plan so that subscriptions can use it."
      />
      <ItemSection
        biz={biz}
        plan={plan}
        title="One-time products"
        rows={charges}
        empty="No charges apply to this plan."
      />
    </div>
  );
}

function ItemSection({
  biz,
  plan,
  title,
  rows,
  empty,
}: {
  biz: string;
  plan: string;
  title: string;
  rows: AttachedRow[];
  empty: string;
}) {
  const [query, setQuery] = React.useState("");
  const needle = query.trim().toLowerCase();
  const shown = needle
    ? rows.filter(
        (r) =>
          r.item.id.toLowerCase().includes(needle) || r.item.name.toLowerCase().includes(needle),
      )
    : rows;

  return (
    <section>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-sm font-medium">{title}</h3>
        {rows.length > 0 ? (
          <div className="flex items-center gap-3">
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search for ID / Name"
              aria-label={`Search ${title.toLowerCase()} by ID or name`}
              className="h-8 w-56"
            />
            <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
              {shown.length > 0
                ? `Showing 1 – ${shown.length} of ${rows.length}`
                : `Showing 0 of ${rows.length}`}
            </span>
          </div>
        ) : null}
      </div>

      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{empty}</p>
      ) : shown.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No {title.toLowerCase()} match “{query.trim()}”.
        </p>
      ) : (
        <ul className="divide-y border-t">
          {shown.map((row) => (
            <ItemRow key={row.item.id} biz={biz} plan={plan} row={row} />
          ))}
        </ul>
      )}
    </section>
  );
}

function ItemRow({ biz, plan, row }: { biz: string; plan: string; row: AttachedRow }) {
  const { item, config, via, quantityApplies } = row;
  // Detach rewrites the attached_items row set. That only removes applicability when
  // the row set is the ONLY thing making this item applicable.
  const detachable = via === "attached";

  return (
    <li className="flex flex-col gap-2 py-3 sm:flex-row sm:items-start sm:justify-between sm:gap-3">
      <div className="flex min-w-0 flex-col gap-1">
        <span className="flex flex-wrap items-center gap-2 text-sm font-medium">
          <Link
            href={`/businesses/${biz}/catalog/products/${item.id}`}
            className="text-primary hover:underline"
          >
            {item.name}
          </Link>
          {via === "all_plans" ? (
            <Badge variant="outline" className="text-xs">
              All plans
            </Badge>
          ) : null}
          {via === "differential" ? (
            <Badge variant="outline" className="text-xs">
              Via differential price
            </Badge>
          ) : null}
        </span>
        <span className="font-mono text-xs text-muted-foreground">{item.id}</span>
        {config ? (
          <span className="flex flex-wrap gap-1.5">
            <Badge
              variant={config.applicability === "mandatory" ? "default" : "secondary"}
              className="text-xs capitalize"
            >
              {config.applicability}
            </Badge>
            {item.kind === "charge" ? (
              <Badge variant="secondary" className="text-xs">
                {CHARGE_EVENT_LABELS[config.chargeOnEvent] ?? config.chargeOnEvent}
              </Badge>
            ) : null}
            {config.chargeOnce ? (
              <Badge variant="secondary" className="text-xs">
                Once
              </Badge>
            ) : null}
            {config.defaultQuantity !== 1 ? (
              <Badge variant="outline" className="text-xs">
                Qty {config.defaultQuantity}
              </Badge>
            ) : null}
            {config.billingCycles != null ? (
              <Badge variant="outline" className="text-xs">
                {config.billingCycles} cycle{config.billingCycles !== 1 ? "s" : ""}
              </Badge>
            ) : null}
            {config.customerCanChangeQuantity === false ? (
              <Badge variant="outline" className="text-xs">
                Portal: fixed quantity
              </Badge>
            ) : config.minQuantity != null ||
              config.maxQuantity != null ||
              config.quantityStep > 1 ? (
              <Badge variant="outline" className="text-xs">
                Portal:{" "}
                {config.maxQuantity != null
                  ? `${config.minQuantity ?? 1} to ${config.maxQuantity}`
                  : `${config.minQuantity ?? 1} or more`}
                {config.quantityStep > 1 ? `, step ${config.quantityStep}` : ""}
              </Badge>
            ) : null}
          </span>
        ) : null}
        {via === "all_plans" ? (
          <p className="text-xs text-muted-foreground">
            Applies to every plan in this business. The setting is on the addon, not here.{" "}
            <Link
              href={`/businesses/${biz}/catalog/products/${item.id}/edit`}
              className="text-primary hover:underline"
            >
              Edit {item.name}
            </Link>{" "}
            to disable “Applies to all plans”.
          </p>
        ) : null}
        {via === "differential" ? (
          <p className="text-xs text-muted-foreground">
            Applies because this item has a differential price for this plan.{" "}
            <Link
              href={`/businesses/${biz}/catalog/products/${item.id}?plan=${plan}`}
              className="text-primary hover:underline"
            >
              Manage differential pricing
            </Link>{" "}
            to remove the link.
          </p>
        ) : null}
      </div>

      <div className="flex shrink-0 items-center gap-1">
        <AttachAddonModal
          biz={biz}
          plan={plan}
          addons={[]}
          editItem={item}
          editConfig={config ?? undefined}
          quantityApplies={{ [item.id]: quantityApplies }}
          note={
            via === "attached"
              ? undefined
              : via === "all_plans"
                ? "This addon applies to every plan. Save keeps a configuration for THIS plan only. It does not change the “Applies to all plans” setting."
                : "This addon applies through its differential price for this plan. Save keeps an explicit configuration for it."
          }
          trigger={
            <button
              type="button"
              className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              {config ? "Edit" : "Configure"}
            </button>
          }
        />
        {detachable ? (
          <ActionButton
            resultAction={detachItemFromPlanAction}
            fields={{ biz, plan, addon: item.id }}
            label="Remove"
            variant="ghost"
            size="sm"
            confirm={{
              title: "Remove item?",
              description: `${item.name} will not apply to this plan.`,
              confirmLabel: "Remove",
              destructive: true,
            }}
          />
        ) : null}
      </div>
    </li>
  );
}
