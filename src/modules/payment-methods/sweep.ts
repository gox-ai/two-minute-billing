/**
 * Payment-source expiry sweep (C6 / GW-5). A daily clock pass that flags cards
 * lapsing this month as `expiring` and already-lapsed cards as `expired`, emitting
 * `payment_source.expiring` / `payment_source.expired` once per transition.
 *
 * Since F-45 it reads TWO expiry facts, not one — the card's printed expiry and the
 * MANDATE's end date (see {@link decidePaymentSourceExpiry}).
 *
 * Cross-tenant scan on the base connection (like the billing clock), then
 * re-enters `withTenant` per changed row so the event is emitted under RLS.
 *
 * A business whose `reminder_config.card_expiring` is a list of lead days gets
 * `payment_source_expiry_reminder` on each of them instead (see `cardExpiryReminders`); its
 * `payment_source_expiring` transition still fires, once, without the email.
 */
import { and, eq, inArray, isNotNull, lte, or, sql } from "drizzle-orm";
import { systemDb, withTenant } from "@/platform/db";
import { emitEvent } from "@/modules/events/emit";
import { buildEventData } from "@/modules/events/registry";
import { businesses, customers, events, paymentMethods } from "@db/schema";
import {
  dueLeadDay,
  leadAlreadySent,
  resolveReminderConfig,
  type ReminderConfig,
} from "@/modules/subscriptions/reminder-config";
import { scanBusinessFilter } from "@/platform/clock";
import { createLogger } from "@/platform/logger";
// From the LEAF module directly, the same way `invoicing/collection.ts` reaches it:
// `payment-methods/service` re-exports it but imports `events/emit`, and the expiry
// predicate is pure.
import { mandateHasExpired } from "./mandate-afa";

const log = createLogger("payment-methods.sweep");

/** The lifecycle statuses this sweep can compute. `payment_methods.status` has more. */
export type SweptStatus = "valid" | "expiring" | "expired";

/** Which stored fact decided the status — a card's printed expiry, or its mandate's end date. */
export type ExpirySource = "card" | "mandate";

export interface ExpiryDecision {
  next: SweptStatus;
  /** Null exactly when `next` is `valid`. */
  reason: ExpirySource | null;
  /**
   * Whether this transition should MAIL the payer.
   *
   * ⚠️ Does NOT gate the event any more. Every real transition emits `payment_source_
   * expired`/`_expiring` unconditionally — a webhook subscriber must hear about a
   * demotion even when the customer should not be mailed about it yet — so `notify:
   * false` instead stamps `suppress_email: true` on the envelope, which
   * `emails/outbox.ts` reads and skips only the mail. See
   * {@link MANDATE_EXPIRY_NOTICE_FROM}.
   */
  notify: boolean;
}

