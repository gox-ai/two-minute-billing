import { and, eq, inArray } from "drizzle-orm";
import { withTenant } from "@/platform/db";
import { accountBalance } from "@/modules/ledger/service";
import { walletBalance } from "@/modules/wallet/service";
import { monthlyRecurringMinor } from "@/modules/metrics/mrr";
import {
  discountsForMrr,
  netMrrForDiscounts,
  type ActiveDiscountForMrr,
} from "@/modules/subscriptions/service";
import {
  discountIsImportable,
  discountRemainingPeriods,
  discountTotalPeriods,
  type DiscountCadence,
  type ImportScope,
} from "./import";
import {
  importRecords,
  subscriptions,
  subscriptionItems,
  coupons,
  invoices,
  invoiceLineItems,
  invoiceLineDiscounts,
  customers,
  prices,
  differentialPrices,
  attachedItems,
  gatewayAccounts,
} from "@db/schema";
import { OPEN_INVOICE_STATUSES } from "./types";
import type { MigrationSource, SourceSubscription } from "./types";
import type { PriceSnapshot } from "@/modules/catalog/pricing";

export interface ReconcileMismatch {
  area: string;
  sourceId?: string;
  expected: unknown;
  actual: unknown;
  detail?: string;
}

export interface ReconcileReport {
  pass: boolean;
  checkedAt: string;
  /** area → number of records compared */
  compared: Record<string, number>;
  mismatches: ReconcileMismatch[];
  /**
   * What this run actually compared. A CLEAN reconcile means "clean **within this
   * scope**" and the report has to say so — otherwise a scoped pass reads as a
   * whole-site pass, which is the more dangerous direction of the two.
   */
  scope: {
    /**
     * True when the import ran `--catalog-only`: catalog + coupons compared, and NOTHING
     * per-customer. Reported explicitly rather than left implicit in an empty status list,
     * because "0 subscriptions, all matched" and "no subscriptions were in scope" are the
     * same numbers and opposite meanings.
     */
    catalogOnly?: boolean;
    /**
     * How many subscriptions the import was explicitly NAMED to bring
     * (`ImportScope.subscriptionSourceIds`), for a partial migration.
     *
     * Reported for the same reason `catalogOnly` is: with a named set, "every
     * subscription matched" means every subscription IN THE LIST matched, and the
     * hundreds left on the source deliberately were never looked at. A report that
     * did not say so would read as a whole-site pass — the dangerous direction.
     */
    namedSubscriptions?: number;
    subscriptionStatuses: string[] | "all";
    customers: "all" | "holders-of-in-scope-subscriptions";
    invoices: "all" | "open-only";
    /** Source records excluded from every check above, by reason. */
    excluded: Record<string, number>;
  };
}

/** Our status for a source status (must mirror the importer's mapStatus). */
function expectedStatus(s: SourceSubscription["status"]): string {
  switch (s) {
    case "non_renewing":
      return "active";
    case "trialing":
      return "in_trial";
    case "future":
      return "active";
    case "paused":
      return "paused";
    case "canceled":
      return "cancelled";
    default:
      return "active";
  }
}

/**
 * Pull the source AND tmbilling and diff them — resource counts, every
 * subscription (items / quantities / effective unit price / term end / status),
 * coupon redemption counts, promo balances, open AR per currency, MRR totals.
 * Run it right after an import (before renewals move money) for a clean
 * pass/fail signal; every mismatch is listed individually.
 *
 * ⚠️ **Pass the same `scope` / `includeHistory` the import ran under.** This function
 * compares the source against what landed here, so its notion of "should be present"
 * has to be the importer's. Given nothing, it compares the WHOLE site: after a
 * `--billable-only --no-history` import that reports every deliberately-excluded
 * record as a mismatch (on a production book: 33 cancelled subscriptions, the 32 customers
 * holding only those, and 252 settled invoices), so the reconcile gate can never pass
 * — and a gate that is red by construction is a gate people stop reading.
 */
