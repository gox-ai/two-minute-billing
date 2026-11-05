/**
 * Credit units, credit grants and their movements (design G3 §3.1–3.2, §3.8, §4).
 *
 * A grant's remaining units and money are the sum of its movements; no column stores them.
 * Every movement that changes what the ledger holds posts in the same transaction. Readers
 * and writers that draw a grant take `lockCustomerBalances` (7401) first, as the buckets do.
 */
import { isExactWindowGrant } from "./reset-windows";
import { missingMeters, resolveGrantScopes } from "./scope";
import { and, asc, desc, eq, gte, inArray, lt, sql, type SQL } from "drizzle-orm";
import { withTenant, type Tx } from "@/platform/db";
import { publicId } from "@/platform/ids";
import { stampNow } from "@/platform/clock";
import { createLogger } from "@/platform/logger";
import { postEntries, type LedgerLine } from "@/modules/ledger/service";
import { emitEvent } from "@/modules/events/emit";
import { buildEventData } from "@/modules/events/registry";
import { lockCustomerBalances } from "@/modules/customers/balances-read";
import { slugify, validateSlug } from "@/modules/catalog/service";
import {
  CREDIT_LEDGER_ACCOUNTS,
  creditAutoTopupRuns,
  creditGrantMovements,
  creditGrants,
  creditUnits,
  customers,
  invoices,
  ledgerEntries,
  prices,
  type CreditApplicability,
  type CreditOnExhausted,
  type CreditTaxTreatment,
} from "@db/schema";
import type { GrantDraw, PlannerGrant } from "./planner";
import { faceMinorFor, formatRateE12, formatSteps, MONEY_RATE, type CreditUnitRate } from "./units";
import { checkGrantLimit, recordLargeGrant } from "./grant-limits";

const log = createLogger("credits");

export type CreditUnit = typeof creditUnits.$inferSelect;
export type CreditGrant = typeof creditGrants.$inferSelect;
export type CreditGrantMovement = typeof creditGrantMovements.$inferSelect;
export type CreditGrantCategory = "paid" | "promotional";
export type CreditGrantSource = "purchase" | "plan_cycle" | "manual" | "restore" | "auto_top_up";
export type CreditGrantStatus = "pending" | "active" | "expired" | "voided";
export type MovementKind =
  | "grant"
  | "draw"
  | "expire"
  | "void"
  | "restore"
  | "rollover_in"
  | "rollover_out"
  | "activate";

/** A request we refuse (400). */
export class CreditRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CreditRuleError";
  }
}

/** A change we refuse because of the record's state (409). */
export class CreditConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CreditConflictError";
  }
}

const A = CREDIT_LEDGER_ACCOUNTS;
/** The promotional expense account a promotional grant is booked against (as today's bucket). */
const PROMO_EXPENSE = "promotional_credit";
const RESTORE_EXPIRY_MONTHS = 12;

export function unitRate(
  u: Pick<CreditUnit, "minorPerUnitE12" | "decimals"> | null,
): CreditUnitRate {
  return u ? { minorPerUnitE12: u.minorPerUnitE12, decimals: u.decimals } : MONEY_RATE;
}

// ── Units ─────────────────────────────────────────────────────────────────────

export function serializeCreditUnit(u: CreditUnit) {
  return {
    object: "credit_unit",
    id: u.key,
    name: u.name,
    plural_name: u.pluralName,
    currency: u.currency,
    minor_per_unit: formatRateE12(u.minorPerUnitE12),
    decimals: u.decimals,
    locked: u.lockedAt !== null,
    locked_at: u.lockedAt?.toISOString() ?? null,
    status: u.active ? "active" : "archived",
    created_at: u.createdAt.toISOString(),
    updated_at: u.updatedAt.toISOString(),
    resource_version: u.resourceVersion,
  };
}

const unitEventData = (
  type: "credit_unit_created" | "credit_unit_updated" | "credit_unit_archived",
  u: CreditUnit,
) => buildEventData(type, serializeCreditUnit(u), u.resourceVersion);

export async function creditUnitByKey(
  tx: Tx,
  businessId: string,
  key: string,
): Promise<CreditUnit | null> {
  const [u] = await tx
    .select()
    .from(creditUnits)
    .where(and(eq(creditUnits.businessId, businessId), eq(creditUnits.key, key)))
    .limit(1);
  return u ?? null;
}

export async function getCreditUnit(
  organizationId: string,
  businessId: string,
  key: string,
): Promise<CreditUnit | null> {
  return withTenant(organizationId, (tx) => creditUnitByKey(tx, businessId, key));
}

export async function listCreditUnits(input: {
  organizationId: string;
  businessId: string;
  limit: number;
  startingAfter?: string;
  status?: "active" | "archived";
}): Promise<{ data: CreditUnit[]; hasMore: boolean }> {
  return withTenant(input.organizationId, async (tx) => {
    const conds: SQL[] = [eq(creditUnits.businessId, input.businessId)];
    if (input.status) conds.push(eq(creditUnits.active, input.status === "active"));
    if (input.startingAfter) conds.push(sql`${creditUnits.key} > ${input.startingAfter}`);
    const rows = await tx
      .select()
      .from(creditUnits)
      .where(and(...conds))
      .orderBy(asc(creditUnits.key))
      .limit(input.limit + 1);
    return { data: rows.slice(0, input.limit), hasMore: rows.length > input.limit };
  });
}

export interface CreditUnitInput {
  name: string;
  pluralName?: string;
  currency: string;
  minorPerUnitE12: bigint;
  decimals?: number;
}

function unitIssue(d: Partial<CreditUnitInput>): string | null {
  if (d.minorPerUnitE12 !== undefined && d.minorPerUnitE12 <= 0n)
    return "We could not save the credit unit. The rate must be more than 0.";
  if (
    d.decimals !== undefined &&
    (!Number.isInteger(d.decimals) || d.decimals < 0 || d.decimals > 4)
  )
    return "We could not save the credit unit. Decimals must be a whole number from 0 to 4.";
  if (d.currency !== undefined && !/^[A-Z]{3}$/.test(d.currency.toUpperCase()))
    return "We could not save the credit unit. The currency must be a 3-letter ISO code.";
  return null;
}

export async function createCreditUnit(input: {
  organizationId: string;
  businessId: string;
  key?: string;
  unit: CreditUnitInput;
}): Promise<CreditUnit> {
  const d = input.unit;
  const issue = unitIssue(d);
  if (issue) throw new CreditRuleError(issue);
  const key = input.key ?? slugify(d.name);
  // `money` names the implicit unit in filters.
  if (key === "money")
    throw new CreditConflictError(
      "We could not create the credit unit. The id money is reserved. Use a different id.",
    );
  if (!validateSlug(key))
    throw new CreditRuleError(
      "We could not save the credit unit. The id must start with a letter or digit and use only letters, digits, '.', '_' and '-' (at most 100 characters).",
    );
  return withTenant(input.organizationId, async (tx) => {
    if (await creditUnitByKey(tx, input.businessId, key))
      throw new CreditConflictError(
        `We could not create the credit unit. The id ${key} is already used. Use a different id.`,
      );
    const [u] = await tx
      .insert(creditUnits)
      .values({
        organizationId: input.organizationId,
        businessId: input.businessId,
        key,
        name: d.name,
        pluralName: d.pluralName ?? `${d.name}s`,
        currency: d.currency.toUpperCase(),
        minorPerUnitE12: d.minorPerUnitE12,
        decimals: d.decimals ?? 0,
      })
      .returning();
    await emitEvent(tx, {
      organizationId: input.organizationId,
      businessId: input.businessId,
      type: "credit_unit_created",
      data: unitEventData("credit_unit_created", u!),
    });
    return u!;
  });
}

