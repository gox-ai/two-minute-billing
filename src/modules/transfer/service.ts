import { and, desc, eq, gt, inArray, isNull, lt, ne, or, type SQL } from "drizzle-orm";
import { withTenant, type Tx } from "@/platform/db";
import { publicId } from "@/platform/ids";
import {
  transferConfigurations,
  businesses,
  productGroups,
  products,
  prices,
  attachedItems,
  differentialPrices,
  coupons,
  couponItemConstraints,
  taxProfiles,
  taxRegions,
  taxRateComponents,
  taxStateRegistrations,
} from "@db/schema";
import { createLogger } from "@/platform/logger";
import { isUuid } from "@/platform/list-query";
import type { Role } from "@/modules/auth/service";
import { fixedRolePermissions, isFixedRole } from "@/modules/auth/permissions";
import {
  buildPairPlan,
  canon,
  componentKey,
  DEFAULT_SECTIONS,
  planIsEmpty,
  serializePairPlan,
  TransferError,
  type Biz,
  type MergeMode,
  type Numbering,
  type PairPlan,
  type TransferSection,
} from "./plan";

export { TransferError, ALL_SECTIONS, DEFAULT_SECTIONS } from "./plan";
export type { TransferSection, Numbering } from "./plan";

const log = createLogger("transfer");

/** The live override was asked for by someone who may not grant it. */
export class TransferForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransferForbiddenError";
  }
}

/** The destination changed after the preview the live override was bound to. */
export class TransferConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransferConflictError";
  }
}

/** Who may grant the live override: `transfers:live_override` (owner and admin among fixed roles). */
function overridePermissions(input: {
  operatorRole?: Role | null;
  operatorPermissions?: ReadonlySet<string> | null;
}): ReadonlySet<string> {
  if (input.operatorPermissions) return input.operatorPermissions;
  const role = input.operatorRole;
  return role && isFixedRole(role) ? fixedRolePermissions(role) : new Set();
}

/** A run older than this is a crash; `reapStuckTransfers` fails it. */
const STUCK_AFTER_MS = 10 * 60_000;
const STALE_PREVIEW = "The destination changed after the preview. Preview the transfer again.";

export interface SectionReport {
  created: number;
  updated: number;
  skipped: number;
}
type Report = Record<string, SectionReport>;

type JobRow = typeof transferConfigurations.$inferSelect;
export type TransferJob = JobRow & { twin: JobRow | null };

/** Strip identity/audit columns and re-home a copied row onto the destination.
 *  Returns `any` — a bulk row copier can't be statically typed per table. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function copyValues(
  src: Record<string, unknown>,
  destOrg: string,
  destBiz: string,
  overrides: Record<string, unknown> = {},
): any {
  const {
    id: _id,
    organizationId: _o,
    businessId: _b,
    resourceVersion: _rv,
    createdAt: _c,
    updatedAt: _u,
    ...rest
  } = src;
  return { ...rest, organizationId: destOrg, businessId: destBiz, ...overrides };
}

export interface TransferInput {
  organizationId: string;
  sourceBusinessId: string; // biz UUID
  destinationBusinessId: string; // biz UUID
  sections?: TransferSection[];
  wipeDestination?: boolean;
  /** Set the destination's prefixes. Omitted: the destination keeps its own. */
  numbering?: Numbering;
  /** Both businesses live: also copy the source's test twin into the destination's. */
  includeTestTwins?: boolean;
  /** Write settings / company profile / email / tax into a LIVE destination. */
  liveOverride?: { confirm: string; planDigest: string } | null;
  /** The signed-in person's role; null for a key. Only owners and admins grant the override. */
  operatorRole?: Role | null;
  /** The signed-in member's permission keys; wins over `operatorRole`. Null for a key. */
  operatorPermissions?: ReadonlySet<string> | null;
}

interface Pair {
  src: Biz;
  dest: Biz;
}

