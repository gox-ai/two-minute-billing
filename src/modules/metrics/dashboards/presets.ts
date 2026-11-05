import { measureById } from "@/modules/metrics/daily/measures";
import type { TileSize } from "./service";
import type { BillingModel } from "@/modules/metrics/billing-models";

/**
 * The dashboards every business has on day one.
 *
 * A saved-dashboard feature that starts empty asks the operator to know our catalogue
 * before it is worth anything — 97 reports, and a blank page with an "Add report" button.
 * These five are the answer to "what would a competent person put on the wall", one per
 * job rather than one per taste, and they are what the Dashboards page opens on.
 *
 * **Declared in code, not seeded rows.** A preset is not data:
 *  - every business gets all five the moment it exists, including one created tomorrow —
 *    no per-tenant seed, no backfill, nothing to go missing on a restore;
 *  - a preset cannot be half-deleted into a broken state, because there is nothing to
 *    delete. It is read-only by construction rather than by a permission check;
 *  - when a report is renamed or retired, a preset follows the registry automatically —
 *    a seeded row would still name the old key and would have to be migrated.
 *
 * This is the same shape `list_views` already uses: an operator's saved views sit
 * alongside built-in ones, and nobody has to have built a view to have a useful list.
 *
 * Customising one is a COPY: a preset has no owner, so "make it mine" creates an ordinary
 * saved dashboard with the same tiles. That is deliberate — an editable preset would drift
 * per business and stop being a shared vocabulary between two people comparing screens.
 *
 * ⚠️ Every `report` here must be a live registry key. `assertPresetsAreWellFormed()` is
 * called by the gate rather than at import time, so a bad key fails a build step instead
 * of taking the API down on boot.
 */

export interface PresetTile {
  report: string;
  /** DEPRECATED — a width preset; the width it means is derived from it. */
  size?: TileSize;
  /** Rows of 80px. Omitted, the preset stands at the default height. */
  heightUnits?: number;
  /** Pin an option. Omitted, the tile follows whatever the request or the report defaults to. */
  range?: string;
  granularity?: string;
  groupBy?: string;
  shape?: "series" | "totals";
}

export interface PresetDashboard {
  /** Stable id, exposed as the dashboard's public id so a link survives a rename. */
  key: string;
  name: string;
  /** One sentence: who this is for and what question it answers. */
  description: string;
  tiles: ReadonlyArray<PresetTile>;
  /** Listed only for a business that has this model (`billingModelsPresent`). */
  requires?: BillingModel;
}

/**
 * **Business overview** — the one a founder opens on Monday.
 *
 * Level first (MRR, ARR), then the movement that produced it, then retention as a rate.
 * Deliberately short: a dashboard that needs scrolling to reach the number you came for is
 * a report list with extra steps.
 */
const OVERVIEW: PresetDashboard = {
  key: "overview",
  name: "Business overview",
  description: "The headline numbers and what moved them, for a weekly read.",
  tiles: [
    { report: "mrr", size: "md" },
    { report: "cmrr", size: "md" },
    { report: "paying_subscriptions", size: "md" },
    { report: "renewing_subscriptions", size: "md" },
    { report: "active_subscriptions", size: "md" },
    { report: "mrr_new", size: "md" },
    { report: "mrr_churn", size: "md" },
    { report: "mrr", groupBy: "plan", size: "full" },
  ],
};

/**
 * **What moved it** — the six flows that turn last month's book into this one.
 *
 * All six, never five: a pause is not churn, and a waterfall missing one of them does not
 * add up. Contraction sits beside churn because a downgrade is a partial loss a churn
 * figure alone never shows.
 */
// A split tile draws a matrix: one row per slice, one column per period. Twelve periods
// plus the label is 13 columns, which does not fit in 9 of 12 and scrolls sideways inside
// its own card. Grouped tiles take the full width.
const MOVEMENT: PresetDashboard = {
  key: "movement",
  name: "What moved it",
  description: "Every change to recurring revenue, and which plans produced it.",
  tiles: [
    { report: "mrr_new", size: "md" },
    { report: "mrr_expansion", size: "md" },
    { report: "mrr_reactivation", size: "md" },
    { report: "mrr_contraction", size: "md" },
    { report: "mrr_churn", size: "md" },
    { report: "mrr_paused", size: "md" },
    { report: "mrr_churn", groupBy: "plan", size: "full" },
    { report: "mrr_expansion", groupBy: "plan", size: "full" },
  ],
};

/**
 * **Lifecycle** — subscriptions and customers arriving, converting and leaving.
 *
 * Counted as events over a window, not read at an instant: "how many activated in March"
 * is a different question from "how many are active", and putting the two on one screen
 * is how they get quoted as if they were the same figure.
 */
