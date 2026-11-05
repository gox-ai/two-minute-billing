import {
  and,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lte,
  ne,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import { systemDb, withTenant } from "@/platform/db";
import { notDeleted } from "./deleted-sql";
import { emitEvent } from "@/modules/events/emit";
import { buildEventData, type EventType } from "@/modules/events/registry";
import {
  businesses,
  customers,
  events,
  gatewayAccounts,
  invoices,
  paymentMethodAuthorizations,
  paymentMethods,
  preDebitNotices,
  scheduledChanges,
  subscriptions,
} from "@db/schema";
import { scanBusinessFilter } from "@/platform/clock";
import { createLogger } from "@/platform/logger";
import { resolveAdapter } from "@/providers/registry";
import { preDebitRule, type PaymentProvider } from "@/providers/types";
import { sendGatewayNotice } from "@/modules/invoicing/pre-debit";
import { loadChargeContact } from "@/modules/invoicing/collection";
import { autoCollectionOffSql } from "@/modules/invoicing/service";
import { nextBillingBoundary } from "./service";
import { estimateRenewal, estimateRenewalCeiling } from "./estimate";
import { skippedRenewal } from "./renewal-skips";
import { ACH_VARYING_AMOUNT_NOTICE_DAYS } from "@/modules/payment-methods/ach-authorization";
import { noticeDutyFor, ownsAchNotice } from "@/modules/payment-methods/notice-duty";
import type { TickError } from "@/modules/subscriptions/renewal";
import {
  DEFAULT_REMINDER_LEAD_DAYS,
  OPTIONAL_REMINDER_KINDS,
  REMINDER_KINDS,
  dueLeadDay,
  leadAlreadySent,
  resolveReminderConfig,
  type OptionalReminderKind,
  type ReminderConfig,
  type ReminderKind,
} from "./reminder-config";

/** Default days before trial end at which we emit the reminder (per business: 0376). */
export const TRIAL_ENDING_WINDOW_DAYS = DEFAULT_REMINDER_LEAD_DAYS.trial_ending[0]!;
/** Default days before a term boundary at which we warn that the subscription renews. */
export const RENEWAL_REMINDER_WINDOW_DAYS = DEFAULT_REMINDER_LEAD_DAYS.renewal[0]!;
/** The same, for a yearly (or longer) plan. */
export const YEARLY_RENEWAL_REMINDER_WINDOW_DAYS = DEFAULT_REMINDER_LEAD_DAYS.renewal_yearly[0]!;

/** A yearly (or longer) term: renewal reminders use the `renewal_yearly` list. */
export function isYearlyTerm(sub: {
  billingPeriod: number | null;
  billingPeriodUnit: string | null;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
}): boolean {
  const n = sub.billingPeriod ?? 1;
  const unit = sub.billingPeriodUnit;
  return unit
    ? unit === "year" ||
        (unit === "month" && n >= 12) ||
        (unit === "week" && n >= 52) ||
        (unit === "day" && n >= 365)
    : // No snapshot on the row: judge by the term itself (a year is ≥ 360 days).
      !!sub.currentPeriodStart &&
        !!sub.currentPeriodEnd &&
        sub.currentPeriodEnd.getTime() - sub.currentPeriodStart.getTime() >= 360 * 86_400_000;
}

/** Default renewal lead time for one subscription, by its billing period. */
export function renewalLeadDays(sub: Parameters<typeof isYearlyTerm>[0]): number {
  return isYearlyTerm(sub) ? YEARLY_RENEWAL_REMINDER_WINDOW_DAYS : RENEWAL_REMINDER_WINDOW_DAYS;
}
/** Default days before a *scheduled* cancellation takes effect at which we warn about it. */
export const CANCELLATION_REMINDER_WINDOW_DAYS = DEFAULT_REMINDER_LEAD_DAYS.cancellation[0]!;
/**
 * Days before a MANDATE debit at which the payer must be notified.
 *
 * Not a product choice — NPCI requires the payer be told at least 24h before every
 * Autopay debit, with the amount, the date and the mandate reference, and RBI's
 * e-mandate framework says the same for cards and netbanking. RazorPay raises it for
 * their own Subscriptions product; on the custom recurring API we drive there is no
 * notification endpoint at all (every documented path 404s — operator ask 2), so the
 * obligation lands on us.
 *
 * ⚠️ **A MINIMUM, not a target.** The pass runs once a minute and this window is
 * inclusive, so a subscription entering it is notified on the next tick — roughly
 * 48h to 24h ahead. Shortening it to exactly 1 day would leave no margin for a tick
 * that is delayed or capped, and a notice that lands 23h ahead is not compliant.
 */
const PRE_DEBIT_NOTICE_WINDOW_DAYS = 2;

/**
 * How far ahead section 4 looks for debits whose notice goes THROUGH the gateway. Covers a
 * minimum lead of up to ~94h (one gateway asks 48h for cards; another suggests 72h).
 */
const GATEWAY_NOTICE_SCAN_DAYS = 4;

/**
 * An ACH debit whose amount can vary needs a notice of the amount and date at least 10 days
 * before it (Reg E 12 CFR 1005.10(d)(1), via eCFR, read 2026-10-28). Sent from 12 days out,
 * so a delayed tick still lands it in time. Only where the authorization is ours to take
 * (`achAuthorization: "ours"`): elsewhere the gateway notifies the payer.
 */
const ACH_NOTICE_SCAN_DAYS = ACH_VARYING_AMOUNT_NOTICE_DAYS + 2;
/** A gateway notice goes out this long before its minimum lead runs out. */
const GATEWAY_NOTICE_MARGIN_MS = 2 * 3600_000;

const log = createLogger("subscriptions.reminders");

/**
 * The DEFAULT lead times, keyed by the EMAIL type each reminder produces. A business's own
 * lists come from `resolveReminderConfig`; the pre-debit notice has only this one.
 */
export const REMINDER_LEAD_DAYS = {
  trial_ending: TRIAL_ENDING_WINDOW_DAYS,
  renewal_reminder: RENEWAL_REMINDER_WINDOW_DAYS,
  // Yearly plans get YEARLY_RENEWAL_REMINDER_WINDOW_DAYS; the endpoint reports both.
  cancellation_reminder: CANCELLATION_REMINDER_WINDOW_DAYS,
  // The pre-debit notice is a reminder like the three above and now appears beside them
  // on the hub, so it has to carry its lead time too — omitting it would render the one
  // reminder with a LEGAL deadline as the only one whose timing the screen cannot state,
  // which is the vagueness this map was added to end.
  pre_debit_notification: PRE_DEBIT_NOTICE_WINDOW_DAYS,
} as const;

/**
 * Top-level `data` key carrying the OCCURRENCE a recurring reminder is about.
 *
 * It must be top-level: `emitEvent` runs the payload through `buildEventContent`,
 * which overwrites `data.subscription` with a full snapshot — anything we tuck
 * inside the resource envelope is lost. `buildEventData`'s `extra` argument is
 * merged at the top level and survives enrichment, so that is where it goes.
 */
const OCCURRENCE_KEY: Partial<Record<EventType, string>> = {
  subscription_renewal_reminder: "renewal_at",
  subscription_cancellation_reminder: "cancel_at",
  subscription_pre_debit_notification: "debit_at",
  subscription_pause_reminder: "pause_at",
  subscription_resume_reminder: "resume_at",
  invoice_payment_due_reminder: "due_at",
};

/**
 * Has this reminder already been emitted for this subscription?
 *
 * `occurrence` is what makes a RECURRING reminder correct. Trial-ending happens
 * once per subscription, so "any event of this type for this resource" is a fine
 * dedup key. A renewal reminder must fire once per TERM, forever — dedup on
 * (type, resource) alone would fire it in term 1 and then go silent for the life
 * of the subscription. So for those we also require the stored event to carry the
 * SAME target date, and the next term (a different `current_period_end`) is a
 * different occurrence that fires again.
 *
 * The date is compared as the ISO string we wrote; both sides derive from the same
 * timestamptz column read into a JS Date, so the rendering is stable across ticks.
 */
async function alreadyEmitted(
  type: EventType,
  resourceId: string,
  occurrence?: { key: string; value: string },
): Promise<boolean> {
  const [seen] = await systemDb
    .select({ id: events.id })
    .from(events)
    .where(
      and(
        eq(events.type, type),
        eq(events.resourceType, "subscription"),
        eq(events.resourceId, resourceId),
        // CAST pins the `->>` overload: an untyped parameter leaves
        // `jsonb ->> unknown` ambiguous between the text and integer operators.
        occurrence
          ? sql`${events.data} ->> CAST(${occurrence.key} AS text) = ${occurrence.value}`
          : undefined,
      ),
    )
    .limit(1);
  return !!seen;
}

/**
 * The `lead_days` of every reminder already emitted for this subscription (and occurrence,
 * when given). null = an event from before 0376, which carries none.
 */
async function sentLeads(
  type: EventType,
  resourceId: string,
  occurrence?: { key: string; value: string },
  resourceType: "subscription" | "invoice" = "subscription",
): Promise<Array<number | null>> {
  const rows = await systemDb
    .select({ lead: sql<string | null>`${events.data} ->> 'lead_days'` })
    .from(events)
    .where(
      and(
        eq(events.type, type),
        eq(events.resourceType, resourceType),
        eq(events.resourceId, resourceId),
        occurrence
          ? sql`${events.data} ->> CAST(${occurrence.key} AS text) = ${occurrence.value}`
          : undefined,
      ),
    );
  return rows.map((r) => (r.lead == null ? null : Number(r.lead)));
}

/**
 * Reminder settings of the businesses in this pass that have their own (0376). The rest use
 * the defaults; `horizon` is the longest lead in play per kind, so one scan covers them all.
 */
async function loadReminderConfigs(): Promise<{
  forBusiness: (businessId: string) => ReminderConfig;
  horizon: Record<ReminderKind | OptionalReminderKind, number>;
  /** Businesses with an optional kind switched on. Off is the default, so only stored ones. */
  onFor: (kind: OptionalReminderKind) => string[];
}> {
  const rows = await systemDb
    .select({ id: businesses.id, reminderConfig: businesses.reminderConfig })
    .from(businesses)
    .where(and(isNotNull(businesses.reminderConfig), scanBusinessFilter(businesses.id)));
  const byId = new Map(rows.map((r) => [r.id, resolveReminderConfig(r)]));
  const fallback = resolveReminderConfig(null);
  const horizon = {} as Record<ReminderKind | OptionalReminderKind, number>;
  for (const k of REMINDER_KINDS)
    horizon[k] = Math.max(
      ...DEFAULT_REMINDER_LEAD_DAYS[k],
      ...[...byId.values()].flatMap((c) => c.leadDays[k]),
    );
  for (const k of OPTIONAL_REMINDER_KINDS)
    horizon[k] = Math.max(0, ...[...byId.values()].flatMap((c) => c.optional[k]));
  const onFor = (k: OptionalReminderKind) =>
    [...byId.entries()].filter(([, c]) => c.optional[k].length > 0).map(([id]) => id);
  return { forBusiness: (id) => byId.get(id) ?? fallback, horizon, onFor };
}

/** The later of two instants: when a target date became known. */
const later = (a: Date | null, b: Date | null) => (a && b ? (a > b ? a : b) : (a ?? b));

/** Emit one reminder for one subscription (or invoice), RLS-scoped to its org. */
async function emitReminder(
  row: { organizationId: string; businessId: string; publicId: string },
  type: EventType,
  resource: Record<string, unknown>,
  extra?: Record<string, unknown>,
): Promise<void> {
  await withTenant(row.organizationId, async (tx) => {
    await emitEvent(tx, {
      organizationId: row.organizationId,
      businessId: row.businessId,
      type,
      data: buildEventData(type, { id: row.publicId, ...resource }, null, extra),
    });
  });
}

export interface RemindersPassResult {
  /**
   * Total reminders emitted by the pass, all kinds — the number the billing clock
   * logs. Broken down by kind below.
   */
  reminded: number;
  trialEnding: number;
  renewal: number;
  cancellation: number;
  /** NPCI/RBI pre-debit notices sent for mandate-rail subscriptions. */
  preDebit: number;
  /** Pre-debit notices sent through the gateway (`capabilities.preDebitNotice`). Not events. */
  gatewayPreDebit: number;
  /** Reminders before the due date of an invoice the customer pays themselves. */
  paymentDue: number;
  /** Reminders before a scheduled pause and a scheduled resume. */
  pause: number;
  resume: number;
  /** Per-item failures, for the tick row: the log line for them is rate-limited. */
  errors: TickError[];
}

/**
 * Reminder pass (billing clock): emit the time-relative subscription warnings —
 * `subscription_trial_ending`, `subscription_renewal_reminder` and
 * `subscription_cancellation_reminder` — at each of the business's lead days before the
 * thing each warns about (0376; defaults 3, 5 / 30 yearly, 5). System-wide scan (admin
 * connection), per-row RLS on the emit.
 *
 * The pass runs on EVERY tick, so every reminder is deduped against the events log and
 * re-running is a no-op: one event per (subscription, kind, occurrence, lead day). Each
 * event carries its `lead_days`. Trial-ending has no occurrence key (a subscription has one
 * trial); renewal and cancellation key on the target date, so they fire again next term or
 * after a reschedule. See `dueLeadDay` for which lead day is due.
 *
 * Sections 5 and 6 add `invoice_payment_due_reminder` and the scheduled pause / resume
 * reminders, each Off unless the business set its list.
 *
 * This function only emits events. Mapping them to customer emails is the email
 * module's job (it subscribes to the events log).
 */
export async function runRemindersPass(now: Date): Promise<RemindersPassResult> {
  const horizonFor = (days: number) => new Date(now.getTime() + days * 24 * 3600_000);
  const { forBusiness, horizon, onFor } = await loadReminderConfigs();

  // ---- 1. Trial ending ----------------------------------------------------
  const trialDue = await systemDb
    .select({
      id: subscriptions.id,
      organizationId: subscriptions.organizationId,
      businessId: subscriptions.businessId,
      publicId: subscriptions.publicId,
      trialEnd: subscriptions.trialEnd,
      trialStart: subscriptions.trialStart,
      createdAt: subscriptions.createdAt,
    })
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.status, "in_trial"),
        gt(subscriptions.trialEnd, now),
        lte(subscriptions.trialEnd, horizonFor(horizon.trial_ending)),
        notDeleted(),
        scanBusinessFilter(subscriptions.businessId),
      ),
    );

  let trialEnding = 0;
  for (const row of trialDue) {
    const cfg = forBusiness(row.businessId);
    const lead = dueLeadDay(cfg.leadDays.trial_ending, row.trialEnd!, now, {
      changedAt: cfg.changedAt.trial_ending,
      knownSince: later(row.trialStart, row.createdAt),
    });
    if (lead == null) continue;
    const sent = await sentLeads("subscription_trial_ending", row.publicId);
    if (leadAlreadySent(sent, lead, TRIAL_ENDING_WINDOW_DAYS)) continue;
    await emitReminder(
      row,
      "subscription_trial_ending",
      { trial_end: row.trialEnd },
      { lead_days: lead },
    );
    trialEnding++;
  }

  // ---- 2. Renewal ---------------------------------------------------------
  // `active` subscriptions whose term ends inside the window AND that will
  // actually renew: a sub that is already non_renewing (cancel_at_period_end, a
  // pending specific-date cancel, or remaining_billing_cycles exhausted — see
  // `apiSubscriptionStatus`) gets the CANCELLATION reminder below instead, never
  // a "you will be charged again" notice for a charge that will not happen.
  // Scanned at the LONGEST lead in play, then narrowed per row to its own list.
  const renewalHorizon = horizonFor(Math.max(horizon.renewal, horizon.renewal_yearly));
  const renewalDue = await systemDb
    .select({
      id: subscriptions.id,
      organizationId: subscriptions.organizationId,
      businessId: subscriptions.businessId,
      publicId: subscriptions.publicId,
      currentPeriodStart: subscriptions.currentPeriodStart,
      currentPeriodEnd: subscriptions.currentPeriodEnd,
      billingPeriod: subscriptions.billingPeriod,
      billingPeriodUnit: subscriptions.billingPeriodUnit,
      // A trialling subscription has no term (2026-08-25); its next charge is at trial_end,
      // and `nextBillingBoundary` needs the status to pick between them.
      trialEnd: subscriptions.trialEnd,
      status: subscriptions.status,
      createdAt: subscriptions.createdAt,
    })
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.status, "active"),
        gt(subscriptions.currentPeriodEnd, now),
        lte(subscriptions.currentPeriodEnd, renewalHorizon),
        eq(subscriptions.cancelAtPeriodEnd, false),
        isNull(subscriptions.cancelScheduledAt),
        or(
          isNull(subscriptions.remainingBillingCycles),
          ne(subscriptions.remainingBillingCycles, 0),
        ),
        notDeleted(),
        scanBusinessFilter(subscriptions.businessId),
      ),
    );

  let renewal = 0;
  for (const row of renewalDue) {
    // The next BILLING boundary: trial_end while trialling, the term end after (2026-08-25).
    const renewalBoundary = nextBillingBoundary(row);
    if (!renewalBoundary) continue;
    const cfg = forBusiness(row.businessId);
    const kind: ReminderKind = isYearlyTerm(row) ? "renewal_yearly" : "renewal";
    const lead = dueLeadDay(cfg.leadDays[kind], renewalBoundary, now, {
      changedAt: cfg.changedAt[kind],
      knownSince: later(row.currentPeriodStart, row.createdAt),
    });
    if (lead == null) continue;
    // A skipped renewal charges nothing recurring: no "you will be charged" notice.
    if (await skippedRenewal(row.id, renewalBoundary)) continue;
    const renewalAt = renewalBoundary.toISOString();
    const key = OCCURRENCE_KEY.subscription_renewal_reminder!;
    const sent = await sentLeads("subscription_renewal_reminder", row.publicId, {
      key,
      value: renewalAt,
    });
    if (leadAlreadySent(sent, lead, renewalLeadDays(row))) continue;
    // What the renewal will cost, so the reminder can say it. The same fixed-charge
    // estimate the pre-debit notice uses; no estimate ⇒ no amount, never a guess.
    const est = await estimateRenewal({
      organizationId: row.organizationId,
      businessId: row.businessId,
      subscriptionId: row.id,
    });
    await emitReminder(
      row,
      "subscription_renewal_reminder",
      { current_period_end: row.currentPeriodEnd },
      {
        [key]: renewalAt,
        lead_days: lead,
        expected_amount_minor: est ? (est.amount_due_minor ?? est.total_minor) : null,
        ...(est?.currency ? { currency: est.currency } : {}),
      },
    );
    renewal++;
  }

  // ---- 3. Scheduled cancellation ------------------------------------------
  // Two ways a cancellation is pending (0159): an explicit `specific_date` cancel
  // (`cancel_scheduled_at`), or an end-of-term cancel (`cancel_at_period_end`, or
  // `remaining_billing_cycles` down to 0) which lands on `current_period_end`.
  // Either can be in the window, so the scan ORs both and the effective date is
  // resolved per row below with the same precedence the serializer uses.
  const cancelHorizon = horizonFor(horizon.cancellation);
  const cancelDue = await systemDb
    .select({
      organizationId: subscriptions.organizationId,
      businessId: subscriptions.businessId,
      publicId: subscriptions.publicId,
      currentPeriodEnd: subscriptions.currentPeriodEnd,
      // A trialling subscription has no term (2026-08-25); its next charge is at trial_end,
      // and `nextBillingBoundary` needs the status to pick between them.
      trialEnd: subscriptions.trialEnd,
      status: subscriptions.status,
      cancelScheduledAt: subscriptions.cancelScheduledAt,
      cancelAtPeriodEnd: subscriptions.cancelAtPeriodEnd,
      remainingBillingCycles: subscriptions.remainingBillingCycles,
      // No column records when the cancel was scheduled; the last write is the closest.
      updatedAt: subscriptions.updatedAt,
    })
    .from(subscriptions)
    .where(
      and(
        // A terminal (`cancelled`) or not-yet-started (`future`) subscription has
        // nothing to warn about.
        notInArray(subscriptions.status, ["cancelled", "future"]),
        or(
          and(
            gt(subscriptions.cancelScheduledAt, now),
            lte(subscriptions.cancelScheduledAt, cancelHorizon),
          ),
          and(
            or(
              eq(subscriptions.cancelAtPeriodEnd, true),
              eq(subscriptions.remainingBillingCycles, 0),
            ),
            gt(subscriptions.currentPeriodEnd, now),
            lte(subscriptions.currentPeriodEnd, cancelHorizon),
          ),
        ),
        notDeleted(),
        scanBusinessFilter(subscriptions.businessId),
      ),
    );

  let cancellation = 0;
  for (const row of cancelDue) {
    const effective =
      row.cancelScheduledAt ??
      (row.cancelAtPeriodEnd || row.remainingBillingCycles === 0 ? row.currentPeriodEnd : null);
    // A row can match the scan on one branch while precedence picks the other
    // date (e.g. a specific-date cancel far out on a term that ends next week).
    // Only warn about the date that will actually happen, and only at a lead day.
    if (!effective) continue;
    const cfg = forBusiness(row.businessId);
    const lead = dueLeadDay(cfg.leadDays.cancellation, effective, now, {
      changedAt: cfg.changedAt.cancellation,
      knownSince: row.updatedAt,
    });
    if (lead == null) continue;
    const cancelAt = effective.toISOString();
    const key = OCCURRENCE_KEY.subscription_cancellation_reminder!;
    const sent = await sentLeads("subscription_cancellation_reminder", row.publicId, {
      key,
      value: cancelAt,
    });
    if (leadAlreadySent(sent, lead, CANCELLATION_REMINDER_WINDOW_DAYS)) continue;
    await emitReminder(
      row,
      "subscription_cancellation_reminder",
      { cancel_scheduled_at: effective },
      { [key]: cancelAt, lead_days: lead },
    );
    cancellation++;
  }

  // ---- 4. Pre-debit notification (mandate rails) --------------------------
  //
  // A LEGAL obligation, not a courtesy: NPCI requires the payer be notified at least
  // 24h before every Autopay debit, carrying the amount, the date and the mandate
  // reference. RazorPay sends it for their own Subscriptions product; on the custom
  // recurring API we drive, no notification endpoint exists (operator ask 2), so we
  // send it ourselves.
  //
  // Scoped to instruments that actually ride a MANDATE — `payment_methods.mandate_rail`
  // is non-null exactly when the provider registered one (0179). A plain card-on-file
  // has no pre-debit obligation, and notifying those would train customers to ignore
  // the mail that legally matters.
  //
  // Joined to the subscription's DEFAULT payment method: that is the instrument the
  // renewal will actually debit (`collectInvoice` prefers it before falling back to the
  // customer's primary), so the mandate reference quoted is the one being drawn on.
  //
  // Two other rails are not ours to notify. Where the gateway's adapter declares
  // `preDebitNotice`, the notice is a gateway API call (the bank then tells the payer), sent
  // here once the debit is inside the gateway's lead time. Where it declares
  // `gatewayNotifiesPayer`, the gateway mails the payer itself. Both skip our email: two
  // notices with different figures confuse payers.
  const debitHorizon = horizonFor(PRE_DEBIT_NOTICE_WINDOW_DAYS);
  const achHorizon = horizonFor(ACH_NOTICE_SCAN_DAYS);
  const debitDue = await systemDb
    .select({
      organizationId: subscriptions.organizationId,
      businessId: subscriptions.businessId,
      id: subscriptions.id,
      publicId: subscriptions.publicId,
      currentPeriodEnd: subscriptions.currentPeriodEnd,
      // A trialling subscription has no term (2026-08-25); its next charge is at trial_end,
      // and `nextBillingBoundary` needs the status to pick between them.
      trialEnd: subscriptions.trialEnd,
      status: subscriptions.status,
      currency: subscriptions.currency,
      mandateRail: paymentMethods.mandateRail,
      mandateReference: paymentMethods.mandateReference,
      pm: paymentMethods,
      account: gatewayAccounts,
    })
    .from(subscriptions)
    .innerJoin(paymentMethods, eq(paymentMethods.id, subscriptions.defaultPaymentMethodId))
    .leftJoin(gatewayAccounts, eq(gatewayAccounts.id, paymentMethods.gatewayAccountId))
    .where(
      and(
        eq(subscriptions.status, "active"),
        gt(subscriptions.currentPeriodEnd, now),
        lte(
          subscriptions.currentPeriodEnd,
          horizonFor(
            Math.max(PRE_DEBIT_NOTICE_WINDOW_DAYS, GATEWAY_NOTICE_SCAN_DAYS, ACH_NOTICE_SCAN_DAYS),
          ),
        ),
        // Nothing will be debited if the term is its last.
        eq(subscriptions.cancelAtPeriodEnd, false),
        isNull(subscriptions.cancelScheduledAt),
        or(
          isNull(subscriptions.remainingBillingCycles),
          ne(subscriptions.remainingBillingCycles, 0),
        ),
        // The whole scope: only mandate rails carry the obligation — plus instruments bound
        // to a gateway account, which may need a gateway notice or forbid our email.
        or(
          isNotNull(paymentMethods.mandateRail),
          isNotNull(paymentMethods.gatewayAccountId),
          eq(paymentMethods.type, "us_bank_account"),
        ),
        notDeleted(),
        scanBusinessFilter(subscriptions.businessId),
      ),
    );

  let preDebit = 0;
  let gatewayPreDebit = 0;
  const errors: TickError[] = [];
  for (const row of debitDue) {
    const debitBoundary = nextBillingBoundary(row);
    if (!debitBoundary) continue;
    const adapter = row.account ? adapterOrNull(row.account, errors) : null;
    const cap = adapter?.capabilities.preDebitNotice;
    const duty = noticeDutyFor(row.pm, adapter);
    const viaGateway = duty === "gateway";
    // An ACH debit we hold the authorization for: our notice, 10+ days ahead.
    const achNotice = !viaGateway && ownsAchNotice(row.pm);
    if (
      !viaGateway &&
      (duty !== "ours" || row.currentPeriodEnd! > (achNotice ? achHorizon : debitHorizon))
    )
      continue;
    if (
      viaGateway &&
      debitBoundary.getTime() - now.getTime() >
        preDebitRule(cap!, row.pm.type).minLeadHours * 3600_000 + GATEWAY_NOTICE_MARGIN_MS
    )
      continue;
    // A skipped renewal debits only metered usage, if any. With none, nothing is debited and
    // no notice is due; with some, the notice still goes, without the fixed amount it skips.
    const skipped = await skippedRenewal(row.id, debitBoundary);
    if (skipped && !skipped.meteredUsage) continue;
    if (viaGateway) {
      if (await sendProactiveGatewayNotice(row, adapter!, debitBoundary, skipped, errors))
        gatewayPreDebit++;
      continue;
    }
    const debitAt = debitBoundary.toISOString();
    const key = OCCURRENCE_KEY.subscription_pre_debit_notification!;
    if (
      await alreadyEmitted("subscription_pre_debit_notification", row.publicId, {
        key,
        value: debitAt,
      })
    ) {
      continue;
    }
    /**
     * The amount that will actually be DEBITED — the one fact in this notice the
     * rule is strictest about, and the one we were getting most wrong.
     *
     * It used to quote `subscriptions.mrr`, which is a **monthly-normalized metric**,
     * not a charge. Measured 2026-08-18: a ₹1,20,000/year subscription on a UPI
     * mandate was notified for **₹10,000** and would have been debited ₹1,20,000 —
     * out by 12×, on a legally-required figure, and silently right for the monthly
     * plans anyone would have spot-checked. MRR also excludes tax, so an 18%-GST
     * renewal understated by the whole tax amount even at the correct interval.
     *
     * `estimateRenewal` is the calculator the renewal itself uses, which is the only
     * defensible source — the estimate module's own docstring records what building a
     * parallel one cost last time. Prefer `amount_due_minor` (total less the
     * customer's balance) since that is what leaves their bank. The ceiling variant: with
     * a scheduled change, the higher of today's items and the post-change items.
     *
     * ⚠️ Two honest limits, neither hidden by a fabricated number:
     *  - **Usage is excluded.** `estimateRenewal` is the fixed-charge floor, because
     *    usage for a period that has not happened cannot be known. A metered INR plan
     *    can therefore debit MORE than its notice said — an open compliance question
     *    recorded against operator ask 2, not something arithmetic can close.
     *  - **No estimate ⇒ no amount**, never a substitute. The template already renders
     *    an empty `{{amount}}` rather than a false ₹0.00, and a notice missing the
     *    figure is a smaller wrong than a notice stating someone else's.
     */
    const est = skipped
      ? null
      : await estimateRenewalCeiling({
          organizationId: row.organizationId,
          businessId: row.businessId,
          subscriptionId: row.id,
        });
    const expected = est ? (est.amount_due_minor ?? est.total_minor) : null;

    await emitReminder(
      row,
      "subscription_pre_debit_notification",
      { current_period_end: row.currentPeriodEnd },
      {
        [key]: debitAt,
        // The three facts NPCI names: amount, date, mandate reference. On an ACH debit the
        // reference is the payer's authorization (Reg E names amount and date).
        expected_amount_minor: expected,
        currency: est?.currency ?? row.currency,
        mandate_rail: achNotice ? "ach" : row.mandateRail,
        mandate_reference: achNotice
          ? await latestAchAuthorizationId(row.organizationId, row.pm.id)
          : row.mandateReference,
      },
    );
    preDebit++;
  }

  const paymentDue = await paymentDueReminders(now, forBusiness, onFor("payment_due"), horizon);
  const { pause, resume } = await pauseResumeReminders(now, forBusiness, onFor, horizon);

  return {
    reminded: trialEnding + renewal + cancellation + preDebit + paymentDue + pause + resume,
    trialEnding,
    renewal,
    cancellation,
    preDebit,
    gatewayPreDebit,
    paymentDue,
    pause,
    resume,
    errors,
  };
}

