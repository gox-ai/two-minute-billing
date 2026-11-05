/**
 * Credit packs (design G3 §3.6): a one-time price with `grants_credit.kind = "pack"`. Every
 * invoice line for a pack creates a `pending` grant in the invoice's transaction; the grant
 * activates when the invoice is paid, at every site that marks an invoice paid, with the
 * `activate_credit_grants` pass as the backstop.
 */
import { missingMeters } from "./scope";
import { normalizeReset, resetRefusal, type Reset } from "./reset-windows";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { systemDb, withTenant, type Tx } from "@/platform/db";
import { createLogger } from "@/platform/logger";
import { scanBusinessFilter } from "@/platform/clock";
import { postEntries } from "@/modules/ledger/service";
import { emitEvent } from "@/modules/events/emit";
import { buildEventData } from "@/modules/events/registry";
import {
  businesses,
  CREDIT_LEDGER_ACCOUNTS,
  creditGrants,
  creditUnits,
  invoices,
  prices,
  type BusinessCreditConfig,
  type PriceGrantsCredit,
} from "@db/schema";
import {
  CreditRuleError,
  grantViews,
  insertCreditGrant,
  recordGrantMovement,
  serializeCreditGrant,
  type CreditGrant,
  type CreditUnit,
} from "./service";
import { formatMoney } from "@/platform/currency";

const log = createLogger("credits.packs");
const A = CREDIT_LEDGER_ACCOUNTS;

// ── The price column ──────────────────────────────────────────────────────────

const applicability = z.union([
  z.object({ kind: z.literal("metered") }).strict(),
  z
    .object({
      kind: z.literal("prices"),
      prices: z.array(z.string().min(1).max(100)).min(1).max(100),
    })
    .strict(),
  z
    .object({
      kind: z.literal("meters"),
      meters: z.array(z.string().min(1).max(100)).min(1).max(100),
    })
    .strict(),
]);
const onExhausted = z.enum(["block", "bill"]).nullable().optional();
const amount = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const priority = z.number().int().min(0).max(100).optional();

export const priceGrantsCreditSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("pack"),
      unit: z.string().min(1).max(100).nullable(),
      amount,
      category: z.literal("paid").optional(),
      priority,
      expires_after: z
        .object({ days: z.number().int().min(1).max(3650) })
        .strict()
        .nullable()
        .optional(),
      applicability: applicability.optional(),
      tax_treatment: z.enum(["taxed_at_purchase", "taxed_at_use"]).nullable().optional(),
      on_exhausted: onExhausted,
    })
    .strict(),
  z
    .object({
      kind: z.literal("per_cycle"),
      unit: z.string().min(1).max(100).nullable(),
      amount,
      priority,
      applicability: applicability.optional(),
      on_exhausted: onExhausted,
      rollover: z
        .object({
          mode: z.enum(["none", "carry"]),
          percent: z.number().int().min(1).max(100).optional(),
          cap: amount.nullable().optional(),
          expire_after_cycles: z.number().int().min(1).max(120).nullable().optional(),
        })
        .strict()
        .optional(),
      reset: z.unknown().optional(),
      first_window: z.enum(["full", "prorated", "next_full_window"]).nullable().optional(),
    })
    .strict(),
]);

/**
 * Check a price's `grants_credit` against the price and the business, and fill the pack's tax
 * treatment from the business default. Throws `CreditRuleError` (400).
 */