/** The main pair, plus the test twins when asked. Same organization by construction (RLS). */
async function resolvePairs(
  tx: Tx,
  input: TransferInput,
): Promise<{ main: Pair; twin: Pair | null }> {
  if (input.sourceBusinessId === input.destinationBusinessId)
    throw new TransferError("The source and the destination must be different businesses.");
  const rows = await tx
    .select()
    .from(businesses)
    .where(inArray(businesses.id, [input.sourceBusinessId, input.destinationBusinessId]));
  const src = rows.find((b) => b.id === input.sourceBusinessId);
  const dest = rows.find((b) => b.id === input.destinationBusinessId);
  if (!src || !dest) throw new TransferError("We could not find the source or the destination.");
  if (src.organizationId !== input.organizationId || dest.organizationId !== input.organizationId)
    throw new TransferError("The source and the destination must be in this organization.");
  if (!input.includeTestTwins) return { main: { src, dest }, twin: null };
  if (src.livemode !== "live" || dest.livemode !== "live")
    throw new TransferError(
      "include_test_twins needs a live source and a live destination. Their test businesses are copied with them.",
    );
  const twins = await tx
    .select()
    .from(businesses)
    .where(inArray(businesses.liveBusinessId, [src.id, dest.id]));
  const srcTwin = twins.find((t) => t.liveBusinessId === src.id);
  const destTwin = twins.find((t) => t.liveBusinessId === dest.id);
  if (!srcTwin)
    throw new TransferError(
      `${src.publicId} has no test business. Copy without include_test_twins.`,
    );
  if (!destTwin)
    throw new TransferError(
      `${dest.publicId} has no test business yet. Open its test mode once, then try again.`,
    );
  return { main: { src, dest }, twin: { src: srcTwin, dest: destTwin } };
}

/** Only the main pair clears first; a twin pair never does. */
const planOpts = (
  input: TransferInput,
  sections: TransferSection[],
  allowLiveWrites: boolean,
  wipe = false,
) => ({ sections, numbering: input.numbering, allowLiveWrites, wipe });
const blockerText = (plan: PairPlan) => plan.blockers.map((b) => b.message).join(" ");

/**
 * What a transfer would write, pair by pair and field by field. Writes nothing. A LIVE
 * destination is planned as if the live override were granted, so the operator sees what
 * it would change; `plan_digest` binds a later override run to exactly this plan.
 */
export async function previewTransfer(input: TransferInput) {
  const sections = input.sections?.length ? input.sections : DEFAULT_SECTIONS;
  return withTenant(input.organizationId, async (tx) => {
    const { main, twin } = await resolvePairs(tx, input);
    const mainPlan = await buildPairPlan(
      tx,
      main.src,
      main.dest,
      planOpts(input, sections, true, input.wipeDestination === true),
    );
    const twinPlan = twin
      ? await buildPairPlan(tx, twin.src, twin.dest, planOpts(input, sections, true))
      : null;
    const liveOverrideAvailable =
      main.dest.livemode === "live" &&
      mainPlan.sections.some((s) => s.status === "needs_live_override" && s.changes > 0);
    return {
      object: "transfer_preview" as const,
      source_business: main.src.publicId,
      destination_business: main.dest.publicId,
      sections,
      plan_digest: mainPlan.digest,
      live_override_available: liveOverrideAvailable,
      pairs: [...(twinPlan ? [twinPlan] : []), mainPlan].map(serializePairPlan),
    };
  });
}

/**
 * Copy catalog, coupons, tax, settings, company profile and email sending from a source
 * business to a destination. Both directions. NEVER touches customers/subs/invoices/gateway
 * credentials/keys/webhooks/email templates.
 *
 * A LIVE destination is merge-only: catalog and coupons skip what exists, and the override
 * sections (settings, company profile, email, tax updates) write nothing — unless the live
 * override is granted: a signed-in owner or admin, the destination's exact name typed back,
 * and the digest of a preview that still matches the destination under a row lock.
 *
 * Each pair runs in one transaction (atomic) and re-plans after writing: a difference left
 * over rolls the pair back. With test twins, the test pair runs first; if it fails, the live
 * pair is not touched.
 *
 * Currency note (finale review, accepted-by-design): copied prices KEEP their source
 * currency — catalogs are multi-currency and billing matches price currency to the
 * customer. No conversion is ever attempted.
 */