/** Name and plural always change; currency, rate and decimals only before the first grant. */
export async function updateCreditUnit(input: {
  organizationId: string;
  businessId: string;
  key: string;
  patch: Partial<CreditUnitInput>;
  expectedVersion?: number;
}): Promise<CreditUnit | null> {
  const p = input.patch;
  const issue = unitIssue(p);
  if (issue) throw new CreditRuleError(issue);
  return withTenant(input.organizationId, async (tx) => {
    const [cur] = await tx
      .select()
      .from(creditUnits)
      .where(and(eq(creditUnits.businessId, input.businessId), eq(creditUnits.key, input.key)))
      .for("update")
      .limit(1);
    if (!cur) return null;
    if (input.expectedVersion !== undefined && cur.resourceVersion !== input.expectedVersion)
      throw new CreditConflictError(
        `We could not change the credit unit. It changed since you loaded it (version ${cur.resourceVersion}). Load it again.`,
      );
    const set: Partial<typeof creditUnits.$inferInsert> = {};
    if (p.name !== undefined) set.name = p.name;
    if (p.pluralName !== undefined) set.pluralName = p.pluralName;
    const frozen: Partial<typeof creditUnits.$inferInsert> = {};
    if (p.currency !== undefined && p.currency.toUpperCase() !== cur.currency)
      frozen.currency = p.currency.toUpperCase();
    if (p.minorPerUnitE12 !== undefined && p.minorPerUnitE12 !== cur.minorPerUnitE12)
      frozen.minorPerUnitE12 = p.minorPerUnitE12;
    if (p.decimals !== undefined && p.decimals !== cur.decimals) frozen.decimals = p.decimals;
    if (Object.keys(frozen).length > 0 && cur.lockedAt)
      throw new CreditConflictError(
        "We could not change the credit unit. A credit grant uses this unit. Create a new unit.",
      );
    Object.assign(set, frozen);
    if (Object.keys(set).length === 0) return cur;
    const [u] = await tx.update(creditUnits).set(set).where(eq(creditUnits.id, cur.id)).returning();
    await emitEvent(tx, {
      organizationId: input.organizationId,
      businessId: input.businessId,
      type: "credit_unit_updated",
      data: unitEventData("credit_unit_updated", u!),
    });
    return u!;
  });
}

/** An archived unit takes no new grant; existing grants keep it. */
export async function archiveCreditUnit(input: {
  organizationId: string;
  businessId: string;
  key: string;
}): Promise<CreditUnit | null> {
  return withTenant(input.organizationId, async (tx) => {
    const cur = await creditUnitByKey(tx, input.businessId, input.key);
    if (!cur) return null;
    if (!cur.active) return cur;
    const [u] = await tx
      .update(creditUnits)
      .set({ active: false })
      .where(eq(creditUnits.id, cur.id))
      .returning();
    await emitEvent(tx, {
      organizationId: input.organizationId,
      businessId: input.businessId,
      type: "credit_unit_archived",
      data: unitEventData("credit_unit_archived", u!),
    });
    return u!;
  });
}

// ── Movements ─────────────────────────────────────────────────────────────────

export interface GrantRemaining {
  units: bigint;
  face: bigint;
  cost: bigint;
}

/** Σ movements per grant. Grants with no movement (pending) read 0/0/0. */
export async function grantRemaining(
  tx: Tx,
  grantIds: readonly string[],
): Promise<Map<string, GrantRemaining>> {
  const out = new Map<string, GrantRemaining>();
  if (grantIds.length === 0) return out;
  const rows = await tx
    .select({
      grantId: creditGrantMovements.grantId,
      units: sql<string>`coalesce(sum(${creditGrantMovements.units}), 0)`,
      face: sql<string>`coalesce(sum(${creditGrantMovements.faceMinor}), 0)`,
      cost: sql<string>`coalesce(sum(${creditGrantMovements.costMinor}), 0)`,
    })
    .from(creditGrantMovements)
    .where(inArray(creditGrantMovements.grantId, [...grantIds]))
    .groupBy(creditGrantMovements.grantId);
  for (const r of rows)
    out.set(r.grantId, { units: BigInt(r.units), face: BigInt(r.face), cost: BigInt(r.cost) });
  for (const id of grantIds) if (!out.has(id)) out.set(id, { units: 0n, face: 0n, cost: 0n });
  return out;
}

/**
 * Append one movement. Signs follow the kind (CHECK): grant / restore / rollover_in ≥ 0;
 * draw / expire / void / rollover_out ≤ 0; activate is the full lot of a pending grant.
 */
export async function recordGrantMovement(
  tx: Tx,
  input: {
    grant: Pick<CreditGrant, "id" | "organizationId" | "businessId" | "customerId">;
    kind: MovementKind;
    units: bigint;
    faceMinor: bigint;
    costMinor?: bigint;
    invoiceId?: string | null;
    ledgerTransactionId?: string | null;
  },
): Promise<CreditGrantMovement> {
  const [m] = await tx
    .insert(creditGrantMovements)
    .values({
      organizationId: input.grant.organizationId,
      businessId: input.grant.businessId,
      publicId: publicId("cgm"),
      customerId: input.grant.customerId,
      grantId: input.grant.id,
      kind: input.kind,
      units: input.units,
      faceMinor: input.faceMinor,
      costMinor: input.costMinor ?? 0n,
      invoiceId: input.invoiceId ?? null,
      ledgerTransactionId: input.ledgerTransactionId ?? null,
    })
    .returning();
  return m!;
}

async function post(
  tx: Tx,
  g: Pick<CreditGrant, "organizationId" | "businessId" | "customerId" | "currency">,
  sourceType: string,
  sourceId: string,
  lines: Array<Omit<LedgerLine, "currency">>,
): Promise<string | null> {
  const live = lines.filter((l) => l.amountMinor > 0n);
  if (live.length < 2) return null;
  const { transactionId } = await postEntries(
    {
      organizationId: g.organizationId,
      businessId: g.businessId,
      customerId: g.customerId,
      sourceType,
      sourceId,
      lines: live.map((l) => ({ ...l, currency: g.currency })),
    },
    tx,
  );
  return transactionId;
}

// ── Grants ────────────────────────────────────────────────────────────────────

