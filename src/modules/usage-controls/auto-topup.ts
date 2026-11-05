/**
 * Automatic credit top-up (design G5 §3.6): the config, its runs and the `credit_auto_topups`
 * clock pass. A run raises a purchase invoice with a pending paid grant; the grant activates
 * only when the invoice is paid. A decline voids the invoice and turns the config off: no
 * dunning, no retry.
 */
import { and, asc, desc, eq, gte, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { systemDb, withTenant, type Tx } from "@/platform/db";
import { config as appConfig } from "@/platform/config";
import {
  localDatePartsInTz,
  midnightOnDateInTz,
  scanBusinessFilter,
  stampNow,
  startOfDayInTz,
} from "@/platform/clock";
import { publicId } from "@/platform/ids";
import { formatMoney } from "@/platform/currency";
import { createLogger } from "@/platform/logger";
import { withSpan } from "@/platform/trace";
import { emitEvent } from "@/modules/events/emit";
import { buildEventData, type EventType } from "@/modules/events/registry";
import { postEntries } from "@/modules/ledger/service";
import {
  chargeOrder,
  chargeWithMethod,
  lostChargeHandle,
  resolveChargeAdapter,
  resolveChargeCandidates,
  shouldTryBackup,
  tmtestOutcome,
  type ChargeAttempt,
  type LostChargeHandle,
  type Pm,
} from "@/modules/invoicing/collection";
import { PAYMENT_PURPOSE_KEY } from "@/modules/invoicing/pre-debit";
import { createInvoiceFromLines, invoiceOutstanding } from "@/modules/invoicing/service";
import { voidInvoice } from "@/modules/invoicing/ops";
import { activatePaidCreditGrants } from "@/modules/credits/packs";
import { insertCreditGrant, unitRate } from "@/modules/credits/service";
import { liveBalance } from "@/modules/credits/balance";
import { stepsForMinor } from "@/modules/credits/units";
import { settlePaymentFailed, settlePaymentSucceeded } from "@/modules/payments/settlement";
import { methodTypeOf } from "@/modules/payments/method-type";
import { recordTransaction } from "@/modules/transactions/service";
import { GatewayRouterError } from "@/modules/gateway/router";
import {
  debitNeedsBuyerAuthentication,
  INR_AFA_FREE_CEILING_MINOR,
} from "@/modules/payment-methods/mandate-afa";
import {
  noticeDutyFor,
  noticeLeadHours,
  ownNoticeLeadHours,
} from "@/modules/payment-methods/notice-duty";
import { declineHiddenFromPayer } from "@/providers/decline-codes";
import { ProviderIndeterminateError, strandedObjectId } from "@/providers/types";
import {
  AUTO_TOPUP_OPEN_RUN_STATUSES,
  CREDIT_LEDGER_ACCOUNTS,
  businesses,
  creditAutoTopupRuns,
  creditAutoTopups,
  creditUnits,
  customers,
  events,
  invoices,
  paymentMethods,
  payments,
  preDebitNotices,
  type AutoTopupMethod,
  type AutoTopupSchedule,
  type AutoTopupTrigger,
  type CreditApplicability,
  type CreditTaxTreatment,
} from "@db/schema";
import { leadCoverMinor, scheduleSlotOn, topupAmount } from "./auto-topup-amount";
import { measureBurn } from "./measure";
import { registerUsageAlertsDailyStep } from "./alerts-pass";

const log = createLogger("usage-controls.auto-topup");

type Config = typeof creditAutoTopups.$inferSelect;
type Run = typeof creditAutoTopupRuns.$inferSelect;
type Customer = typeof customers.$inferSelect;
type TickError = { organization: string; business?: string; step: string; message: string };

/** The per-customer lock that serializes run creation (design §3.6). */
const LOCK_KEY = 7410;
/** Our own notice's legal lead (24 h; ACH 10 days), plus the gate's margin. */
const ownNoticeMs = (pm: Parameters<typeof ownNoticeLeadHours>[0]) =>
  (ownNoticeLeadHours(pm) - 2) * 3_600_000 + 10 * 60_000;
/** A `charging` run with no booked payment this old crashed before the gateway call. */
const STUCK_CHARGING_MS = 10 * 60_000;
const OPEN = [...AUTO_TOPUP_OPEN_RUN_STATUSES];
/** Runs that count against the monthly cap. */
const CAP_STATUSES = ["notice_sent", "charging", "pending", "succeeded"] as const;

export class AutoTopupError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 = 400,
  ) {
    super(message);
    this.name = "AutoTopupError";
  }
}

// ── Burn (§3.5): spend in the last 7 days ÷ 7 ─────────────────────────────────

export interface Burn {
  burnMinorPerDay: bigint;
  /** Hours of usage history; the lead-time rule needs ≥ 24. */
  usageHours: number;
}
export type BurnReader = (
  tx: Tx,
  input: { businessId: string; customerId: string; currency: string; now: Date },
) => Promise<Burn | null>;

/** Burn from the usage measure (`measureBurn`): 24 h of usage, else unknown. */
const measuredBurn: BurnReader = async (tx, q) => {
  const b = await measureBurn(tx, q);
  return b.burnMinorPerDay == null ? null : { burnMinorPerDay: b.burnMinorPerDay, usageHours: 24 };
};
let burnReader: BurnReader = measuredBurn;
/** Tests: replace the burn reader (null restores the measure). */
export function setBurnReader(r: BurnReader | null): void {
  burnReader = r ?? measuredBurn;
}

// ── Config ────────────────────────────────────────────────────────────────────

export interface GrantConfig {
  tax_treatment: CreditTaxTreatment;
  priority?: number;
  expires_after_months?: number | null;
  applicability?: CreditApplicability;
}

export interface AutoTopupInput {
  currency?: string;
  unitKey?: string | null;
  trigger: AutoTopupTrigger;
  thresholdMinor?: bigint | null;
  schedule?: AutoTopupSchedule | null;
  method: AutoTopupMethod;
  amountMinor?: bigint | null;
  targetMinor?: bigint | null;
  monthlyCapMinor: bigint;
  maxRunsPerDay?: number;
  /** `pm_…`; null = the customer's charge order. */
  paymentMethod?: string | null;
  grant: GrantConfig;
}

const err = (m: string) => new AutoTopupError(`We could not save automatic top-up. ${m}`);

/** What a save or a read says about the lead-time rule. */
export interface LeadCheck {
  leadHours: number;
  burnMinorPerDay: bigint | null;
  requiredMinor: bigint | null;
  /** Set when burn is not known yet (under 24 h of usage). */
  warning: string | null;
}

async function customerOf(tx: Tx, businessId: string, cus: string): Promise<Customer> {
  const [c] = await tx
    .select()
    .from(customers)
    .where(and(eq(customers.businessId, businessId), eq(customers.publicId, cus)))
    .limit(1);
  if (!c) throw new AutoTopupError(`No such customer: ${cus}`, 404);
  return c;
}

/**
 * The instrument a run charges first: the config's, else the customer's charge order for
 * `currency` (a mandate held in another currency is not picked first).
 */
async function firstCandidate(
  organizationId: string,
  customerId: string,
  pmId: string | null,
  currency: string,
): Promise<Pm | null> {
  if (pmId) {
    const [pm] = await withTenant(organizationId, (tx) =>
      tx.select().from(paymentMethods).where(eq(paymentMethods.id, pmId)).limit(1),
    );
    return pm ?? null;
  }
  return (
    chargeOrder(await resolveChargeCandidates({ organizationId, customerId, currency }))[0] ?? null
  );
}