export async function validatePriceGrantsCredit(
  tx: Tx,
  input: {
    businessId: string;
    priceType: string;
    /** The price's product kind. A plan's price is billed by a subscription, never sold. */
    productKind?: string | null;
    currency: string;
    value: unknown;
    /** The price's term, for the reset rule (G3b). */
    interval?: string | null;
    intervalCount?: number | null;
  },
): Promise<PriceGrantsCredit | null> {
  if (input.value == null) return null;
  const parsed = priceGrantsCreditSchema.safeParse(input.value);
  if (!parsed.success) {
    const i = parsed.error.issues[0];
    throw new CreditRuleError(
      `We could not save the price. grants_credit${i?.path.length ? `.${i.path.join(".")}` : ""}: ${i?.message ?? "not valid"}.`,
    );
  }
  const v = parsed.data;
  if (v.kind === "pack" && (input.priceType !== "one_time" || input.productKind === "plan"))
    throw new CreditRuleError(
      "We could not save the price. A credit pack must be a one-time price of an add-on or a charge.",
    );
  if (v.kind === "per_cycle" && input.priceType !== "recurring")
    throw new CreditRuleError(
      "We could not save the price. Credits per cycle need a recurring price.",
    );
  if (v.unit) {
    const [u] = await tx
      .select()
      .from(creditUnits)
      .where(and(eq(creditUnits.businessId, input.businessId), eq(creditUnits.key, v.unit)))
      .limit(1);
    if (!u)
      throw new CreditRuleError(`We could not save the price. No such credit unit: ${v.unit}.`);
    if (!u.active)
      throw new CreditRuleError(
        `We could not save the price. The credit unit ${v.unit} is archived.`,
      );
    if (u.currency !== input.currency.toUpperCase())
      throw new CreditRuleError(
        `We could not save the price. The credit unit ${v.unit} is priced in ${u.currency}, not ${input.currency.toUpperCase()}.`,
      );
  }
  if (v.applicability?.kind === "prices") {
    const found = await tx
      .select({ publicId: prices.publicId })
      .from(prices)
      .where(
        and(
          eq(prices.businessId, input.businessId),
          inArray(prices.publicId, v.applicability.prices),
        ),
      );
    const have = new Set(found.map((p) => p.publicId));
    const missing = v.applicability.prices.filter((p) => !have.has(p));
    if (missing.length)
      throw new CreditRuleError(
        `We could not save the price. No such price: ${missing.join(", ")}.`,
      );
  }
  if (v.applicability?.kind === "meters") {
    const missing = await missingMeters(tx, input.businessId, v.applicability.meters);
    if (missing.length)
      throw new CreditRuleError(
        `We could not save the price. No such meter: ${missing.join(", ")}.`,
      );
  }
  if (v.kind === "pack") {
    const [biz] = await tx
      .select({ cfg: businesses.creditConfig })
      .from(businesses)
      .where(eq(businesses.id, input.businessId))
      .limit(1);
    const treatment = v.tax_treatment ?? biz?.cfg?.default_tax_treatment ?? null;
    if (!treatment)
      throw new CreditRuleError(
        "We could not save the price. Set a tax treatment for paid credit first.",
      );
    if (treatment === "taxed_at_use" && v.unit)
      throw new CreditRuleError(
        "We could not save the price. Credit in a custom unit is taxed at purchase.",
      );
    return {
      kind: "pack",
      unit: v.unit,
      amount: v.amount,
      category: "paid",
      priority: v.priority ?? 50,
      expires_after: v.expires_after ?? null,
      applicability: v.applicability ?? { kind: "metered" },
      tax_treatment: treatment,
      on_exhausted: v.on_exhausted ?? null,
    };
  }
  let reset: Reset | null;
  try {
    reset = normalizeReset(v.reset ?? null);
  } catch (e) {
    throw new CreditRuleError(
      `We could not save the price. grants_credit.reset: ${(e as Error).message}.`,
    );
  }
  const refusal = resetRefusal(reset, {
    target: "credits",
    interval: input.interval,
    intervalCount: input.intervalCount,
  });
  if (refusal) throw new CreditRuleError(`We could not save the price. ${refusal}`);
  if (reset?.every === "never" && v.rollover?.mode === "carry")
    throw new CreditRuleError(
      "We could not save the price. Credits that never renew cannot carry over.",
    );
  const roll = v.rollover ?? { mode: "none" as const };
  return {
    kind: "per_cycle",
    unit: v.unit,
    amount: v.amount,
    priority: v.priority ?? 50,
    applicability: v.applicability ?? { kind: "metered" },
    on_exhausted: v.on_exhausted ?? null,
    rollover:
      roll.mode === "carry"
        ? {
            mode: "carry",
            percent: roll.percent ?? 100,
            cap: roll.cap ?? null,
            expire_after_cycles:
              roll.expire_after_cycles === undefined ? 1 : roll.expire_after_cycles,
          }
        : { mode: "none" },
    ...(reset && reset.every !== "term" ? { reset } : {}),
    ...(v.first_window != null ? { first_window: v.first_window } : {}),
  };
}

// ── Pack lines on an invoice ──────────────────────────────────────────────────

export interface PackPrice {
  priceId: string;
  pricePublicId: string;
  pack: Extract<PriceGrantsCredit, { kind: "pack" }>;
}

/** Pack prices among these price ids, keyed by price id. */
export async function packPricesFor(
  tx: Tx,
  priceIds: ReadonlyArray<string | null | undefined>,
): Promise<Map<string, PackPrice>> {
  const ids = [...new Set(priceIds.filter((p): p is string => !!p))];
  const out = new Map<string, PackPrice>();
  if (!ids.length) return out;
  const rows = await tx
    .select({ id: prices.id, publicId: prices.publicId, gc: prices.grantsCredit })
    .from(prices)
    .where(and(inArray(prices.id, ids), sql`${prices.grantsCredit}->>'kind' = 'pack'`));
  for (const r of rows)
    out.set(r.id, { priceId: r.id, pricePublicId: r.publicId, pack: r.gc as PackPrice["pack"] });
  return out;
}