export interface InsertCreditGrantInput {
  organizationId: string;
  businessId: string;
  customerId: string;
  /** Money grants: required. Unit grants: the unit's currency (checked). */
  currency: string;
  unit: CreditUnit | null;
  /** In the unit's smallest step; money: minor units. */
  amount: bigint;
  /** Defaults to the unit conversion of `amount`. A restore or rollover passes the exact face. */
  faceMinor?: bigint;
  costBasisMinor?: bigint;
  category: CreditGrantCategory;
  priority?: number;
  effectiveAt?: Date;
  expiresAt?: Date | null;
  applicability?: CreditApplicability;
  source: CreditGrantSource;
  sourceRef?: string | null;
  invoiceId?: string | null;
  subscriptionItemId?: string | null;
  restoredFromId?: string | null;
  taxTreatment?: CreditTaxTreatment | null;
  onExhausted?: CreditOnExhausted | null;
  /** `pending` writes no movement and no ledger; activation does. Default `active`. */
  status?: "pending" | "active";
  metadata?: Record<string, unknown> | null;
  createdByUserId?: string | null;
  /**
   * The opening movement of an active grant. Default: `grant`, with the ledger posting for a
   * promotional grant (Dr promotional_credit / Cr credit_grants_promotional). A rollover or a
   * restore passes `{kind, ledger: false}`: the money is already on the account.
   */
  opening?: {
    kind: "grant" | "restore" | "rollover_in";
    ledger: boolean;
    /** A restore: the invoice it gives back, and the posting that moved the money. */
    invoiceId?: string;
    ledgerTransactionId?: string | null;
  };
  /** Emit `credit_grant_created`. Default true. */
  emit?: boolean;
}

/**
 * Insert one grant (any category or source) inside the caller's transaction, stamp its unit
 * as locked, and for an active grant write the opening movement and its posting.
 */
export async function insertCreditGrant(
  tx: Tx,
  input: InsertCreditGrantInput,
): Promise<CreditGrant> {
  const currency = input.currency.toUpperCase();
  const unit = input.unit;
  if (input.amount <= 0n)
    throw new CreditRuleError(
      "We could not create the credit grant. The amount must be more than 0.",
    );
  if (unit) {
    if (unit.businessId !== input.businessId)
      throw new CreditRuleError(
        "We could not create the credit grant. The credit unit is not in this business.",
      );
    if (!unit.active && input.source !== "restore" && input.source !== "plan_cycle")
      throw new CreditRuleError(
        `We could not create the credit grant. The credit unit ${unit.key} is archived.`,
      );
    if (unit.currency !== currency)
      throw new CreditRuleError(
        `We could not create the credit grant. The credit unit ${unit.key} is priced in ${unit.currency}, not ${currency}.`,
      );
  }
  const category = input.category;
  const treatment = input.taxTreatment ?? null;
  if (category === "paid" && !treatment)
    throw new CreditRuleError(
      "We could not create the credit grant. Set a tax treatment for paid credit.",
    );
  if (category === "promotional" && treatment)
    throw new CreditRuleError(
      "We could not create the credit grant. Promotional credit has no tax treatment.",
    );
  if (treatment === "taxed_at_use" && unit)
    throw new CreditRuleError(
      "We could not create the credit grant. Credit in a custom unit is taxed at purchase.",
    );
  const priority = input.priority ?? 50;
  if (!Number.isInteger(priority) || priority < 0 || priority > 100)
    throw new CreditRuleError(
      "We could not create the credit grant. The priority must be from 0 to 100.",
    );
  const face = input.faceMinor ?? faceMinorFor(input.amount, unitRate(unit));
  if (face <= 0n)
    throw new CreditRuleError(
      "We could not create the credit grant. The amount is worth less than one minor unit of money.",
    );
  const cost = category === "paid" ? (input.costBasisMinor ?? 0n) : 0n;
  if (cost < 0n)
    throw new CreditRuleError(
      "We could not create the credit grant. The cost basis cannot be negative.",
    );
  const effectiveAt = input.effectiveAt ?? stampNow(input.businessId);
  const expiresAt = input.expiresAt ?? null;
  if (expiresAt && expiresAt.getTime() <= effectiveAt.getTime())
    throw new CreditRuleError(
      "We could not create the credit grant. The expiry must be after the start.",
    );
  const applicability = input.applicability ?? { kind: "metered" as const };
  if (applicability.kind === "prices")
    await assertPricesExist(tx, input.businessId, applicability.prices);
  if (applicability.kind === "meters") {
    const missing = await missingMeters(tx, input.businessId, applicability.meters);
    if (missing.length)
      throw new CreditRuleError(
        `We could not create the credit grant. No such meter: ${missing.join(", ")}.`,
      );
  }
  const status = input.status ?? "active";

  if (unit && !unit.lockedAt)
    await tx
      .update(creditUnits)
      .set({ lockedAt: sql`app_now()` })
      .where(and(eq(creditUnits.id, unit.id), sql`${creditUnits.lockedAt} is null`));

  const [g] = await tx
    .insert(creditGrants)
    .values({
      organizationId: input.organizationId,
      businessId: input.businessId,
      publicId: publicId("cgr"),
      customerId: input.customerId,
      currency,
      unitId: unit?.id ?? null,
      amount: input.amount,
      faceMinor: face,
      costBasisMinor: cost,
      category,
      priority,
      effectiveAt,
      expiresAt,
      applicability,
      source: input.source,
      sourceRef: input.sourceRef ?? null,
      invoiceId: input.invoiceId ?? null,
      subscriptionItemId: input.subscriptionItemId ?? null,
      restoredFromId: input.restoredFromId ?? null,
      taxTreatment: treatment,
      onExhausted: input.onExhausted ?? null,
      status,
      metadata: input.metadata ?? null,
      createdByUserId: input.createdByUserId ?? null,
    })
    .returning();
  const grant = g!;

  if (status === "active") {
    const opening = input.opening ?? { kind: "grant" as const, ledger: category === "promotional" };
    let ledgerTx: string | null = null;
    if (opening.ledger && category === "promotional")
      ledgerTx = await post(tx, grant, "credit_grant", grant.publicId, [
        { account: PROMO_EXPENSE, direction: "debit", amountMinor: face },
        { account: A.promotional, direction: "credit", amountMinor: face },
      ]);
    await recordGrantMovement(tx, {
      grant,
      kind: opening.kind,
      units: input.amount,
      faceMinor: face,
      costMinor: cost,
      invoiceId: input.opening?.invoiceId ?? null,
      ledgerTransactionId: ledgerTx ?? input.opening?.ledgerTransactionId ?? null,
    });
  }
  if (input.emit !== false) await emitGrantEvent(tx, "credit_grant_created", grant);
  return grant;
}

async function assertPricesExist(tx: Tx, businessId: string, ids: readonly string[]) {
  if (ids.length === 0)
    throw new CreditRuleError("We could not create the credit grant. List at least one price.");
  const found = await tx
    .select({ publicId: prices.publicId })
    .from(prices)
    .where(and(eq(prices.businessId, businessId), inArray(prices.publicId, [...ids])));
  const have = new Set(found.map((p) => p.publicId));
  const missing = ids.filter((i) => !have.has(i));
  if (missing.length)
    throw new CreditRuleError(
      `We could not create the credit grant. No such price: ${missing.join(", ")}.`,
    );
}