export async function runTransfer(input: TransferInput): Promise<TransferJob> {
  const { organizationId: orgId } = input;
  const sections = input.sections?.length ? input.sections : DEFAULT_SECTIONS;
  const override = !!input.liveOverride;

  const { main, twin } = await withTenant(orgId, async (tx) => {
    const pairs = await resolvePairs(tx, input);
    if (override) {
      if (pairs.main.dest.livemode !== "live")
        throw new TransferError("live_override applies only when the destination is live.");
      if (!overridePermissions(input).has("transfers:live_override"))
        throw new TransferForbiddenError(
          "The live override needs a signed-in owner or admin. An API key cannot grant it.",
        );
      if (input.liveOverride!.confirm !== pairs.main.dest.name)
        throw new TransferError(
          "The confirmation does not match the destination's name. Type the name exactly.",
        );
    }
    // Preflight: a blocker or a stale preview refuses the run before anything is written.
    for (const [pair, allow, wipe] of [
      [pairs.twin, true, false],
      [pairs.main, override, input.wipeDestination === true],
    ] as const) {
      if (!pair) continue;
      const plan = await buildPairPlan(
        tx,
        pair.src,
        pair.dest,
        planOpts(input, sections, allow, wipe),
      );
      if (plan.blockers.length) throw new TransferError(blockerText(plan));
      if (pair === pairs.main && override && plan.digest !== input.liveOverride!.planDigest)
        throw new TransferConflictError(STALE_PREVIEW);
    }
    return pairs;
  });

  const options = {
    ...(input.numbering ? { numbering: input.numbering } : {}),
    ...(input.includeTestTwins ? { include_test_twins: true } : {}),
  };
  const row = (pair: Pair, extra: Partial<typeof transferConfigurations.$inferInsert>) => ({
    organizationId: orgId,
    sourceBusinessId: pair.src.id,
    destinationBusinessId: pair.dest.id,
    sections,
    // Asymmetry: wipe-first only when the destination is a TEST business. Never twins.
    wipeDestination: input.wipeDestination === true && pair.dest.livemode === "test",
    status: "running",
    options: Object.keys(options).length ? options : null,
    ...extra,
  });
  const { mainJob, twinJob } = await withTenant(orgId, async (tx) => {
    // One run per destination at a time. The row lock makes the check and the insert atomic
    // against a second request for the same destination.
    const dests = [main.dest.id, ...(twin ? [twin.dest.id] : [])];
    await tx
      .select({ id: businesses.id })
      .from(businesses)
      .where(inArray(businesses.id, dests))
      .for("update");
    const [busy] = await tx
      .select({ id: transferConfigurations.id })
      .from(transferConfigurations)
      .where(
        and(
          inArray(transferConfigurations.destinationBusinessId, dests),
          eq(transferConfigurations.status, "running"),
          // Older than the reaper's cutoff = a crashed run, not a live one.
          gt(transferConfigurations.createdAt, new Date(Date.now() - STUCK_AFTER_MS)),
        ),
      )
      .limit(1);
    if (busy)
      throw new TransferConflictError(
        "A transfer into this business is still running. Wait for it to finish, then try again.",
      );
    const [m] = await tx
      .insert(transferConfigurations)
      .values(
        row(main, {
          liveOverride: override,
          planDigest: override ? input.liveOverride!.planDigest : null,
        }),
      )
      .returning();
    const [t] = twin
      ? await tx
          .insert(transferConfigurations)
          .values(row(twin, { twinOf: m!.id, wipeDestination: false }))
          .returning()
      : [null];
    return { mainJob: m!, twinJob: t ?? null };
  });

  let twinDone: JobRow | null = null;
  if (twin && twinJob) {
    twinDone = await runPair(orgId, twinJob, twin, sections, input, true, null);
    if (twinDone.status === "failed") {
      const main = await finishJob(
        orgId,
        mainJob.id,
        "failed",
        null,
        `We did not change the live business, because the test businesses were not copied: ${twinDone.error}`,
      );
      return { ...main, twin: twinDone };
    }
  }
  const mainDone = await runPair(
    orgId,
    mainJob,
    main,
    sections,
    input,
    override,
    override ? input.liveOverride!.planDigest : null,
  );
  return { ...mainDone, twin: twinDone };
}