/**
 * ── The mandate-expiry MAIL cutover (F-45) ────────────────────────────────────
 *
 * A mandate that lapsed before this instant is DEMOTED without MAILING the payer: the
 * instrument stops being selected for collection, and no customer email goes out about
 * it. The transition still EMITS its event — a webhook subscriber is told regardless,
 * because the demotion itself is exactly the kind of state change a subscriber needs to
 * hear about, even on the one cohort a human piece of mail about it would be unwelcome
 * noise for. See `suppress_email` on the emitted envelope, and
 * `src/modules/emails/outbox.ts::enqueueEmails`.
 *
 * ── Why a fixed instant, and not a column ─────────────────────────────────────
 * Measured 2026-09-01 over the dev database: **115 of 137 RazorPay card mandates were
 * already past their stored `mandate_expires_at` while still reporting
 * `mandate_status: confirmed`** (see `mandate-afa.ts` § `mandateHasExpired` for the full
 * measurement). Nothing has ever read that column in the sweep, so those 115 are a
 * BACKLOG, not news: if production resembles the dev data, teaching the sweep to read
 * mandate expiry without a cutover mails a large batch in one tick, about a state those
 * customers have been in for weeks, from a template that then tells them to fix
 * something they cannot have caused. The demotion is worth doing; the mail is not.
 *
 * Three mechanisms were considered. This one needs no schema change, and that is a
 * consequence of it being the honest question rather than a way around a migration:
 *
 *  1. **A fixed cutover instant (this).** "Was this mandate already over before the
 *     engine started looking?" is answerable from data we ALREADY store — the expiry
 *     instant itself — compared against the date the check shipped. No new fact is
 *     needed, so no column is.
 *  2. **A `mandate_expiry_first_seen_at` column.** Rejected: it would record when OUR
 *     SWEEP happened to run, which is a fact about our deployment schedule, not about
 *     the mandate. A restored snapshot, a fresh environment or a clock that was down for
 *     a week would each stamp a different date for the identical mandate, and the mail
 *     the payer receives would follow our ops history instead of their bank's.
 *  3. **A one-time "mark the existing ones as already notified" pass.** Rejected for the
 *     same reason plus an unenforceable ordering constraint: it is only correct if it
 *     runs exactly once, and BEFORE the first sweep tick. Nothing can guarantee that
 *     across environments, and getting it wrong is silent in one direction (a batch of
 *     mail) and permanent in the other.
 *
 * ── It must be an instant AFTER the last backlog expiry and AT OR BEFORE the deploy ──
 * `2026-09-01T00:00:00Z` clears the measured cluster at `2026-08-31T18:29:59Z`
 * (end-of-day IST) and precedes the deploy. The 2 rows at `2026-09-30T18:29:59Z` and the
 * 20 at `2030-12-31T18:29:59Z` are AFTER it and will mail normally when they lapse,
 * which is the point: this suppresses a backlog, not a feature.
 *
 * ── It decays to inert ────────────────────────────────────────────────────────
 * Every mandate registered from here on carries an end date after this instant, so the
 * branch stops firing on its own once the pre-cutover rows are gone. It is a one-time
 * cutover that reads like one, rather than a permanent policy.
 *
 * ⚠️ Never move this forward to silence a NEW batch of expiries. A batch of newly-lapsed
 * mandates is customers who need to hear from us; the cutover exists for the single
 * cohort that lapsed while nothing was watching.
 */
export const MANDATE_EXPIRY_NOTICE_FROM = new Date("2026-09-01T00:00:00.000Z");

/**
 * What one instrument's status should be, and whether the transition is worth a word to
 * the payer. Pure, so both facts are testable without a database
 * (`test/unit/mandate.test.ts`).
 *
 * ── The printed card expiry is checked FIRST, and that ordering is load-bearing ──
 * A card can be past BOTH its printed expiry and its mandate's end date. Reading the
 * mandate first would route such a row through the cutover and suppress a mail we send
 * TODAY — a regression dressed as a feature. Printed expiry decides first, so every row
 * whose answer the pre-F-45 sweep could reach behaves exactly as it did before, bit for
 * bit, and the mandate branch only ever ADDS rows the sweep previously ignored.
 *
 * ── Why the mandate's end date belongs in this sweep at all ───────────────────
 * `invoicing/collection.ts::mandateExpiredRefusal` already refuses the DEBIT, so the
 * money is correct without this. What was not correct is the instrument: a lapsed mandate
 * still read `status: 'valid'`, so `pickPrimaryCandidate` preferred it over a live
 * sibling ("usable" there means `status === 'valid'`), the operator's list and the buyer
 * portal both showed it as fine, and `assertChargeableForAutoCollect` would let a new
 * auto-collect subscription be created against it. Demoting it is what makes the fact we
 * already hold visible to the surfaces that select and display instruments.
 *
 * ── No mandate-status check, deliberately ─────────────────────────────────────
 * Not gated on `mandate_status` being live: the whole defect is that RazorPay reports
 * `confirmed` for mandates whose own end date has gone by, so requiring agreement between
 * the two would reproduce the bug. Expiry is a separate axis from chargeability — the
 * reason `mandateHasExpired` is a separate predicate.
 *
 * ── No `capabilities.mandates` check either, and why that is safe here ────────
 * The charge-path refusals skip when an adapter declares no mandate model, because they
 * run per charge with an adapter already resolved. This runs cross-tenant over every
 * business, where resolving an adapter per row would be one gateway lookup per instrument
 * on the one pass that already scans everything. It is safe without the check because
 * `mandate_expires_at` is only ever WRITTEN from a `ProviderMandate` the gateway itself
 * reported (`webhooks/inbound.ts`, `payment-methods/service.ts`) — a non-null value IS a
 * gateway that has a mandate model, so the guard could never fire.
 */