/** Money of the pack lines in a line set (they take no promotional credit and no grants). */
export async function packLinesMinor(
  tx: Tx,
  lines: ReadonlyArray<{ priceId?: string | null; amountMinor: bigint; creditPack?: string }>,
): Promise<bigint> {
  const packs = await packPricesFor(
    tx,
    lines.map((l) => l.priceId),
  );
  return lines.reduce(
    (s, l) => s + (l.creditPack || (l.priceId && packs.has(l.priceId)) ? l.amountMinor : 0n),
    0n,
  );
}

/**
 * One `pending` grant per pack line of a fresh invoice, in its transaction, plus the reclass
 * Dr revenue / Cr credit_grants_pending at the cost basis (source `invoice`, so a void's mirror
 * reverses it). Cost basis = the line's net, excl. tax, after discounts. `source_ref` = the
 * line id: a re-run of the same invoice grants once.
 */
export async function createPendingPackGrants(
  tx: Tx,
  input: {
    organizationId: string;
    businessId: string;
    invoice: {
      id: string;
      publicId: string;
      customerId: string;
      currency: string;
      createdAt: Date;
    };
    lines: ReadonlyArray<{
      id: string;
      priceId?: string | null;
      quantity?: number | null;
      amountMinor: bigint;
      discountMinor?: bigint;
      inclusiveTaxMinor?: bigint;
    }>;
  },
): Promise<CreditGrant[]> {
  const packs = await packPricesFor(
    tx,
    input.lines.map((l) => l.priceId),
  );
  if (!packs.size) return [];
  const out: CreditGrant[] = [];
  let reclass = 0n;
  for (const line of input.lines) {
    const p = line.priceId ? packs.get(line.priceId) : undefined;
    if (!p) continue;
    const qty = BigInt(Math.max(1, line.quantity ?? 1));
    const unit = p.pack.unit ? await unitByKey(tx, input.businessId, p.pack.unit) : null;
    if (p.pack.unit && !unit)
      throw new CreditRuleError(
        `We could not create the invoice. No such credit unit: ${p.pack.unit}.`,
      );
    const cost = line.amountMinor - (line.discountMinor ?? 0n) - (line.inclusiveTaxMinor ?? 0n);
    // Effective now; the pair moves to the paid time at activation, keeping the lifetime.
    const effectiveAt = input.invoice.createdAt;
    const days = p.pack.expires_after?.days ?? null;
    const g = await insertCreditGrant(tx, {
      organizationId: input.organizationId,
      businessId: input.businessId,
      customerId: input.invoice.customerId,
      currency: input.invoice.currency,
      unit,
      amount: BigInt(p.pack.amount) * qty,
      costBasisMinor: cost > 0n ? cost : 0n,
      category: "paid",
      priority: p.pack.priority ?? 50,
      effectiveAt,
      expiresAt: days ? new Date(effectiveAt.getTime() + days * 86_400_000) : null,
      applicability: p.pack.applicability ?? { kind: "metered" },
      source: "purchase",
      sourceRef: line.id,
      invoiceId: input.invoice.id,
      taxTreatment: p.pack.tax_treatment ?? "taxed_at_purchase",
      onExhausted: p.pack.on_exhausted ?? null,
      status: "pending",
    });
    reclass += g.costBasisMinor;
    out.push(g);
  }
  if (reclass > 0n)
    await postEntries(
      {
        organizationId: input.organizationId,
        businessId: input.businessId,
        customerId: input.invoice.customerId,
        sourceType: "invoice",
        sourceId: input.invoice.publicId,
        lines: [
          {
            account: "revenue",
            direction: "debit",
            amountMinor: reclass,
            currency: input.invoice.currency,
          },
          {
            account: A.pending,
            direction: "credit",
            amountMinor: reclass,
            currency: input.invoice.currency,
          },
        ],
      },
      tx,
    );
  return out;
}

async function unitByKey(tx: Tx, businessId: string, key: string): Promise<CreditUnit | null> {
  const [u] = await tx
    .select()
    .from(creditUnits)
    .where(and(eq(creditUnits.businessId, businessId), eq(creditUnits.key, key)))
    .limit(1);
  return u ?? null;
}

// ── Activation ────────────────────────────────────────────────────────────────

/**
 * Activate the pending grants an invoice sold, once it is `paid`: effective from the paid time
 * (the lifetime moves with it), the full lot as an `activate` movement, and
 * Dr credit_grants_pending / Cr credit_grants_paid at the cost basis. The status flip is the
 * guard: whichever caller gets there first activates, the rest find nothing. Returns the count.
 */