/** ₹15,000 on an INR card / UPI mandate (Decision 3); null elsewhere. */
export function afaCapFor(pm: Pm | null, currency: string): bigint | null {
  if (!pm) return null;
  return debitNeedsBuyerAuthentication(pm, currency, INR_AFA_FREE_CEILING_MINOR + 1n)
    ? INR_AFA_FREE_CEILING_MINOR
    : null;
}

async function leadCheckFor(input: {
  organizationId: string;
  businessId: string;
  customerId: string;
  currency: string;
  pm: Pm;
  thresholdMinor: bigint;
  now: Date;
}): Promise<LeadCheck> {
  let leadHours = 0;
  try {
    const { adapter } = await resolveChargeAdapter({
      organizationId: input.organizationId,
      businessId: input.businessId,
      currency: input.currency,
      pm: input.pm,
    });
    leadHours = noticeLeadHours(input.pm, adapter);
  } catch {
    leadHours = noticeLeadHours(input.pm, null);
  }
  if (leadHours === 0)
    return { leadHours, burnMinorPerDay: null, requiredMinor: null, warning: null };
  const burn = await withTenant(input.organizationId, (tx) =>
    burnReader(tx, {
      businessId: input.businessId,
      customerId: input.customerId,
      currency: input.currency,
      now: input.now,
    }),
  );
  if (!burn || burn.usageHours < 24 || burn.burnMinorPerDay <= 0n)
    return {
      leadHours,
      burnMinorPerDay: burn?.burnMinorPerDay ?? null,
      requiredMinor: null,
      warning:
        "Not enough usage to check the threshold. We check it again when there is 24 hours of usage.",
    };
  return {
    leadHours,
    burnMinorPerDay: burn.burnMinorPerDay,
    requiredMinor: leadCoverMinor(leadHours, burn.burnMinorPerDay),
    warning: null,
  };
}

/** The lead-time rule as it stands for a saved config (its first instrument, burn now). */
export async function autoTopupLead(cfg: Config): Promise<LeadCheck | null> {
  const pm = await firstCandidate(
    cfg.organizationId,
    cfg.customerId,
    cfg.paymentMethodId,
    cfg.currency,
  );
  if (!pm) return null;
  return leadCheckFor({
    organizationId: cfg.organizationId,
    businessId: cfg.businessId,
    customerId: cfg.customerId,
    currency: cfg.currency,
    pm,
    thresholdMinor: cfg.thresholdMinor ?? 0n,
    now: stampNow(cfg.businessId),
  });
}

export const leadRefusal = (lead: number, required: bigint, currency: string) =>
  `On this payment method, the charge can happen up to ${lead} hours after we send the notice. Set a threshold of ${formatMoney(required, currency)} or more. This covers ${lead} hours of usage at the current rate.`;

export async function getAutoTopup(input: {
  organizationId: string;
  businessId: string;
  customerPublicId: string;
  currency?: string;
  unitKey?: string | null;
}): Promise<Config | null> {
  return withTenant(input.organizationId, async (tx) => {
    const c = await customerOf(tx, input.businessId, input.customerPublicId);
    const unitId = input.unitKey ? await unitIdOf(tx, input.businessId, input.unitKey) : null;
    const [row] = await tx
      .select()
      .from(creditAutoTopups)
      .where(
        and(
          eq(creditAutoTopups.customerId, c.id),
          input.currency ? eq(creditAutoTopups.currency, input.currency.toUpperCase()) : undefined,
          unitId ? eq(creditAutoTopups.unitId, unitId) : isNull(creditAutoTopups.unitId),
        ),
      )
      .orderBy(asc(creditAutoTopups.createdAt))
      .limit(1);
    return row ?? null;
  });
}

async function unitIdOf(tx: Tx, businessId: string, key: string): Promise<string> {
  const [u] = await tx
    .select({ id: creditUnits.id })
    .from(creditUnits)
    .where(and(eq(creditUnits.businessId, businessId), eq(creditUnits.key, key)))
    .limit(1);
  if (!u) throw new AutoTopupError(`No such credit unit: ${key}`, 404);
  return u.id;
}

/** Create or replace the config. Refuses what can never run (design §3.6, Decision 3). */
export async function putAutoTopup(input: {
  organizationId: string;
  businessId: string;
  customerPublicId: string;
  config: AutoTopupInput;
  /** The buyer saves from the portal: inside the operator's min / max only. */
  setBy?: "operator" | "customer";
}): Promise<{ config: Config; lead: LeadCheck | null }> {
  const { organizationId, businessId } = input;
  const c = input.config;
  const now = stampNow(businessId);
  if ((c.trigger === "threshold") !== (c.thresholdMinor != null))
    throw err("A threshold top-up needs threshold_minor, and only a threshold top-up takes it.");
  if ((c.trigger === "schedule") !== (c.schedule != null))
    throw err("A schedule top-up needs a schedule, and only a schedule top-up takes it.");
  if ((c.method === "fixed") !== (c.amountMinor != null))
    throw err("A fixed top-up needs amount_minor, and only a fixed top-up takes it.");
  if ((c.method === "target") !== (c.targetMinor != null))
    throw err("A target top-up needs target_minor, and only a target top-up takes it.");
  if (c.schedule?.every === "week" && !(c.schedule.weekday >= 1 && c.schedule.weekday <= 7))
    throw err("The weekday must be 1 (Monday) to 7 (Sunday).");
  if (c.schedule?.every === "month" && !(c.schedule.day >= 1 && c.schedule.day <= 31))
    throw err("The day of the month must be 1 to 31.");
  if (c.monthlyCapMinor <= 0n) throw err("monthly_cap_minor must be more than 0.");
  const maxRuns = c.maxRunsPerDay ?? 3;
  if (maxRuns < 1 || maxRuns > 10) throw err("max_runs_per_day must be 1 to 10.");
  if (!c.grant?.tax_treatment) throw err("Set a tax treatment for the credit.");
  if (c.grant.tax_treatment === "taxed_at_use" && c.unitKey)
    throw err("Credit in a custom unit is taxed at purchase.");

  const prep = await withTenant(organizationId, async (tx) => {
    const customer = await customerOf(tx, businessId, input.customerPublicId);
    const unitId = c.unitKey ? await unitIdOf(tx, businessId, c.unitKey) : null;
    const [unit] = unitId
      ? await tx.select().from(creditUnits).where(eq(creditUnits.id, unitId)).limit(1)
      : [];
    const currency = (unit?.currency ?? c.currency ?? customer.currency ?? "").toUpperCase();
    if (!currency) throw err("Send a currency.");
    if (unit && c.currency && c.currency.toUpperCase() !== unit.currency)
      throw err(`The credit unit ${unit.key} is priced in ${unit.currency}.`);
    let pmId: string | null = null;
    if (c.paymentMethod) {
      const [pm] = await tx
        .select({ id: paymentMethods.id })
        .from(paymentMethods)
        .where(
          and(
            eq(paymentMethods.customerId, customer.id),
            eq(paymentMethods.publicId, c.paymentMethod),
          ),
        )
        .limit(1);
      if (!pm) throw new AutoTopupError(`No such payment method: ${c.paymentMethod}`, 404);
      pmId = pm.id;
    }
    const [biz] = await tx
      .select({ cfg: businesses.creditConfig })
      .from(businesses)
      .where(eq(businesses.id, businessId))
      .limit(1);
    return { customer, unitId, currency, pmId, limits: biz?.cfg?.top_up_limits?.[currency] };
  });
  const { customer, currency } = prep;
  const min = prep.limits?.min_minor != null ? BigInt(prep.limits.min_minor) : null;
  const max = prep.limits?.max_minor != null ? BigInt(prep.limits.max_minor) : null;
  if (min != null && max != null && min > max) throw err("The top-up limits are not valid.");
  if (c.method === "fixed" && max != null && c.amountMinor! > max)
    throw err(`The amount must be ${formatMoney(max, currency)} or less.`);
  if (c.method === "fixed" && min != null && c.amountMinor! < min)
    throw err(`The amount must be ${formatMoney(min, currency)} or more.`);

  const pm = await firstCandidate(organizationId, customer.id, prep.pmId, currency);
  if (!pm)
    throw err("The customer has no payment method that we can charge. Add a payment method.");
  // AFA (Decision 3): a run on a card / UPI mandate is clamped to ₹15,000; a config that
  // needs more than that can never run as set.
  const afa = afaCapFor(pm, currency);
  if (afa != null) {
    const needs =
      c.method === "fixed"
        ? c.amountMinor!
        : c.trigger === "threshold"
          ? c.targetMinor! - c.thresholdMinor!
          : c.targetMinor!;
    if ((min != null && min > afa) || needs > afa)
      throw err(
        "A card or UPI mandate can pay at most ₹15,000 without the payer. Lower the amount, or use a netbanking mandate.",
      );
  }
  if (c.method === "target" && c.trigger === "threshold" && c.targetMinor! <= c.thresholdMinor!)
    throw err("The target must be more than the threshold.");

  // The lead-time rule: on a notice rail, the threshold must cover the notice lead of usage.
  let lead: LeadCheck | null = null;
  if (c.trigger === "threshold") {
    lead = await leadCheckFor({
      organizationId,
      businessId,
      customerId: customer.id,
      currency,
      pm,
      thresholdMinor: c.thresholdMinor!,
      now,
    });
    if (lead.requiredMinor != null && c.thresholdMinor! < lead.requiredMinor)
      throw err(leadRefusal(lead.leadHours, lead.requiredMinor, currency));
  }

  const values = {
    trigger: c.trigger,
    thresholdMinor: c.thresholdMinor ?? null,
    schedule: c.schedule ?? null,
    method: c.method,
    amountMinor: c.amountMinor ?? null,
    targetMinor: c.targetMinor ?? null,
    monthlyCapMinor: c.monthlyCapMinor,
    maxRunsPerDay: maxRuns,
    paymentMethodId: prep.pmId,
    grantConfig: c.grant as unknown as Record<string, unknown>,
    status: "active" as const,
    disabledReason: null,
    disabledAt: null,
    updatedAt: now,
  };
  const row = await withTenant(organizationId, async (tx) => {
    const [existing] = await tx
      .select()
      .from(creditAutoTopups)
      .where(
        and(
          eq(creditAutoTopups.customerId, customer.id),
          eq(creditAutoTopups.currency, currency),
          prep.unitId ? eq(creditAutoTopups.unitId, prep.unitId) : isNull(creditAutoTopups.unitId),
        ),
      )
      .for("update")
      .limit(1);
    const [saved] = existing
      ? await tx
          .update(creditAutoTopups)
          .set(values)
          .where(eq(creditAutoTopups.id, existing.id))
          .returning()
      : await tx
          .insert(creditAutoTopups)
          .values({
            ...values,
            organizationId,
            businessId,
            publicId: publicId("atu"),
            customerId: customer.id,
            currency,
            unitId: prep.unitId,
            createdAt: now,
          })
          .returning();
    await activateUsageControls(tx, businessId, customer.id);
    return saved!;
  });
  return { config: row, lead };
}

