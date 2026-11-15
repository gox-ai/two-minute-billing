/**
 * Plan one transfer pair as items: one per object or setting, with its action against the
 * destination, its diff, its dependencies, its validation messages and a fingerprint of both
 * sides. Read-only. The runner re-plans and compares fingerprints to catch drift.
 */
import { createHash } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Tx } from "@/platform/db";
import {
  attachedItems,
  couponItemConstraints,
  coupons,
  creditUnits,
  differentialPrices,
  gatewayAccounts,
  meters,
  priceRates,
  prices,
  productGroups,
  products,
  subscriptionItems,
  subscriptions,
  taxProfiles,
  taxRateComponents,
  taxRegions,
  taxStateRegistrations,
} from "@db/schema";
import { buildPairPlan, canon, type Biz, type Numbering, type TransferSection } from "./plan";
import { wipeDestinationCatalog } from "./service";
import { sortItems, type ItemAction, type ItemKind, type ItemMessage, type Pair } from "./graph";

type Row = Record<string, unknown>;
export type { Policy, ConflictPolicy } from "./graph";
import type { Policy, ConflictPolicy } from "./graph";

export interface PlannedItem {
  pair: Pair;
  section: string;
  kind: ItemKind;
  key: string;
  label: string;
  action: ItemAction;
  excluded: boolean;
  dependsOn: string[];
  diff: Array<{ field: string; from: unknown; to: unknown }> | null;
  messages: ItemMessage[];
  /** Source row id; for a field, the business column. */
  sourceRef: string | null;
  fingerprint: string;
}

export interface PairOptions {
  sections: TransferSection[];
  numbering?: Numbering;
  wipe: boolean;
  policy: ConflictPolicy;
}

export { defaultPolicy } from "./graph";

const IDENTITY = new Set([
  "id",
  "organizationId",
  "businessId",
  "createdAt",
  "updatedAt",
  "resourceVersion",
]);
/** Run-time state, never copied or compared. */
const RUNTIME = new Set(["timesRedeemed", "lockedAt", "foldedFrom", "backfilledAt"]);
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const snake = (s: string) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

/** JSON-safe: bigint and numeric strings stay readable, dates become ISO strings. */
export function plain(v: unknown): unknown {
  return JSON.parse(
    JSON.stringify(v ?? null, (_k, x) => (typeof x === "bigint" ? x.toString() : x)),
  );
}

/** Comparable values: no identity or run-time columns; references replaced by natural keys. */
function cmp(row: Row, refs: Record<string, unknown> = {}, drop: string[] = []): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(row)) {
    if (IDENTITY.has(k) || RUNTIME.has(k) || drop.includes(k)) continue;
    out[k] = v;
  }
  return plain({ ...out, ...refs }) as Row;
}

function diffOf(dest: Row, src: Row): Array<{ field: string; from: unknown; to: unknown }> {
  const keys = [...new Set([...Object.keys(src), ...Object.keys(dest)])].sort();
  return keys
    .filter((k) => canon(src[k] ?? null) !== canon(dest[k] ?? null))
    .map((k) => ({ field: snake(k), from: dest[k] ?? null, to: src[k] ?? null }));
}

/** Price columns a change to which does not change what a subscription is charged. */
const PRICE_NON_BILLING = new Set(
  [
    "name",
    "externalName",
    "description",
    "invoiceNotes",
    "showDescriptionInInvoices",
    "showDescriptionInQuotes",
    "sku",
    "accountingCode",
    "accountingCategoryCode",
    "metadata",
    "portalMinQuantity",
    "portalMaxQuantity",
  ].map(snake),
);
const METER_BILLING = new Set(
  ["eventName", "aggregation", "valueProperty", "uniqueProperty", "filters", "groupBy"].map(snake),
);
const UNIT_VALUE = new Set(["currency", "minorPerUnitE12", "decimals"].map(snake));
const LIVE_SUB = sql`${subscriptions.status} not in ('cancelled', 'expired')`;

interface Builder {
  items: PlannedItem[];
  add(i: Omit<PlannedItem, "excluded" | "fingerprint">, src: unknown, dest: unknown): void;
}

function builder(): Builder {
  const items: PlannedItem[] = [];
  return {
    items,
    add(i, src, dest) {
      items.push({ ...i, excluded: false, fingerprint: sha(canon([src ?? null, dest ?? null])) });
    },
  };
}