/** A promotional grant given by an operator (or the API), booked at once. */
export async function createPromotionalGrant(input: {
  organizationId: string;
  businessId: string;
  customerPublicId: string;
  currency?: string;
  unitKey?: string | null;
  amount: bigint;
  priority?: number;
  effectiveAt?: Date;
  expiresAt?: Date | null;
  applicability?: CreditApplicability;
  onExhausted?: CreditOnExhausted | null;
  metadata?: Record<string, unknown> | null;
  createdByUserId?: string | null;
}): Promise<CreditGrant> {
  return withTenant(input.organizationId, async (tx) => {
    const customer = await customerByPublicId(tx, input.businessId, input.customerPublicId);
    const unit = input.unitKey ? await creditUnitByKey(tx, input.businessId, input.unitKey) : null;
    if (input.unitKey && !unit)
      throw new CreditRuleError(
        `We could not create the credit grant. No such credit unit: ${input.unitKey}.`,
      );
    const currency = unit?.currency ?? input.currency ?? customer.currency;
    if (!currency)
      throw new CreditRuleError(
        "We could not create the credit grant. The customer has no currency. Set the currency.",
      );
    if (unit && input.currency && input.currency.toUpperCase() !== unit.currency)
      throw new CreditRuleError(
        `We could not create the credit grant. The credit unit ${unit.key} is priced in ${unit.currency}.`,
      );
    // Free credit: the business's per-grant maximum and alert threshold, on the money value.
    const faceMinor = faceMinorFor(input.amount, unitRate(unit));
    const alert = await checkGrantLimit(
      tx,
      { businessId: input.businessId, currency, amountMinor: faceMinor, kind: "credit_grant" },
      (m) => new CreditRuleError(m),
    );
    const grant = await insertCreditGrant(tx, {
      organizationId: input.organizationId,
      businessId: input.businessId,
      customerId: customer.id,
      currency,
      unit,
      amount: input.amount,
      category: "promotional",
      priority: input.priority,
      effectiveAt: input.effectiveAt,
      expiresAt: input.expiresAt,
      applicability: input.applicability,
      source: "manual",
      onExhausted: input.onExhausted,
      metadata: input.metadata,
      createdByUserId: input.createdByUserId,
    });
    if (alert)
      await recordLargeGrant(tx, {
        organizationId: input.organizationId,
        businessId: input.businessId,
        customerId: customer.id,
        kind: "credit_grant",
        reference: grant.publicId,
        amountMinor: faceMinor,
        currency,
        alertAboveMinor: alert.alertAboveMinor,
      });
    return grant;
  });
}

export async function customerByPublicId(tx: Tx, businessId: string, customerPublicId: string) {
  const [c] = await tx
    .select()
    .from(customers)
    .where(and(eq(customers.businessId, businessId), eq(customers.publicId, customerPublicId)))
    .limit(1);
  if (!c) throw new CreditNotFoundError(`No such customer: ${customerPublicId}`);
  return c;
}

/** Missing customer, unit or grant (404). */
export class CreditNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CreditNotFoundError";
  }
}

/**
 * Book what is left of a grant out of it and close it: `expire` or `void`.
 *  - promotional: Dr credit_grants_promotional / Cr promotional_credit (face; the expense reverses);
 *  - paid, expire: Dr credit_grants_paid / Cr credit_breakage (cost);
 *  - paid, void: no posting here; a credit note posts its own reclass.
 * Takes the customer balance lock. Returns the movement, or null when nothing was left.
 */
export async function bookGrantRemainder(
  tx: Tx,
  input: { grant: CreditGrant; kind: "expire" | "void"; emit?: boolean },
): Promise<CreditGrantMovement | null> {
  const g = input.grant;
  await lockCustomerBalances(tx, g.customerId);
  const left = (await grantRemaining(tx, [g.id])).get(g.id)!;
  let movement: CreditGrantMovement | null = null;
  if (left.units > 0n || left.face > 0n || left.cost > 0n) {
    const lines: Array<Omit<LedgerLine, "currency">> =
      g.category === "promotional"
        ? [
            { account: A.promotional, direction: "debit", amountMinor: left.face },
            { account: PROMO_EXPENSE, direction: "credit", amountMinor: left.face },
          ]
        : input.kind === "expire"
          ? [
              { account: A.paid, direction: "debit", amountMinor: left.cost },
              { account: A.breakage, direction: "credit", amountMinor: left.cost },
            ]
          : [];
    const ledgerTx = await post(tx, g, "credit_grant", g.publicId, lines);
    movement = await recordGrantMovement(tx, {
      grant: g,
      kind: input.kind,
      units: -left.units,
      faceMinor: -left.face,
      costMinor: -left.cost,
      ledgerTransactionId: ledgerTx,
    });
  }
  const [updated] = await tx
    .update(creditGrants)
    .set({ status: input.kind === "expire" ? "expired" : "voided" })
    .where(eq(creditGrants.id, g.id))
    .returning();
  if (input.emit !== false)
    await emitGrantEvent(
      tx,
      input.kind === "expire" ? "credit_grant_expired" : "credit_grant_voided",
      updated!,
      { units: left.units, face_minor: left.face },
    );
  return movement;
}

/** Void a promotional grant by hand. A paid grant leaves only through a credit note. */
export async function voidCreditGrant(input: {
  organizationId: string;
  businessId: string;
  customerPublicId: string;
  grantPublicId: string;
}): Promise<CreditGrant> {
  return withTenant(input.organizationId, async (tx) => {
    const customer = await customerByPublicId(tx, input.businessId, input.customerPublicId);
    await lockCustomerBalances(tx, customer.id);
    const [g] = await tx
      .select()
      .from(creditGrants)
      .where(
        and(
          eq(creditGrants.businessId, input.businessId),
          eq(creditGrants.customerId, customer.id),
          eq(creditGrants.publicId, input.grantPublicId),
        ),
      )
      .for("update")
      .limit(1);
    if (!g) throw new CreditNotFoundError(`No such credit grant: ${input.grantPublicId}`);
    if (g.category !== "promotional")
      throw new CreditConflictError(
        "We could not void the credit grant. Paid credit is removed with a credit note on its invoice.",
      );
    if (g.status !== "active")
      throw new CreditConflictError(`We could not void the credit grant. It is ${g.status}.`);
    await bookGrantRemainder(tx, { grant: g, kind: "void" });
    const [after] = await tx.select().from(creditGrants).where(eq(creditGrants.id, g.id));
    return after!;
  });
}

// ── Drawdown ──────────────────────────────────────────────────────────────────

/**
 * The customer's active grants in one currency, as the planner reads them. Call under
 * `lockCustomerBalances` when the result gates a draw.
 */
export async function loadPlannerGrants(
  tx: Tx,
  input: { businessId: string; customerId: string; currency: string },
): Promise<PlannerGrant[]> {
  const rows = await tx
    .select({ g: creditGrants, u: creditUnits })
    .from(creditGrants)
    .leftJoin(creditUnits, eq(creditUnits.id, creditGrants.unitId))
    .where(
      and(
        eq(creditGrants.businessId, input.businessId),
        eq(creditGrants.customerId, input.customerId),
        eq(creditGrants.currency, input.currency.toUpperCase()),
        eq(creditGrants.status, "active"),
      ),
    );
  if (rows.length === 0) return [];
  const left = await grantRemaining(
    tx,
    rows.map((r) => r.g.id),
  );
  const planned = rows
    .map(({ g, u }) => toPlannerGrant(g, u, left.get(g.id)!))
    .filter((p) => p.remainingFace > 0n);
  return resolveGrantScopes(tx, { businessId: input.businessId }, planned);
}