/** The first control turns on the dirty mark; a config change re-marks the customer. */
async function activateUsageControls(tx: Tx, businessId: string, customerId: string) {
  await tx.execute(sql`update businesses set usage_controls_active = true
    where id = ${businessId} and not usage_controls_active`);
  await tx.execute(sql`
    insert into usage_control_dirty (customer_id, organization_id, business_id)
    values (${customerId}, current_setting('app.org_id', true)::uuid, ${businessId})
    on conflict (customer_id) do nothing`);
}

export async function setAutoTopupStatus(input: {
  organizationId: string;
  businessId: string;
  customerPublicId: string;
  currency?: string;
  unitKey?: string | null;
  status: "active" | "disabled";
  reason?: "operator" | "customer";
}): Promise<Config> {
  const cfg = await getAutoTopup(input);
  if (!cfg) throw new AutoTopupError("This customer has no automatic top-up.", 404);
  const now = stampNow(input.businessId);
  if (input.status === "active") {
    const pm = await firstCandidate(
      input.organizationId,
      cfg.customerId,
      cfg.paymentMethodId,
      cfg.currency,
    );
    if (!pm || pm.status === "invalid")
      throw new AutoTopupError(
        "We could not turn on automatic top-up. The customer has no payment method that we can charge. Add a payment method, then try again.",
      );
  }
  return withTenant(input.organizationId, async (tx) => {
    const [row] = await tx
      .update(creditAutoTopups)
      .set(
        input.status === "active"
          ? { status: "active", disabledReason: null, disabledAt: null, updatedAt: now }
          : {
              status: "disabled",
              disabledReason: input.reason ?? "operator",
              disabledAt: now,
              updatedAt: now,
            },
      )
      .where(eq(creditAutoTopups.id, cfg.id))
      .returning();
    if (input.status === "active")
      await activateUsageControls(tx, input.businessId, cfg.customerId);
    return row!;
  });
}

export async function listAutoTopupRuns(input: {
  organizationId: string;
  businessId: string;
  customerPublicId: string;
  limit: number;
  startingAfter?: string;
}): Promise<{ data: Run[]; hasMore: boolean }> {
  return withTenant(input.organizationId, async (tx) => {
    const c = await customerOf(tx, input.businessId, input.customerPublicId);
    let before: Date | null = null;
    if (input.startingAfter) {
      const [r] = await tx
        .select({ createdAt: creditAutoTopupRuns.createdAt })
        .from(creditAutoTopupRuns)
        .where(eq(creditAutoTopupRuns.publicId, input.startingAfter))
        .limit(1);
      before = r?.createdAt ?? null;
    }
    const rows = await tx
      .select()
      .from(creditAutoTopupRuns)
      .where(
        and(
          eq(creditAutoTopupRuns.customerId, c.id),
          before ? sql`${creditAutoTopupRuns.createdAt} < ${before.toISOString()}` : undefined,
        ),
      )
      .orderBy(desc(creditAutoTopupRuns.createdAt), desc(creditAutoTopupRuns.id))
      .limit(input.limit + 1);
    return { data: rows.slice(0, input.limit), hasMore: rows.length > input.limit };
  });
}

// ── Serialization ─────────────────────────────────────────────────────────────

const n = (v: bigint | null | undefined) => (v == null ? null : Number(v));
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

export async function serializeAutoTopup(
  organizationId: string,
  cfg: Config,
  lead?: LeadCheck | null,
) {
  const refs = await withTenant(organizationId, async (tx) => {
    const [c] = await tx
      .select({ id: customers.publicId })
      .from(customers)
      .where(eq(customers.id, cfg.customerId));
    const [pm] = cfg.paymentMethodId
      ? await tx
          .select({ id: paymentMethods.publicId })
          .from(paymentMethods)
          .where(eq(paymentMethods.id, cfg.paymentMethodId))
      : [];
    const [u] = cfg.unitId
      ? await tx
          .select({ key: creditUnits.key })
          .from(creditUnits)
          .where(eq(creditUnits.id, cfg.unitId))
      : [];
    return { customer: c?.id ?? null, pm: pm?.id ?? null, unit: u?.key ?? null };
  });
  return {
    object: "auto_topup",
    id: cfg.publicId,
    customer: refs.customer,
    currency: cfg.currency,
    unit: refs.unit,
    trigger: cfg.trigger,
    threshold_minor: n(cfg.thresholdMinor),
    schedule: cfg.schedule,
    method: cfg.method,
    amount_minor: n(cfg.amountMinor),
    target_minor: n(cfg.targetMinor),
    monthly_cap_minor: Number(cfg.monthlyCapMinor),
    max_runs_per_day: cfg.maxRunsPerDay,
    payment_method: refs.pm,
    grant: cfg.grantConfig,
    status: cfg.status,
    disabled_reason: cfg.disabledReason,
    disabled_at: iso(cfg.disabledAt),
    threshold_low_at: iso(cfg.thresholdLowAt),
    ...(lead
      ? {
          lead_time: {
            lead_hours: lead.leadHours,
            burn_minor_per_day: n(lead.burnMinorPerDay),
            required_threshold_minor: n(lead.requiredMinor),
            warning: lead.warning,
          },
        }
      : {}),
    created_at: iso(cfg.createdAt),
    updated_at: iso(cfg.updatedAt),
    resource_version: cfg.resourceVersion,
  };
}