const LIFECYCLE: PresetDashboard = {
  key: "lifecycle",
  name: "Lifecycle",
  description: "Signups, trials, activations and cancellations over a window.",
  tiles: [
    { report: "customers_created", size: "md" },
    { report: "activations", size: "md" },
    { report: "trials_started", size: "md" },
    { report: "subscription_cancellations", size: "md" },
    { report: "subscriptions_total", size: "md" },
    { report: "subscription_quantity", size: "md" },
    { report: "trials_cumulative", size: "md" },
    { report: "activations", groupBy: "currency", size: "full" },
  ],
};

/**
 * ⚠️ **Billing & cash** and **Collections** used to be presets here and are deliberately
 * gone. Every tile on them — billing, payments, tax, receivables, ageing, dunning, refunds,
 * recovery — was a report key, and the semantic layer publishes no measure for any of them
 * yet. A preset whose tiles cannot be answered is a wall of errors on the screen an
 * operator opens by default, which is the one thing a default dashboard must never do.
 * Restore both the moment those measures exist; the tile lists are in this file's history.
 */

/** **Credits** — prepaid and AI credit: what is held, sold, used and lost to expiry. */
const CREDITS: PresetDashboard = {
  key: "credits",
  name: "Credits",
  description: "Credit held, granted, used and expired, and the revenue it turns into.",
  requires: "credits",
  tiles: [
    { report: "credits_outstanding", size: "md" },
    { report: "credits_liability", size: "md" },
    { report: "credits_granted", size: "md" },
    { report: "credits_used", size: "md" },
    { report: "credits_used_cost", size: "md" },
    { report: "credit_breakage", size: "md" },
    { report: "credits_granted", groupBy: "credit_source", size: "full" },
  ],
};

/** **Usage** — metered usage: what it earned, how much was sent, and by which meter. */
const USAGE: PresetDashboard = {
  key: "usage",
  name: "Usage",
  description: "Usage revenue, events and customers, by meter, with what usage cost.",
  requires: "usage",
  tiles: [
    { report: "revenue_billed", groupBy: "meter", size: "full" },
    { report: "usage_events", size: "md" },
    { report: "usage_customers", size: "md" },
    { report: "usage_cost", size: "md" },
    { report: "usage_revenue_retention", size: "md" },
    { report: "usage_events", groupBy: "meter", size: "full" },
  ],
};

/** **One-time sales** — orders, what they are worth and who comes back. */
const SALES: PresetDashboard = {
  key: "sales",
  name: "One-time sales",
  description: "Orders, order revenue and value, buyers and returning buyers, by product.",
  requires: "one_time",
  tiles: [
    { report: "orders", size: "md" },
    { report: "order_revenue", size: "md" },
    { report: "average_order_value", size: "md" },
    { report: "buyers", size: "md" },
    { report: "returning_buyer_rate", size: "md" },
    { report: "order_refunds", size: "md" },
    { report: "order_revenue", groupBy: "product", size: "full" },
  ],
};

export const PRESET_DASHBOARDS: ReadonlyArray<PresetDashboard> = [
  OVERVIEW,
  MOVEMENT,
  LIFECYCLE,
  CREDITS,
  USAGE,
  SALES,
];

/** `dash_preset_<key>` — a public id shaped like any other, so a link is a link. */
export const presetPublicId = (key: string) => `dash_preset_${key}`;

export const PRESET_BY_PUBLIC_ID = new Map(
  PRESET_DASHBOARDS.map((p) => [presetPublicId(p.key), p] as const),
);

/** The one the Dashboards page opens on when the operator has no default of their own. */
export const DEFAULT_PRESET = OVERVIEW;

/**
 * Every preset tile names a live MEASURE, and its pinned options are ones that measure will
 * honour. Called from the gate: a preset with a dead key renders a wall of "there is no
 * measure called …", which is the one thing a default dashboard must never do.
 *
 * ⚠️ This used to validate against the REPORT registry. A dashboard resolves its tiles
 * through the semantic layer, so the check passed against a registry nobody reads any more
 * while all five presets rendered zero figures — a green gate over a dead screen. Validate
 * against the thing that actually answers the tile.
 */
export function assertPresetsAreWellFormed(): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const p of PRESET_DASHBOARDS) {
    if (seen.has(p.key)) problems.push(`duplicate preset key: ${p.key}`);
    seen.add(p.key);
    if (p.tiles.length === 0) problems.push(`${p.key}: has no tiles`);
    for (const t of p.tiles) {
      const def = measureById(t.report);
      if (!def) {
        problems.push(`${p.key}: no such measure "${t.report}"`);
        continue;
      }
      if (t.groupBy && !(def.dimensions as readonly string[]).includes(t.groupBy)) {
        problems.push(`${p.key}: ${t.report} cannot be grouped by ${t.groupBy}`);
      }
    }
  }
  return problems;
}