/** Plan and apply one pair in one transaction, then mark its job. */
async function runPair(
  orgId: string,
  job: JobRow,
  pair: Pair,
  sections: TransferSection[],
  input: TransferInput,
  allowLiveWrites: boolean,
  expectedDigest: string | null,
): Promise<JobRow> {
  try {
    const report = await withTenant(orgId, async (tx) => {
      // Lock the destination: nothing may change it between the plan and the write.
      const [dest] = await tx
        .select()
        .from(businesses)
        .where(eq(businesses.id, pair.dest.id))
        .for("update");
      const [src] = await tx.select().from(businesses).where(eq(businesses.id, pair.src.id));
      if (!src || !dest)
        throw new TransferError("We could not find the source or the destination.");
      const opts = planOpts(input, sections, allowLiveWrites, job.wipeDestination);
      const plan = await buildPairPlan(tx, src, dest, opts);
      if (plan.blockers.length) throw new TransferError(blockerText(plan));
      if (expectedDigest && plan.digest !== expectedDigest)
        throw new TransferConflictError(STALE_PREVIEW);

      const report = await applyPlan(tx, orgId, plan, sections, job.wipeDestination);

      const [after] = await tx.select().from(businesses).where(eq(businesses.id, dest.id));
      // After the write a clear-first has nothing left to clear: re-plan as a plain copy.
      const recheck = await buildPairPlan(tx, src, after!, { ...opts, wipe: false });
      if (!planIsEmpty(recheck))
        throw new Error(
          `self-check: ${canon(Object.keys(recheck.patch))} and ${recheck.taxChanges} tax change(s) remain; rolled back`,
        );

      // A transfer is a config-mutating admin action — it belongs in the audit trail like
      // any settings change. Field values are the plan's; secrets are masked there.
      const { writeAuditLog } = await import("@/modules/audit/service");
      await writeAuditLog(
        {
          organizationId: orgId,
          businessId: dest.id,
          action: plan.override ? "transfer.live_override" : "transfer.run",
          resourceType: "transfer",
          resourceId: job.id,
          before: { fields: plan.auditBefore },
          after: {
            fields: plan.auditAfter,
            source_business: src.publicId,
            sections,
            wipe: job.wipeDestination,
            mode: plan.mode,
            report,
            ...(plan.override ? { plan_digest: plan.digest } : {}),
          },
        },
        tx,
      );
      return report;
    });
    return await finishJob(orgId, job.id, "succeeded", report, null);
  } catch (e) {
    // The job row keeps the message; the log keeps the stack and the trace.
    log.error(e, {
      event: "transfer_failed",
      job: job.id,
      sourceBusiness: pair.src.id,
      destBusiness: pair.dest.id,
      sections,
    });
    return await finishJob(orgId, job.id, "failed", null, (e as Error)?.message ?? String(e));
  }
}

async function applyPlan(
  tx: Tx,
  orgId: string,
  plan: PairPlan,
  sections: TransferSection[],
  wipe: boolean,
): Promise<Report> {
  const srcBiz = plan.source.id;
  const destBiz = plan.destination.id;
  const mode = plan.mode;
  const report: Report = {};
  if (wipe) await wipeDestinationCatalog(tx, destBiz, sections);
  // Catalog first (groups → products → prices → attached → differential); coupons
  // and item-constraints depend on product ids too.
  const groupMap = new Map<string, string>();
  const productMap = new Map<string, string>();
  const priceMap = new Map<string, string>();
  if (sections.includes("catalog")) {
    report.catalog = { created: 0, updated: 0, skipped: 0 };
    await copyBySlug(
      tx,
      productGroups,
      srcBiz,
      destBiz,
      orgId,
      report.catalog,
      {},
      groupMap,
      "publicId",
      mode,
    );
    await copyBySlug(
      tx,
      products,
      srcBiz,
      destBiz,
      orgId,
      report.catalog,
      (src) => ({ productGroupId: groupMap.get(src.productGroupId as string) ?? null }),
      productMap,
      "publicId",
      mode,
    );
    await copyBySlug(
      tx,
      prices,
      srcBiz,
      destBiz,
      orgId,
      report.catalog,
      (src) => ({ productId: productMap.get(src.productId as string) }),
      priceMap,
      "publicId",
      mode,
    );
    await copyAttachedItems(tx, srcBiz, destBiz, orgId, productMap, report.catalog, mode);
    await copyDifferentialPrices(tx, srcBiz, destBiz, orgId, productMap, report.catalog, mode);
  }
  if (sections.includes("coupons")) {
    report.coupons = { created: 0, updated: 0, skipped: 0 };
    const couponMap = new Map<string, string>();
    await copyBySlug(
      tx,
      coupons,
      srcBiz,
      destBiz,
      orgId,
      report.coupons,
      {},
      couponMap,
      "code",
      mode,
    );
    await copyCouponConstraints(tx, srcBiz, destBiz, orgId, couponMap, report.coupons);
  }
  if (sections.includes("tax_rates")) {
    report.tax_rates = { created: 0, updated: 0, skipped: 0 };
    const live = plan.destination.livemode === "live";
    if (!live || plan.override) {
      if (plan.renameDefaultProfile)
        await tx
          .update(taxProfiles)
          .set({ name: plan.renameDefaultProfile.to })
          .where(eq(taxProfiles.id, plan.renameDefaultProfile.id));
      // Live: only when something differs, so a no-op override writes no tax rows at all.
      if (!live || plan.taxChanges > 0)
        await copyTaxRates(tx, srcBiz, destBiz, orgId, report.tax_rates, "overwrite");
    } else {
      // Live without the override: new profiles are created, existing ones are kept.
      await copyTaxRates(tx, srcBiz, destBiz, orgId, report.tax_rates, "skip_existing");
    }
  }
  for (const sec of plan.sections) {
    if (!sec.fields) continue;
    const written = sec.status === "copy" || plan.override;
    report[sec.section] = {
      created: 0,
      updated: written ? sec.changes : 0,
      skipped: written ? 0 : 1,
    };
  }
  if (Object.keys(plan.patch).length > 0)
    await tx.update(businesses).set(plan.patch).where(eq(businesses.id, destBiz));
  return report;
}