export function toPlannerGrant(
  g: CreditGrant,
  u: CreditUnit | null,
  left: GrantRemaining,
): PlannerGrant {
  return {
    id: g.id,
    category: g.category as CreditGrantCategory,
    source: g.source,
    priority: g.priority,
    effectiveAt: g.effectiveAt,
    expiresAt: g.expiresAt,
    taxTreatment: g.taxTreatment ?? null,
    unitId: g.unitId,
    applicability: g.applicability ?? { kind: "metered" },
    amount: g.amount,
    costBasisMinor: g.costBasisMinor,
    rate: unitRate(u),
    remainingUnits: left.units,
    remainingFace: left.face,
    remainingCost: left.cost,
    exactWindow: isExactWindowGrant(g.source, g.sourceRef),
  };
}

/**
 * Book an invoice's grant draws: per draw, one ledger transaction (`credit_applied`, the
 * invoice's id, so the void mirror reverses it) and one `draw` movement.
 *  - promotional: Dr credit_grants_promotional / Cr AR (face);
 *  - paid: Dr credit_grants_paid (cost) + Dr credit_grant_discount (face − cost) / Cr AR (face).
 * Emits one `credit_grant_applied` per invoice. Caller holds `lockCustomerBalances`.
 */
export async function postGrantDraws(
  tx: Tx,
  input: {
    organizationId: string;
    businessId: string;
    customerId: string;
    invoiceId: string;
    invoicePublicId: string;
    currency: string;
    draws: readonly GrantDraw[];
  },
): Promise<void> {
  const draws = input.draws.filter((d) => d.faceMinor > 0n);
  if (draws.length === 0) return;
  const grants = await tx
    .select()
    .from(creditGrants)
    .where(
      and(
        eq(creditGrants.businessId, input.businessId),
        inArray(
          creditGrants.id,
          draws.map((d) => d.grantId),
        ),
      ),
    );
  const byId = new Map(grants.map((g) => [g.id, g]));
  const applied: Array<Record<string, unknown>> = [];
  for (const d of draws) {
    const g = byId.get(d.grantId);
    if (!g) throw new Error(`credit grant ${d.grantId} vanished during the invoice commit`);
    const discount = d.faceMinor - d.costMinor;
    const lines: Array<Omit<LedgerLine, "currency">> =
      g.category === "promotional"
        ? [
            { account: A.promotional, direction: "debit", amountMinor: d.faceMinor },
            { account: "accounts_receivable", direction: "credit", amountMinor: d.faceMinor },
          ]
        : [
            { account: A.paid, direction: "debit", amountMinor: d.costMinor },
            discount >= 0n
              ? { account: A.discount, direction: "debit", amountMinor: discount }
              : { account: A.discount, direction: "credit", amountMinor: -discount },
            { account: "accounts_receivable", direction: "credit", amountMinor: d.faceMinor },
          ];
    const ledgerTx = await post(
      tx,
      { ...g, currency: input.currency },
      "credit_applied",
      input.invoicePublicId,
      lines,
    );
    await recordGrantMovement(tx, {
      grant: g,
      kind: "draw",
      units: -d.units,
      faceMinor: -d.faceMinor,
      costMinor: -d.costMinor,
      invoiceId: input.invoiceId,
      ledgerTransactionId: ledgerTx,
    });
    applied.push({
      id: g.publicId,
      phase: d.phase,
      category: g.category,
      units: Number(d.units),
      face_minor: Number(d.faceMinor),
    });
  }
  await emitEvent(tx, {
    organizationId: input.organizationId,
    businessId: input.businessId,
    type: "credit_grant_applied",
    data: buildEventData("credit_grant_applied", {
      invoice: input.invoicePublicId,
      currency: input.currency,
      amount_minor: draws.reduce((s, d) => s + Number(d.faceMinor), 0),
      grants: applied,
    }),
  });
}

/**
 * What an invoice drew from each grant and what it has given back, keyed by the grant it drew.
 * A give-back that landed on a new restore grant counts against the grant it came from.
 */
async function grantDrawsOfInvoice(
  tx: Tx,
  businessId: string,
  invoiceId: string,
): Promise<Map<string, { drawn: GrantRemaining; restored: GrantRemaining }>> {
  const rows = await tx
    .select({ m: creditGrantMovements, gid: creditGrants.id, from: creditGrants.restoredFromId })
    .from(creditGrantMovements)
    .innerJoin(creditGrants, eq(creditGrants.id, creditGrantMovements.grantId))
    .where(
      and(
        eq(creditGrantMovements.businessId, businessId),
        eq(creditGrantMovements.invoiceId, invoiceId),
        inArray(creditGrantMovements.kind, ["draw", "restore"]),
      ),
    );
  const drewFrom = new Set(rows.filter((r) => r.m.kind === "draw").map((r) => r.gid));
  const out = new Map<string, { drawn: GrantRemaining; restored: GrantRemaining }>();
  const slot = (id: string) => {
    let v = out.get(id);
    if (!v) {
      v = { drawn: { units: 0n, face: 0n, cost: 0n }, restored: { units: 0n, face: 0n, cost: 0n } };
      out.set(id, v);
    }
    return v;
  };
  for (const { m, gid, from } of rows) {
    if (m.kind === "draw") {
      const d = slot(gid).drawn;
      d.units -= m.units;
      d.face -= m.faceMinor;
      d.cost -= m.costMinor;
    } else {
      const key = drewFrom.has(gid) ? gid : (from ?? gid);
      const r = slot(key).restored;
      r.units += m.units;
      r.face += m.faceMinor;
      r.cost += m.costMinor;
    }
  }
  return out;
}

/** Grant-drawn money an invoice has not given back yet. */
export async function grantDrawnOutstanding(
  tx: Tx,
  businessId: string,
  invoiceId: string,
): Promise<bigint> {
  let left = 0n;
  for (const v of (await grantDrawsOfInvoice(tx, businessId, invoiceId)).values())
    left += v.drawn.face - v.restored.face;
  return left > 0n ? left : 0n;
}

/**
 * Give an invoice's grant draws back: all of them, or `faceMinor` of money spread over the
 * grants in proportion to what each still has outstanding. Never more than was drawn.
 *  - A grant still live takes its units back (`restore` movement).
 *  - An expired or voided grant gives them to a NEW grant with the same category, cost, unit,
 *    treatment and applicability, `source = restore`, drawn first, expiring in 12 months (C7).
 * `ledger: false` when the caller's own posting already returns the money (an invoice void's
 * mirror). Otherwise per grant: promotional Dr credit_adjustments / Cr credit_grants_promotional
 * (face); paid Dr credit_adjustments (face) / Cr credit_grants_paid (cost) / Cr credit_grant_discount
 * (face − cost). The sale is undone; no grant-paid value ever becomes cash.
 * Returns the money given back. Takes `lockCustomerBalances`.
 */