export async function activatePaidCreditGrants(
  tx: Tx,
  input: { organizationId: string; invoiceId: string },
): Promise<number> {
  const [inv] = await tx
    .select({ status: invoices.status, paidAt: invoices.paidAt })
    .from(invoices)
    .where(eq(invoices.id, input.invoiceId))
    .limit(1);
  if (!inv || inv.status !== "paid") return 0;
  const paidAt = inv.paidAt ?? new Date();
  const flipped = await tx
    .update(creditGrants)
    .set({
      status: "active",
      effectiveAt: paidAt,
      expiresAt: sql`case when ${creditGrants.expiresAt} is null then null
        else ${paidAt.toISOString()}::timestamptz + (${creditGrants.expiresAt} - ${creditGrants.effectiveAt}) end`,
    })
    .where(and(eq(creditGrants.invoiceId, input.invoiceId), eq(creditGrants.status, "pending")))
    .returning();
  for (const g of flipped) {
    let ledgerTx: string | null = null;
    if (g.costBasisMinor > 0n) {
      const r = await postEntries(
        {
          organizationId: g.organizationId,
          businessId: g.businessId,
          customerId: g.customerId,
          sourceType: "credit_grant",
          sourceId: g.publicId,
          lines: [
            {
              account: A.pending,
              direction: "debit",
              amountMinor: g.costBasisMinor,
              currency: g.currency,
            },
            {
              account: A.paid,
              direction: "credit",
              amountMinor: g.costBasisMinor,
              currency: g.currency,
            },
          ],
        },
        tx,
      );
      ledgerTx = r.transactionId;
    }
    await recordGrantMovement(tx, {
      grant: g,
      kind: "activate",
      units: g.amount,
      faceMinor: g.faceMinor,
      costMinor: g.costBasisMinor,
      invoiceId: input.invoiceId,
      ledgerTransactionId: ledgerTx,
    });
    const [view] = await grantViews(tx, [g]);
    await emitEvent(tx, {
      organizationId: g.organizationId,
      businessId: g.businessId,
      type: "credit_grant_activated",
      data: buildEventData(
        "credit_grant_activated",
        serializeCreditGrant(view!),
        g.resourceVersion,
      ),
    });
  }
  return flipped.length;
}

/**
 * The `activate_credit_grants` pass: pending grants whose invoice is paid, for any site that
 * marked it paid without activating (the partial index on pending grants keeps it cheap).
 */
export async function runActivateCreditGrants(): Promise<{ activated: number }> {
  const scope = scanBusinessFilter(creditGrants.businessId);
  // systemDb: the pass finds paid invoices across organizations; each activates under withTenant.
  const due = await systemDb
    .selectDistinct({ organization_id: creditGrants.organizationId, invoice_id: invoices.id })
    .from(creditGrants)
    .innerJoin(invoices, eq(invoices.id, creditGrants.invoiceId))
    .where(and(eq(creditGrants.status, "pending"), eq(invoices.status, "paid"), scope))
    .limit(500);
  let activated = 0;
  for (const r of due) {
    try {
      activated += await withTenant(r.organization_id, (tx) =>
        activatePaidCreditGrants(tx, {
          organizationId: r.organization_id,
          invoiceId: r.invoice_id,
        }),
      );
    } catch (e) {
      log.error(e, { event: "credit_grant_activation_failed", invoiceId: r.invoice_id });
    }
  }
  if (activated)
    log.warn("pending credit grants activated by the backstop", {
      event: "credit_grants_backstop",
      activated,
    });
  return { activated };
}

// ── Top-up limits ─────────────────────────────────────────────────────────────

export class TopUpLimitError extends CreditRuleError {
  constructor(message: string) {
    super(message);
    this.name = "TopUpLimitError";
  }
}

/**
 * The money total of the pack lines on one purchase must be inside the business's top-up limits
 * for the currency (`credit_config.top_up_limits`). No pack lines, or no limits: nothing to check.
 */
export async function assertTopUpLimits(
  tx: Tx,
  input: {
    businessId: string;
    currency: string;
    lines: ReadonlyArray<{ priceId?: string | null; amountMinor: bigint }>;
    config?: BusinessCreditConfig | null;
  },
): Promise<void> {
  const total = await packLinesMinor(tx, input.lines);
  if (total === 0n) return;
  let cfg = input.config;
  if (cfg === undefined) {
    const [b] = await tx
      .select({ cfg: businesses.creditConfig })
      .from(businesses)
      .where(eq(businesses.id, input.businessId))
      .limit(1);
    cfg = b?.cfg ?? null;
  }
  const cur = input.currency.toUpperCase();
  const lim = cfg?.top_up_limits?.[cur];
  if (!lim) return;
  const min = lim.min_minor != null ? BigInt(lim.min_minor) : null;
  const max = lim.max_minor != null ? BigInt(lim.max_minor) : null;
  if ((min != null && total < min) || (max != null && total > max))
    throw new TopUpLimitError(
      `We could not start the purchase. The amount must be between ${formatMoney(min ?? 0n, cur)} and ${max != null ? formatMoney(max, cur) : "any amount"}.`,
    );
}