export async function serializeAutoTopupRuns(organizationId: string, runs: Run[]) {
  const ids = (xs: Array<string | null>) => [...new Set(xs.filter((x): x is string => !!x))];
  const maps = await withTenant(organizationId, async (tx) => {
    const cfgIds = ids(runs.map((r) => r.configId));
    const invIds = ids(runs.map((r) => r.invoiceId));
    const payIds = ids(runs.map((r) => r.paymentId));
    const cfgs = cfgIds.length
      ? await tx
          .select({ id: creditAutoTopups.id, p: creditAutoTopups.publicId })
          .from(creditAutoTopups)
          .where(inArray(creditAutoTopups.id, cfgIds))
      : [];
    const invs = invIds.length
      ? await tx
          .select({ id: invoices.id, p: invoices.publicId })
          .from(invoices)
          .where(inArray(invoices.id, invIds))
      : [];
    const pays = payIds.length
      ? await tx
          .select({ id: payments.id, p: payments.publicId })
          .from(payments)
          .where(inArray(payments.id, payIds))
      : [];
    const m = (rows: Array<{ id: string; p: string }>) => new Map(rows.map((r) => [r.id, r.p]));
    return { cfg: m(cfgs), inv: m(invs), pay: m(pays) };
  });
  return runs.map((r) => ({
    object: "auto_topup_run",
    id: r.publicId,
    auto_topup: maps.cfg.get(r.configId) ?? null,
    trigger: r.trigger,
    trigger_key: r.triggerKey,
    amount_minor: Number(r.amountMinor),
    currency: r.currency,
    status: r.status,
    invoice: r.invoiceId ? (maps.inv.get(r.invoiceId) ?? null) : null,
    payment: r.paymentId ? (maps.pay.get(r.paymentId) ?? null) : null,
    charge_after: iso(r.chargeAfter),
    decline_code: r.declineCode,
    failure_message: r.failureMessage,
    created_at: iso(r.createdAt),
    updated_at: iso(r.updatedAt),
  }));
}

// ── The `credit_auto_topups` pass ─────────────────────────────────────────────

export interface AutoTopupPassResult {
  created: number;
  noticed: number;
  succeeded: number;
  pending: number;
  failed: number;
  skipped: number;
  cancelled: number;
  capped: boolean;
  errors: TickError[];
}

/**
 * Create due runs, send notices, charge the runs whose time has come and settle the ones a
 * webhook or the stale-pending sweep resolved. Talks to gateways, like renewal and dunning.
 */
export async function runCreditAutoTopups(now: Date): Promise<AutoTopupPassResult> {
  const out: AutoTopupPassResult = {
    created: 0,
    noticed: 0,
    succeeded: 0,
    pending: 0,
    failed: 0,
    skipped: 0,
    cancelled: 0,
    capped: false,
    errors: [],
  };
  const limit = appConfig.TICK_SCAN_LIMIT;
  const fail = (organization: string, business: string, step: string, e: unknown) => {
    out.errors.push({
      organization,
      business,
      step,
      message: e instanceof Error ? e.message : String(e),
    });
    log.error(e as Error, { event: "credit_auto_topup_pass_error", step });
  };

  // 1. Create runs for active configs.
  const configs = await systemDb
    .select()
    .from(creditAutoTopups)
    .where(
      and(eq(creditAutoTopups.status, "active"), scanBusinessFilter(creditAutoTopups.businessId)),
    )
    .orderBy(asc(creditAutoTopups.updatedAt), asc(creditAutoTopups.id))
    .limit(limit + 1);
  if (configs.length > limit) out.capped = true;
  for (const cfg of configs.slice(0, limit)) {
    try {
      const r = await createRunFor(cfg, now);
      if (r === "created") out.created++;
      else if (r === "skipped") out.skipped++;
    } catch (e) {
      fail(cfg.organizationId, cfg.businessId, "credit_auto_topups.create", e);
    }
  }

  // 2. Due runs: notice, then charge.
  const due = await systemDb
    .select()
    .from(creditAutoTopupRuns)
    .where(
      and(
        inArray(creditAutoTopupRuns.status, ["created", "notice_sent"]),
        or(isNull(creditAutoTopupRuns.chargeAfter), lte(creditAutoTopupRuns.chargeAfter, now)),
        scanBusinessFilter(creditAutoTopupRuns.businessId),
      ),
    )
    .orderBy(asc(creditAutoTopupRuns.createdAt))
    .limit(limit + 1);
  if (due.length > limit) out.capped = true;
  for (const run of due.slice(0, limit)) {
    try {
      const r = await advanceRun(run, now);
      if (r) out[r]++;
    } catch (e) {
      fail(run.organizationId, run.businessId, "credit_auto_topups.charge", e);
    }
  }

  // 3. Open runs a webhook, the sweep or a crash left behind; failed runs whose void failed.
  const open = await systemDb
    .select()
    .from(creditAutoTopupRuns)
    .where(
      and(
        or(
          inArray(creditAutoTopupRuns.status, ["charging", "pending"]),
          and(
            eq(creditAutoTopupRuns.status, "failed"),
            sql`exists (select 1 from invoices i where i.id = ${creditAutoTopupRuns.invoiceId}
              and i.status in ('payment_due', 'posted', 'not_paid'))`,
          ),
        ),
        scanBusinessFilter(creditAutoTopupRuns.businessId),
      ),
    )
    .orderBy(asc(creditAutoTopupRuns.updatedAt))
    .limit(limit + 1);
  if (open.length > limit) out.capped = true;
  for (const run of open.slice(0, limit)) {
    try {
      const r = await reconcileRun(run, now);
      if (r) out[r]++;
    } catch (e) {
      fail(run.organizationId, run.businessId, "credit_auto_topups.reconcile", e);
    }
  }
  return out;
}

const lockCustomer = (tx: Tx, customerId: string) =>
  tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${customerId}::text, ${LOCK_KEY}))`);

function isUniqueViolation(e: unknown, ...names: string[]): boolean {
  const x = e as {
    code?: string;
    constraint?: string;
    cause?: { code?: string; constraint_name?: string };
  };
  const code = x?.code ?? x?.cause?.code;
  const name = String(x?.constraint ?? x?.cause?.constraint_name ?? "");
  return code === "23505" && names.some((n) => name.includes(n));
}

/** Business-zone day and month starts for `now`. */
function calendarOf(now: Date, tz: string) {
  const p = localDatePartsInTz(now, tz);
  const day = `${p.year}-${String(p.month + 1).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
  return {
    day,
    month: day.slice(0, 7),
    dayStart: startOfDayInTz(now, tz),
    monthStart: midnightOnDateInTz(p.year, p.month, 1, tz),
  };
}

