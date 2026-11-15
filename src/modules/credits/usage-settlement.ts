/**
 * Settlement of usage paid in credits (0526). The gate took the units from the balance row as
 * each event arrived; here they are drawn from the grants, with the revenue of paid credit:
 * Dr credit_grants_paid / Cr revenue at the cost of the units drawn. One function for the
 * hourly pass, the period invoice and every path that reads what a grant has left.
 *
 * `credit_unit_balances.available_steps` = Σ movement units of the customer's grants in the
 * unit that are not `out_of_balance` − units taken and not settled − what open grace rows
 * hold. `held_steps` = Σ what the open holds reserve; `pinned_steps` = the part of it that
 * closed grants keep in their grace rows. The gate offers available − (held − pinned).
 * `bringUnitBalanceToNow` moves a grant in at its start and out at its expiry, and ends the
 * holds whose time is up.
 *
 * Lock order, for every path: the customer lock (`lockCustomerBalances`), grant rows and hold
 * rows, the balance rows (by unit id), then grace rows and `credit_usage_events` rows.
 */
import { and, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import { scanBusinessFilter, stampNow } from "@/platform/clock";
import { systemDb, withTenant, type Tx } from "@/platform/db";
import { publicId } from "@/platform/ids";
import { createLogger } from "@/platform/logger";
import { lockCustomerBalances } from "@/modules/customers/balances-read";
import { emitEvent } from "@/modules/events/emit";
import { buildEventData } from "@/modules/events/registry";
import { postEntries } from "@/modules/ledger/service";
import { rowsOf } from "@/modules/metering/usage-sql";
import { subscribedEventTypes } from "@/modules/webhooks/subscribed-types";
import {
  CREDIT_LEDGER_ACCOUNTS as A,
  creditGrantGrace,
  creditGrants,
  creditUnitBalances,
  creditUsageEvents,
  creditUsageSettlements,
  invoiceLineItems,
  type BusinessCreditConfig,
} from "@db/schema";
import {
  allocateUnitDraws,
  lateEventGraceMs,
  repayOvershoot,
  unitDrawCost,
  type UnitGrant,
} from "./credit-cost";
import { grantRemaining, recordGrantMovement, type CreditGrant } from "./service";
import { formatSteps } from "./units";
import { groupDigits } from "./grant-limits";

const log = createLogger("credits.usage-settlement");

/** Events one settlement row takes. A longer backlog settles in several rows. */
const BATCH = 10_000;

type Settlement = typeof creditUsageSettlements.$inferSelect;

interface TakeRow {
  id: string;
  meter_id: string;
  meter_key: string;
  part: number;
  received_at: Date;
  quantity: string;
  units: string;
  units_due: string;
  units_uncovered: string;
}

const hourFloor = (d: Date) => new Date(Math.floor(d.getTime() / 3_600_000) * 3_600_000);

/** A numeric as fixed-12. */
function toE12(text: string): bigint {
  const [w, f = ""] = text.split(".");
  return BigInt(w || "0") * 10n ** 12n + BigInt(f.padEnd(12, "0").slice(0, 12) || "0");
}

const e12Text = (v: bigint) => {
  const s = v.toString().padStart(13, "0");
  const frac = s.slice(-12).replace(/0+$/, "");
  return frac ? `${s.slice(0, -12)}.${frac}` : s.slice(0, -12);
};

/** The part of an event's quantity that credits did not pay: quantity × uncovered ÷ due. */
const uncoveredQuantity = (quantity: string, uncovered: bigint, due: bigint): bigint =>
  uncovered <= 0n || due <= 0n ? 0n : (toE12(quantity) * uncovered) / due;

async function lockBalanceRow(tx: Tx, customerId: string, unitId: string) {
  const [row] = await tx
    .select({ id: creditUnitBalances.id })
    .from(creditUnitBalances)
    .where(
      and(eq(creditUnitBalances.customerId, customerId), eq(creditUnitBalances.unitId, unitId)),
    )
    .for("update")
    .limit(1);
  return row ?? null;
}

const moveBalance = (tx: Tx, rowId: string, steps: bigint) =>
  tx
    .update(creditUnitBalances)
    .set({
      availableSteps: sql`${creditUnitBalances.availableSteps} + ${steps}`,
      updatedAt: sql`app_now()`,
    })
    .where(eq(creditUnitBalances.id, rowId));

/** The customer's oldest subscription that is not cancelled: the one a settlement names. */
async function primarySubscriptionId(tx: Tx, customerId: string): Promise<string | null> {
  const [s] = rowsOf<{ id: string }>(
    await tx.execute(sql`
      select id from subscriptions where customer_id = ${customerId} and status <> 'cancelled'
      order by created_at, id limit 1`),
  );
  return s?.id ?? null;
}

/** Write one settlement row with its draws, movements and revenue. */
async function writeSettlement(
  tx: Tx,
  input: {
    grantsById: Map<string, CreditGrant>;
    customerId: string;
    organizationId: string;
    businessId: string;
    unitId: string;
    currency: string;
    meterId: string;
    meterKey: string;
    subscriptionId: string | null;
    kind: "usage" | "late";
    graceGrantId?: string | null;
    windowStart: Date;
    windowEnd: Date;
    takes: TakeRow[];
    draws: Array<{ grantId: string; units: bigint; costMinor: bigint }>;
    decimals: number;
    unitKey: string;
    customerPublicId: string;
    listened: ReadonlySet<string>;
  },
): Promise<Settlement> {
  const [prev] = rowsOf<{ seq: number }>(
    await tx.execute(sql`
      select seq from credit_usage_settlements
      where customer_id = ${input.customerId} and meter_id = ${input.meterId}
      order by seq desc limit 1`),
  );
  let due = 0n;
  let quantity = 0n;
  let quantityUncovered = 0n;
  let events = 0;
  for (const t of input.takes) {
    if (t.part === 0) events++;
    due += BigInt(t.units_due);
    quantity += toE12(t.quantity);
    quantityUncovered += uncoveredQuantity(
      t.quantity,
      BigInt(t.units_uncovered),
      BigInt(t.units_due),
    );
  }
  // A late event's first part carries the whole cost; the units this row draws are its own.
  const taken = input.takes.reduce((s, t) => s + BigInt(t.units), 0n);
  const drawn = input.draws.reduce((s, d) => s + d.units, 0n);
  const revenue = input.draws.reduce((s, d) => s + d.costMinor, 0n);
  const windowStart = input.windowStart;
  const [row] = await tx
    .insert(creditUsageSettlements)
    .values({
      organizationId: input.organizationId,
      businessId: input.businessId,
      publicId: publicId("cst"),
      customerId: input.customerId,
      meterId: input.meterId,
      unitId: input.unitId,
      subscriptionId: input.subscriptionId,
      seq: (prev?.seq ?? 0) + 1,
      kind: input.kind,
      graceGrantId: input.graceGrantId ?? null,
      windowStart,
      windowEnd: input.windowEnd < windowStart ? windowStart : input.windowEnd,
      events,
      quantity: e12Text(quantity),
      // A part of a late event carries units and no cost of its own.
      unitsDue: due > taken ? due : taken,
      unitsDrawn: drawn,
      quantityUncovered: e12Text(quantityUncovered),
      currency: input.currency,
      revenueMinor: revenue,
    })
    .returning();
  const settlement = row!;
  const applied: Array<Record<string, unknown>> = [];
  for (const d of input.draws) {
    const g = input.grantsById.get(d.grantId)!;
    let ledgerTx: string | null = null;
    // Paid credit used: its cost becomes revenue. Given credit has no money and posts nothing.
    if (d.costMinor > 0n) {
      const r = await postEntries(
        {
          organizationId: input.organizationId,
          businessId: input.businessId,
          customerId: input.customerId,
          sourceType: "credit_usage",
          sourceId: settlement.publicId,
          lines: [
            { account: A.paid, direction: "debit", amountMinor: d.costMinor, currency: g.currency },
            {
              account: "revenue",
              direction: "credit",
              amountMinor: d.costMinor,
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
      kind: "draw",
      units: -d.units,
      faceMinor: 0n,
      costMinor: -d.costMinor,
      settlementId: settlement.id,
      ledgerTransactionId: ledgerTx,
    });
    applied.push({
      id: g.publicId,
      phase: "pre_tax",
      category: g.category,
      units: Number(d.units),
      face_minor: 0,
      cost_minor: Number(d.costMinor),
    });
  }
  for (let i = 0; i < input.takes.length; i += 5_000)
    await tx
      .update(creditUsageEvents)
      .set({ status: "settled", settlementId: settlement.id })
      .where(
        inArray(
          creditUsageEvents.id,
          input.takes.slice(i, i + 5_000).map((t) => t.id),
        ),
      );
  if (applied.length)
    await emitEvent(tx, {
      organizationId: input.organizationId,
      businessId: input.businessId,
      type: "credit_grant_applied",
      data: buildEventData("credit_grant_applied", {
        invoice: null,
        settlement: settlement.publicId,
        currency: input.currency,
        amount_minor: 0,
        grants: applied,
      }),
    });
  if (input.listened.has("credit_usage_settled"))
    await emitEvent(tx, {
      organizationId: input.organizationId,
      businessId: input.businessId,
      type: "credit_usage_settled",
      data: buildEventData(
        "credit_usage_settled",
        serializeSettlement(settlement, {
          customer: input.customerPublicId,
          meter: input.meterKey,
          unit: input.unitKey,
          decimals: input.decimals,
        }),
      ),
    });
  if (taken !== drawn)
    log.error(new Error("credit usage settlement drew less than the gate took"), {
      event: "credit_usage_settlement_short",
      settlement: settlement.publicId,
      taken: taken.toString(),
      drawn: drawn.toString(),
    });
  return settlement;
}

export function serializeSettlement(
  s: Settlement,
  refs: { customer: string; meter: string; unit: string; decimals: number },
) {
  return {
    object: "credit_usage" as const,
    id: s.publicId,
    customer: refs.customer,
    meter: refs.meter,
    unit: refs.unit,
    kind: s.kind,
    status: s.status,
    window_start: s.windowStart.toISOString(),
    window_end: s.windowEnd.toISOString(),
    events: s.events,
    quantity: e12Text(toE12(s.quantity)),
    credits_due: formatSteps(s.unitsDue, refs.decimals),
    credits_drawn: formatSteps(s.unitsDrawn, refs.decimals),
    quantity_uncovered: e12Text(toE12(s.quantityUncovered)),
    currency: s.currency,
    revenue_minor: Number(s.revenueMinor),
    created_at: s.createdAt.toISOString(),
  };
}

interface UnitContext {
  organizationId: string;
  businessId: string;
  currency: string;
  unitKey: string;
  decimals: number;
  customerPublicId: string;
  creditConfig: BusinessCreditConfig | null;
}

async function unitContext(tx: Tx, customerId: string, unitId: string): Promise<UnitContext> {
  const [r] = rowsOf<{
    organization_id: string;
    business_id: string;
    currency: string;
    key: string;
    decimals: number;
    public_id: string;
    credit_config: BusinessCreditConfig | null;
  }>(
    await tx.execute(sql`
      select u.organization_id, u.business_id, u.currency, u.key, u.decimals, c.public_id,
        b.credit_config
      from credit_units u
      join customers c on c.id = ${customerId}
      join businesses b on b.id = u.business_id
      where u.id = ${unitId}`),
  );
  return {
    organizationId: r!.organization_id,
    businessId: r!.business_id,
    currency: r!.currency,
    unitKey: r!.key,
    decimals: r!.decimals,
    customerPublicId: r!.public_id,
    creditConfig: r!.credit_config ?? null,
  };
}

/** Term plan grants are closed by the renewal (`settlePlanCycles`), every other grant by the expiry pass. */
const closedByRenewal = (g: Pick<CreditGrant, "source" | "sourceRef">) =>
  g.source === "plan_cycle" && !/:(w|wroll):/.test(g.sourceRef ?? "");

/**
 * The grants a settlement may draw: active, in the balance row, with no open grace row (only
 * late events draw a grant that a grace row holds).
 */
export async function loadDrawGrants(tx: Tx, customerId: string, unitId: string) {
  const grants = await tx
    .select()
    .from(creditGrants)
    .where(
      and(
        eq(creditGrants.customerId, customerId),
        eq(creditGrants.unitId, unitId),
        eq(creditGrants.status, "active"),
        eq(creditGrants.outOfBalance, false),
        sql`not exists (select 1 from credit_grant_grace gg
          where gg.grant_id = ${creditGrants.id} and gg.locked_at is null)`,
      ),
    );
  const left = await grantRemaining(
    tx,
    grants.map((g) => g.id),
  );
  const unitGrants: UnitGrant[] = grants
    .map((g) => ({
      id: g.id,
      category: g.category as "paid" | "promotional",
      source: g.source,
      priority: g.priority,
      effectiveAt: g.effectiveAt,
      expiresAt: g.expiresAt,
      // A term plan grant still in the row pays until its renewal closes it: the gate takes
      // it out at the term end unless it waits for that renewal.
      ...(closedByRenewal(g) ? { paysUntil: null } : {}),
      applicability: g.applicability ?? { kind: "metered" as const },
      amount: g.amount,
      costBasisMinor: g.costBasisMinor,
      remainingUnits: left.get(g.id)!.units,
      remainingCost: left.get(g.id)!.cost,
    }))
    .filter((g) => g.remainingUnits > 0n);
  return { grants, unitGrants };
}

/**
 * How long past the term end a term plan grant still pays while its renewal has not run, on
 * top of the business's usage close wait. The same hour after which the back office pages a
 * late renewal.
 */
export const RENEWAL_WAIT_LIMIT_MS = 60 * 60_000;

/**
 * SQL: grant `g` is a term plan grant whose term ended and whose renewal has not run yet. The
 * subscription is active and still in the grant's term (the renewal moves the period on), and
 * nothing ends or pauses it at that boundary. `bounded`: only inside the wait limit.
 */
const awaitsRenewal = (now: Date, bounded: boolean) => sql`(
  g.source = 'plan_cycle' and g.source_ref not like '%:w:%' and g.source_ref not like '%:wroll:%'
  and exists (
    select 1 from subscription_items si
    join subscriptions s on s.id = si.subscription_id
    join businesses b on b.id = s.business_id
    where si.id = g.subscription_item_id
      and s.status = 'active' and s.deleted_at is null
      and s.current_period_end = g.expires_at
      and not s.cancel_at_period_end
      and (s.cancel_scheduled_at is null or s.cancel_scheduled_at > g.expires_at)
      and (s.remaining_billing_cycles is null or s.remaining_billing_cycles > 0)
      and not exists (
        select 1 from scheduled_changes sc
        where sc.subscription_id = s.id and sc.status = 'scheduled'
          and sc.type in ('cancel', 'pause') and sc.effective_at <= g.expires_at)
      ${
        bounded
          ? sql`and g.expires_at + make_interval(mins => coalesce(b.usage_close_delay_minutes, 0),
              secs => ${RENEWAL_WAIT_LIMIT_MS / 1000}) > ${now.toISOString()}::timestamptz`
          : sql``
      }))`;

/**
 * SQL: grants of the customer and unit that the balance row must take in or let go at `now`.
 * A term plan grant that waits for its renewal stays in the row past its term end.
 */
const dueGrants = (customerId: string, unitId: string, now: Date) => sql`
  g.customer_id = ${customerId} and g.unit_id = ${unitId} and g.status = 'active'
  and not g.unit_rated
  and ((g.out_of_balance and g.effective_at <= ${now.toISOString()}::timestamptz
        and (g.expires_at is null or g.expires_at > ${now.toISOString()}::timestamptz))
    or (not g.out_of_balance and g.expires_at <= ${now.toISOString()}::timestamptz
        and not exists (select 1 from credit_grant_grace gg
          where gg.grant_id = g.id and gg.locked_at is null)
        and not ${awaitsRenewal(now, true)}))`;

/** SQL: open holds of the customer in the unit whose time is up at `now`. */
const lapsedHolds = (customerId: string, unitId: string, now: Date) => sql`
  h.customer_id = ${customerId} and h.unit_id = ${unitId} and h.status = 'held'
  and h.expires_at <= ${now.toISOString()}::timestamptz`;

/**
 * A grant starts or ends at or before `now`, or a hold's time is up, and the balance row does
 * not show it yet.
 */
export async function unitBalanceDue(
  tx: Tx,
  input: { customerId: string; unitId: string; now: Date },
): Promise<boolean> {
  const [row] = rowsOf<{ x: number }>(
    await tx.execute(sql`select 1 as x where exists (
      select 1 from credit_grants g where ${dueGrants(input.customerId, input.unitId, input.now)})
      or exists (
      select 1 from credit_holds h where ${lapsedHolds(input.customerId, input.unitId, input.now)})`),
  );
  return !!row;
}

/**
 * Make the balance row exact at `now`, so a grant pays only while its window contains the
 * instant. A grant that has started comes in. A grant past its expiry goes out: usage is
 * settled first, then the grant is closed as the expiry pass closes it (`closeExpiredGrant`:
 * what is left moves to its grace row, or is booked out). A term plan grant, and a grant whose
 * close fails, is only marked `out_of_balance`; its renewal or the pass closes it later.
 * Caller holds `lockCustomerBalances`.
 */
export async function bringUnitBalanceToNow(
  tx: Tx,
  input: { customerId: string; unitId: string; now: Date },
): Promise<void> {
  // Grant rows, then the balance row.
  const due = rowsOf<{ id: string; out_of_balance: boolean }>(
    await tx.execute(sql`
      select g.id, g.out_of_balance from credit_grants g
      where ${dueGrants(input.customerId, input.unitId, input.now)}
      order by g.id for update of g`),
  );
  // Hold rows, then the balance row: a hold whose time is up gives its units back.
  const { expireLapsedUnitHolds } = await import("./unit-holds");
  await expireLapsedUnitHolds(tx, input);
  const bal = await lockBalanceRow(tx, input.customerId, input.unitId);
  if (!bal || !due.length) return;
  const starting = due.filter((d) => d.out_of_balance).map((d) => d.id);
  if (starting.length) {
    const left = await grantRemaining(tx, starting);
    await tx
      .update(creditGrants)
      .set({ outOfBalance: false })
      .where(inArray(creditGrants.id, starting));
    const units = starting.reduce((s, id) => s + left.get(id)!.units, 0n);
    if (units !== 0n) await moveBalance(tx, bal.id, units);
  }
  const endedIds = due.filter((d) => !d.out_of_balance).map((d) => d.id);
  if (!endedIds.length) return;
  // What an ended grant has left is true only once the usage it paid is drawn.
  await settleCreditUsage(tx, {
    customerId: input.customerId,
    unitId: input.unitId,
    cutoff: null,
    now: input.now,
  });
  const ended = await tx.select().from(creditGrants).where(inArray(creditGrants.id, endedIds));
  const { closeExpiredGrant } = await import("./expiry");
  for (const g of ended.sort((a, b) => (a.id < b.id ? -1 : 1))) {
    if (!closedByRenewal(g))
      try {
        await tx.transaction((sp) => closeExpiredGrant(sp, g, input.now));
      } catch (e) {
        log.error(e, { event: "credit_grant_close_at_gate_failed", grantId: g.id });
      }
    const [after] = rowsOf<{ open: boolean }>(
      await tx.execute(sql`
        select (g.status = 'active' and not g.out_of_balance and not exists (
          select 1 from credit_grant_grace gg where gg.grant_id = g.id)) as open
        from credit_grants g where g.id = ${g.id}`),
    );
    if (!after?.open) continue;
    // A renewal that is this late must not keep paying: stop, and say so.
    if (closedByRenewal(g)) {
      const [late] = rowsOf<{ x: number }>(
        await tx.execute(sql`
          select 1 as x from credit_grants g
          where g.id = ${g.id} and ${awaitsRenewal(input.now, false)}`),
      );
      if (late)
        log.error(new Error("term credit stopped paying: the renewal is overdue"), {
          event: "credit_term_grant_renewal_overdue",
          grantId: g.id,
          customerId: g.customerId,
        });
    }
    const left = (await grantRemaining(tx, [g.id])).get(g.id)!;
    await tx.update(creditGrants).set({ outOfBalance: true }).where(eq(creditGrants.id, g.id));
    if (left.units !== 0n) await moveBalance(tx, bal.id, -left.units);
  }
}

/**
 * What each grant in the balance row would have left once the usage taken so far is drawn.
 * Read only: the same allocation as `settleCreditUsage`, with nothing written.
 */
export async function grantsLeftAfterSettlement(
  tx: Tx,
  input: { customerId: string; unitId: string },
): Promise<Map<string, { units: bigint; cost: bigint }>> {
  const { unitGrants } = await loadDrawGrants(tx, input.customerId, input.unitId);
  const takes = rowsOf<{ meter_id: string; meter_key: string; received_at: Date; units: string }>(
    await tx.execute(sql`
      select c.meter_id, m.key as meter_key, c.received_at, c.units::text as units
      from credit_usage_events c join meters m on m.id = c.meter_id
      where c.customer_id = ${input.customerId} and c.unit_id = ${input.unitId}
        and c.status = 'taken' and c.units > 0`),
  );
  const plan = allocateUnitDraws(
    unitGrants,
    takes.map((t) => ({
      meterId: t.meter_id,
      meterKey: t.meter_key,
      payAt: new Date(t.received_at),
      units: BigInt(t.units),
    })),
  );
  const out = new Map(
    unitGrants.map((g) => [g.id, { units: g.remainingUnits, cost: g.remainingCost }]),
  );
  for (const d of plan.draws) {
    const g = out.get(d.grantId)!;
    g.units -= d.units;
    g.cost -= d.costMinor;
  }
  return out;
}

/**
 * The unit balance at `now`, read only. `beforeHolds`: the row, plus grants that have started
 * and are not in it yet, less what grants past their expiry would have left after settlement,
 * plus what closed grants keep for open holds. `held`: what the open holds whose time is not
 * up still reserve. `unsettled`: taken by events and not drawn from a grant yet.
 * `offered`: what the gate offers, never below 0.
 */
export async function unitBalanceView(
  tx: Tx,
  input: { customerId: string; unitId: string; now: Date },
): Promise<{
  offered: bigint;
  held: bigint;
  unsettled: bigint;
  beforeHolds: bigint;
  openHolds: number;
  /** `offered` before the floor at 0: negative when the balance is below zero (0530). */
  raw: bigint;
}> {
  const [row] = await tx
    .select({
      steps: creditUnitBalances.availableSteps,
      pinned: creditUnitBalances.pinnedSteps,
    })
    .from(creditUnitBalances)
    .where(
      and(
        eq(creditUnitBalances.customerId, input.customerId),
        eq(creditUnitBalances.unitId, input.unitId),
      ),
    )
    .limit(1);
  let steps = row?.steps ?? 0n;
  // The holds are read, not the row's sum: a hold whose time is up no longer counts.
  const [h] = rowsOf<{ held: string; n: number; unsettled: string }>(
    await tx.execute(sql`
      select coalesce(sum(remaining_units), 0)::text as held, count(*)::int as n,
        (select coalesce(sum(c.units), 0) from credit_usage_events c
          where c.customer_id = ${input.customerId} and c.unit_id = ${input.unitId}
            and c.status in ('taken', 'pending'))::text as unsettled
      from credit_holds
      where customer_id = ${input.customerId} and unit_id = ${input.unitId}
        and status = 'held' and expires_at > ${input.now.toISOString()}::timestamptz`),
  );
  const held = BigInt(h?.held ?? "0");
  const due = rowsOf<{ id: string; out_of_balance: boolean }>(
    await tx.execute(sql`
      select g.id, g.out_of_balance from credit_grants g
      where ${dueGrants(input.customerId, input.unitId, input.now)}`),
  );
  let ending = 0n;
  if (due.length) {
    const starting = due.filter((d) => d.out_of_balance).map((d) => d.id);
    const startLeft = await grantRemaining(tx, starting);
    for (const id of starting) steps += startLeft.get(id)!.units;
    const ended = due.filter((d) => !d.out_of_balance).map((d) => d.id);
    if (ended.length) {
      const left = await grantsLeftAfterSettlement(tx, input);
      for (const id of ended) ending += left.get(id)?.units ?? 0n;
    }
  }
  steps -= ending;
  const available = steps > 0n ? steps : 0n;
  // Kept for the open holds by closed grants, and by the grants that end at this instant.
  let pinned = row?.pinned ?? 0n;
  if (pinned > held) pinned = held;
  const short = held - pinned - available;
  if (short > 0n) pinned += short < ending ? short : ending;
  const kept = held - pinned;
  return {
    raw: steps - kept,
    offered: available > kept ? available - kept : 0n,
    held,
    unsettled: BigInt(h?.unsettled ?? "0"),
    beforeHolds: available + pinned,
    openHolds: h?.n ?? 0,
  };
}

/** What the gate offers at `now`, read only (`unitBalanceView`). */
export async function unitBalanceAt(
  tx: Tx,
  input: { customerId: string; unitId: string; now: Date },
): Promise<bigint> {
  return (await unitBalanceView(tx, input)).offered;
}

/**
 * Draw what the gate took from the customer's grants in one unit. `cutoff`: only events
 * received before it; null = every event received so far. Takes the customer lock and the
 * balance row, so no event of this customer and unit is gated while it runs. A second run
 * finds nothing to settle.
 */
export async function settleCreditUsage(
  tx: Tx,
  input: { customerId: string; unitId: string; cutoff: Date | null; now: Date },
): Promise<{ settlements: number; units: bigint; revenueMinor: bigint }> {
  const out = { settlements: 0, units: 0n, revenueMinor: 0n };
  await lockCustomerBalances(tx, input.customerId);
  const bal = await lockBalanceRow(tx, input.customerId, input.unitId);
  let ctx: UnitContext | null = null;
  let subscriptionId: string | null = null;
  let listened: ReadonlySet<string> = new Set();
  for (;;) {
    const takes = rowsOf<TakeRow>(
      await tx.execute(sql`
        select c.id, c.meter_id, m.key as meter_key, c.part, c.received_at,
          c.quantity::text as quantity, c.units::text as units, c.units_due::text as units_due,
          c.units_uncovered::text as units_uncovered
        from credit_usage_events c join meters m on m.id = c.meter_id
        where c.customer_id = ${input.customerId} and c.unit_id = ${input.unitId}
          and c.status = 'taken' and c.source <> 'overdraft'
          ${input.cutoff ? sql`and c.received_at < ${input.cutoff.toISOString()}::timestamptz` : sql``}
        order by c.received_at, c.id
        limit ${BATCH} for update of c`),
    );
    if (!takes.length) break;
    if (!ctx) {
      ctx = await unitContext(tx, input.customerId, input.unitId);
      subscriptionId = await primarySubscriptionId(tx, input.customerId);
      listened = await subscribedEventTypes(tx, ctx.organizationId);
    }
    const { grants, unitGrants } = await loadDrawGrants(tx, input.customerId, input.unitId);
    const plan = allocateUnitDraws(
      unitGrants,
      takes
        .filter((t) => BigInt(t.units) > 0n)
        .map((t) => ({
          meterId: t.meter_id,
          meterKey: t.meter_key,
          payAt: new Date(t.received_at),
          units: BigInt(t.units),
        })),
    );
    // The balance is one number per unit, so a grant scoped to other meters may pay.
    if (plan.fallbackUnits > plan.windowFallbackUnits)
      log.warn("credit usage drawn from a grant that does not cover the meter", {
        event: "credit_usage_settlement_scope_fallback",
        units: (plan.fallbackUnits - plan.windowFallbackUnits).toString(),
      });
    // The gate offers only grants that are live, so this is a defect, or a grant written in
    // the same instant as an event in flight.
    if (plan.windowFallbackUnits > 0n)
      log.error(new Error("credit usage drawn from a grant outside its window"), {
        event: "credit_usage_settlement_fallback",
        customerId: input.customerId,
        units: plan.windowFallbackUnits.toString(),
      });
    const grantsById = new Map(grants.map((g) => [g.id, g]));
    const taken = takes.reduce((s, t) => s + BigInt(t.units), 0n);
    // The draw movements take the units off the row again; the gate already did.
    if (bal && taken > 0n) await moveBalance(tx, bal.id, taken);
    const windowEnd = input.cutoff ?? input.now;
    for (const meterId of [...new Set(takes.map((t) => t.meter_id))].sort()) {
      const mine = takes.filter((t) => t.meter_id === meterId);
      const s = await writeSettlement(tx, {
        grantsById,
        customerId: input.customerId,
        organizationId: ctx.organizationId,
        businessId: ctx.businessId,
        unitId: input.unitId,
        currency: ctx.currency,
        meterId,
        meterKey: mine[0]!.meter_key,
        subscriptionId,
        kind: "usage",
        windowStart: new Date(mine[0]!.received_at),
        windowEnd,
        takes: mine,
        draws: plan.draws.filter((d) => d.meterId === meterId),
        decimals: ctx.decimals,
        unitKey: ctx.unitKey,
        customerPublicId: ctx.customerPublicId,
        listened,
      });
      out.settlements++;
      out.units += s.unitsDrawn;
      out.revenueMinor += s.revenueMinor;
    }
    if (takes.length < BATCH) break;
  }
  await repayOvershootParts(tx, input, bal?.id ?? null, out);
  return out;
}

/**
 * An overshoot below zero is repaid by what the grants have once the usage they covered is
 * drawn: oldest part first, whole or in part. A part that no grant can repay yet stays
 * `taken`, so the balance row stays below zero by it.
 */
async function repayOvershootParts(
  tx: Tx,
  input: { customerId: string; unitId: string; cutoff: Date | null; now: Date },
  balanceRowId: string | null,
  out: { settlements: number; units: bigint; revenueMinor: bigint },
): Promise<void> {
  const owed = rowsOf<TakeRow & { event_id: string }>(
    await tx.execute(sql`
      select c.id, c.event_id, c.meter_id, m.key as meter_key, c.part, c.received_at,
        c.quantity::text as quantity, c.units::text as units, c.units_due::text as units_due,
        c.units_uncovered::text as units_uncovered
      from credit_usage_events c join meters m on m.id = c.meter_id
      where c.customer_id = ${input.customerId} and c.unit_id = ${input.unitId}
        and c.status = 'taken' and c.source = 'overdraft' and c.units > 0
      order by c.received_at, c.id
      limit ${BATCH} for update of c`),
  );
  if (!owed.length) return;
  const { grants, unitGrants } = await loadDrawGrants(tx, input.customerId, input.unitId);
  // Usage the grants covered and that waits for a later cut-off keeps its units.
  const [kept] = rowsOf<{ units: string }>(
    await tx.execute(sql`
      select coalesce(sum(units), 0)::text as units from credit_usage_events
      where customer_id = ${input.customerId} and unit_id = ${input.unitId}
        and status = 'taken' and source <> 'overdraft'`),
  );
  const capacity =
    unitGrants.reduce((s, g) => s + g.remainingUnits, 0n) - BigInt(kept?.units ?? "0");
  const repaid = repayOvershoot(
    owed.map((o) => ({ id: o.id, units: BigInt(o.units) })),
    capacity,
  );
  if (!repaid.length) return;
  const byId = new Map(owed.map((o) => [o.id, o]));
  const takes: TakeRow[] = [];
  for (const r of repaid) {
    const row = byId.get(r.id)!;
    if (r.whole) {
      takes.push(row);
      continue;
    }
    // Repaid in part: the part that is repaid becomes its own row; the rest stays owed.
    await tx
      .update(creditUsageEvents)
      .set({ units: sql`${creditUsageEvents.units} - ${r.units}` })
      .where(eq(creditUsageEvents.id, r.id));
    const [next] = rowsOf<{ part: number }>(
      await tx.execute(sql`
        select max(part) + 1 as part from credit_usage_events
        where event_id = ${row.event_id} and meter_id = ${row.meter_id}`),
    );
    const [made] = rowsOf<{ id: string }>(
      await tx.execute(sql`
        insert into credit_usage_events (organization_id, business_id, customer_id, meter_id,
          unit_id, event_id, event_key, event_timestamp, received_at, part, quantity,
          credits_per_unit, cost_source, units_due, units_uncovered, units, source, status,
          covered_by_hold)
        select organization_id, business_id, customer_id, meter_id, unit_id, event_id, event_key,
          event_timestamp, received_at, ${next!.part}, 0, credits_per_unit, cost_source, 0, 0,
          ${r.units}, 'overdraft', 'taken', covered_by_hold
        from credit_usage_events where id = ${r.id}
        returning id`),
    );
    takes.push({
      ...row,
      id: made!.id,
      part: next!.part,
      quantity: "0",
      units: r.units.toString(),
      units_due: "0",
      units_uncovered: "0",
    });
  }
  const ctx = await unitContext(tx, input.customerId, input.unitId);
  const subscriptionId = await primarySubscriptionId(tx, input.customerId);
  const listened = await subscribedEventTypes(tx, ctx.organizationId);
  // A debt is repaid by the grants that are live now, whenever its event arrived.
  const plan = allocateUnitDraws(
    unitGrants,
    takes.map((t) => ({
      meterId: t.meter_id,
      meterKey: t.meter_key,
      payAt: input.now,
      units: BigInt(t.units),
    })),
  );
  const grantsById = new Map(grants.map((g) => [g.id, g]));
  const taken = takes.reduce((s, t) => s + BigInt(t.units), 0n);
  if (balanceRowId && taken > 0n) await moveBalance(tx, balanceRowId, taken);
  for (const meterId of [...new Set(takes.map((t) => t.meter_id))].sort()) {
    const mine = takes.filter((t) => t.meter_id === meterId);
    const s = await writeSettlement(tx, {
      grantsById,
      customerId: input.customerId,
      organizationId: ctx.organizationId,
      businessId: ctx.businessId,
      unitId: input.unitId,
      currency: ctx.currency,
      meterId,
      meterKey: mine[0]!.meter_key,
      subscriptionId,
      kind: "usage",
      windowStart: new Date(mine[0]!.received_at),
      windowEnd: input.now,
      takes: mine,
      draws: plan.draws.filter((d) => d.meterId === meterId),
      decimals: ctx.decimals,
      unitKey: ctx.unitKey,
      customerPublicId: ctx.customerPublicId,
      listened,
    });
    out.settlements++;
    out.units += s.unitsDrawn;
    out.revenueMinor += s.revenueMinor;
  }
}

/** Settle every unit the customer has unsettled usage in (the period invoice), in the gate's lock order. */
export async function settleCustomerCreditUsage(
  tx: Tx,
  input: { customerId: string; now: Date },
): Promise<void> {
  const units = rowsOf<{ unit_id: string }>(
    await tx.execute(sql`
      select distinct unit_id from credit_usage_events
      where customer_id = ${input.customerId} and status = 'taken'
      order by unit_id`),
  );
  for (const u of units)
    await settleCreditUsage(tx, {
      customerId: input.customerId,
      unitId: u.unit_id,
      cutoff: null,
      now: input.now,
    });
}

/** The unit pays some meter, or has usage that waits: only then does a close keep a grace row. */
async function unitSpendsCredits(tx: Tx, g: Pick<CreditGrant, "customerId" | "unitId">) {
  const [row] = rowsOf<{ x: number }>(
    await tx.execute(sql`
      select 1 as x where exists (
        select 1 from meter_credit_costs where unit_id = ${g.unitId} and active)
      or exists (
        select 1 from credit_usage_events
        where customer_id = ${g.customerId} and unit_id = ${g.unitId}
          and status in ('taken', 'pending'))
      or exists (
        select 1 from credit_grant_grace
        where customer_id = ${g.customerId} and unit_id = ${g.unitId} and locked_at is null)`),
  );
  return !!row;
}

/** The grace window of a closed grant ends: draw its late events, give the rest back to the row. */
async function lockGrace(
  tx: Tx,
  input: { grant: CreditGrant; balanceRowId: string | null; now: Date },
): Promise<void> {
  const g = input.grant;
  const [grace] = await tx
    .select()
    .from(creditGrantGrace)
    .where(and(eq(creditGrantGrace.grantId, g.id), isNull(creditGrantGrace.lockedAt)))
    .for("update")
    .limit(1);
  if (!grace) return;
  const takes = rowsOf<TakeRow>(
    await tx.execute(sql`
      select c.id, c.meter_id, m.key as meter_key, c.part, c.received_at,
        c.quantity::text as quantity, c.units::text as units, c.units_due::text as units_due,
        c.units_uncovered::text as units_uncovered
      from credit_usage_events c join meters m on m.id = c.meter_id
      where c.grace_grant_id = ${g.id} and c.status = 'pending'
      order by c.received_at, c.id for update of c`),
  );
  if (takes.length) {
    const ctx = await unitContext(tx, g.customerId, g.unitId!);
    const subscriptionId = await primarySubscriptionId(tx, g.customerId);
    const listened = await subscribedEventTypes(tx, ctx.organizationId);
    const left = (await grantRemaining(tx, [g.id])).get(g.id)!;
    const state = {
      amount: g.amount,
      costBasisMinor: g.costBasisMinor,
      remainingUnits: left.units,
      remainingCost: left.cost,
    };
    const taken = takes.reduce((s, t) => s + BigInt(t.units), 0n);
    if (input.balanceRowId && taken > 0n) await moveBalance(tx, input.balanceRowId, taken);
    for (const meterId of [...new Set(takes.map((t) => t.meter_id))].sort()) {
      const mine = takes.filter((t) => t.meter_id === meterId);
      let units = mine.reduce((s, t) => s + BigInt(t.units), 0n);
      if (units > state.remainingUnits) units = state.remainingUnits;
      const costMinor = unitDrawCost(state, units);
      state.remainingUnits -= units;
      state.remainingCost -= costMinor;
      await writeSettlement(tx, {
        grantsById: new Map([[g.id, g]]),
        customerId: g.customerId,
        organizationId: ctx.organizationId,
        businessId: ctx.businessId,
        unitId: g.unitId!,
        currency: ctx.currency,
        meterId,
        meterKey: mine[0]!.meter_key,
        subscriptionId,
        kind: "late",
        graceGrantId: g.id,
        windowStart: grace.validFrom,
        windowEnd: grace.validUntil,
        takes: mine,
        draws: units > 0n ? [{ grantId: g.id, units, costMinor }] : [],
        decimals: ctx.decimals,
        unitKey: ctx.unitKey,
        customerPublicId: ctx.customerPublicId,
        listened,
      });
    }
  }
  // What no late event used goes back to the row; the caller books it out of the grant.
  if (input.balanceRowId && grace.availableSteps > 0n)
    await moveBalance(tx, input.balanceRowId, grace.availableSteps);
  // A void closes at once: what the grant kept for open holds is gone with it.
  if (input.balanceRowId && grace.heldSteps > 0n)
    await tx
      .update(creditUnitBalances)
      .set({
        pinnedSteps: sql`greatest(${creditUnitBalances.pinnedSteps} - ${grace.heldSteps}, 0)`,
      })
      .where(eq(creditUnitBalances.id, input.balanceRowId));
  await tx
    .update(creditGrantGrace)
    .set({ availableSteps: 0n, heldSteps: 0n, lockedAt: input.now, updatedAt: sql`app_now()` })
    .where(eq(creditGrantGrace.grantId, g.id));
}

/**
 * Before a grant in a unit with no rate is expired, voided or rolled over: settle the usage
 * the gate took, so what the grant has left is true. Returns true when the caller must leave
 * the grant alone: an expiry waits, because the grant keeps what is left for late events until
 * its grace window ends (the units leave the balance row now; the `settle_credit_usage` pass
 * books them out then), and a grant in that window does not roll over.
 * A unit that pays no meter returns false at once.
 */
export async function beforeOwnUnitGrantChange(
  tx: Tx,
  input: { grant: CreditGrant; kind: "expire" | "void" | "rollover" },
): Promise<boolean> {
  const g = input.grant;
  if (g.unitRated || !g.unitId) return false;
  if (!(await unitSpendsCredits(tx, g))) return false;
  const now = stampNow(g.businessId);
  await settleCreditUsage(tx, { customerId: g.customerId, unitId: g.unitId, cutoff: null, now });
  const bal = await lockBalanceRow(tx, g.customerId, g.unitId);
  const [grace] = await tx
    .select()
    .from(creditGrantGrace)
    .where(eq(creditGrantGrace.grantId, g.id))
    .for("update")
    .limit(1);
  if (grace) {
    if (grace.lockedAt) return false;
    // Closed: what is left waits for late events and does not roll over.
    if (input.kind === "rollover") return true;
    if (input.kind === "expire" && now.getTime() < grace.locksAt.getTime()) return true;
    if (input.kind === "expire" && grace.heldSteps > 0n) {
      // Units kept for open holds: end the holds whose time is up, then look again.
      const { expireLapsedUnitHolds } = await import("./unit-holds");
      await expireLapsedUnitHolds(tx, { customerId: g.customerId, unitId: g.unitId, now });
      const [again] = await tx
        .select({ held: creditGrantGrace.heldSteps })
        .from(creditGrantGrace)
        .where(eq(creditGrantGrace.grantId, g.id))
        .limit(1);
      if ((again?.held ?? 0n) > 0n) {
        // A hold is still open (it was extended): the grant waits for it.
        await tx.execute(sql`
          update credit_grant_grace set locks_at = (
            select max(h.expires_at) from credit_holds h
            where h.customer_id = ${g.customerId} and h.unit_id = ${g.unitId}
              and h.status = 'held')
          where grant_id = ${g.id} and exists (
            select 1 from credit_holds h
            where h.customer_id = ${g.customerId} and h.unit_id = ${g.unitId}
              and h.status = 'held')`);
        return true;
      }
    }
    await lockGrace(tx, { grant: g, balanceRowId: bal?.id ?? null, now });
    return false;
  }
  if (input.kind !== "expire") return false;
  const ctx = await unitContext(tx, g.customerId, g.unitId);
  const graceMs = lateEventGraceMs(ctx.creditConfig);
  const validUntil = g.expiresAt && g.expiresAt.getTime() < now.getTime() ? g.expiresAt : now;
  // No late event to wait for: no window, a grant that never ran, or a window that is over.
  const noWindow =
    graceMs <= 0 ||
    validUntil.getTime() <= g.effectiveAt.getTime() ||
    now.getTime() >= validUntil.getTime() + graceMs;
  const left = (await grantRemaining(tx, [g.id])).get(g.id)!;
  const [mark] = await tx
    .select({ out: creditGrants.outOfBalance })
    .from(creditGrants)
    .where(eq(creditGrants.id, g.id))
    .limit(1);
  // A hold pins its grants: what the open holds need beyond the grants that stay is kept in
  // this grant's grace row until those holds close.
  const pin = bal && !mark?.out ? await pinFor(tx, g, bal.id, left.units) : null;
  if (noWindow && !pin) return false;
  if (left.units <= 0n || !bal) return false;
  const waitsUntil = noWindow ? now : new Date(validUntil.getTime() + graceMs);
  await tx.insert(creditGrantGrace).values({
    grantId: g.id,
    organizationId: g.organizationId,
    businessId: g.businessId,
    customerId: g.customerId,
    unitId: g.unitId,
    availableSteps: left.units,
    heldSteps: pin?.units ?? 0n,
    validFrom: g.effectiveAt,
    // With no window the row covers no late event: it only keeps the pinned units.
    validUntil: noWindow ? g.effectiveAt : validUntil,
    locksAt: pin && pin.until.getTime() > waitsUntil.getTime() ? pin.until : waitsUntil,
  });
  if (pin)
    await tx
      .update(creditUnitBalances)
      .set({ pinnedSteps: sql`${creditUnitBalances.pinnedSteps} + ${pin.units}` })
      .where(eq(creditUnitBalances.id, bal.id));
  // A grant the row does not hold has nothing to take out; from here its grace row stands
  // for it, as for any closed grant.
  if (mark?.out)
    await tx.update(creditGrants).set({ outOfBalance: false }).where(eq(creditGrants.id, g.id));
  else await moveBalance(tx, bal.id, -left.units);
  // Closed early (a plan change): the grant stops at the close for every reader.
  if (!g.expiresAt || g.expiresAt.getTime() > validUntil.getTime())
    await tx.update(creditGrants).set({ expiresAt: validUntil }).where(eq(creditGrants.id, g.id));
  return true;
}

/**
 * What a closing grant must keep for the open holds: the held units that the row cannot back
 * once this grant's `left` units leave it, up to `left`, and until the last open hold ends.
 * Null when it keeps nothing.
 */
async function pinFor(
  tx: Tx,
  g: Pick<CreditGrant, "customerId" | "unitId">,
  balanceRowId: string,
  left: bigint,
): Promise<{ units: bigint; until: Date } | null> {
  if (left <= 0n) return null;
  const [row] = await tx
    .select({
      available: creditUnitBalances.availableSteps,
      held: creditUnitBalances.heldSteps,
      pinned: creditUnitBalances.pinnedSteps,
    })
    .from(creditUnitBalances)
    .where(eq(creditUnitBalances.id, balanceRowId))
    .limit(1);
  if (!row || row.held <= row.pinned) return null;
  const short = row.held - row.pinned - (row.available - left);
  if (short <= 0n) return null;
  const [last] = rowsOf<{ until: Date | null }>(
    await tx.execute(sql`
      select max(expires_at) as until from credit_holds
      where customer_id = ${g.customerId} and unit_id = ${g.unitId} and status = 'held'`),
  );
  if (!last?.until) return null;
  return { units: short < left ? short : left, until: new Date(last.until) };
}

/**
 * The `settle_credit_usage` pass. Each hour: draw the usage received before the top of the
 * hour. Each tick: close the grace window of every grant whose time is up.
 */
export async function runSettleCreditUsage(
  now: Date,
  opts: { limit?: number } = {},
): Promise<{ settled: number; locked: number; failed: number; capped: boolean }> {
  const limit = opts.limit ?? 500;
  const cutoff = hourFloor(now);
  const due = await systemDb
    .selectDistinct({
      organizationId: creditUsageEvents.organizationId,
      customerId: creditUsageEvents.customerId,
      unitId: creditUsageEvents.unitId,
    })
    .from(creditUsageEvents)
    .where(
      and(
        eq(creditUsageEvents.status, "taken"),
        sql`${creditUsageEvents.receivedAt} < ${cutoff.toISOString()}::timestamptz`,
        scanBusinessFilter(creditUsageEvents.businessId),
      ),
    )
    .limit(limit + 1);
  const out = { settled: 0, locked: 0, failed: 0, capped: due.length > limit };
  for (const d of due.slice(0, limit)) {
    try {
      const r = await withTenant(d.organizationId, (tx) =>
        settleCreditUsage(tx, { customerId: d.customerId!, unitId: d.unitId, cutoff, now }),
      );
      out.settled += r.settlements;
    } catch (e) {
      out.failed++;
      log.error(e, { event: "credit_usage_settle_failed", customerId: d.customerId });
    }
  }
  const closing = await systemDb
    .select({
      organizationId: creditGrantGrace.organizationId,
      grantId: creditGrantGrace.grantId,
      customerId: creditGrantGrace.customerId,
    })
    .from(creditGrantGrace)
    .where(
      and(
        isNull(creditGrantGrace.lockedAt),
        lte(creditGrantGrace.locksAt, now),
        scanBusinessFilter(creditGrantGrace.businessId),
      ),
    )
    .orderBy(creditGrantGrace.locksAt)
    .limit(limit + 1);
  if (closing.length > limit) out.capped = true;
  const { bookGrantRemainder } = await import("./service");
  for (const c of closing.slice(0, limit)) {
    try {
      await withTenant(c.organizationId, async (tx) => {
        await lockCustomerBalances(tx, c.customerId);
        const [g] = await tx
          .select()
          .from(creditGrants)
          .where(eq(creditGrants.id, c.grantId))
          .for("update")
          .limit(1);
        if (!g) return;
        if (g.status === "active") await bookGrantRemainder(tx, { grant: g, kind: "expire" });
        // Voided or expired by another path: only the row is left to close.
        else
          await tx
            .update(creditGrantGrace)
            .set({ lockedAt: now, updatedAt: sql`app_now()` })
            .where(and(eq(creditGrantGrace.grantId, g.id), isNull(creditGrantGrace.lockedAt)));
      });
      out.locked++;
    } catch (e) {
      out.failed++;
      log.error(e, { event: "credit_grace_lock_failed", grantId: c.grantId });
    }
  }
  return out;
}

/** Where the next information line of a subscription starts: the end of its last one. */
export async function creditLinesFrom(
  tx: Tx,
  input: { subscriptionId: string; subscriptionStart: Date; excludeInvoiceId?: string },
): Promise<Date> {
  const [last] = rowsOf<{ until: Date | null }>(
    await tx.execute(sql`
      select max(li.period_end) as until from invoice_line_items li
      join invoices i on i.id = li.invoice_id
      where i.subscription_id = ${input.subscriptionId} and i.status <> 'voided'
        ${input.excludeInvoiceId ? sql`and i.id <> ${input.excludeInvoiceId}` : sql``}
        and li.kind = 'credit_usage'`),
  );
  return last?.until && new Date(last.until) > input.subscriptionStart
    ? new Date(last.until)
    : input.subscriptionStart;
}

export interface CoveredCreditUsage {
  meter: string;
  meter_name: string;
  unit: string;
  unit_name: string;
  unit_plural: string;
  decimals: number;
  /** Fixed-12 text: the quantity that credits paid. */
  quantity: string;
  /** Steps of the unit. */
  units: string;
}

/** Per meter, the usage received in `[from, before)` that credits paid (the information line). */
export async function coveredCreditUsage(
  tx: Tx,
  input: { customerId: string; from: Date; before: Date },
): Promise<CoveredCreditUsage[]> {
  return rowsOf<CoveredCreditUsage>(
    await tx.execute(sql`
      with r as (
        select c.meter_id, c.unit_id, c.part, c.units, c.source, c.status,
          first_value(c.quantity) over w as q0, first_value(c.units_due) over w as d0
        from credit_usage_events c
        where c.customer_id = ${input.customerId} and c.status in ('taken', 'pending', 'settled')
          and c.received_at >= ${input.from.toISOString()}::timestamptz
          and c.received_at < ${input.before.toISOString()}::timestamptz
        window w as (partition by c.event_id, c.meter_id order by c.part))
      select m.key as meter, m.name as meter_name, u.key as unit, u.name as unit_name,
        u.plural_name as unit_plural, u.decimals,
        -- The quantity that credits paid: an event's share by the units its parts drew.
        trunc(sum(case when r.d0 > 0 then r.q0 * r.units / r.d0
          when r.part = 0 then r.q0 else 0 end), 12)::text as quantity,
        sum(r.units)::text as units
      from r
      join meters m on m.id = r.meter_id
      join credit_units u on u.id = r.unit_id
      -- An overshoot that no grant repaid yet was not paid with credits.
      where r.source <> 'overdraft' or r.status = 'settled'
      group by m.key, m.name, u.key, u.name, u.plural_name, u.decimals
      having sum(r.units) > 0
      order by m.key`),
  );
}

/**
 * The information lines of a period invoice: per meter, the usage that credits paid since the
 * subscription's last such line, up to the period boundary. Zero amount, kind `credit_usage`.
 * Only on the invoices of the customer's oldest subscription, so usage shows once.
 */
export async function insertCreditUsageLines(
  tx: Tx,
  input: {
    organizationId: string;
    businessId: string;
    customerId: string;
    subscriptionId: string;
    subscriptionStart: Date;
    invoiceId: string;
    periodStart: Date;
  },
): Promise<number> {
  const [any] = rowsOf<{ x: number }>(
    await tx.execute(
      sql`select 1 as x from credit_usage_events where customer_id = ${input.customerId} limit 1`,
    ),
  );
  if (!any) return 0;
  if ((await primarySubscriptionId(tx, input.customerId)) !== input.subscriptionId) return 0;
  const from = await creditLinesFrom(tx, { ...input, excludeInvoiceId: input.invoiceId });
  if (from.getTime() >= input.periodStart.getTime()) return 0;
  const rows = await coveredCreditUsage(tx, {
    customerId: input.customerId,
    from,
    before: input.periodStart,
  });
  if (!rows.length) return 0;
  await tx.insert(invoiceLineItems).values(
    rows.map((r) => {
      const quantity = e12Text(toE12(r.quantity));
      const credits = formatSteps(BigInt(r.units), r.decimals);
      const label = credits === "1" ? r.unit_name : r.unit_plural;
      return {
        organizationId: input.organizationId,
        businessId: input.businessId,
        invoiceId: input.invoiceId,
        publicId: publicId("il"),
        // In-app text (ASD-STE100).
        description: `${r.meter_name}: ${groupDigits(quantity)}. Paid with ${groupDigits(credits)} ${label}.`,
        priceId: null,
        quantity: Math.min(2_147_483_647, Math.round(Number(quantity))),
        unitAmountMinor: 0n,
        amountMinor: 0n,
        kind: "credit_usage",
        periodStart: from,
        periodEnd: input.periodStart,
        quantityDecimal: quantity,
        rating: { credit_usage: { meter: r.meter, unit: r.unit, credit_units: credits, quantity } },
      };
    }),
  );
  return rows.length;
}

/** A customer's settlements, newest first. */
export async function listCreditUsage(input: {
  organizationId: string;
  businessId: string;
  customerId: string;
  customerPublicId: string;
  limit: number;
  startingAfter?: string;
  meterKey?: string;
}): Promise<{ data: Array<ReturnType<typeof serializeSettlement>>; hasMore: boolean }> {
  return withTenant(input.organizationId, async (tx) => {
    const rows = rowsOf<
      Record<string, unknown> & {
        meter_key: string;
        unit_key: string;
        decimals: number;
        sid: string;
      }
    >(
      await tx.execute(sql`
        select s.id as sid, m.key as meter_key, u.key as unit_key, u.decimals
        from credit_usage_settlements s
        join meters m on m.id = s.meter_id
        join credit_units u on u.id = s.unit_id
        where s.business_id = ${input.businessId} and s.customer_id = ${input.customerId}
          ${input.meterKey ? sql`and m.key = ${input.meterKey}` : sql``}
          ${
            input.startingAfter
              ? sql`and s.id < (select id from credit_usage_settlements
                  where public_id = ${input.startingAfter} and business_id = ${input.businessId})`
              : sql``
          }
        order by s.id desc limit ${input.limit + 1}`),
    );
    const page = rows.slice(0, input.limit);
    const full = page.length
      ? await tx
          .select()
          .from(creditUsageSettlements)
          .where(
            inArray(
              creditUsageSettlements.id,
              page.map((r) => r.sid),
            ),
          )
      : [];
    const byId = new Map(full.map((s) => [s.id, s]));
    return {
      data: page.map((r) =>
        serializeSettlement(byId.get(r.sid)!, {
          customer: input.customerPublicId,
          meter: r.meter_key,
          unit: r.unit_key,
          decimals: r.decimals,
        }),
      ),
      hasMore: rows.length > input.limit,
    };
  });
}