export async function restoreGrantDraws(
  tx: Tx,
  input: {
    organizationId: string;
    businessId: string;
    customerId: string;
    invoiceId: string;
    invoicePublicId: string;
    faceMinor: bigint | "all";
    ledger: boolean;
    /** Ledger source type; the source id is always the invoice's public id. */
    sourceType: string;
  },
): Promise<bigint> {
  if (input.faceMinor !== "all" && input.faceMinor <= 0n) return 0n;
  await lockCustomerBalances(tx, input.customerId);
  const per = await grantDrawsOfInvoice(tx, input.businessId, input.invoiceId);
  const open = [...per]
    .map(([id, v]) => ({
      id,
      left: {
        units: v.drawn.units - v.restored.units,
        face: v.drawn.face - v.restored.face,
        cost: v.drawn.cost - v.restored.cost,
      },
    }))
    .filter((x) => x.left.face > 0n)
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  const total = open.reduce((s, x) => s + x.left.face, 0n);
  if (total === 0n) return 0n;
  const target = input.faceMinor === "all" || input.faceMinor >= total ? total : input.faceMinor;
  // Largest remainder, so the shares sum to the target exactly.
  const shares = open.map((x) => {
    const exact = target * x.left.face;
    return { x, share: exact / total, frac: exact % total };
  });
  let rest = target - shares.reduce((s, v) => s + v.share, 0n);
  for (const v of [...shares].sort((a, b) => (b.frac > a.frac ? 1 : b.frac < a.frac ? -1 : 0))) {
    if (rest <= 0n) break;
    v.share += 1n;
    rest -= 1n;
  }
  const grants = await tx
    .select({ g: creditGrants, u: creditUnits })
    .from(creditGrants)
    .leftJoin(creditUnits, eq(creditUnits.id, creditGrants.unitId))
    .where(
      inArray(
        creditGrants.id,
        open.map((x) => x.id),
      ),
    );
  const now = stampNow(input.businessId);
  let given = 0n;
  for (const { x, share } of shares) {
    if (share <= 0n) continue;
    const row = grants.find((r) => r.g.id === x.id);
    if (!row) continue;
    const { g, u } = row;
    const whole = share === x.left.face;
    const back = {
      face: share,
      units: whole ? x.left.units : (x.left.units * share) / x.left.face,
      cost: whole ? x.left.cost : (x.left.cost * share) / x.left.face,
    };
    const ledgerTx = input.ledger
      ? await post(
          tx,
          g,
          input.sourceType,
          input.invoicePublicId,
          g.category === "promotional"
            ? [
                { account: "credit_adjustments", direction: "debit", amountMinor: back.face },
                { account: A.promotional, direction: "credit", amountMinor: back.face },
              ]
            : [
                { account: "credit_adjustments", direction: "debit", amountMinor: back.face },
                { account: A.paid, direction: "credit", amountMinor: back.cost },
                back.face >= back.cost
                  ? { account: A.discount, direction: "credit", amountMinor: back.face - back.cost }
                  : { account: A.discount, direction: "debit", amountMinor: back.cost - back.face },
              ],
        )
      : null;
    given += back.face;
    const live = g.status === "active" && (g.expiresAt === null || g.expiresAt > now);
    if (live) {
      await recordGrantMovement(tx, {
        grant: g,
        kind: "restore",
        units: back.units,
        faceMinor: back.face,
        costMinor: back.cost,
        invoiceId: input.invoiceId,
        ledgerTransactionId: ledgerTx,
      });
      await emitGrantEvent(tx, "credit_grant_restored", g, {
        units: back.units,
        face_minor: back.face,
        restored_to: g.publicId,
      });
      continue;
    }
    const expiresAt = new Date(now);
    expiresAt.setUTCMonth(expiresAt.getUTCMonth() + RESTORE_EXPIRY_MONTHS);
    const fresh = await insertCreditGrant(tx, {
      organizationId: g.organizationId,
      businessId: g.businessId,
      customerId: g.customerId,
      currency: g.currency,
      unit: u,
      // A units-free sliver keeps one step so the grant can exist; it carries only its face.
      amount: back.units > 0n ? back.units : 1n,
      faceMinor: back.face,
      costBasisMinor: back.cost,
      category: g.category as CreditGrantCategory,
      priority: g.priority,
      effectiveAt: now,
      expiresAt,
      applicability: g.applicability,
      source: "restore",
      invoiceId: g.invoiceId,
      restoredFromId: g.id,
      taxTreatment: g.taxTreatment,
      onExhausted: g.onExhausted,
      opening: {
        kind: "restore",
        ledger: false,
        invoiceId: input.invoiceId,
        ledgerTransactionId: ledgerTx,
      },
      emit: false,
    });
    await emitGrantEvent(tx, "credit_grant_restored", fresh, {
      units: back.units,
      face_minor: back.face,
      restored_from: g.publicId,
    });
  }
  log.info("credit grant draws restored", {
    event: "credit_grants_restored",
    invoiceId: input.invoiceId,
    sourceType: input.sourceType,
    faceMinor: given.toString(),
  });
  return given;
}

/** A voided invoice gives every draw back; its ledger mirror already returned the money. */
export async function restoreGrantDrawsForVoidedInvoice(
  tx: Tx,
  input: {
    organizationId: string;
    businessId: string;
    customerId: string;
    invoiceId: string;
    invoicePublicId: string;
  },
): Promise<bigint> {
  return restoreGrantDraws(tx, {
    ...input,
    faceMinor: "all",
    ledger: false,
    sourceType: "invoice_void",
  });
}

/**
 * The invoice that sold a pending grant was voided or written off: the grant will never be
 * paid, so it is `voided`. A void's ledger mirror already reverses the pack's reclass (posted
 * with the invoice's source); a write-off does not, so this books Dr credit_grants_pending /
 * Cr revenue for what the invoice moved into pending.
 */
export async function voidPendingGrantsForInvoice(
  tx: Tx,
  input: {
    organizationId: string;
    businessId: string;
    invoiceId: string;
    invoicePublicId: string;
    reason: "void" | "write_off";
  },
): Promise<number> {
  const voided = await tx
    .update(creditGrants)
    .set({ status: "voided" })
    .where(
      and(
        eq(creditGrants.businessId, input.businessId),
        eq(creditGrants.invoiceId, input.invoiceId),
        eq(creditGrants.status, "pending"),
      ),
    )
    .returning();
  if (voided.length === 0) return 0;
  if (input.reason === "write_off") {
    const [row] = await tx
      .select({
        held: sql<string>`coalesce(sum(case when ${ledgerEntries.direction} = 'credit' then ${ledgerEntries.amountMinor} else -${ledgerEntries.amountMinor} end), 0)`,
      })
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.businessId, input.businessId),
          eq(ledgerEntries.account, A.pending),
          eq(ledgerEntries.sourceId, input.invoicePublicId),
        ),
      );
    let held = BigInt(row?.held ?? 0);
    for (const g of voided) {
      const amt = g.costBasisMinor < held ? g.costBasisMinor : held;
      if (amt > 0n) {
        await post(tx, g, "credit_grant", input.invoicePublicId, [
          { account: A.pending, direction: "debit", amountMinor: amt },
          { account: "revenue", direction: "credit", amountMinor: amt },
        ]);
        held -= amt;
      }
    }
  }
  for (const g of voided)
    await emitGrantEvent(tx, "credit_grant_voided", g, { reason: input.reason });
  return voided.length;
}