/** Once per period key: has this config already emitted this skip? */
async function skipOnce(
  tx: Tx,
  cfg: Config,
  reason: "monthly_cap" | "daily_limit",
  periodKey: string,
): Promise<void> {
  const [seen] = await tx
    .select({ id: events.id })
    .from(events)
    .where(
      and(
        eq(events.type, "credit_auto_topup_skipped"),
        eq(events.resourceId, cfg.publicId),
        sql`${events.data} ->> 'period_key' = ${`${reason}:${periodKey}`}`,
      ),
    )
    .limit(1);
  if (seen) return;
  await emitEvent(tx, {
    organizationId: cfg.organizationId,
    businessId: cfg.businessId,
    type: "credit_auto_topup_skipped",
    data: buildEventData(
      "credit_auto_topup_skipped",
      { id: cfg.publicId, customer: await customerPublicId(tx, cfg.customerId) },
      cfg.resourceVersion,
      { reason, period_key: `${reason}:${periodKey}` },
    ),
  });
}

async function customerPublicId(tx: Tx, id: string): Promise<string | null> {
  const [c] = await tx
    .select({ p: customers.publicId })
    .from(customers)
    .where(eq(customers.id, id))
    .limit(1);
  return c?.p ?? null;
}

type Decision =
  | { kind: "run"; amount: bigint; triggerKey: string | null }
  | { kind: "none" }
  | { kind: "skipped" };

/** Decide under the customer lock; create the run and its invoice in one transaction. */
export async function createRunFor(
  cfg: Config,
  now: Date,
): Promise<"created" | "skipped" | "none"> {
  const [biz] = await systemDb
    .select({ tz: businesses.timezone, cfg: businesses.creditConfig })
    .from(businesses)
    .where(eq(businesses.id, cfg.businessId))
    .limit(1);
  const tz = biz?.tz ?? "UTC";
  const cal = calendarOf(now, tz);
  const pm = await firstCandidate(
    cfg.organizationId,
    cfg.customerId,
    cfg.paymentMethodId,
    cfg.currency,
  );
  const decision: Decision = await withTenant(cfg.organizationId, async (tx) => {
    await lockCustomer(tx, cfg.customerId);
    const runs = await tx
      .select()
      .from(creditAutoTopupRuns)
      .where(
        and(
          eq(creditAutoTopupRuns.configId, cfg.id),
          gte(
            creditAutoTopupRuns.createdAt,
            cal.monthStart < cal.dayStart ? cal.monthStart : cal.dayStart,
          ),
        ),
      );
    const openRuns = await tx
      .select({ amount: creditAutoTopupRuns.amountMinor })
      .from(creditAutoTopupRuns)
      .where(
        and(eq(creditAutoTopupRuns.configId, cfg.id), inArray(creditAutoTopupRuns.status, OPEN)),
      );
    if (openRuns.length > 0) return { kind: "none" };
    let triggerKey: string | null = null;
    if (cfg.trigger === "schedule") {
      const slot = scheduleSlotOn(cfg.schedule!, cal.day);
      if (!slot) return { kind: "none" };
      triggerKey = `sch:${slot}`;
      if (runs.some((r) => r.triggerKey === triggerKey)) return { kind: "none" };
    }
    const [cust] = await tx
      .select({ settings: customers.creditSettings })
      .from(customers)
      .where(eq(customers.id, cfg.customerId))
      .limit(1);
    const bal = await liveBalance(tx, {
      customerId: cfg.customerId,
      currency: cfg.currency,
      now,
      businessConfig: biz?.cfg ?? null,
      customerSettings: cust?.settings ?? null,
    });
    const lim = biz?.cfg?.top_up_limits?.[cfg.currency];
    const used = runs
      .filter(
        (r) =>
          r.createdAt.getTime() >= cal.monthStart.getTime() &&
          (CAP_STATUSES as readonly string[]).includes(r.status),
      )
      .reduce((s, r) => s + r.amountMinor, 0n);
    const amount = topupAmount({
      trigger: cfg.trigger,
      method: cfg.method,
      thresholdMinor: cfg.thresholdMinor,
      amountMinor: cfg.amountMinor,
      targetMinor: cfg.targetMinor,
      balanceMinor: bal.balanceMinor,
      openMinor: 0n,
      minMinor: lim?.min_minor != null ? BigInt(lim.min_minor) : null,
      maxMinor: lim?.max_minor != null ? BigInt(lim.max_minor) : null,
      afaCapMinor: afaCapFor(pm, cfg.currency),
      monthlyCapMinor: cfg.monthlyCapMinor,
      usedThisMonthMinor: used,
    });
    if (amount.kind === "none") return { kind: "none" };
    if (amount.kind === "skip") {
      await skipOnce(tx, cfg, "monthly_cap", cal.month);
      return { kind: "skipped" };
    }
    const today = runs.filter((r) => r.createdAt.getTime() >= cal.dayStart.getTime()).length;
    if (today >= cfg.maxRunsPerDay) {
      await skipOnce(tx, cfg, "daily_limit", cal.day);
      return { kind: "skipped" };
    }
    return { kind: "run", amount: amount.amountMinor, triggerKey };
  });
  if (decision.kind !== "run") return decision.kind;
  try {
    await createRunAndInvoice(cfg, decision.amount, decision.triggerKey);
    return "created";
  } catch (e) {
    // A concurrent creation won: the open-run index (or the slot) refused this one.
    if (
      isUniqueViolation(
        e,
        "credit_auto_topup_runs_open_uq",
        "credit_auto_topup_runs_trigger_key_uq",
      )
    )
      return "none";
    throw e;
  }
}