async function finishJob(
  orgId: string,
  jobId: string,
  status: string,
  report: Report | null,
  error: string | null,
): Promise<JobRow> {
  return withTenant(orgId, async (tx) => {
    const [row] = await tx
      .update(transferConfigurations)
      .set({ status, report, error, updatedAt: new Date() })
      .where(eq(transferConfigurations.id, jobId))
      .returning();
    return row!;
  });
}

/** Merge/insert rows keyed by a slug column (default public_id). Builds src→dest id map. */
async function copyBySlug(
  tx: Tx,
  table: any,
  srcBiz: string,
  destBiz: string,
  orgId: string,
  rep: SectionReport,
  overrides: ((src: any) => Record<string, unknown>) | Record<string, unknown>,
  idMap: Map<string, string>,
  keyCol: "publicId" | "code" = "publicId",
  mode: MergeMode = "overwrite",
): Promise<void> {
  const key = table[keyCol];
  const srcRows = await tx.select().from(table).where(eq(table.businessId, srcBiz));
  for (const src of srcRows) {
    const ov = typeof overrides === "function" ? overrides(src) : overrides;
    const values = copyValues(src, orgId, destBiz, ov);
    const [existing] = await tx
      .select()
      .from(table)
      .where(and(eq(table.businessId, destBiz), eq(key, src[keyCol])))
      .limit(1);
    if (existing) {
      if (mode === "skip_existing") {
        // Live destination: the existing row WINS — never rewrite live prices/
        // catalog under transfers. Still map ids so children link to it.
        idMap.set(src.id, existing.id);
        rep.skipped++;
        continue;
      }
      // Test destination merge: update everything except identity/key.
      const { [keyCol]: _k, ...updatable } = values as Record<string, unknown>;
      await tx.update(table).set(updatable).where(eq(table.id, existing.id));
      idMap.set(src.id, existing.id);
      rep.updated++;
    } else {
      const [row] = await tx.insert(table).values(values).returning({ id: table.id });
      idMap.set(src.id, row!.id);
      rep.created++;
    }
  }
}

async function wipeDestinationCatalog(
  tx: Tx,
  destBiz: string,
  sections: TransferSection[],
): Promise<void> {
  // FK-safe order. Only wipe sections that will be re-copied.
  if (sections.includes("catalog")) {
    await tx.delete(differentialPrices).where(eq(differentialPrices.businessId, destBiz));
    await tx.delete(attachedItems).where(eq(attachedItems.businessId, destBiz));
  }
  if (sections.includes("coupons")) {
    await tx.delete(couponItemConstraints).where(eq(couponItemConstraints.businessId, destBiz));
    await tx.delete(coupons).where(eq(coupons.businessId, destBiz));
  }
  if (sections.includes("catalog")) {
    await tx.delete(prices).where(eq(prices.businessId, destBiz));
    await tx.delete(products).where(eq(products.businessId, destBiz));
    // Keep the auto-created "Default" product group; delete the rest.
    // (H review: inArray([]) compiled to WHERE false and deleted nothing.)
    await tx
      .delete(productGroups)
      .where(and(eq(productGroups.businessId, destBiz), ne(productGroups.publicId, "default")));
  }
  // Deleting the profiles cascades to regions → components → state registrations, so
  // one statement clears the whole tax configuration.
  if (sections.includes("tax_rates"))
    await tx.delete(taxProfiles).where(eq(taxProfiles.businessId, destBiz));
}