type ConfigFor = (businessId: string) => ReminderConfig;
const DAY_MS = 86_400_000;

/**
 * 5. Payment due: before the due date of an open invoice with money due that nothing will
 * charge (auto-collection off, the `isAutoCollectOn` order). An auto-collected invoice
 * charges itself, so "pay before the due date" would be wrong there. Off unless the business
 * set `reminder_config.payment_due`. Once per (invoice, due date, lead day).
 */
async function paymentDueReminders(
  now: Date,
  forBusiness: ConfigFor,
  businessIds: string[],
  horizon: Record<OptionalReminderKind, number>,
): Promise<number> {
  if (businessIds.length === 0) return 0;
  const rows = await systemDb
    .select({
      organizationId: invoices.organizationId,
      businessId: invoices.businessId,
      publicId: invoices.publicId,
      dueDate: invoices.dueDate,
      createdAt: invoices.createdAt,
    })
    .from(invoices)
    .innerJoin(customers, eq(customers.id, invoices.customerId))
    .leftJoin(subscriptions, eq(subscriptions.id, invoices.subscriptionId))
    .where(
      and(
        inArray(invoices.businessId, businessIds),
        inArray(invoices.status, ["posted", "payment_due"]),
        gt(invoices.dueDate, now),
        lte(invoices.dueDate, new Date(now.getTime() + horizon.payment_due * DAY_MS)),
        sql`coalesce(${invoices.amountDueMinor}, ${invoices.totalMinor}) > 0`,
        autoCollectionOffSql(),
        scanBusinessFilter(invoices.businessId),
      ),
    );
  let sentCount = 0;
  for (const row of rows) {
    const cfg = forBusiness(row.businessId);
    const lead = dueLeadDay(cfg.optional.payment_due, row.dueDate!, now, {
      changedAt: cfg.changedAt.payment_due,
      knownSince: row.createdAt,
    });
    if (lead == null) continue;
    const type = "invoice_payment_due_reminder" as const;
    const occurrence = { key: OCCURRENCE_KEY[type]!, value: row.dueDate!.toISOString() };
    const sent = await sentLeads(type, row.publicId, occurrence, "invoice");
    if (leadAlreadySent(sent, lead, lead)) continue;
    await emitReminder(row, type, {}, { [occurrence.key]: occurrence.value, lead_days: lead });
    sentCount++;
  }
  return sentCount;
}