export function decidePaymentSourceExpiry(
  pm: { expMonth: number | null; expYear: number | null; mandateExpiresAt: Date | null },
  now: Date,
  noticeFrom: Date = MANDATE_EXPIRY_NOTICE_FROM,
): ExpiryDecision {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth() + 1;
  const ey = pm.expYear;
  const em = pm.expMonth;
  const hasPrinted = ey != null && em != null;
  const printedExpired = hasPrinted && (ey! < y || (ey! === y && em! < m));
  const printedExpiring = hasPrinted && ey! === y && em! === m;

  if (printedExpired) return { next: "expired", reason: "card", notify: true };
  if (mandateHasExpired(pm, now)) {
    return {
      next: "expired",
      reason: "mandate",
      // The one suppression. `!` rather than `>=` so an expiry exactly AT the cutover
      // instant is treated as backlog — the cutover is "everything up to here is old".
      notify: !(pm.mandateExpiresAt!.getTime() <= noticeFrom.getTime()),
    };
  }
  if (printedExpiring) return { next: "expiring", reason: "card", notify: true };
  return { next: "valid", reason: null, notify: false };
}

/** Transitions per tick; a larger backlog drains over the following ticks. */
const SWEEP_BATCH = 1000;

export async function paymentSourceSweep(
  now: Date,
): Promise<{ expiring: number; expired: number; silenced: number; reminded: number }> {
  const leadMode = await loadCardLeadBusinesses();
  // `decidePaymentSourceExpiry` moved into SQL: only live rows that WILL transition this
  // tick — a printed expiry before this month, a lapsed mandate, or a `valid` card in its
  // expiry month. Each row fetched leaves the set once handled, so the batch cap only spreads
  // a backlog over ticks. Fetching every live card put the whole table in memory each minute
  // and crashed the worker at a million cards.
  //
  // Joined to `customers` for the PUBLIC id the event must carry; a per-row lookup would be
  // one query per transitioning card on a cross-tenant pass.
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth() + 1;
  const candidates = await systemDb
    .select({ pm: paymentMethods, customerPublicId: customers.publicId })
    .from(paymentMethods)
    .innerJoin(customers, eq(customers.id, paymentMethods.customerId))
    .where(
      and(
        inArray(paymentMethods.status, ["valid", "expiring"]),
        or(
          and(
            isNotNull(paymentMethods.expMonth),
            sql`(${paymentMethods.expYear}, ${paymentMethods.expMonth}) < (${y}, ${m})`,
          ),
          lte(paymentMethods.mandateExpiresAt, now),
          and(
            eq(paymentMethods.status, "valid"),
            eq(paymentMethods.expYear, y),
            eq(paymentMethods.expMonth, m),
          ),
        ),
        scanBusinessFilter(paymentMethods.businessId),
      ),
    )
    .limit(SWEEP_BATCH);

  let expiring = 0;
  let expired = 0;
  let silenced = 0;
  for (const { pm, customerPublicId } of candidates) {
    const { next, reason, notify } = decidePaymentSourceExpiry(pm, now);
    if (next === "valid" || next === pm.status) continue; // no transition
    // Lead-day businesses mail from `cardExpiryReminders`; the status change stays silent.
    const mail = notify && !(next === "expiring" && leadMode.has(pm.businessId));
    // ── Idempotency is the TRANSITION, not the cutover ────────────────────────
    // The demotion writes `expired`, and `expired` is not in the status filter above, so
    // a lapsed mandate is picked up exactly once however often the clock ticks. The
    // cutover only decides whether that ONE transition also mails the payer — it is not
    // itself a "have we told anyone?" record, and does not need to be: the event below
    // fires either way.
    await withTenant(pm.organizationId, async (tx) => {
      await tx.update(paymentMethods).set({ status: next }).where(eq(paymentMethods.id, pm.id));
      await emitEvent(tx, {
        organizationId: pm.organizationId,
        businessId: pm.businessId,
        type: next === "expired" ? "payment_source_expired" : "payment_source_expiring",
        // Same resource shape `payment_source_added` emits — `customer`, `type` and
        // `brand` alongside the expiry fields — and the parity is load-bearing, not
        // tidiness. These three events are the payment-source family a subscriber sees,
        // and this one used to name only the card: no customer, so a consumer could not
        // tell WHOSE card lapsed, and no type/brand, so it could not say "Visa ending
        // 4242" in the mail it sends about it. A webhook adapter that resolves the
        // account from the customer dropped every one of these for want of it, which
        // is how a card-expiry sweep ran for weeks while no customer heard about it.
        data: buildEventData(
          next === "expired" ? "payment_source_expired" : "payment_source_expiring",
          {
            id: pm.publicId,
            customer: customerPublicId,
            type: pm.type,
            brand: pm.brand,
            last4: pm.last4,
            exp_month: pm.expMonth,
            exp_year: pm.expYear,
          },
          undefined,
          // TOP-LEVEL, not inside the resource, because `events/content.ts` REPLACES
          // `data.payment_source` wholesale with a fresh snapshot when the loader
          // succeeds — anything added to the resource payload is dropped, and a field a
          // consumer sees only sometimes is worse than one they never see.
          //
          // `expiry_reason` is what `emails/outbox.ts::emailTypeForEvent` routes on — a
          // "mandate" reason now gets the rail-neutral `mandate_expired` template instead
          // of `card_expired`, which would say "your card ending 4242 has expired" and
          // print the PRINTED expiry beside it, self-contradicting a 01/2099 card whose
          // MANDATE lapsed. `suppress_email` is the other half: present and `true` only
          // for the pre-cutover backlog, so a subscriber still hears about every real
          // transition while the customer is mailed about only the ones worth mailing.
          { expiry_reason: reason, ...(mail ? {} : { suppress_email: true }) },
        ),
      });
    });
    if (next === "expired") {
      expired++;
      if (!notify) silenced++;
    } else expiring++;
  }
  // The clock tick's own summary reports `{expiring, expired}` (`platform/jobs.ts`), so an
  // unmailed demotion would otherwise be invisible in it — the event still fires (a
  // webhook subscriber hears about it), but nothing mails the customer, and that fact was
  // folded into a count that also holds the ones that do. This is the one line that says
  // a customer's instrument was taken out of selection without THEM being told, even
  // though something else was.
  if (silenced > 0)
    log.info("demoted pre-cutover mandate expiries without mailing the payer", {
      silenced,
      expired,
      expiring,
    });
  const reminded = await cardExpiryReminders(now, leadMode);
  return { expiring, expired, silenced, reminded };
}