/**
 * The action for a matched pair of rows. A row missing in the destination is created; one that
 * differs is updated under `update` and skipped under `skip`.
 */
function actionFor(
  destRow: Row | undefined,
  d: Array<unknown>,
  policy: Policy,
): { action: ItemAction; messages: ItemMessage[] } {
  if (!destRow) return { action: "create", messages: [] };
  if (d.length === 0) return { action: "unchanged", messages: [] };
  if (policy === "update") return { action: "update", messages: [] };
  return { action: "skip", messages: [] };
}

/** Plan one pair. The returned items are in apply order. */
export async function planPairItems(
  tx: Tx,
  src: Biz,
  dest: Biz,
  pair: Pair,
  opts: PairOptions,
): Promise<{ items: PlannedItem[]; destLive: boolean }> {
  const live = dest.livemode === "live";
  const wipe = opts.wipe && !live;
  const has = (s: TransferSection) => opts.sections.includes(s);
  const pol = (s: TransferSection): Policy => opts.policy[s] ?? (live ? "skip" : "update");
  const b = builder();
  const bySrc = async <T extends Row>(table: unknown, biz: string): Promise<T[]> =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (await tx
      .select()
      .from(table as any)
      .where(eq((table as any).businessId, biz))) as T[];
  // A clear-first plans against an empty destination.
  const byDest = async <T extends Row>(table: unknown, clears: boolean): Promise<T[]> =>
    clears ? [] : bySrc<T>(table, dest.id);

  const cleared = wipe ? (["catalog", "coupons", "tax_rates"] as const).filter(has) : [];
  const refused = await clearRefusals(tx, dest.id, cleared);
  for (const s of cleared)
    b.add(
      {
        pair,
        section: s,
        kind: "clear",
        key: `clear:${s}`,
        label: `Delete the destination's ${s === "tax_rates" ? "taxes" : s} first`,
        action: refused.has(s) ? "blocked" : "delete",
        dependsOn: [],
        diff: null,
        messages: refused.has(s)
          ? [
              {
                level: "error",
                message: `Records in the destination, such as subscriptions or invoices, use its ${s === "tax_rates" ? "taxes" : s}. We cannot delete them. Do not select "Delete its catalog, coupons and taxes first", and the copy keeps what is there.`,
              },
            ]
          : [],
        sourceRef: null,
      },
      s,
      null,
    );

  // ── taxes ──
  const srcProfiles = await bySrc<typeof taxProfiles.$inferSelect>(taxProfiles, src.id);
  const destProfilesAll = await bySrc<typeof taxProfiles.$inferSelect>(taxProfiles, dest.id);
  const profileName = new Map<string, string>(
    [...srcProfiles, ...destProfilesAll].map((p) => [p.id, p.name]),
  );
  if (has("tax_rates")) {
    const legacy = await buildPairPlan(tx, src, dest, {
      sections: ["tax_rates"],
      allowLiveWrites: pol("tax_rates") === "update",
      wipe,
    });
    const taxErrors: ItemMessage[] = legacy.blockers.map((x) => ({
      level: "error",
      message: x.message,
    }));
    const destProfiles = wipe ? [] : destProfilesAll;
    const sub = async (profileIds: string[]) => {
      if (!profileIds.length) return { regions: [], comps: [], regs: [] };
      const regions = await tx
        .select()
        .from(taxRegions)
        .where(inArray(taxRegions.taxProfileId, profileIds));
      const ids = regions.map((r) => r.id);
      const comps = ids.length
        ? await tx
            .select()
            .from(taxRateComponents)
            .where(inArray(taxRateComponents.taxRegionId, ids))
        : [];
      const regs = ids.length
        ? await tx
            .select()
            .from(taxStateRegistrations)
            .where(inArray(taxStateRegistrations.taxRegionId, ids))
        : [];
      return { regions, comps, regs };
    };
    const tree = (p: Row, all: Awaited<ReturnType<typeof sub>>) => {
      const strip = (r: Row) => cmp(r, {}, ["publicId", "taxProfileId", "taxRegionId"]);
      const regions = all.regions.filter((r) => r.taxProfileId === p.id);
      return {
        profile: strip(p),
        regions: regions
          .map((r) => ({
            region: strip(r),
            comps: all.comps
              .filter((c) => c.taxRegionId === r.id)
              .map(strip)
              .sort((x, y) => canon(x).localeCompare(canon(y))),
            regs: all.regs
              .filter((g) => g.taxRegionId === r.id)
              .map(strip)
              .sort((x, y) => canon(x).localeCompare(canon(y))),
          }))
          .sort((x, y) => canon(x.region).localeCompare(canon(y.region))),
      };
    };
    const srcTree = await sub(srcProfiles.map((p) => p.id));
    const destTree = await sub(destProfiles.map((p) => p.id));
    const rename = wipe ? null : legacy.renameDefaultProfile;
    if (rename)
      b.add(
        {
          pair,
          section: "tax_rates",
          kind: "tax_default_rename",
          key: "tax_rename:default",
          label: `Default tax profile "${rename.from}"`,
          action: pol("tax_rates") === "update" ? "update" : "skip",
          dependsOn: [],
          diff: [{ field: "name", from: rename.from, to: rename.to }],
          messages: pol("tax_rates") === "update" ? taxErrors : [],
          sourceRef: rename.id,
        },
        rename,
        null,
      );
    for (const sp of srcProfiles) {
      const dp = destProfiles.find(
        (p) => p.name === sp.name || (rename?.id === p.id && rename.to === sp.name),
      );
      const s = tree(sp, srcTree);
      const d = dp ? tree({ ...dp, name: sp.name }, destTree) : null;
      const changed = d ? canon(s) !== canon(d) : true;
      const { action } = actionFor(dp, changed ? [1] : [], pol("tax_rates"));
      const regionText = s.regions
        .map((r) => `${String(r.region.country)}: ${r.comps.length} rate(s)`)
        .join(", ");
      b.add(
        {
          pair,
          section: "tax_rates",
          kind: "tax_profile",
          key: `tax_profile:${sp.name}`,
          label: `Tax profile "${sp.name}"`,
          action,
          dependsOn: rename && rename.to === sp.name ? ["tax_rename:default"] : [],
          diff:
            action === "update" || action === "skip"
              ? [{ field: "regions", from: d ? plain(d.regions) : null, to: plain(s.regions) }]
              : regionText
                ? [{ field: "regions", from: null, to: regionText }]
                : null,
          messages: action === "update" ? taxErrors : [],
          sourceRef: sp.id,
        },
        s,
        d,
      );
    }
  }

  // ── catalog: meters, credit units, groups, products, prices, attached, differential ──
  const srcProducts = await bySrc<typeof products.$inferSelect>(products, src.id);
  const destProductsAll = await bySrc<typeof products.$inferSelect>(products, dest.id);
  const srcPrices = await bySrc<typeof prices.$inferSelect>(prices, src.id);
  const srcMeters = await bySrc<typeof meters.$inferSelect>(meters, src.id);
  const srcGroups = await bySrc<typeof productGroups.$inferSelect>(productGroups, src.id);
  const productPub = new Map<string, string>(
    [...srcProducts, ...destProductsAll].map((p) => [p.id, p.publicId]),
  );
  const groupPub = new Map<string, string>(srcGroups.map((g) => [g.id, g.publicId]));
  const meterKey = new Map<string, string>(srcMeters.map((m) => [m.id, m.key]));

  if (has("catalog")) {
    const clears = wipe;
    const pc = pol("catalog");
    const destMeters = await bySrc<typeof meters.$inferSelect>(meters, dest.id);
    for (const m of destMeters) meterKey.set(m.id, m.key);
    const destPrices = await byDest<typeof prices.$inferSelect>(prices, clears);
    const destPricesAll = clears
      ? await bySrc<typeof prices.$inferSelect>(prices, dest.id)
      : destPrices;
    // Live subscriptions per destination price and meter, for the billing-change rule.
    const subsByPrice = new Map<string, number>();
    if (live && destPricesAll.length) {
      const rows = await tx
        .select({
          priceId: subscriptionItems.priceId,
          n: sql<number>`count(distinct ${subscriptions.id})::int`,
        })
        .from(subscriptionItems)
        .innerJoin(subscriptions, eq(subscriptions.id, subscriptionItems.subscriptionId))
        .where(
          and(
            inArray(
              subscriptionItems.priceId,
              destPricesAll.map((p) => p.id),
            ),
            LIVE_SUB,
          ),
        )
        .groupBy(subscriptionItems.priceId);
      for (const r of rows) subsByPrice.set(r.priceId, r.n);
    }

    for (const sm of srcMeters) {
      const dm = destMeters.find((m) => m.key === sm.key);
      const s = cmp(sm, {}, ["status"]);
      const d = dm ? cmp(dm, {}, ["status"]) : null;
      const df = d ? diffOf(d, s) : [];
      const a = actionFor(dm, df, pc);
      if (a.action === "update" && dm && live) {
        const used = destPricesAll
          .filter((p) => p.meterId === dm.id)
          .reduce((n, p) => n + (subsByPrice.get(p.id) ?? 0), 0);
        if (used > 0 && df.some((x) => METER_BILLING.has(x.field)))
          a.messages.push({
            level: "error",
            message: `${used} live subscription(s) bill from this meter. A change to how it counts usage changes their bills. Create a new meter in the source instead.`,
          });
      }
      b.add(
        {
          pair,
          section: "catalog",
          kind: "meter",
          key: `meter:${sm.key}`,
          label: `Meter "${sm.name}"`,
          action: a.messages.some((m) => m.level === "error") ? "blocked" : a.action,
          dependsOn: [],
          diff: a.action === "create" ? null : df,
          messages: a.messages,
          sourceRef: sm.id,
        },
        s,
        d,
      );
    }

    const destUnits = await bySrc<typeof creditUnits.$inferSelect>(creditUnits, dest.id);
    for (const su of await bySrc<typeof creditUnits.$inferSelect>(creditUnits, src.id)) {
      const du = destUnits.find((u) => u.key === su.key);
      const s = cmp(su);
      const d = du ? cmp(du) : null;
      const df = d ? diffOf(d, s) : [];
      const a = actionFor(du, df, pc);
      if (a.action === "update" && du?.lockedAt && df.some((x) => UNIT_VALUE.has(x.field)))
        a.messages.push({
          level: "error",
          message:
            "Credits of this unit are already granted in the destination, so its currency, value and decimals cannot change.",
        });
      b.add(
        {
          pair,
          section: "catalog",
          kind: "credit_unit",
          key: `credit_unit:${su.key}`,
          label: `Credit unit "${su.name}"`,
          action: a.messages.length ? "blocked" : a.action,
          dependsOn: [],
          diff: a.action === "create" ? null : df,
          messages: a.messages,
          sourceRef: su.id,
        },
        s,
        d,
      );
    }

    const destGroups = await byDest<typeof productGroups.$inferSelect>(productGroups, false);
    for (const sg of srcGroups) {
      // A clear-first keeps the destination's "default" group.
      const dg =
        clears && sg.publicId !== "default"
          ? undefined
          : destGroups.find((g) => g.publicId === sg.publicId);
      const s = cmp(sg);
      const d = dg ? cmp(dg) : null;
      const df = d ? diffOf(d, s) : [];
      const a = actionFor(dg, df, pc);
      b.add(
        {
          pair,
          section: "catalog",
          kind: "product_group",
          key: `product_group:${sg.publicId}`,
          label: `Product group "${sg.name}"`,
          action: a.action,
          dependsOn: [],
          diff: a.action === "create" ? null : df,
          messages: [],
          sourceRef: sg.id,
        },
        s,
        d,
      );
    }

    const destProducts = clears ? [] : destProductsAll;
    const destGroupPub = new Map(destGroups.map((g) => [g.id, g.publicId]));
    for (const sp of srcProducts) {
      const dp = destProducts.find((p) => p.publicId === sp.publicId);
      const refs = (p: typeof sp, groups: Map<string, string>) => ({
        productGroupId: p.productGroupId ? (groups.get(p.productGroupId) ?? null) : null,
        taxProfileId: p.taxProfileId ? (profileName.get(p.taxProfileId) ?? null) : null,
      });
      const s = cmp(sp, refs(sp, groupPub));
      const d = dp ? cmp(dp, refs(dp, destGroupPub)) : null;
      const df = d ? diffOf(d, s) : [];
      const a = actionFor(dp, df, pc);
      const deps: string[] = [];
      if (sp.productGroupId && groupPub.get(sp.productGroupId))
        deps.push(`product_group:${groupPub.get(sp.productGroupId)}`);
      if (sp.taxProfileId) {
        const name = profileName.get(sp.taxProfileId);
        if (name && has("tax_rates")) deps.push(`tax_profile:${name}`);
        else if (name && !destProfilesAll.some((p) => p.name === name))
          a.messages.push({
            level: "error",
            message: `It uses the tax profile "${name}", which the destination does not have. Select Taxes too.`,
          });
      }
      const active = srcPrices.filter((p) => p.productId === sp.id && p.active);
      if (sp.kind === "plan" && sp.active && active.length === 0 && a.action !== "unchanged")
        a.messages.push({
          level: "error",
          message:
            "This plan is active, but all its prices are archived in the source. Add a price or archive the plan first.",
        });
      b.add(
        {
          pair,
          section: "catalog",
          kind: "product",
          key: `product:${sp.publicId}`,
          label: `${sp.kind === "addon" ? "Add-on" : sp.kind === "charge" ? "Charge" : "Plan"} "${sp.name}"`,
          action: a.messages.some((m) => m.level === "error") ? "blocked" : a.action,
          dependsOn: deps,
          diff: a.action === "create" ? null : df,
          messages: a.messages,
          sourceRef: sp.id,
        },
        s,
        d,
      );
    }

    const allRates = await tx
      .select()
      .from(priceRates)
      .where(inArray(priceRates.businessId, [src.id, dest.id]));
    const ratesOf = (priceId: string) =>
      allRates
        .filter((r) => r.priceId === priceId)
        .map((r) => cmp(r, {}, ["priceId"]))
        .sort((x, y) => canon(x).localeCompare(canon(y)));
    const gateways = live
      ? await tx
          .select()
          .from(gatewayAccounts)
          .where(and(eq(gatewayAccounts.businessId, dest.id), eq(gatewayAccounts.status, "active")))
      : [];
    const destCurrencies = Array.isArray(dest.currencies) ? (dest.currencies as string[]) : null;
    // The gateway warning shows once per currency, on its first new price.
    const warned = new Set<string>();
    for (const sp of srcPrices) {
      const dp = destPrices.find((p) => p.publicId === sp.publicId);
      const refs = (p: typeof sp) => ({
        productId: productPub.get(p.productId) ?? null,
        meterId: p.meterId ? (meterKey.get(p.meterId) ?? null) : null,
        rates: ratesOf(p.id),
      });
      const s = cmp(sp, refs(sp));
      const d = dp ? cmp(dp, refs(dp)) : null;
      const df = d ? diffOf(d, s) : [];
      const a = actionFor(dp, df, pc);
      const msgs = a.messages;
      if (
        destCurrencies &&
        sp.currency !== dest.defaultCurrency &&
        !destCurrencies.includes(sp.currency)
      )
        msgs.push({
          level: "error",
          message: `The destination does not bill in ${sp.currency}. Add ${sp.currency} to its currencies first.`,
        });
      if (a.action === "update" && dp && live && (subsByPrice.get(dp.id) ?? 0) > 0) {
        const billing = df.filter((x) => !PRICE_NON_BILLING.has(x.field));
        if (billing.length)
          msgs.push({
            level: "error",
            message: `${subsByPrice.get(dp.id)} live subscription(s) bill from this price. The copy does not change their price. Create a new price in the source instead.`,
          });
      }
      if (
        live &&
        sp.active &&
        a.action === "create" &&
        !warned.has(sp.currency) &&
        !gateways.some((g) => {
          const c = g.currencies as string[] | null;
          return !c || c.includes(sp.currency);
        })
      ) {
        warned.add(sp.currency);
        msgs.push({
          level: "warning",
          message: `No connected payment gateway in the destination takes ${sp.currency}. Connect one before customers buy this price.`,
        });
      }
      const deps = [`product:${productPub.get(sp.productId)}`];
      if (sp.meterId && meterKey.get(sp.meterId)) deps.push(`meter:${meterKey.get(sp.meterId)}`);
      const unit = (sp.grantsCredit as { unit?: string | null } | null)?.unit;
      if (unit) deps.push(`credit_unit:${unit}`);
      b.add(
        {
          pair,
          section: "catalog",
          kind: "price",
          key: `price:${sp.publicId}`,
          label: `Price "${sp.name ?? sp.publicId}" (${sp.currency})`,
          action: msgs.some((m) => m.level === "error") ? "blocked" : a.action,
          dependsOn: deps,
          diff: a.action === "create" ? null : df,
          messages: msgs,
          sourceRef: sp.id,
        },
        s,
        d,
      );
    }

    const destAttached = await byDest<typeof attachedItems.$inferSelect>(attachedItems, clears);
    for (const sa of await bySrc<typeof attachedItems.$inferSelect>(attachedItems, src.id)) {
      const item = productPub.get(sa.itemProductId);
      const plan = productPub.get(sa.planProductId);
      const da = destAttached.find(
        (x) => productPub.get(x.itemProductId) === item && productPub.get(x.planProductId) === plan,
      );
      const refs = { itemProductId: item, planProductId: plan };
      const s = cmp(sa, refs);
      const d = da ? cmp(da, refs) : null;
      const df = d ? diffOf(d, s) : [];
      const a = actionFor(da, df, pc);
      b.add(
        {
          pair,
          section: "catalog",
          kind: "attached_item",
          key: `attached:${item}@${plan}`,
          label: `Attached item ${item} on ${plan}`,
          action: a.action,
          dependsOn: [`product:${item}`, `product:${plan}`],
          diff: a.action === "create" ? null : df,
          messages: [],
          sourceRef: sa.id,
        },
        s,
        d,
      );
    }

    const destDiff = await byDest<typeof differentialPrices.$inferSelect>(
      differentialPrices,
      clears,
    );
    for (const sd of await bySrc<typeof differentialPrices.$inferSelect>(
      differentialPrices,
      src.id,
    )) {
      const addon = productPub.get(sd.addonProductId);
      const plan = productPub.get(sd.planProductId);
      const dd = destDiff.find(
        (x) =>
          productPub.get(x.addonProductId) === addon &&
          productPub.get(x.planProductId) === plan &&
          x.currency === sd.currency &&
          (x.interval ?? null) === (sd.interval ?? null),
      );
      const refs = { addonProductId: addon, planProductId: plan };
      const s = cmp(sd, refs, ["publicId"]);
      const d = dd ? cmp(dd, refs, ["publicId"]) : null;
      const df = d ? diffOf(d, s) : [];
      const a = actionFor(dd, df, pc);
      b.add(
        {
          pair,
          section: "catalog",
          kind: "differential_price",
          // Unique per (addon, plan, currency, interval), as differential_prices_uq.
          key: `dprice:${addon}@${plan}@${sd.currency}@${sd.interval ?? "any"}`,
          label: `Price of ${addon} on ${plan} (${sd.currency}${sd.interval ? `, ${sd.interval}` : ""})`,
          action: a.action,
          dependsOn: [`product:${addon}`, `product:${plan}`],
          diff: a.action === "create" ? null : df,
          messages: [],
          sourceRef: sd.id,
        },
        s,
        d,
      );
    }
  }

  // ── coupons ──
  if (has("coupons")) {
    const pc = pol("coupons");
    const srcCoupons = await bySrc<typeof coupons.$inferSelect>(coupons, src.id);
    const destCoupons = await byDest<typeof coupons.$inferSelect>(coupons, wipe);
    const codeOf = new Map<string, string>(
      [...srcCoupons, ...destCoupons].map((c) => [c.id, c.code]),
    );
    for (const sc of srcCoupons) {
      const dc = destCoupons.find((c) => c.code === sc.code);
      const s = cmp(sc);
      const d = dc ? cmp(dc) : null;
      const df = d ? diffOf(d, s) : [];
      const a = actionFor(dc, df, pc);
      b.add(
        {
          pair,
          section: "coupons",
          kind: "coupon",
          key: `coupon:${sc.code}`,
          label: `Coupon ${sc.code}`,
          action: a.action,
          dependsOn: [],
          diff: a.action === "create" ? null : df,
          messages: [],
          sourceRef: sc.id,
        },
        s,
        d,
      );
    }
    const destCons = await byDest<typeof couponItemConstraints.$inferSelect>(
      couponItemConstraints,
      wipe,
    );
    for (const sc of await bySrc<typeof couponItemConstraints.$inferSelect>(
      couponItemConstraints,
      src.id,
    )) {
      const code = codeOf.get(sc.couponId);
      const dc = destCons.find(
        (c) => codeOf.get(c.couponId) === code && c.itemKind === sc.itemKind,
      );
      const s = cmp(sc, { couponId: code });
      const d = dc ? cmp(dc, { couponId: code }) : null;
      const df = d ? diffOf(d, s) : [];
      const a = actionFor(dc, df, pc);
      b.add(
        {
          pair,
          section: "coupons",
          kind: "coupon_constraint",
          key: `coupon_constraint:${code}:${sc.itemKind}`,
          label: `Coupon ${code}: ${sc.itemKind} rule`,
          action: a.action,
          dependsOn: [`coupon:${code}`],
          diff: a.action === "create" ? null : df,
          messages: [],
          sourceRef: sc.id,
        },
        s,
        d,
      );
    }
  }

  // ── field sections ──
  const fieldSections = (["settings", "company_profile", "email_sending"] as const).filter(has);
  if (fieldSections.length || opts.numbering) {
    const legacy = await buildPairPlan(tx, src, dest, {
      sections: [...fieldSections],
      numbering: opts.numbering,
      allowLiveWrites: true,
      wipe: false,
    });
    for (const sec of legacy.sections) {
      if (!sec.fields) continue;
      const section = sec.section;
      const policy: Policy = section === "numbering" ? "update" : pol(section as TransferSection);
      const errors: ItemMessage[] = legacy.blockers
        .filter((x) => x.section === section)
        .map((x) => ({ level: "error", message: x.message }));
      const warns: ItemMessage[] = legacy.warnings
        .filter((x) => x.section === section)
        .map((x) => ({ level: "warning", message: x.message }));
      for (const f of sec.fields) {
        const action: ItemAction = !f.changed
          ? "unchanged"
          : policy === "update"
            ? "update"
            : "skip";
        const msgs = action === "update" ? [...errors, ...warns] : [];
        b.add(
          {
            pair,
            section,
            kind: "field",
            key: `${section}.${snake(String(f.column))}`,
            label: fieldLabel(snake(String(f.column))),
            action: msgs.some((m) => m.level === "error") ? "blocked" : action,
            dependsOn: [],
            diff: [{ field: snake(String(f.column)), from: plain(f.from), to: plain(f.to) }],
            messages: msgs,
            sourceRef: String(f.column),
          },
          plain(f.to),
          plain(f.from),
        );
      }
    }
  }

  // A clear-first section's items wait for its clear: if the clear fails, they are skipped.
  for (const i of b.items)
    if (i.kind !== "clear" && (cleared as readonly string[]).includes(i.section))
      i.dependsOn.push(`clear:${i.section}`);
  return { items: sortItems(b.items), destLive: live };
}