/**
 * 6. Before a SCHEDULED pause and a scheduled resume (`scheduled_changes`). Off unless the
 * business set `reminder_config.pause` / `resume`. Keyed on the effective date, so moving
 * the date reminds again and saving the same date does not.
 */
async function pauseResumeReminders(
  now: Date,
  forBusiness: ConfigFor,
  onFor: (k: OptionalReminderKind) => string[],
  horizon: Record<OptionalReminderKind, number>,
): Promise<{ pause: number; resume: number }> {
  const businessIds = [...new Set([...onFor("pause"), ...onFor("resume")])];
  const out = { pause: 0, resume: 0 };
  if (businessIds.length === 0) return out;
  const rows = await systemDb
    .select({
      organizationId: scheduledChanges.organizationId,
      businessId: scheduledChanges.businessId,
      changePublicId: scheduledChanges.publicId,
      type: scheduledChanges.type,
      effectiveAt: scheduledChanges.effectiveAt,
      createdAt: scheduledChanges.createdAt,
      publicId: subscriptions.publicId,
      status: subscriptions.status,
    })
    .from(scheduledChanges)
    .innerJoin(subscriptions, eq(subscriptions.id, scheduledChanges.subscriptionId))
    .where(
      and(
        inArray(scheduledChanges.businessId, businessIds),
        eq(scheduledChanges.status, "scheduled"),
        inArray(scheduledChanges.type, ["pause", "resume"]),
        gt(scheduledChanges.effectiveAt, now),
        lte(
          scheduledChanges.effectiveAt,
          new Date(now.getTime() + Math.max(horizon.pause, horizon.resume) * DAY_MS),
        ),
        ne(subscriptions.status, "cancelled"),
        notDeleted(),
        scanBusinessFilter(scheduledChanges.businessId),
      ),
    );
  for (const row of rows) {
    const kind = row.type as "pause" | "resume";
    // A pause of a paused subscription will not happen (the apply step skips it as moot).
    if (kind === "pause" && row.status === "paused") continue;
    const cfg = forBusiness(row.businessId);
    const lead = dueLeadDay(cfg.optional[kind], row.effectiveAt, now, {
      changedAt: cfg.changedAt[kind],
      knownSince: row.createdAt,
    });
    if (lead == null) continue;
    const type =
      kind === "pause" ? "subscription_pause_reminder" : ("subscription_resume_reminder" as const);
    const occurrence = { key: OCCURRENCE_KEY[type]!, value: row.effectiveAt.toISOString() };
    const sent = await sentLeads(type, row.publicId, occurrence);
    if (leadAlreadySent(sent, lead, lead)) continue;
    await emitReminder(
      row,
      type,
      {},
      {
        [occurrence.key]: occurrence.value,
        lead_days: lead,
        scheduled_change: row.changePublicId,
      },
    );
    out[kind]++;
  }
  return out;
}