async function copyAttachedItems(
  tx: Tx,
  srcBiz: string,
  destBiz: string,
  orgId: string,
  productMap: Map<string, string>,
  rep: SectionReport,
  mode: MergeMode = "overwrite",
): Promise<void> {
  const rows = await tx.select().from(attachedItems).where(eq(attachedItems.businessId, srcBiz));
  for (const src of rows) {
    const item = productMap.get(src.itemProductId);
    const plan = productMap.get(src.planProductId);
    if (!item || !plan) {
      rep.skipped++;
      continue;
    }
    const [existing] = await tx
      .select()
      .from(attachedItems)
      .where(
        and(
          eq(attachedItems.businessId, destBiz),
          eq(attachedItems.itemProductId, item),
          eq(attachedItems.planProductId, plan),
        ),
      )
      .limit(1);
    const values = copyValues(src, orgId, destBiz, { itemProductId: item, planProductId: plan });
    if (existing) {
      if (mode === "skip_existing") {
        rep.skipped++;
        continue;
      }
      await tx.update(attachedItems).set(values).where(eq(attachedItems.id, existing.id));
      rep.updated++;
    } else {
      await tx.insert(attachedItems).values(values);
      rep.created++;
    }
  }
}

async function copyDifferentialPrices(
  tx: Tx,
  srcBiz: string,
  destBiz: string,
  orgId: string,
  productMap: Map<string, string>,
  rep: SectionReport,
  mode: MergeMode = "overwrite",
): Promise<void> {
  const rows = await tx
    .select()
    .from(differentialPrices)
    .where(eq(differentialPrices.businessId, srcBiz));
  for (const src of rows) {
    const addon = productMap.get(src.addonProductId);
    const plan = productMap.get(src.planProductId);
    if (!addon || !plan) {
      rep.skipped++;
      continue;
    }
    const [existing] = await tx
      .select()
      .from(differentialPrices)
      .where(
        and(
          eq(differentialPrices.businessId, destBiz),
          eq(differentialPrices.addonProductId, addon),
          eq(differentialPrices.planProductId, plan),
          // Natural key includes the interval; NULL interval must match NULL, not
          // any row (H review: the old tautology overwrote arbitrary intervals).
          src.interval == null
            ? isNull(differentialPrices.interval)
            : eq(differentialPrices.interval, src.interval),
        ),
      )
      .limit(1);
    // publicId (dprice_…) is globally unique — regenerate on copy; keep on update.
    const values = copyValues(src, orgId, destBiz, { addonProductId: addon, planProductId: plan });
    delete values.publicId;
    if (existing) {
      if (mode === "skip_existing") {
        rep.skipped++;
        continue;
      }
      await tx.update(differentialPrices).set(values).where(eq(differentialPrices.id, existing.id));
      rep.updated++;
    } else {
      await tx.insert(differentialPrices).values({ ...values, publicId: publicId("dprice") });
      rep.created++;
    }
  }
}

async function copyCouponConstraints(
  tx: Tx,
  srcBiz: string,
  destBiz: string,
  orgId: string,
  couponMap: Map<string, string>,
  rep: SectionReport,
): Promise<void> {
  const rows = await tx
    .select()
    .from(couponItemConstraints)
    .where(eq(couponItemConstraints.businessId, srcBiz));
  // Product slug ids inside product_ids carry over verbatim (slugs are stable across businesses).
  for (const src of rows) {
    const couponId = couponMap.get(src.couponId);
    if (!couponId) {
      rep.skipped++;
      continue;
    }
    await tx
      .delete(couponItemConstraints)
      .where(
        and(
          eq(couponItemConstraints.couponId, couponId),
          eq(couponItemConstraints.itemKind, src.itemKind),
        ),
      );
    await tx.insert(couponItemConstraints).values(copyValues(src, orgId, destBiz, { couponId }));
    rep.created++;
  }
}