// ── Credit notes on a pack line (design §3.8, Ex 5) ──────────────────────────

export interface PackLineCredit {
  grant: CreditGrant;
  /** Cost basis not yet drawn, expired or voided. */
  unusedCostMinor: bigint;
  remaining: GrantRemaining;
}

/**
 * The grant each pack line of an invoice sold, keyed by invoice line id. A pending grant
 * (invoice not paid) is all unused. `source_ref` holds the line's id or public id.
 */
export async function packLineCredits(
  tx: Tx,
  input: {
    businessId: string;
    invoiceId: string;
    lines: ReadonlyArray<{ id: string; publicId: string }>;
  },
): Promise<Map<string, PackLineCredit>> {
  const out = new Map<string, PackLineCredit>();
  if (input.lines.length === 0) return out;
  const grants = await tx
    .select()
    .from(creditGrants)
    .where(
      and(
        eq(creditGrants.businessId, input.businessId),
        eq(creditGrants.invoiceId, input.invoiceId),
        inArray(creditGrants.source, ["purchase", "manual"]),
      ),
    );
  if (grants.length === 0) return out;
  const left = await grantRemaining(
    tx,
    grants.map((g) => g.id),
  );
  for (const l of input.lines) {
    const g = grants.find((x) => x.sourceRef === l.id || x.sourceRef === l.publicId);
    if (!g) continue;
    const rem = left.get(g.id)!;
    const unused =
      g.status === "pending" ? g.costBasisMinor : g.status === "active" ? rem.cost : 0n;
    const remaining =
      g.status === "pending" ? { units: g.amount, face: g.faceMinor, cost: g.costBasisMinor } : rem;
    out.set(l.id, { grant: g, unusedCostMinor: unused > 0n ? unused : 0n, remaining });
  }
  return out;
}

/**
 * A credit note took `netMinor` (excl. tax) off a pack line: void the grant's units in
 * proportion to the unused cost, and move that cost out of deferred revenue
 * (Dr credit_grants_paid / Cr revenue). A pending grant is voided whole when the note
 * covers its whole cost; its pending reclass reverses the same way.
 */
export async function voidPackUnitsForCreditNote(
  tx: Tx,
  input: { pack: PackLineCredit; netMinor: bigint; creditNotePublicId: string },
): Promise<void> {
  const { pack } = input;
  const g = pack.grant;
  const net = input.netMinor < pack.unusedCostMinor ? input.netMinor : pack.unusedCostMinor;
  if (net <= 0n) return;
  await lockCustomerBalances(tx, g.customerId);
  const r = pack.remaining;
  const whole = net === pack.unusedCostMinor;
  const units = whole ? r.units : (r.units * net) / pack.unusedCostMinor;
  const face = whole ? r.face : (r.face * net) / pack.unusedCostMinor;
  const account = g.status === "pending" ? A.pending : A.paid;
  const ledgerTx = await post(tx, g, "credit_note", input.creditNotePublicId, [
    { account, direction: "debit", amountMinor: net },
    { account: "revenue", direction: "credit", amountMinor: net },
  ]);
  if (g.status === "pending") {
    // Not active yet: no movements exist. Shrink what activation will grant instead.
    if (whole)
      await tx.update(creditGrants).set({ status: "voided" }).where(eq(creditGrants.id, g.id));
    else
      await tx
        .update(creditGrants)
        .set({
          amount: g.amount - units,
          faceMinor: g.faceMinor - face,
          costBasisMinor: g.costBasisMinor - net,
        })
        .where(eq(creditGrants.id, g.id));
  } else {
    await recordGrantMovement(tx, {
      grant: g,
      kind: "void",
      units: -units,
      faceMinor: -face,
      costMinor: -net,
      // The credited invoice sold the pack. The note is reached through the ledger
      // transaction (source credit_note); movements have no credit-note column.
      invoiceId: g.invoiceId,
      ledgerTransactionId: ledgerTx,
    });
    if (whole && units === r.units)
      await tx.update(creditGrants).set({ status: "voided" }).where(eq(creditGrants.id, g.id));
  }
  await emitGrantEvent(tx, "credit_grant_voided", g, {
    reason: "credit_note",
    credit_note: input.creditNotePublicId,
    units,
    face_minor: face,
  });
}

// ── Reads ─────────────────────────────────────────────────────────────────────

export interface GrantView {
  grant: CreditGrant;
  unit: CreditUnit | null;
  customerPublicId: string;
  invoicePublicId: string | null;
  restoredFromPublicId: string | null;
  /** `atur_…`: the automatic top-up run that sold it. */
  autoTopupRunPublicId: string | null;
  remaining: GrantRemaining;
}

export async function grantViews(tx: Tx, grants: readonly CreditGrant[]): Promise<GrantView[]> {
  if (grants.length === 0) return [];
  const ids = (xs: Array<string | null>) => [...new Set(xs.filter((x): x is string => !!x))];
  const unitIds = ids(grants.map((g) => g.unitId));
  const units = unitIds.length
    ? await tx.select().from(creditUnits).where(inArray(creditUnits.id, unitIds))
    : [];
  const cus = await tx
    .select({ id: customers.id, publicId: customers.publicId })
    .from(customers)
    .where(inArray(customers.id, ids(grants.map((g) => g.customerId))));
  const invIds = ids(grants.map((g) => g.invoiceId));
  const invs = invIds.length
    ? await tx
        .select({ id: invoices.id, publicId: invoices.publicId })
        .from(invoices)
        .where(inArray(invoices.id, invIds))
    : [];
  const fromIds = ids(grants.map((g) => g.restoredFromId));
  const froms = fromIds.length
    ? await tx
        .select({ id: creditGrants.id, publicId: creditGrants.publicId })
        .from(creditGrants)
        .where(inArray(creditGrants.id, fromIds))
    : [];
  const runIds = ids(grants.map((g) => (g.source === "auto_top_up" ? g.sourceRef : null)));
  const runs = runIds.length
    ? await tx
        .select({ id: creditAutoTopupRuns.id, publicId: creditAutoTopupRuns.publicId })
        .from(creditAutoTopupRuns)
        .where(inArray(creditAutoTopupRuns.id, runIds))
    : [];
  const left = await grantRemaining(
    tx,
    grants.map((g) => g.id),
  );
  const pick = <T extends { id: string }>(xs: T[], id: string | null) =>
    id ? (xs.find((x) => x.id === id) ?? null) : null;
  return grants.map((g) => ({
    grant: g,
    unit: pick(units, g.unitId),
    customerPublicId: pick(cus, g.customerId)?.publicId ?? "",
    invoicePublicId: pick(invs, g.invoiceId)?.publicId ?? null,
    restoredFromPublicId: pick(froms, g.restoredFromId)?.publicId ?? null,
    autoTopupRunPublicId:
      g.source === "auto_top_up" ? (pick(runs, g.sourceRef)?.publicId ?? null) : null,
    remaining: left.get(g.id)!,
  }));
}