/** The account's adapter; null (logged) when it cannot be built, so the pass goes on. */
function adapterOrNull(
  account: typeof gatewayAccounts.$inferSelect,
  errors: TickError[],
): PaymentProvider | null {
  try {
    return resolveAdapter(account);
  } catch (e) {
    errors.push({
      organization: account.organizationId,
      business: account.businessId,
      step: "reminders.pre_debit_adapter",
      message: e instanceof Error ? e.message : String(e),
    });
    log.recurringError(`pre_debit_adapter_unresolved:${account.id}`, e, {
      event: "pre_debit_adapter_unresolved",
      gatewayAccount: account.publicId,
    });
    return null;
  }
}

/**
 * Send the gateway notice for the debit at `debitAt`, for the amount the renewal estimate
 * gives. Once per (instrument, debit date): a notice already on record, in any state, ends
 * it — the collection gate replaces one that no longer fits. No estimate, no notice: the
 * gate then sends one at collection and defers the debit.
 */
async function sendProactiveGatewayNotice(
  row: {
    organizationId: string;
    businessId: string;
    id: string;
    pm: typeof paymentMethods.$inferSelect;
    account: typeof gatewayAccounts.$inferSelect | null;
  },
  adapter: PaymentProvider,
  debitAt: Date,
  skipped: unknown,
  errors: TickError[],
): Promise<boolean> {
  const [seen] = await withTenant(row.organizationId, (tx) =>
    tx
      .select({ id: preDebitNotices.id })
      .from(preDebitNotices)
      .where(
        and(eq(preDebitNotices.paymentMethodId, row.pm.id), eq(preDebitNotices.debitAt, debitAt)),
      )
      .limit(1),
  );
  if (seen) return false;
  // An exact-amount gateway re-notifies at collection when the amount differs, so a low
  // notice never reaches the debit: send the expected amount. Elsewhere the ceiling.
  const exact = adapter.capabilities.preDebitNotice?.exactAmount === true;
  const renewalInput = {
    organizationId: row.organizationId,
    businessId: row.businessId,
    subscriptionId: row.id,
  };
  const est = skipped
    ? null
    : exact
      ? await estimateRenewal(renewalInput)
      : await estimateRenewalCeiling(renewalInput);
  const amount = est ? BigInt(est.amount_due_minor ?? est.total_minor) : null;
  if (!est || !amount || amount <= 0n) return false;
  try {
    const notice = await sendGatewayNotice({
      organizationId: row.organizationId,
      businessId: row.businessId,
      adapter,
      account: row.account,
      pm: row.pm,
      amountMinor: amount,
      currency: est.currency,
      debitAt,
      idempotencyKey: `pdn:${row.pm.publicId}:${debitAt.getTime()}:${amount}:${est.currency}`,
      subscriptionId: row.id,
      contact: await loadChargeContact(row.organizationId, row.pm.customerId),
    });
    return notice.status !== "failed";
  } catch (e) {
    log.recurringError(`pre_debit_gateway_notice_failed:${row.id}`, e, {
      event: "pre_debit_gateway_notice_failed",
      subscriptionId: row.id,
    });
    errors.push({
      organization: row.organizationId,
      business: row.businessId,
      subscription: row.id,
      step: "reminders.pre_debit_gateway_notice",
      message: e instanceof Error ? e.message : String(e),
    });
    return false;
  }
}

/** The newest authorization recorded for a bank account, by its public id. */
async function latestAchAuthorizationId(
  organizationId: string,
  paymentMethodId: string,
): Promise<string | null> {
  const [row] = await withTenant(organizationId, (tx) =>
    tx
      .select({ publicId: paymentMethodAuthorizations.publicId })
      .from(paymentMethodAuthorizations)
      .where(eq(paymentMethodAuthorizations.paymentMethodId, paymentMethodId))
      .orderBy(desc(paymentMethodAuthorizations.acceptedAt))
      .limit(1),
  );
  return row?.publicId ?? null;
}