/**
 * The clears the destination refuses because other rows still use what they delete (a
 * subscription on a price, an invoice on a coupon). Tried in a savepoint that always rolls back.
 */
async function clearRefusals(tx: Tx, destId: string, sections: readonly TransferSection[]) {
  const refused = new Set<TransferSection>();
  if (!sections.length) return refused;
  const probe = new Error("probe");
  await tx
    .transaction(async (sp) => {
      for (const s of sections)
        await sp
          .transaction((one) => wipeDestinationCatalog(one, destId, [s]))
          .catch((e) => {
            const code =
              (e as { code?: string; cause?: { code?: string } }).code ??
              (e as { cause?: { code?: string } }).cause?.code;
            if (code !== "23503") throw e;
            refused.add(s);
          });
      throw probe;
    })
    .catch((e) => {
      if (e !== probe) throw e;
    });
  return refused;
}

const FIELD_LABEL: Record<string, string> = {
  address: "Address",
  tax_registration_number: "Tax registration number",
  invoice_issuer: "Invoice issuer",
  default_tax_code: "Default HSN/SAC code",
  default_tax_behavior: "Default tax behavior",
  tax_settings: "Tax settings",
  invoice_prefix: "Invoice prefix",
  credit_note_prefix: "Credit note prefix",
  default_invoice_notes: "Invoice notes",
  default_due_days: "Payment terms (days)",
  dunning_retry_days: "Dunning retry days",
  dunning_config: "Dunning",
  storefront_config: "Checkout and portal",
  email_config: "Sender details",
  smtp_config: "SMTP server",
  ses_config: "Amazon SES",
};

export function fieldLabel(field: string): string {
  if (FIELD_LABEL[field]) return FIELD_LABEL[field]!;
  const words = field.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}