export async function reconcileWithSource(input: {
  organizationId: string;
  businessId: string;
  source: MigrationSource;
  /** The scope the IMPORT ran under (`ImportOptions.scope`). Omitted → whole site. */
  scope?: ImportScope;
  /** Whether the import carried settled history (`ImportOptions.includeHistory`, default true). */
  includeHistory?: boolean;
  /**
   * Mirror `ImportOptions.skipGatewayAccounts`. The comparison below derives the source's
   * gateway accounts from a full payment_sources + transactions walk — the census the
   * import can now skip — so a reconcile that still performs it costs far more than the
   * import it is checking, and compares placeholder rows the import never created.
   */
  skipGatewayAccounts?: boolean;
}): Promise<ReconcileReport> {
  const { organizationId, businessId, source } = input;
  const includeHistory = input.includeHistory ?? true;
  const mismatches: ReconcileMismatch[] = [];
  const compared: Record<string, number> = {};
  const excluded: Record<string, number> = {};
  const miss = (m: ReconcileMismatch) => mismatches.push(m);
  const exclude = (reason: string, n: number) => {
    if (n > 0) excluded[reason] = (excluded[reason] ?? 0) + n;
  };

  // Bulk map: sourceType → (sourceId → targetId)
  const records = await withTenant(organizationId, async (tx) =>
    tx
      .select()
      .from(importRecords)
      .where(and(eq(importRecords.source, source.name), eq(importRecords.businessId, businessId))),
  );
  const byType = new Map<string, Map<string, string>>();
  for (const r of records) {
    const m = byType.get(r.sourceType) ?? new Map();
    m.set(r.sourceId, r.targetId);
    byType.set(r.sourceType, m);
  }
  const mapOf = (t: string) => byType.get(t) ?? new Map<string, string>();

  // --- 0) Narrow the source side to the import's scope ------------------------
  // Mirrors `importFromSource`'s resolution order exactly (import.ts: "resolve the
  // import scope BEFORE customers, because 'which customers' depends on 'which
  // subscriptions'"). The catalog is NEVER scoped — a retained subscription can
  // reference any price, so the importer brings it in full and so must this.
  const catalog = await source.listCatalog();
  // A catalog-only import brought over no subscriptions, so there is nothing to compare
  // and — as in the importer — no reason to read the book to discover that.
  const catalogOnly = input.scope?.catalogOnly === true;
  // Same hint as the importer's `subscriptionListOpts`: narrows the request when the
  // source supports it (fewer rows over the wire), re-filtered below regardless.
  /**
   * A NAMED id set goes to the source, and REPLACES the status hint rather than joining
   * it. The list is the scope; asking for both would let a named subscription whose
   * status changed since the import silently not come back, and "absent from the source"
   * is exactly the difference this gate exists to surface. Status is still applied
   * locally below, so the exclusion it reports stays meaningful.
   *
   * Without this the reconcile pages the whole book — 30,300 subscriptions on a large
   * site — to compare 34, which is the same waste the importer had.
   */
  const srcSubIds = input.scope?.subscriptionSourceIds;
  const allSrcSubs = catalogOnly
    ? []
    : await source.listSubscriptions(
        srcSubIds
          ? { ids: srcSubIds }
          : input.scope?.subscriptionStatuses
            ? { statuses: input.scope.subscriptionStatuses }
            : undefined,
      );

  const wantedStatuses = input.scope?.subscriptionStatuses
    ? new Set<SourceSubscription["status"]>(input.scope.subscriptionStatuses)
    : null;
  const statusScoped = wantedStatuses
    ? allSrcSubs.filter((s) => wantedStatuses.has(s.status))
    : allSrcSubs;
  exclude("subscriptions:out_of_scope_status", allSrcSubs.length - statusScoped.length);

  /**
   * A NAMED subscription set (`ImportScope.subscriptionSourceIds`) — the partial-migration
   * scope. Must be mirrored here or the reconcile is useless for it: the importer brought
   * 2 of 791 subscriptions on purpose, and comparing against the whole book would report
   * the other 789 as missing, so the gate could never come back clean and the one thing it
   * exists to prove would be buried under 789 expected differences.
   *
   * Counted under its own exclusion reason rather than folded into the status one, because
   * "excluded because it was not on the list" and "excluded because it was cancelled" are
   * different facts about the run and a reader chasing a number needs to tell them apart.
   */
  const namedIds = input.scope?.subscriptionSourceIds
    ? new Set(input.scope.subscriptionSourceIds)
    : null;
  const srcSubs = namedIds ? statusScoped.filter((s) => namedIds.has(s.sourceId)) : statusScoped;
  if (namedIds) {
    /**
     * Scoped at the source, so the rest of the book was never fetched and cannot be
     * counted. Reporting `not_in_named_set: 0` would be a truthful zero that reads as
     * "nothing was excluded" — the same trap as the invoice count below. Named instead.
     */
    if (srcSubIds) exclude("subscriptions:not_fetched_scoped_at_source", 0);
    else exclude("subscriptions:not_in_named_set", statusScoped.length - srcSubs.length);
  }

  // Fetched AFTER subscriptions (mirrors import.ts: "which customers" depends on
  // "which subscriptions"), so the retained ids are known before this call and can
  // narrow it the same way `importFromSource` does.
  const retainedCustomerSourceIds =
    // A named set always scopes customers with it, exactly as `importFromSource` does —
    // it imported only the holders of those subscriptions, so comparing against every
    // customer on the source would report all the others as missing.
    catalogOnly || input.scope?.dropCustomersWithoutSubscriptions || namedIds
      ? new Set(srcSubs.map((s) => s.customerSourceId))
      : null;
  const allSrcCustomers = catalogOnly
    ? []
    : await source.listCustomers(
        retainedCustomerSourceIds ? { ids: [...retainedCustomerSourceIds] } : undefined,
      );
  const srcCustomers = retainedCustomerSourceIds
    ? allSrcCustomers.filter((c) => retainedCustomerSourceIds.has(c.sourceId))
    : allSrcCustomers;
  exclude("customers:no_in_scope_subscription", allSrcCustomers.length - srcCustomers.length);

  /**
   * Invoices, resolved ONCE and reused by every check below (the counts, the line
   * math and open AR each used to re-call `listInvoices`).
   *
   * `--no-history` still imports the OPEN invoices (import.ts: they are live AR and
   * carry the in-flight dunning position), so `openOnly` is what "no history" means
   * on this side too. Invoices belonging to a dropped customer go with that customer,
   * exactly as the importer skips them.
   */
  const srcInvoices = source.listInvoices
    ? await (async () => {
        // Scoped at the source when we know the customers: the unscoped read is the whole
        // site's invoice history (65,813 on a large book) to compare a few hundred.
        //
        // It costs one number. `invoices:dropped_customer` below counts what the LOCAL
        // filter removed, and a scoped read never fetches those — so the count would be a
        // truthful 0 that reads as the false claim "nothing was excluded". It is omitted
        // instead, and the scope line says the read was narrowed. An absent number beats a
        // zero that means something else.
        const scopedAtSource = retainedCustomerSourceIds != null;
        const all = await source.listInvoices!({
          ...(includeHistory ? {} : { openOnly: true }),
          ...(scopedAtSource ? { customerIds: [...retainedCustomerSourceIds!] } : {}),
        });
        // `openOnly` is a source *hint*: "a source that ignores the flag just returns
        // everything, which is safe — only slower" (types.ts). Safe for the importer,
        // NOT safe here — an unfiltered list would reinstate every settled invoice as a
        // missing record. Filter locally so the scope holds whatever the source did.
        const open = includeHistory
          ? all
          : all.filter((i) => OPEN_INVOICE_STATUSES.includes(i.status));
        exclude("invoices:settled_history", all.length - open.length);
        if (!retainedCustomerSourceIds) return open;
        const kept = open.filter((i) => retainedCustomerSourceIds.has(i.customerSourceId));
        // Still filtered locally — the server-side narrowing is an optimisation, and a
        // source that ignores it must not widen the comparison.
        if (!scopedAtSource) exclude("invoices:dropped_customer", open.length - kept.length);
        else exclude("invoices:not_fetched_scoped_at_source", 0);
        return kept;
      })()
    : null;

  // --- 1) Resource counts: everything at the source has an import record -----
  const countChecks: Array<[string, number, number]> = [
    ["product_groups", catalog.groups.length, mapOf("product_group").size],
    ["products", catalog.products.length, mapOf("product").size],
    ["prices", catalog.prices.length, mapOf("price").size],
    ["customers", srcCustomers.length, mapOf("customer").size],
    ["subscriptions", srcSubs.length, mapOf("subscription").size],
  ];
  // Differential prices (finale review: 274 imported, zero reconciled before) —
  // count against the destination table, and diff each flat amount by natural key
  // (addon product, plan product, interval), resolved through the import records.
  {
    const destDiffs = await withTenant(organizationId, (tx) =>
      tx.select().from(differentialPrices).where(eq(differentialPrices.businessId, businessId)),
    );
    countChecks.push(["differential_prices", catalog.differentialPrices.length, destDiffs.length]);
    const priceMap = mapOf("price");
    const productMap = mapOf("product");
    const priceRows = await withTenant(organizationId, (tx) =>
      tx
        .select({ id: prices.id, productId: prices.productId })
        .from(prices)
        .where(eq(prices.businessId, businessId)),
    );
    const productOfPrice = new Map(priceRows.map((p) => [p.id, p.productId]));
    const destByKey = new Map(
      destDiffs.map((d) => [
        `${d.addonProductId}|${d.planProductId}|${d.currency}|${d.interval ?? ""}`,
        d,
      ]),
    );
    for (const sd of catalog.differentialPrices) {
      const addonPriceId = priceMap.get(sd.addonPriceSourceId);
      const planProductId = productMap.get(sd.planProductSourceId);
      const addonProductId = addonPriceId ? productOfPrice.get(addonPriceId) : undefined;
      if (!addonProductId || !planProductId) {
        miss({
          area: "differential_price:resolve",
          expected: `${sd.addonPriceSourceId}/${sd.planProductSourceId}`,
          actual: "unresolved import record",
        });
        continue;
      }
      const dest =
        destByKey.get(`${addonProductId}|${planProductId}|${sd.currency}|${sd.interval ?? ""}`) ??
        destByKey.get(`${addonProductId}|${planProductId}|${sd.currency}|`);
      if (!dest) {
        miss({
          area: "differential_price:missing",
          expected: `${sd.addonPriceSourceId}/${sd.planProductSourceId}`,
          actual: "absent",
        });
        continue;
      }
      if (dest.amountMinor == null || BigInt(sd.amountMinor) !== dest.amountMinor) {
        miss({
          area: "differential_price:amount",
          expected: String(sd.amountMinor),
          actual: String(dest.amountMinor),
        });
      }
    }
    compared["differential_prices"] = catalog.differentialPrices.length;
  }
  // Attached add-ons (plan → addon links). Counted against the destination table:
  // a source may have no top-level
  // /attached_items collection, which would import as a silent zero without this check.
  {
    const destAttached = await withTenant(organizationId, (tx) =>
      tx
        .select({ id: attachedItems.id })
        .from(attachedItems)
        .where(eq(attachedItems.businessId, businessId)),
    );
    countChecks.push(["attached_addons", catalog.attachedAddons.length, destAttached.length]);
  }
  // Same decision as import.ts: the cost of deriving gateway accounts — a full
  // `/transactions` walk for 3 resulting rows — is scoped
  // to `includeHistory`, and this function is passed the same `includeHistory` the
  // import ran under (required by the doc comment above), so a scoped reconcile costs
  // no more than the scoped import it is checking.
  if (source.listGatewayAccounts && input.skipGatewayAccounts !== true) {
    const srcGws = await source.listGatewayAccounts({ includeHistory });
    const destGws = await withTenant(organizationId, (tx) =>
      tx
        .select({ id: gatewayAccounts.id })
        .from(gatewayAccounts)
        .where(eq(gatewayAccounts.businessId, businessId)),
    );
    // >= not ==: the operator may have configured real accounts of their own
    // alongside the imported placeholders.
    if (destGws.length < srcGws.length) {
      miss({ area: "count:gateway_accounts", expected: srcGws.length, actual: destGws.length });
    }
    compared["gateway_accounts"] = srcGws.length;
  }
  if (source.listCoupons) {
    const { coupons: srcCoupons, couponSets } = await source.listCoupons();
    countChecks.push(["coupons", srcCoupons.length, mapOf("coupon").size]);
    countChecks.push(["coupon_sets", couponSets.length, mapOf("coupon_set").size]);
  }
  if (srcInvoices) {
    const importable = srcInvoices.filter((i) => i.status !== "pending").length;
    exclude("invoices:pending", srcInvoices.length - importable);
    countChecks.push(["invoices", importable, mapOf("invoice").size]);
  }
  for (const [area, expected, actual] of countChecks) {
    compared[area] = expected;
    if (expected !== actual) miss({ area: `count:${area}`, expected, actual });
  }

  // --- 1b) Imported invoices must ADD UP -------------------------------------
  /**
   * Σ(line items) − Σ(ITEM-LEVEL discounts) must equal the invoice total, to the minor
   * unit. This catches a source's tax or document-level discount being dropped: the
   * header total comes over verbatim, so a missing line is invisible on the header and
   * shows up only as lines that do not sum to it.
   *
   * THE ITEM-LEVEL TERM IS NOT OPTIONAL. Lines are imported GROSS, and an item-level
   * discount deliberately does NOT become a negative line — the source's `sub_total`
   * already has it deducted, so a line would subtract it twice (import.ts,
   * `SourceInvoice.discounts`). It is recorded in `invoice_line_discounts` with
   * `scope: 'item_level'` instead. Document-level discounts DO become negative lines and
   * are therefore already inside Σ(lines) — which is why only the item-level ones are
   * subtracted here.
   *
   * Omitting the term made this fail on every invoice carrying an item-level discount:
   * 10 of 522 on a production book, e.g. 46551 (lines 131000, discount 56000, total 75000).
   * The data was right and the check was wrong — found on a live cutover, because no
   * fixture had an item-level discount.
   */
  if (srcInvoices) {
    const invMap = mapOf("invoice");
    const invIds = [...invMap.values()];
    if (invIds.length > 0) {
      const rows = await withTenant(organizationId, async (tx) =>
        tx
          .select({
            id: invoices.id,
            publicId: invoices.publicId,
            number: invoices.number,
            totalMinor: invoices.totalMinor,
          })
          .from(invoices)
          .where(inArray(invoices.id, invIds)),
      );
      const lineRows = await withTenant(organizationId, async (tx) =>
        tx
          .select({
            invoiceId: invoiceLineItems.invoiceId,
            amountMinor: invoiceLineItems.amountMinor,
          })
          .from(invoiceLineItems)
          .where(inArray(invoiceLineItems.invoiceId, invIds)),
      );
      const itemLevelRows = await withTenant(organizationId, (tx) =>
        tx
          .select({
            invoiceId: invoiceLineDiscounts.invoiceId,
            amountMinor: invoiceLineDiscounts.amountMinor,
          })
          .from(invoiceLineDiscounts)
          .where(
            and(
              inArray(invoiceLineDiscounts.invoiceId, invIds),
              eq(invoiceLineDiscounts.scope, "item_level"),
            ),
          ),
      );
      const sumByInvoice = new Map<string, bigint>();
      for (const l of lineRows) {
        sumByInvoice.set(l.invoiceId, (sumByInvoice.get(l.invoiceId) ?? 0n) + l.amountMinor);
      }
      for (const d of itemLevelRows) {
        sumByInvoice.set(d.invoiceId, (sumByInvoice.get(d.invoiceId) ?? 0n) - d.amountMinor);
      }
      compared["invoice_line_math"] = rows.length;
      for (const inv of rows) {
        const sum = sumByInvoice.get(inv.id) ?? 0n;
        if (sum !== inv.totalMinor) {
          miss({
            area: "invoice.line_sum",
            sourceId: inv.number ?? inv.publicId,
            expected: String(inv.totalMinor),
            actual: String(sum),
            detail:
              "Σ(line items) − Σ(item-level discounts) != invoice total — a tax or " +
              "document-level discount line is missing",
          });
        }
      }
    }
  }

  // --- 2) Per-subscription fidelity ------------------------------------------
  const subMap = mapOf("subscription");
  const subIds = [...subMap.values()];
  const dbSubs = subIds.length
    ? await withTenant(organizationId, async (tx) =>
        tx.select().from(subscriptions).where(inArray(subscriptions.id, subIds)),
      )
    : [];
  const dbItems = subIds.length
    ? await withTenant(organizationId, async (tx) =>
        tx
          .select()
          .from(subscriptionItems)
          .where(inArray(subscriptionItems.subscriptionId, subIds)),
      )
    : [];
  const dbSubById = new Map(dbSubs.map((s) => [s.id, s]));
  const itemsBySub = new Map<string, typeof dbItems>();
  for (const it of dbItems) {
    const arr = itemsBySub.get(it.subscriptionId) ?? [];
    arr.push(it);
    itemsBySub.set(it.subscriptionId, arr);
  }
  const srcPriceById = new Map(catalog.prices.map((p) => [p.sourceId, p]));
  // Source-side coupon definitions, so the expected MRR can net `forever` coupons
  // the same way the engine does (cached on the source — this is a re-read).
  const srcCouponById = new Map(
    (source.listCoupons ? (await source.listCoupons()).coupons : []).map((c) => [c.sourceId, c]),
  );

  compared["subscription_detail"] = srcSubs.length;
  const mrrExpectedByCurrency = new Map<string, bigint>();
  for (const s of srcSubs) {
    const targetId = subMap.get(s.sourceId);
    const db = targetId ? dbSubById.get(targetId) : undefined;
    if (!db) {
      miss({ area: "subscription", sourceId: s.sourceId, expected: "imported", actual: "missing" });
      continue;
    }
    const wantStatus = expectedStatus(s.status);
    if (db.status !== wantStatus && !(wantStatus === "active" && db.status === "in_trial")) {
      miss({
        area: "subscription.status",
        sourceId: s.sourceId,
        expected: wantStatus,
        actual: db.status,
      });
    }
    if (s.status === "non_renewing" && !db.cancelAtPeriodEnd) {
      miss({
        area: "subscription.cancel_at_period_end",
        sourceId: s.sourceId,
        expected: true,
        actual: false,
      });
    }
    // No term while trialling (2026-08-25), so there is nothing to compare — reported as
    // no drift rather than a false mismatch.
    const termDrift =
      db.currentPeriodEnd == null
        ? 0
        : Math.abs(db.currentPeriodEnd.getTime() - s.currentTermEnd.getTime());
    if (termDrift > 1000) {
      miss({
        area: "subscription.term_end",
        sourceId: s.sourceId,
        expected: s.currentTermEnd.toISOString(),
        actual: db.currentPeriodEnd?.toISOString() ?? null,
      });
    }
    const items = itemsBySub.get(db.id) ?? [];
    if (items.length !== s.items.length) {
      miss({
        area: "subscription.items",
        sourceId: s.sourceId,
        expected: s.items.length,
        actual: items.length,
      });
      continue;
    }
    // Compare quantities + effective unit amounts via the snapshots.
    const priceMap = mapOf("price");
    for (const si of s.items) {
      const srcPrice = srcPriceById.get(si.priceSourceId);
      const targetPriceId = priceMap.get(si.priceSourceId);
      const dbItem = items.find((it) => it.priceId === targetPriceId);
      if (!dbItem) {
        miss({
          area: "subscription.item",
          sourceId: `${s.sourceId}/${si.priceSourceId}`,
          expected: `qty ${si.quantity}`,
          actual: "missing",
        });
        continue;
      }
      if (dbItem.quantity !== si.quantity) {
        miss({
          area: "subscription.item_quantity",
          sourceId: `${s.sourceId}/${si.priceSourceId}`,
          expected: si.quantity,
          actual: dbItem.quantity,
        });
      }
      const snap = dbItem.priceSnapshot as PriceSnapshot | null;
      const expectedAmount =
        si.unitPriceMinor != null && (snap?.model === "flat" || snap?.model === "per_unit")
          ? si.unitPriceMinor
          : (srcPrice?.amountMinor ?? snap?.amountMinor ?? null);
      if (expectedAmount != null && snap?.amountMinor !== expectedAmount) {
        miss({
          area: "subscription.item_amount",
          sourceId: `${s.sourceId}/${si.priceSourceId}`,
          expected: expectedAmount,
          actual: snap?.amountMinor ?? null,
        });
      }
    }
    // Expected MRR (flat/per_unit items; mirrors the cached column).
    //
    // MRR counts ACTIVE + NON_RENEWING only. `trialing` and `future` are
    // excluded — they carry MRR $0.00, and so do we (`in_trial` stores 0
    // via `recomputeSubscriptionMrr`, and the importer now matches). Counting them
    // here compared a plan-rate expectation against a stored 0 and flagged every
    // trial as a divergence.
    if (["active", "non_renewing"].includes(s.status)) {
      let mrr = 0n;
      for (const si of s.items) {
        const srcPrice = srcPriceById.get(si.priceSourceId);
        if (!srcPrice || !srcPrice.interval) continue;
        if (srcPrice.model !== "flat" && srcPrice.model !== "per_unit") continue;
        const amount = si.unitPriceMinor ?? srcPrice.amountMinor ?? 0;
        mrr += monthlyRecurringMinor(
          {
            type: "recurring",
            model: srcPrice.model,
            amountMinor: BigInt(amount),
            interval: srcPrice.interval,
            intervalCount: srcPrice.intervalCount ?? 1,
            tiers: null,
            packageSize: null,
            freeUnits: null,
            percentageBps: null,
          } as unknown as typeof prices.$inferSelect,
          si.quantity,
        );
      }
      // Net the SOURCE-side discounts, computed independently of import.ts: any
      // discount spanning more than one billing period restates recurring revenue
      // (`discountsForMrr` owns the rule). Comparing a gross expectation against a
      // netted column would fail every discounted subscription — and, before
      // 2026-08-07, comparing gross-to-gross is what hid the fact that
      // `subscription.discounts[]` was not imported at all.
      const recurringItem = s.items
        .map((si) => srcPriceById.get(si.priceSourceId))
        .find((p) => p?.interval);
      // A discount's span is expressed in the source's own unit; converting it to BILLING
      // PERIODS needs the cadence it is measured against. Same source the netting below
      // uses, so the expectation and the engine agree on what a "period" is.
      const discountCadence: DiscountCadence | null = recurringItem?.interval
        ? { interval: recurringItem.interval, intervalCount: recurringItem.intervalCount ?? 1 }
        : null;
      const active: ActiveDiscountForMrr[] = [
        ...(s.appliedCoupons ?? []).flatMap((ac) => {
          const c = srcCouponById.get(ac.couponSourceId);
          if (!c) return [];
          return [
            {
              source: "coupon",
              remainingPeriods: null,
              totalPeriods:
                c.durationType === "forever"
                  ? null
                  : c.durationType === "repeating"
                    ? Math.max(1, c.durationInPeriods ?? 1)
                    : 1,
              manualKind: null,
              manualPercentOffBps: null,
              manualAmountOffMinor: null,
              manualCurrency: null,
              coupon: {
                kind: c.kind,
                percentOffBps: c.percentOffBps ?? null,
                amountOffMinor: c.amountOffMinor != null ? BigInt(c.amountOffMinor) : null,
                currency: c.currency ?? null,
                durationType: c.durationType,
              },
            } satisfies ActiveDiscountForMrr,
          ];
        }),
        ...(s.discounts ?? []).filter(discountIsImportable).map(
          (d) =>
            ({
              source: "manual",
              remainingPeriods: discountRemainingPeriods(d, discountCadence),
              totalPeriods: discountTotalPeriods(d, discountCadence),
              manualKind: d.kind,
              manualPercentOffBps: d.percentOffBps ?? null,
              manualAmountOffMinor: d.amountOffMinor != null ? BigInt(d.amountOffMinor) : null,
              manualCurrency: d.currency ?? null,
              coupon: null,
            }) satisfies ActiveDiscountForMrr,
        ),
      ];
      mrr = netMrrForDiscounts(
        mrr,
        discountsForMrr(active),
        recurringItem?.interval ?? "month",
        recurringItem?.intervalCount ?? 1,
      );
      const cur = s.currency.toUpperCase();
      mrrExpectedByCurrency.set(cur, (mrrExpectedByCurrency.get(cur) ?? 0n) + mrr);
    }
  }

  // --- 3) MRR totals per currency ---------------------------------------------
  // OUR db vocabulary for the source's active + non_renewing (we store the
  // latter as `active` + `cancel_at_period_end`). `in_trial` and `future` are out —
  // see the expected side above.
  const liveStatuses = ["active"];
  const mrrActualByCurrency = new Map<string, bigint>();
  for (const db of dbSubs) {
    if (!liveStatuses.includes(db.status)) continue;
    const cur = db.currency.toUpperCase();
    mrrActualByCurrency.set(cur, (mrrActualByCurrency.get(cur) ?? 0n) + (db.mrr ?? 0n));
  }
  compared["mrr_currencies"] = mrrExpectedByCurrency.size;
  for (const [cur, expected] of mrrExpectedByCurrency) {
    const actual = mrrActualByCurrency.get(cur) ?? 0n;
    if (expected !== actual) {
      miss({
        area: "mrr_total",
        sourceId: cur,
        expected: Number(expected),
        actual: Number(actual),
      });
    }
  }

  // --- 4) Coupon redemption counts ---------------------------------------------
  if (source.listCoupons) {
    const { coupons: srcCoupons } = await source.listCoupons();
    const couponMap = mapOf("coupon");
    const ids = [...couponMap.values()];
    const dbCoupons = ids.length
      ? await withTenant(organizationId, async (tx) =>
          tx.select().from(coupons).where(inArray(coupons.id, ids)),
        )
      : [];
    const dbCouponById = new Map(dbCoupons.map((cp) => [cp.id, cp]));
    compared["coupon_redemptions"] = srcCoupons.length;
    for (const sc of srcCoupons) {
      const db = dbCouponById.get(couponMap.get(sc.sourceId) ?? "");
      if (!db) continue; // counted in count:coupons
      if (db.timesRedeemed !== (sc.timesRedeemed ?? 0)) {
        miss({
          area: "coupon.times_redeemed",
          sourceId: sc.sourceId,
          expected: sc.timesRedeemed ?? 0,
          actual: db.timesRedeemed,
        });
      }
    }
  }

  // --- 5) Promo balances per customer/currency ---------------------------------
  const customerMap = mapOf("customer");
  compared["promo_balances"] = 0;
  for (const sc of srcCustomers) {
    for (const bal of sc.promoCreditBalances ?? []) {
      compared["promo_balances"]++;
      const customerId = customerMap.get(sc.sourceId);
      if (!customerId) continue;
      const actual = await walletBalance(organizationId, customerId, bal.currency.toUpperCase());
      if (actual !== BigInt(bal.amountMinor)) {
        miss({
          area: "promo_balance",
          sourceId: `${sc.sourceId}/${bal.currency}`,
          expected: bal.amountMinor,
          actual: Number(actual),
          detail: "expected right after import — post-cutover renewals legitimately draw this down",
        });
      }
    }
  }

  // --- 6) Open AR per currency ---------------------------------------------------
  if (srcInvoices) {
    const openByCurrency = new Map<string, number>();
    for (const i of srcInvoices) {
      // Open AR = finalized-but-owed invoices (posted / payment_due / not_paid).
      if (!OPEN_INVOICE_STATUSES.includes(i.status)) continue;
      const cur = i.currency.toUpperCase();
      openByCurrency.set(cur, (openByCurrency.get(cur) ?? 0) + i.amountDueMinor);
    }
    compared["open_ar_currencies"] = openByCurrency.size;
    for (const [cur, expected] of openByCurrency) {
      const actual = await accountBalance(organizationId, businessId, "accounts_receivable", cur);
      if (actual !== BigInt(expected)) {
        miss({
          area: "open_ar",
          sourceId: cur,
          expected,
          actual: Number(actual),
          detail: "expected right after import — post-cutover billing legitimately adds AR",
        });
      }
    }
  }

  return {
    pass: mismatches.length === 0,
    checkedAt: new Date().toISOString(),
    compared,
    mismatches,
    scope: {
      ...(catalogOnly ? { catalogOnly: true as const } : {}),
      ...(namedIds ? { namedSubscriptions: namedIds.size } : {}),
      subscriptionStatuses: catalogOnly ? [] : (input.scope?.subscriptionStatuses ?? "all"),
      customers: retainedCustomerSourceIds ? "holders-of-in-scope-subscriptions" : "all",
      invoices: includeHistory ? "all" : "open-only",
      excluded,
    },
  };
}