export function serializeCreditGrant(v: GrantView) {
  const { grant: g, unit: u } = v;
  const decimals = u?.decimals ?? 0;
  return {
    object: "credit_grant",
    id: g.publicId,
    customer: v.customerPublicId,
    currency: g.currency,
    unit: u?.key ?? null,
    amount: Number(g.amount),
    amount_decimal: formatSteps(g.amount, decimals),
    face_minor: Number(g.faceMinor),
    cost_basis_minor: Number(g.costBasisMinor),
    category: g.category,
    priority: g.priority,
    effective_at: g.effectiveAt.toISOString(),
    expires_at: g.expiresAt?.toISOString() ?? null,
    applicability: g.applicability ?? { kind: "metered" },
    source: g.source,
    tax_treatment: g.taxTreatment ?? null,
    on_exhausted: g.onExhausted ?? null,
    status: g.status,
    invoice: v.invoicePublicId,
    restored_from: v.restoredFromPublicId,
    auto_top_up_run: v.autoTopupRunPublicId,
    remaining: {
      units: Number(v.remaining.units),
      units_decimal: formatSteps(v.remaining.units, decimals),
      face_minor: Number(v.remaining.face),
      cost_minor: Number(v.remaining.cost),
    },
    metadata: g.metadata ?? {},
    created_at: g.createdAt.toISOString(),
    updated_at: g.updatedAt.toISOString(),
    resource_version: g.resourceVersion,
  };
}

async function emitGrantEvent(
  tx: Tx,
  type:
    | "credit_grant_created"
    | "credit_grant_expired"
    | "credit_grant_voided"
    | "credit_grant_restored",
  g: CreditGrant,
  extra?: Record<string, unknown>,
): Promise<void> {
  const [view] = await grantViews(tx, [g]);
  const body = serializeCreditGrant(view!);
  const ext = extra
    ? Object.fromEntries(
        Object.entries(extra).map(([k, val]) => [k, typeof val === "bigint" ? Number(val) : val]),
      )
    : undefined;
  await emitEvent(tx, {
    organizationId: g.organizationId,
    businessId: g.businessId,
    type,
    data: buildEventData(type, body, g.resourceVersion, ext),
  });
}

export async function getCreditGrant(input: {
  organizationId: string;
  businessId: string;
  customerPublicId: string;
  grantPublicId: string;
}): Promise<GrantView | null> {
  return withTenant(input.organizationId, async (tx) => {
    const customer = await customerByPublicId(tx, input.businessId, input.customerPublicId);
    const [g] = await tx
      .select()
      .from(creditGrants)
      .where(
        and(
          eq(creditGrants.businessId, input.businessId),
          eq(creditGrants.customerId, customer.id),
          eq(creditGrants.publicId, input.grantPublicId),
        ),
      )
      .limit(1);
    if (!g) return null;
    return (await grantViews(tx, [g]))[0]!;
  });
}

export async function grantViewById(tx: Tx, grantId: string): Promise<GrantView | null> {
  const [g] = await tx.select().from(creditGrants).where(eq(creditGrants.id, grantId)).limit(1);
  return g ? (await grantViews(tx, [g]))[0]! : null;
}

export async function listCreditGrants(input: {
  organizationId: string;
  businessId: string;
  customerPublicId: string;
  limit: number;
  startingAfter?: string;
  status?: CreditGrantStatus;
  category?: CreditGrantCategory;
  currency?: string;
}): Promise<{ data: GrantView[]; hasMore: boolean }> {
  return withTenant(input.organizationId, async (tx) => {
    const customer = await customerByPublicId(tx, input.businessId, input.customerPublicId);
    const conds: SQL[] = [
      eq(creditGrants.businessId, input.businessId),
      eq(creditGrants.customerId, customer.id),
    ];
    if (input.status) conds.push(eq(creditGrants.status, input.status));
    if (input.category) conds.push(eq(creditGrants.category, input.category));
    if (input.currency) conds.push(eq(creditGrants.currency, input.currency.toUpperCase()));
    if (input.startingAfter) conds.push(sql`${creditGrants.publicId} < ${input.startingAfter}`);
    const rows = await tx
      .select()
      .from(creditGrants)
      .where(and(...conds))
      .orderBy(desc(creditGrants.publicId))
      .limit(input.limit + 1);
    const page = rows.slice(0, input.limit);
    return { data: await grantViews(tx, page), hasMore: rows.length > input.limit };
  });
}

export const MOVEMENT_KINDS: readonly MovementKind[] = [
  "grant",
  "draw",
  "expire",
  "void",
  "restore",
  "rollover_in",
  "rollover_out",
  "activate",
];

/** The credit transaction list: movements, newest first (design §7). */
export async function listCreditTransactions(input: {
  organizationId: string;
  businessId: string;
  customerPublicId: string;
  limit: number;
  startingAfter?: string;
  grantPublicId?: string;
  kind?: MovementKind;
  category?: CreditGrantCategory;
  unitKey?: string | null;
  invoicePublicId?: string;
  createdGte?: Date;
  createdLt?: Date;
}) {
  return withTenant(input.organizationId, async (tx) => {
    const customer = await customerByPublicId(tx, input.businessId, input.customerPublicId);
    const conds: SQL[] = [
      eq(creditGrantMovements.businessId, input.businessId),
      eq(creditGrantMovements.customerId, customer.id),
    ];
    if (input.grantPublicId) conds.push(eq(creditGrants.publicId, input.grantPublicId));
    if (input.kind) conds.push(eq(creditGrantMovements.kind, input.kind));
    if (input.category) conds.push(eq(creditGrants.category, input.category));
    if (input.unitKey === null) conds.push(sql`${creditGrants.unitId} is null`);
    else if (input.unitKey) conds.push(eq(creditUnits.key, input.unitKey));
    if (input.invoicePublicId) conds.push(eq(invoices.publicId, input.invoicePublicId));
    if (input.createdGte) conds.push(gte(creditGrantMovements.createdAt, input.createdGte));
    if (input.createdLt) conds.push(lt(creditGrantMovements.createdAt, input.createdLt));
    if (input.startingAfter)
      conds.push(sql`${creditGrantMovements.publicId} < ${input.startingAfter}`);
    const rows = await tx
      .select({ m: creditGrantMovements, g: creditGrants, u: creditUnits, inv: invoices.publicId })
      .from(creditGrantMovements)
      .innerJoin(creditGrants, eq(creditGrants.id, creditGrantMovements.grantId))
      .leftJoin(creditUnits, eq(creditUnits.id, creditGrants.unitId))
      .leftJoin(invoices, eq(invoices.id, creditGrantMovements.invoiceId))
      .where(and(...conds))
      .orderBy(desc(creditGrantMovements.publicId))
      .limit(input.limit + 1);
    const page = rows.slice(0, input.limit).map(({ m, g, u, inv }) => {
      const decimals = u?.decimals ?? 0;
      return {
        object: "credit_transaction",
        id: m.publicId,
        kind: m.kind,
        grant: g.publicId,
        customer: input.customerPublicId,
        category: g.category,
        currency: g.currency,
        unit: u?.key ?? null,
        units: Number(m.units),
        units_decimal: formatSteps(m.units, decimals),
        face_minor: Number(m.faceMinor),
        cost_minor: Number(m.costMinor),
        invoice: inv ?? null,
        created_at: m.createdAt.toISOString(),
      };
    });
    return { data: page, hasMore: rows.length > input.limit };
  });
}