/**
 * Copy the whole tax configuration: profiles → regions → components → state
 * registrations. Four levels, matched on NATURAL keys (profile name, region country,
 * component state+name, registration state) because every level's `publicId` is
 * globally unique and must be regenerated on copy.
 *
 * A region's component vector ends up EXACTLY the source's: a dest keeping a stale `IGST 1800`
 * next to a freshly copied `CGST 900 + SGST 900` would tax an inter-state supply at a rate
 * nobody configured. Components are updated in place by key, not deleted and re-inserted:
 * `applied_taxes.tax_component_id` is ON DELETE SET NULL, so a re-insert would detach every
 * issued invoice's tax line. Only destination-only components are deleted (on a live
 * destination the plan refuses when an issued invoice uses one). `skip_existing` skips a
 * matched profile entirely, regions and vectors included.
 */
async function copyTaxRates(
  tx: Tx,
  srcBiz: string,
  destBiz: string,
  orgId: string,
  rep: SectionReport,
  mode: MergeMode = "overwrite",
): Promise<void> {
  const srcProfiles = await tx.select().from(taxProfiles).where(eq(taxProfiles.businessId, srcBiz));
  for (const sp of srcProfiles) {
    const [destProfile] = await tx
      .select()
      .from(taxProfiles)
      .where(and(eq(taxProfiles.businessId, destBiz), eq(taxProfiles.name, sp.name)))
      .limit(1);
    let profileId: string;
    if (destProfile) {
      if (mode === "skip_existing") {
        rep.skipped++;
        continue;
      }
      const pv = copyValues(sp, orgId, destBiz);
      delete pv.publicId;
      await tx.update(taxProfiles).set(pv).where(eq(taxProfiles.id, destProfile.id));
      profileId = destProfile.id;
      rep.updated++;
    } else {
      const pv = copyValues(sp, orgId, destBiz);
      delete pv.publicId;
      const [row] = await tx
        .insert(taxProfiles)
        .values({ ...pv, publicId: publicId("txp") })
        .returning();
      profileId = row!.id;
      rep.created++;
    }

    const srcRegions = await tx.select().from(taxRegions).where(eq(taxRegions.taxProfileId, sp.id));
    for (const sr of srcRegions) {
      const [destRegion] = await tx
        .select()
        .from(taxRegions)
        .where(and(eq(taxRegions.taxProfileId, profileId), eq(taxRegions.country, sr.country)))
        .limit(1);
      const rv = copyValues(sr, orgId, destBiz);
      delete rv.publicId;
      rv.taxProfileId = profileId;
      let regionId: string;
      if (destRegion) {
        if (mode === "skip_existing") {
          rep.skipped++;
          continue;
        }
        await tx.update(taxRegions).set(rv).where(eq(taxRegions.id, destRegion.id));
        regionId = destRegion.id;
        rep.updated++;
      } else {
        const [row] = await tx
          .insert(taxRegions)
          .values({ ...rv, publicId: publicId("txg") })
          .returning();
        regionId = row!.id;
        rep.created++;
      }

      const destComponents = await tx
        .select()
        .from(taxRateComponents)
        .where(eq(taxRateComponents.taxRegionId, regionId));
      const leftComponents = new Map(destComponents.map((c) => [componentKey(c), c]));
      const srcComponents = await tx
        .select()
        .from(taxRateComponents)
        .where(eq(taxRateComponents.taxRegionId, sr.id));
      for (const sc of srcComponents) {
        const cv = copyValues(sc, orgId, destBiz);
        delete cv.publicId;
        cv.taxRegionId = regionId;
        const hit = leftComponents.get(componentKey(sc));
        if (hit) {
          leftComponents.delete(componentKey(sc));
          await tx.update(taxRateComponents).set(cv).where(eq(taxRateComponents.id, hit.id));
          rep.updated++;
        } else {
          await tx.insert(taxRateComponents).values({ ...cv, publicId: publicId("txc") });
          rep.created++;
        }
      }
      if (leftComponents.size)
        await tx.delete(taxRateComponents).where(
          inArray(
            taxRateComponents.id,
            [...leftComponents.values()].map((c) => c.id),
          ),
        );

      const destRegs = await tx
        .select()
        .from(taxStateRegistrations)
        .where(eq(taxStateRegistrations.taxRegionId, regionId));
      const leftRegs = new Map(destRegs.map((g) => [g.stateCode, g]));
      const srcRegs = await tx
        .select()
        .from(taxStateRegistrations)
        .where(eq(taxStateRegistrations.taxRegionId, sr.id));
      for (const sg of srcRegs) {
        const gv = copyValues(sg, orgId, destBiz);
        delete gv.publicId;
        gv.taxRegionId = regionId;
        const hit = leftRegs.get(sg.stateCode);
        if (hit) {
          leftRegs.delete(sg.stateCode);
          await tx
            .update(taxStateRegistrations)
            .set(gv)
            .where(eq(taxStateRegistrations.id, hit.id));
          rep.updated++;
        } else {
          await tx.insert(taxStateRegistrations).values({ ...gv, publicId: publicId("txs") });
          rep.created++;
        }
      }
      if (leftRegs.size)
        await tx.delete(taxStateRegistrations).where(
          inArray(
            taxStateRegistrations.id,
            [...leftRegs.values()].map((g) => g.id),
          ),
        );
    }
  }
}