const DAY_MS = 86_400_000;

/** The first instant after a card's printed expiry month (UTC): when it stops working. */
export function cardExpiresAt(expYear: number, expMonth: number): Date {
  return new Date(Date.UTC(expYear, expMonth, 1));
}

/** Businesses whose card notice is lead days, not the expiry month. Default is the month. */
async function loadCardLeadBusinesses(): Promise<Map<string, ReminderConfig>> {
  const rows = await systemDb
    .select({ id: businesses.id, reminderConfig: businesses.reminderConfig })
    .from(businesses)
    .where(
      and(
        sql`jsonb_typeof(${businesses.reminderConfig} -> 'card_expiring') = 'array'`,
        scanBusinessFilter(businesses.id),
      ),
    );
  const out = new Map<string, ReminderConfig>();
  for (const r of rows) {
    const cfg = resolveReminderConfig(r);
    if (Array.isArray(cfg.cardExpiring)) out.set(r.id, cfg);
  }
  return out;
}

/**
 * `payment_source_expiry_reminder` on each lead day before a card's printed expiry, for the
 * businesses in `leadMode`. Deduped on the events log: one per (card, expiry, lead day), and
 * only the smallest lead day reached is due (`dueLeadDay`). Maps to the `card_expiring` email.
 */
async function cardExpiryReminders(
  now: Date,
  leadMode: Map<string, ReminderConfig>,
): Promise<number> {
  if (leadMode.size === 0) return 0;
  const maxLead = Math.max(...[...leadMode.values()].flatMap((c) => c.cardExpiring as number[]));
  const h = new Date(now.getTime() + maxLead * DAY_MS);
  // From this month to the horizon's month; `dueLeadDay` narrows each row.
  const from = [now.getUTCFullYear(), now.getUTCMonth() + 1];
  const to = [h.getUTCFullYear(), h.getUTCMonth() + 1];
  const rows = await systemDb
    .select({ pm: paymentMethods, customerPublicId: customers.publicId })
    .from(paymentMethods)
    .innerJoin(customers, eq(customers.id, paymentMethods.customerId))
    .where(
      and(
        inArray(paymentMethods.businessId, [...leadMode.keys()]),
        inArray(paymentMethods.status, ["valid", "expiring"]),
        isNotNull(paymentMethods.expMonth),
        isNotNull(paymentMethods.expYear),
        sql`(${paymentMethods.expYear}, ${paymentMethods.expMonth}) >= (${from[0]}, ${from[1]})`,
        sql`(${paymentMethods.expYear}, ${paymentMethods.expMonth}) <= (${to[0]}, ${to[1]})`,
        scanBusinessFilter(paymentMethods.businessId),
      ),
    );
  let reminded = 0;
  for (const { pm, customerPublicId } of rows) {
    const cfg = leadMode.get(pm.businessId)!;
    const target = cardExpiresAt(pm.expYear!, pm.expMonth!);
    const lead = dueLeadDay(cfg.cardExpiring as number[], target, now, {
      changedAt: cfg.changedAt.card_expiring,
      knownSince: pm.createdAt,
    });
    if (lead == null) continue;
    const expiresAt = target.toISOString();
    const sent = await systemDb
      .select({ lead: sql<string | null>`${events.data} ->> 'lead_days'` })
      .from(events)
      .where(
        and(
          eq(events.type, "payment_source_expiry_reminder"),
          eq(events.resourceType, "payment_source"),
          eq(events.resourceId, pm.publicId),
          sql`${events.data} ->> 'expires_at' = ${expiresAt}`,
        ),
      );
    if (
      leadAlreadySent(
        sent.map((r) => (r.lead == null ? null : Number(r.lead))),
        lead,
        lead,
      )
    )
      continue;
    await withTenant(pm.organizationId, (tx) =>
      emitEvent(tx, {
        organizationId: pm.organizationId,
        businessId: pm.businessId,
        type: "payment_source_expiry_reminder",
        data: buildEventData(
          "payment_source_expiry_reminder",
          {
            id: pm.publicId,
            customer: customerPublicId,
            type: pm.type,
            brand: pm.brand,
            last4: pm.last4,
            exp_month: pm.expMonth,
            exp_year: pm.expYear,
          },
          undefined,
          // Top level: `events/content.ts` replaces the resource with a snapshot.
          { expires_at: expiresAt, lead_days: lead },
        ),
      }),
    );
    reminded++;
  }
  return reminded;
}