async function createRunAndInvoice(
  cfg: Config,
  amount: bigint,
  triggerKey: string | null,
): Promise<void> {
  const grant = cfg.grantConfig as unknown as GrantConfig;
  const runPublicId = publicId("atur");
  const unit = cfg.unitId
    ? (
        await withTenant(cfg.organizationId, (tx) =>
          tx.select().from(creditUnits).where(eq(creditUnits.id, cfg.unitId!)).limit(1),
        )
      )[0]!
    : null;
  const units = unit ? stepsForMinor(amount, unitRate(unit)) : amount;
  const what = unit ? `${unit.pluralName}` : `${cfg.currency} credit`;
  const { invoice } = await createInvoiceFromLines({
    organizationId: cfg.organizationId,
    businessId: cfg.businessId,
    customerId: cfg.customerId,
    currency: cfg.currency,
    applyTax: true,
    applyCredit: true,
    collect: false,
    originToken: `atu:${runPublicId}`,
    lines: [
      {
        description: `Automatic top-up: ${what}`,
        amountMinor: amount,
        quantity: 1,
        kind: "one_time",
        creditPack: grant.tax_treatment,
      },
    ],
    inTx: async (tx, created) => {
      // The lock and the open-run index make a second concurrent run roll this back.
      await lockCustomer(tx, cfg.customerId);
      const now = created.invoice.createdAt;
      const [run] = await tx
        .insert(creditAutoTopupRuns)
        .values({
          organizationId: cfg.organizationId,
          businessId: cfg.businessId,
          publicId: runPublicId,
          configId: cfg.id,
          customerId: cfg.customerId,
          trigger: cfg.trigger,
          triggerKey,
          amountMinor: amount,
          currency: cfg.currency,
          status: "created",
          invoiceId: created.invoice.id,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      await tx
        .update(invoices)
        .set({ purpose: "credit_purchase", nextAttemptAt: null })
        .where(eq(invoices.id, created.invoice.id));
      const expiresAt =
        grant.expires_after_months != null
          ? new Date(
              Date.UTC(
                now.getUTCFullYear(),
                now.getUTCMonth() + grant.expires_after_months,
                now.getUTCDate(),
                now.getUTCHours(),
                now.getUTCMinutes(),
                now.getUTCSeconds(),
              ),
            )
          : null;
      await insertCreditGrant(tx, {
        organizationId: cfg.organizationId,
        businessId: cfg.businessId,
        customerId: cfg.customerId,
        currency: cfg.currency,
        unit,
        amount: units,
        costBasisMinor: amount,
        category: "paid",
        priority: grant.priority,
        effectiveAt: now,
        expiresAt,
        applicability: grant.applicability,
        source: "auto_top_up",
        sourceRef: run!.id,
        invoiceId: created.invoice.id,
        taxTreatment: grant.tax_treatment,
        status: "pending",
      });
      // The sale moves into pending credit until the invoice is paid (as a pack does).
      await postEntries(
        {
          organizationId: cfg.organizationId,
          businessId: cfg.businessId,
          customerId: cfg.customerId,
          sourceType: "invoice",
          sourceId: created.invoice.publicId,
          lines: [
            { account: "revenue", direction: "debit", amountMinor: amount, currency: cfg.currency },
            {
              account: CREDIT_LEDGER_ACCOUNTS.pending,
              direction: "credit",
              amountMinor: amount,
              currency: cfg.currency,
            },
          ],
        },
        tx,
      );
      // Paid at raise by the money balance: the grant is active now.
      await activatePaidCreditGrants(tx, {
        organizationId: cfg.organizationId,
        invoiceId: created.invoice.id,
      });
    },
  });
  // An auto-collect-off customer's invoice is enrolled after the transaction; the run owns it.
  await withTenant(cfg.organizationId, (tx) =>
    tx
      .update(invoices)
      .set({ nextAttemptAt: null, dunningStatus: null })
      .where(and(eq(invoices.id, invoice.id), eq(invoices.purpose, "credit_purchase"))),
  );
}

/** Notice or charge one due run. Returns the counter it moved. */
async function advanceRun(
  run: Run,
  now: Date,
): Promise<"noticed" | "succeeded" | "pending" | "failed" | "cancelled" | null> {
  const ctx = await loadRunContext(run);
  if (!ctx) return null;
  const { cfg, inv } = ctx;
  if (inv.status === "paid") return (await markSucceeded(run)) ? "succeeded" : null;
  if (inv.status === "voided") return (await closeRun(run, "cancelled")) ? "cancelled" : null;
  // Turned off before the charge: cancel the run and void its invoice.
  if (cfg.status !== "active") {
    if (!(await closeRun(run, "cancelled"))) return null;
    await voidQuietly(run, inv.publicId, "auto_topup_cancelled");
    return "cancelled";
  }

  const candidates = cfg.paymentMethodId
    ? chargeOrder(
        await resolveChargeCandidates({
          organizationId: run.organizationId,
          customerId: run.customerId,
          paymentMethodOverrideId:
            (await pmPublicId(run.organizationId, cfg.paymentMethodId)) ?? "",
          currency: run.currency,
        }),
      )
    : chargeOrder(
        await resolveChargeCandidates({
          organizationId: run.organizationId,
          customerId: run.customerId,
          currency: run.currency,
        }),
      );
  if (candidates.length === 0) {
    if (!(await claim(run, ["created", "notice_sent"], "charging"))) return null;
    await declineRun(
      run,
      "no_payment_method",
      "The customer has no payment method that we can charge.",
    );
    return "failed";
  }
  const due = await withTenant(
    run.organizationId,
    async (tx) => (await invoiceOutstanding(tx, inv)).remainingMinor,
  );
  if (due <= 0n) return (await markSucceeded(run)) ? "succeeded" : null;

  // Our own notice, once, before the first debit on a mandate rail the gateway does not notify.
  const first = candidates[0]!;
  if (run.status === "created") {
    let adapter = null;
    try {
      adapter = (
        await resolveChargeAdapter({
          organizationId: run.organizationId,
          businessId: run.businessId,
          currency: run.currency,
          pm: first,
        })
      ).adapter;
    } catch {
      adapter = null;
    }
    if (noticeDutyFor(first, adapter) === "ours") {
      const chargeAfter = new Date(now.getTime() + ownNoticeMs(first));
      const sent = await withTenant(run.organizationId, async (tx) => {
        const [r] = await tx
          .update(creditAutoTopupRuns)
          .set({ status: "notice_sent", chargeAfter, updatedAt: stampNow(run.businessId) })
          .where(and(eq(creditAutoTopupRuns.id, run.id), eq(creditAutoTopupRuns.status, "created")))
          .returning();
        if (!r) return false;
        await emitRunEvent(tx, "credit_auto_topup_scheduled", cfg, r, {
          amount_minor: Number(due),
          currency: run.currency,
          invoice: inv.publicId,
          debit_at: chargeAfter.toISOString(),
          mandate_reference: first.mandateReference,
          mandate_rail: first.mandateRail,
          // Our notice: the `credit_topup_debit_notice` email carries it.
          notice_by: "ours",
        });
        return true;
      });
      return sent ? "noticed" : null;
    }
  }

  if (!(await claim(run, ["created", "notice_sent"], "charging"))) return null;
  // One span per top-up: the pass charges many customers under the clock tick's trace.
  return withSpan(() => chargeRun({ ...run, status: "charging" }, cfg, inv, candidates, due));
}

async function pmPublicId(organizationId: string, pmId: string): Promise<string | null> {
  const [pm] = await withTenant(organizationId, (tx) =>
    tx
      .select({ p: paymentMethods.publicId })
      .from(paymentMethods)
      .where(eq(paymentMethods.id, pmId))
      .limit(1),
  );
  return pm?.p ?? null;
}

async function loadRunContext(run: Run) {
  return withTenant(run.organizationId, async (tx) => {
    const [cfg] = await tx
      .select()
      .from(creditAutoTopups)
      .where(eq(creditAutoTopups.id, run.configId))
      .limit(1);
    const [inv] = run.invoiceId
      ? await tx.select().from(invoices).where(eq(invoices.id, run.invoiceId)).limit(1)
      : [];
    return cfg && inv ? { cfg, inv } : null;
  });
}

/** Compare-and-swap the run's status. */
async function claim(run: Run, from: Run["status"][], to: Run["status"]): Promise<boolean> {
  const [r] = await withTenant(run.organizationId, (tx) =>
    tx
      .update(creditAutoTopupRuns)
      .set({ status: to, updatedAt: stampNow(run.businessId) })
      .where(and(eq(creditAutoTopupRuns.id, run.id), inArray(creditAutoTopupRuns.status, from)))
      .returning({ id: creditAutoTopupRuns.id }),
  );
  return !!r;
}

async function closeRun(run: Run, to: "cancelled"): Promise<boolean> {
  return claim(run, OPEN, to);
}

async function emitRunEvent(
  tx: Tx,
  type: EventType,
  cfg: Config,
  run: Run,
  extra: Record<string, unknown>,
) {
  await emitEvent(tx, {
    organizationId: run.organizationId,
    businessId: run.businessId,
    type,
    data: buildEventData(
      type,
      {
        id: cfg.publicId,
        customer: await customerPublicId(tx, run.customerId),
        run: run.publicId,
        amount_minor: Number(run.amountMinor),
        currency: run.currency,
        status: run.status,
      },
      cfg.resourceVersion,
      extra,
    ),
  });
}

/** Charge the run's invoice like a paid top-up: candidates, then backups. */
async function chargeRun(
  run: Run,
  cfg: Config,
  inv: typeof invoices.$inferSelect,
  candidates: Pm[],
  due: bigint,
): Promise<"succeeded" | "pending" | "failed" | null> {
  const { organizationId, businessId } = run;
  const [customer] = await withTenant(organizationId, (tx) =>
    tx.select().from(customers).where(eq(customers.id, run.customerId)).limit(1),
  );
  const contact = {
    autoCollection: customer!.autoCollection,
    email: customer!.email,
    phone: customer!.phone,
  };
  let last: { code: string; message: string | null } | null = null;
  for (const pm of candidates) {
    const payId = publicId("pay");
    let booked: typeof payments.$inferSelect | null = null;
    const book = async () =>
      (booked ??= await bookPending({ run, inv, pm, amount: due, payPublicId: payId }));
    let a: ChargeAttempt;
    try {
      a = await chargeWithMethod({
        organizationId,
        businessId,
        currency: run.currency,
        pm,
        amountMinor: due,
        idempotencyKey: payId,
        ownershipRef: inv.publicId,
        description: "Credit top-up",
        contact,
        preDebit: { purpose: "credit_topup" },
        initiator: { by: "merchant", recurring: true },
        beforeGatewayCall: async () => {
          await book();
        },
      });
    } catch (e) {
      const pay = await book();
      if (e instanceof ProviderIndeterminateError) {
        // Money may have moved: pending, never a failure (no double charge).
        const lost = lostChargeHandle(e);
        await settle(
          run,
          pm,
          pay,
          {
            result: { status: "pending", providerChargeId: strandedObjectId(e) ?? "" },
            account: lost?.account ?? null,
            gatewayKey: lost?.gatewayKey ?? pm.providerKey,
          },
          "timeout",
          lost,
        );
        return "pending";
      }
      const router = e instanceof GatewayRouterError;
      log.error(e as Error, { event: "credit_auto_topup_charge_threw", payment: pay.publicId });
      const attempt = failed(
        pm,
        router ? "gateway_account_unavailable" : "gateway_error",
        e instanceof Error ? e.message : String(e),
        !router,
      );
      await settle(run, pm, pay, attempt);
      last = { code: attempt.result.failure!.code, message: attempt.result.failure!.message };
      continue;
    }
    if (a.deferredUntil) {
      if (pm !== candidates[0]) continue;
      // A gateway notice is out: wait for its executable_after (the gate checks the stored row).
      await withTenant(organizationId, async (tx) => {
        const [notice] = await tx
          .select({ id: preDebitNotices.id })
          .from(preDebitNotices)
          .where(
            and(
              eq(preDebitNotices.paymentMethodId, pm.id),
              eq(preDebitNotices.purpose, "credit_topup"),
            ),
          )
          .orderBy(desc(preDebitNotices.createdAt))
          .limit(1);
        const [r] = await tx
          .update(creditAutoTopupRuns)
          .set({
            status: "notice_sent",
            chargeAfter: a.deferredUntil!,
            noticeId: notice?.id ?? null,
            updatedAt: stampNow(businessId),
          })
          .where(
            and(eq(creditAutoTopupRuns.id, run.id), eq(creditAutoTopupRuns.status, "charging")),
          )
          .returning();
        if (r && run.noticeId == null)
          await emitRunEvent(tx, "credit_auto_topup_scheduled", cfg, r, {
            amount_minor: Number(due),
            currency: run.currency,
            invoice: inv.publicId,
            debit_at: a.deferredUntil!.toISOString(),
            notice_by: "gateway",
          });
      });
      return null;
    }
    const pay = await book();
    if (a.result.status === "succeeded") {
      await settle(run, pm, pay, a);
      return (await markSucceeded(run)) ? "succeeded" : null;
    }
    if (a.result.status !== "failed") {
      const outcome = tmtestOutcome(a.result);
      await settle(
        run,
        pm,
        pay,
        a,
        outcome === "timeout"
          ? "timeout"
          : outcome === "needs_attention"
            ? "needs_attention"
            : "in_progress",
      );
      await claim(run, ["charging"], "pending");
      return "pending";
    }
    await settle(run, pm, pay, a);
    last = {
      code: a.result.failure?.code ?? "card_declined",
      message: a.result.failure?.message ?? null,
    };
    if (!shouldTryBackup(a.result)) break;
  }
  await declineRun(run, last?.code ?? "card_declined", last?.message ?? null);
  return "failed";
}

const failed = (pm: Pm, code: string, message: string, retriable: boolean): ChargeAttempt => ({
  result: { status: "failed", providerChargeId: "", failure: { code, message, retriable } },
  account: null,
  gatewayKey: pm.providerKey,
});

/** Booked BEFORE the gateway call, with the run's payment, so a crash still leaves a row. */
async function bookPending(input: {
  run: Run;
  inv: typeof invoices.$inferSelect;
  pm: Pm;
  amount: bigint;
  payPublicId: string;
}): Promise<typeof payments.$inferSelect> {
  const { run, inv, pm } = input;
  return withTenant(run.organizationId, async (tx) => {
    const [pay] = await tx
      .insert(payments)
      .values({
        organizationId: run.organizationId,
        businessId: run.businessId,
        customerId: run.customerId,
        invoiceId: inv.id,
        paymentMethodId: pm.id,
        publicId: input.payPublicId,
        status: "pending",
        amountMinor: input.amount,
        currency: run.currency,
        providerKey: pm.providerKey,
        methodType: methodTypeOf(null, pm),
        // Which notice this debit runs under (`preDebitGate` matches on it).
        metadata: { [PAYMENT_PURPOSE_KEY]: "credit_topup" },
      })
      .returning();
    await tx
      .update(creditAutoTopupRuns)
      .set({ paymentId: pay!.id, updatedAt: stampNow(run.businessId) })
      .where(eq(creditAutoTopupRuns.id, run.id));
    return pay!;
  });
}

/** The gateway's answer on the booked payment: one transaction row, settled like a webhook. */
async function settle(
  run: Run,
  pm: Pm,
  pay: typeof payments.$inferSelect,
  a: ChargeAttempt,
  pendingStatus?: "in_progress" | "timeout" | "needs_attention",
  lost?: LostChargeHandle | null,
): Promise<void> {
  const { organizationId, businessId } = run;
  const r = a.result;
  const chargeId = r.providerChargeId || null;
  await withTenant(organizationId, async (tx) => {
    await tx
      .update(payments)
      .set({ providerKey: a.gatewayKey, providerChargeId: chargeId })
      .where(eq(payments.id, pay.id));
    await recordTransaction(
      {
        organizationId,
        businessId,
        customerId: run.customerId,
        type: "payment",
        status: pendingStatus ?? (r.status === "succeeded" ? "succeeded" : "failed"),
        amountMinor: pay.amountMinor,
        currency: pay.currency,
        gatewayAccountId: a.account?.id ?? null,
        gatewayKey: a.gatewayKey,
        idAtGateway: chargeId,
        ...(lost ? { ownershipRef: lost.ownershipRef, idempotencyKey: lost.idempotencyKey } : {}),
        paymentMethodId: pm.id,
        invoiceId: pay.invoiceId,
        paymentId: pay.id,
        errorCode: r.failure?.code ?? null,
        errorText: r.failure?.message ?? null,
        retriable: r.failure?.retriable ?? null,
      },
      tx,
    );
    if (pendingStatus) return;
    if (r.status === "succeeded")
      await settlePaymentSucceeded(tx, { organizationId, businessId, paymentId: pay.id });
    else
      await settlePaymentFailed(tx, {
        organizationId,
        businessId,
        paymentId: pay.id,
        errorCode: r.failure?.code ?? "card_declined",
        errorText: r.failure?.message ?? null,
        retriable: r.failure?.retriable ?? true,
        // No dunning, no retry: the decline path voids the invoice.
        rearmDunning: false,
      });
  });
}

async function markSucceeded(run: Run): Promise<boolean> {
  return withTenant(run.organizationId, async (tx) => {
    const [r] = await tx
      .update(creditAutoTopupRuns)
      .set({ status: "succeeded", updatedAt: stampNow(run.businessId) })
      .where(and(eq(creditAutoTopupRuns.id, run.id), inArray(creditAutoTopupRuns.status, OPEN)))
      .returning();
    if (!r) return false;
    const [cfg] = await tx
      .select()
      .from(creditAutoTopups)
      .where(eq(creditAutoTopups.id, r.configId))
      .limit(1);
    const [inv] = await tx
      .select({ p: invoices.publicId })
      .from(invoices)
      .where(eq(invoices.id, r.invoiceId!))
      .limit(1);
    await emitRunEvent(tx, "credit_auto_topup_succeeded", cfg!, r, { invoice: inv?.p ?? null });
    return true;
  });
}

const FAILED_MESSAGE = (reason: string | null) =>
  `We could not add credit to your account.${reason ? ` Your bank declined the payment (${reason}).` : " Your bank declined the payment."} Automatic top-up is now off. Update your payment method, then turn on automatic top-up again.`;

/** The decline path: run failed, config off, event and email, then the invoice voided. */
async function declineRun(run: Run, code: string, message: string | null): Promise<void> {
  const hidden = declineHiddenFromPayer(code);
  const reason = hidden ? null : code.replace(/_/g, " ");
  const invPublicId = await withTenant(run.organizationId, async (tx) => {
    const now = stampNow(run.businessId);
    const [r] = await tx
      .update(creditAutoTopupRuns)
      .set({ status: "failed", declineCode: code, failureMessage: message, updatedAt: now })
      .where(and(eq(creditAutoTopupRuns.id, run.id), inArray(creditAutoTopupRuns.status, OPEN)))
      .returning();
    if (!r) return null;
    const [cfg] = await tx
      .update(creditAutoTopups)
      .set({
        status: "disabled",
        disabledReason: "payment_declined",
        disabledAt: now,
        updatedAt: now,
      })
      .where(eq(creditAutoTopups.id, r.configId))
      .returning();
    const [inv] = await tx
      .select({ p: invoices.publicId })
      .from(invoices)
      .where(eq(invoices.id, r.invoiceId!))
      .limit(1);
    await emitRunEvent(tx, "credit_auto_topup_failed", cfg!, r, {
      invoice: inv?.p ?? null,
      decline_code: code,
      // Null when the code is ours, not the payer's to read (`declineHiddenFromPayer`).
      decline_reason: reason,
      message: FAILED_MESSAGE(reason),
    });
    return inv?.p ?? null;
  });
  if (invPublicId) await voidQuietly(run, invPublicId, "auto_topup_declined");
}

/** Void the purchase invoice; a refusal (a payment still in flight) is retried by the pass. */
async function voidQuietly(run: Run, invoicePublicId: string, reason: string): Promise<void> {
  try {
    await voidInvoice(run.organizationId, run.businessId, invoicePublicId, {
      voidReasonCode: reason,
    });
  } catch (e) {
    log.warn("could not void an automatic top-up invoice yet", {
      event: "credit_auto_topup_void_deferred",
      run: run.publicId,
      error: (e as Error)?.message,
    });
  }
}

/** Settle what happened after the pass left a run open. */
async function reconcileRun(
  run: Run,
  now: Date,
): Promise<"succeeded" | "pending" | "failed" | null> {
  const ctx = await loadRunContext(run);
  if (!ctx) return null;
  const { inv } = ctx;
  if (run.status === "failed") {
    if (["payment_due", "posted", "not_paid"].includes(inv.status))
      await voidQuietly(run, inv.publicId, "auto_topup_declined");
    return null;
  }
  if (inv.status === "paid") return (await markSucceeded(run)) ? "succeeded" : null;
  const [pay] = run.paymentId
    ? await withTenant(run.organizationId, (tx) =>
        tx.select().from(payments).where(eq(payments.id, run.paymentId!)).limit(1),
      )
    : [];
  if (!pay) {
    // Crashed between the claim and the booking: nothing reached a gateway.
    if (run.status === "charging" && now.getTime() - run.updatedAt.getTime() > STUCK_CHARGING_MS)
      await claim(run, ["charging"], "created");
    return null;
  }
  if (pay.status === "failed") {
    await declineRun(run, pay.failureCode ?? "card_declined", pay.failureMessage ?? null);
    return "failed";
  }
  if (pay.status === "succeeded") return (await markSucceeded(run)) ? "succeeded" : null;
  if (run.status === "charging") await claim(run, ["charging"], "pending");
  return null;
}

// ── Weekly lead-time re-check (a daily step of the `usage_alerts` pass) ──────────────

/**
 * Every active threshold config on a notice rail: when burn has grown past the threshold's
 * cover, emit `credit_auto_topup_threshold_low` once a week. The config is never changed.
 */
export async function recheckAutoTopupThresholds(now: Date): Promise<{ warned: number }> {
  let warned = 0;
  const weekAgo = new Date(now.getTime() - 7 * 86_400_000);
  const rows = await systemDb
    .select()
    .from(creditAutoTopups)
    .where(
      and(
        eq(creditAutoTopups.status, "active"),
        eq(creditAutoTopups.trigger, "threshold"),
        or(isNull(creditAutoTopups.thresholdLowAt), lte(creditAutoTopups.thresholdLowAt, weekAgo)),
        scanBusinessFilter(creditAutoTopups.businessId),
      ),
    )
    .limit(appConfig.TICK_SCAN_LIMIT);
  for (const cfg of rows) {
    try {
      const pm = await firstCandidate(
        cfg.organizationId,
        cfg.customerId,
        cfg.paymentMethodId,
        cfg.currency,
      );
      if (!pm) continue;
      const lead = await leadCheckFor({
        organizationId: cfg.organizationId,
        businessId: cfg.businessId,
        customerId: cfg.customerId,
        currency: cfg.currency,
        pm,
        thresholdMinor: cfg.thresholdMinor!,
        now,
      });
      if (lead.requiredMinor == null || cfg.thresholdMinor! >= lead.requiredMinor) continue;
      const done = await withTenant(cfg.organizationId, async (tx) => {
        const [r] = await tx
          .update(creditAutoTopups)
          .set({ thresholdLowAt: now })
          .where(
            and(
              eq(creditAutoTopups.id, cfg.id),
              or(
                isNull(creditAutoTopups.thresholdLowAt),
                lte(creditAutoTopups.thresholdLowAt, weekAgo),
              ),
            ),
          )
          .returning();
        if (!r) return false;
        await emitEvent(tx, {
          organizationId: cfg.organizationId,
          businessId: cfg.businessId,
          type: "credit_auto_topup_threshold_low",
          data: buildEventData(
            "credit_auto_topup_threshold_low",
            {
              id: cfg.publicId,
              customer: await customerPublicId(tx, cfg.customerId),
              threshold_minor: Number(cfg.thresholdMinor),
              required_minor: Number(lead.requiredMinor),
              burn_minor_per_day: Number(lead.burnMinorPerDay),
              lead_hours: lead.leadHours,
              currency: cfg.currency,
            },
            r.resourceVersion,
          ),
        });
        return true;
      });
      if (done) warned++;
    } catch (e) {
      log.error(e as Error, { event: "credit_auto_topup_recheck_failed", config: cfg.publicId });
    }
  }
  return { warned };
}

registerUsageAlertsDailyStep(
  "auto_topup_threshold_low",
  async (now) => (await recheckAutoTopupThresholds(now)).warned,
);