/**
 * Clock pass (finale review): a crash between the copy tx and finishJob leaves a
 * transfer stuck `running` forever. Reap anything running > 10 minutes to
 * `failed` (the copy tx is atomic — a reaped job either fully applied or fully
 * rolled back; re-running the transfer is the idempotent recovery).
 */
export async function reapStuckTransfers(now: Date): Promise<{ reaped: number }> {
  const { systemDb: db } = await import("@/platform/db");
  const cutoff = new Date(now.getTime() - STUCK_AFTER_MS);
  const rows = await db
    .update(transferConfigurations)
    .set({
      status: "failed",
      error: "reaped: transfer did not finish within 10 minutes (process crash?)",
      updatedAt: now,
    })
    .where(
      and(
        eq(transferConfigurations.status, "running"),
        lt(transferConfigurations.createdAt, cutoff),
      ),
    )
    .returning({ id: transferConfigurations.id });
  return { reaped: rows.length };
}

/** A job and, for a run with test twins, the twin job that ran with it. */
export async function getTransfer(orgId: string, jobId: string): Promise<TransferJob | null> {
  // Raw uuid PK — a non-uuid job id is "not found", not a 500. See isUuid.
  if (!isUuid(jobId)) return null;
  return withTenant(orgId, async (tx) => {
    const [row] = await tx
      .select()
      .from(transferConfigurations)
      .where(eq(transferConfigurations.id, jobId))
      .limit(1);
    if (!row) return null;
    const [twin] = await tx
      .select()
      .from(transferConfigurations)
      .where(eq(transferConfigurations.twinOf, row.id))
      .limit(1);
    return { ...row, twin: twin ?? null };
  });
}

/**
 * Past runs, newest first: main jobs with their twin attached. `businessId` keeps the runs that
 * copied from or into that business; omitted, the whole organization. Keyset on
 * (created_at, id) — ids made before UUIDv7 are not time-ordered.
 */
export async function listTransfers(
  orgId: string,
  opts: { businessId?: string; limit: number; startingAfter?: string },
): Promise<{ data: TransferJob[]; hasMore: boolean }> {
  return withTenant(orgId, async (tx) => {
    const t = transferConfigurations;
    const where: SQL[] = [isNull(t.twinOf)];
    if (opts.businessId)
      where.push(
        or(eq(t.sourceBusinessId, opts.businessId), eq(t.destinationBusinessId, opts.businessId))!,
      );
    if (opts.startingAfter) {
      if (!isUuid(opts.startingAfter)) return { data: [], hasMore: false };
      const [cur] = await tx
        .select({ createdAt: t.createdAt, id: t.id })
        .from(t)
        .where(eq(t.id, opts.startingAfter))
        .limit(1);
      if (!cur) return { data: [], hasMore: false };
      where.push(
        or(lt(t.createdAt, cur.createdAt), and(eq(t.createdAt, cur.createdAt), lt(t.id, cur.id)))!,
      );
    }
    const rows = await tx
      .select()
      .from(t)
      .where(and(...where))
      .orderBy(desc(t.createdAt), desc(t.id))
      .limit(opts.limit + 1);
    const page = rows.slice(0, opts.limit);
    const twins = page.length
      ? await tx
          .select()
          .from(t)
          .where(
            inArray(
              t.twinOf,
              page.map((r) => r.id),
            ),
          )
      : [];
    return {
      data: page.map((r) => ({ ...r, twin: twins.find((x) => x.twinOf === r.id) ?? null })),
      hasMore: rows.length > opts.limit,
    };
  });
}
