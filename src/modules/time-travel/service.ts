import { and, eq, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { systemDb, withTenant } from "@/platform/db";
import { runWithClockScope } from "@/platform/clock";
import { timeTravels, businesses, subscriptions } from "@db/schema";
import { createLogger } from "@/platform/logger";

const log = createLogger("time-travel");

/**
 * H4 (TL-4) — Time Travel orchestrator (TEST businesses only).
 *
 * Time Travel pins a business's clock at a simulated instant. `travelForward`
 * advances that instant in tick-sized (default daily) steps and drives the REAL
 * billing pipeline (`runBillingClockTickOnce`) at each step as-of the simulated
 * instant — inside a clock scope that (a) restricts every pass scan to this one
 * business and (b) makes `businessNow(businessId)` return the simulated instant.
 * Because every pass is idempotent and threshold-based (`… <= now`), re-driving a
 * tick at an already-processed instant produces zero new rows (the determinism
 * guarantee the capstone asserts).
 *
 * A real billing_clock_tick EXCLUDES time-travelled businesses (see
 * `timeTravelledBusinessIds` + the task wrapper in jobs.ts), so wall time never
 * touches a business that travel drives.
 */
export class TimeTravelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeTravelError";
  }
}

/** Business UUIDs with an active simulated clock — excluded from real ticks. Cross-tenant (admin). */
export async function timeTravelledBusinessIds(): Promise<string[]> {
  const rows = await systemDb
    .select({ businessId: timeTravels.businessId })
    .from(timeTravels)
    .where(isNotNull(timeTravels.simulatedNow));
  return rows.map((r) => r.businessId);
}

export async function getTimeTravel(orgId: string, bizId: string) {
  return withTenant(orgId, async (tx) => {
    const [row] = await tx
      .select()
      .from(timeTravels)
      .where(eq(timeTravels.businessId, bizId))
      .limit(1);
    return row ?? null;
  });
}

/** Assert a business is test-mode; throws otherwise (routes also gate, this is defense-in-depth). */
async function assertTestBusiness(orgId: string, bizId: string): Promise<void> {
  const [biz] = await withTenant(orgId, (tx) =>
    tx
      .select({ livemode: businesses.livemode })
      .from(businesses)
      .where(eq(businesses.id, bizId))
      .limit(1),
  );
  if (!biz) throw new TimeTravelError("business not found");
  if (biz.livemode !== "test")
    throw new TimeTravelError("Time Travel is only available on test businesses");
}

/**
 * start_afresh: enable Time Travel and pin the clock at `genesisTime`. Does NOT
 * wipe (a fresh test business is empty; wipe happens on stop). Idempotent per
 * business (one row; unique index).
 */
export async function startTimeTravel(input: {
  orgId: string;
  bizId: string;
  genesisTime: Date;
}): Promise<typeof timeTravels.$inferSelect> {
  await assertTestBusiness(input.orgId, input.bizId);
  // Every subsequent line for this business is dated from a fabricated clock. A log
  // reader who doesn't know that will misread everything that follows.
  log.info("time travel started — this business now runs on a simulated clock", {
    businessId: input.bizId,
    genesisTime: input.genesisTime.toISOString(),
  });
  return withTenant(input.orgId, async (tx) => {
    const [existing] = await tx
      .select()
      .from(timeTravels)
      .where(eq(timeTravels.businessId, input.bizId))
      .limit(1);
    if (existing) {
      const [row] = await tx
        .update(timeTravels)
        .set({
          status: "in_progress",
          genesisTime: input.genesisTime,
          simulatedNow: input.genesisTime,
          error: null,
          updatedAt: new Date(),
        })
        .where(eq(timeTravels.id, existing.id))
        .returning();
      return row!;
    }
    const [row] = await tx
      .insert(timeTravels)
      .values({
        organizationId: input.orgId,
        businessId: input.bizId,
        status: "in_progress",
        genesisTime: input.genesisTime,
        simulatedNow: input.genesisTime,
      })
      .returning();
    return row!;
  });
}

const DAY_MS = 86_400_000;
/** Re-drives of one instant before a travel gives up (a capped renewal pass is ~25 renewals). */
const MAX_ROUNDS_PER_STEP = 20;

/**
 * travel_forward: advance the simulated clock to `toTime` in `stepDays`-sized steps,
 * driving a full billing tick at each step boundary (same pass order as a real
 * tick). Forward-only. Traveling to the CURRENT instant re-drives one tick (the
 * idempotency no-op check). Steps must be ≤ the shortest billing interval so each
 * tick catches at most one renewal per subscription (default 1 day is safe for
 * day+ intervals).
 */

/** Shortest billing interval (days, floor) across the business's active subs — the
 *  hard cap for travel step_days (a longer step skips renewals). Null = no subs. */
async function shortestIntervalDays(orgId: string, bizId: string): Promise<number | null> {
  const rows = await withTenant(orgId, (tx) =>
    tx
      .select({ unit: subscriptions.billingPeriodUnit, count: subscriptions.billingPeriod })
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.businessId, bizId),
          inArray(subscriptions.status, ["future", "in_trial", "active", "paused"]),
        ),
      ),
  );
  if (rows.length === 0) return null;
  const days = (unit: string | null, count: number | null): number => {
    const c = count ?? 1;
    switch (unit ?? "month") {
      case "day":
        return c;
      case "week":
        return 7 * c;
      case "year":
        return 365 * c;
      default:
        return 28 * c; // month: shortest month wins
    }
  };
  return Math.min(...rows.map((r) => days(r.unit, r.count)));
}

export async function travelForward(input: {
  orgId: string;
  bizId: string;
  toTime: Date;
  stepDays?: number;
}): Promise<{ steps: number; from: Date; to: Date }> {
  await assertTestBusiness(input.orgId, input.bizId);
  const tm = await getTimeTravel(input.orgId, input.bizId);
  if (!tm || tm.simulatedNow == null)
    throw new TimeTravelError("Time Travel is not started for this business");
  // VALIDATE BEFORE LEASING. These two refusals used to run AFTER the CAS claim
  // below, and only the success path cleared it — so a rejected travel (backwards,
  // or an oversized step) left the lease held and wedged the business for the full
  // 15 minutes, with every later travel refused "already in progress". A caller who
  // sends one bad request and then a good one is the ordinary case, not an exotic
  // one; it forced verify:time-travel to order its cases around the bug. Same shape
  // as the stranded graphile queue locks: a lock taken by a path that cannot release
  // it. Nothing here needs the lease — they read inputs and this business's catalog.
  const from = tm.simulatedNow;
  const to = input.toTime;
  if (to.getTime() < from.getTime())
    throw new TimeTravelError(
      "Time Travel moves only forward. to must be the current simulated time or later.",
    );
  // Step bound (finale review): each tick must catch at most ONE renewal per
  // subscription, so the step may never exceed the business's shortest billing
  // interval — a 90-day step over monthly subs produces 1 invoice where 3 are owed.
  const requestedStep = Math.max(1, Math.floor(input.stepDays ?? 1));
  const shortest = await shortestIntervalDays(input.orgId, input.bizId);
  if (shortest != null && requestedStep > shortest) {
    throw new TimeTravelError(
      `step_days ${requestedStep} is more than the shortest billing interval of the business (~${shortest} days). The travel would skip renewals.`,
    );
  }

  // SERIALIZE (finale review): two concurrent travels (or a retry racing the
  // first) would interleave ticks at different simulated instants against the
  // same business — renewal has no per-period claim against a DIFFERENT `now`.
  // Leased CAS claim on the machine row; a second call fails fast, and a crashed
  // travel self-expires after 15 minutes instead of wedging the machine.
  const leased = await withTenant(input.orgId, async (tx) => {
    const rows = await tx
      .update(timeTravels)
      .set({ travelLeaseUntil: new Date(Date.now() + 15 * 60_000) })
      .where(
        and(
          eq(timeTravels.id, tm.id),
          or(isNull(timeTravels.travelLeaseUntil), lt(timeTravels.travelLeaseUntil, new Date())),
        ),
      )
      .returning({ id: timeTravels.id });
    return rows.length > 0;
  });
  if (!leased) throw new TimeTravelError("A travel is already in progress for this business");
  log.log("time travel starting", {
    businessId: input.bizId,
    from: tm.simulatedNow.toISOString(),
    to: input.toTime.toISOString(),
    stepDays: input.stepDays,
  });
  const stepMs = requestedStep * DAY_MS;
  const { runBillingClockTickOnce } = await import("@/platform/jobs");

  // Drive the clock as-of `at`, scoped to this business, until nothing due at `at` is
  // left. A live tick may leave a capped or shed pass to the next minute; a travel step
  // has no next minute at `at`, so it re-drives the same instant instead. Every pass is
  // idempotent at a fixed `now`, so a repeat only does the remainder.
  const driveTick = async (at: Date) => {
    // The usage-controls check (its own cron, which skips a travelled business) first, so
    // the interim invoices it raises are collected by this step's tick.
    await runWithClockScope({ onlyBusinessId: input.bizId, now: at }, async () => {
      await import("@/modules/usage-controls/threshold-invoicing");
      const { runUsageControlsCheck } = await import("@/modules/usage-controls/check");
      for (let round = 0; round < MAX_ROUNDS_PER_STEP; round++)
        if (!(await runUsageControlsCheck()).capped) break;
    });
    // Plan credit windows (their own cron, which skips a travelled business), before the tick.
    await runWithClockScope({ onlyBusinessId: input.bizId, now: at }, async () => {
      const { runPlanCreditResets } = await import("@/modules/credits/credit-clock");
      await runPlanCreditResets(at);
    });
    let unfinished: string[] = [];
    for (let round = 0; round < MAX_ROUNDS_PER_STEP; round++) {
      ({ unfinished } = await runWithClockScope({ onlyBusinessId: input.bizId, now: at }, () =>
        runBillingClockTickOnce(() => {}, at),
      ));
      if (unfinished.length === 0) return;
    }
    throw new TimeTravelError(
      `We could not complete the travel. The billing work due at ${at.toISOString()} did ` +
        `not finish in ${MAX_ROUNDS_PER_STEP} runs (${unfinished.join(", ")}). Travel again to continue.`,
    );
  };

  let steps = 0;
  // Release the lease on ANY exit, not just the happy one. A tick that throws
  // mid-travel leaves `simulated_now` at `from`, so a retry re-drives from there —
  // safe, because every pass is idempotent and threshold-based (`… <= now`), which
  // is the same property the determinism check relies on. Holding the lease instead
  // would turn one transient tick failure into a 15-minute outage for the business.
  let committed = false;
  try {
    if (to.getTime() === from.getTime()) {
      // Re-drive the current instant (idempotent no-op / determinism check).
      await driveTick(from);
      steps = 1;
    } else {
      let cursorMs = from.getTime();
      while (cursorMs < to.getTime()) {
        cursorMs = Math.min(cursorMs + stepMs, to.getTime());
        await driveTick(new Date(cursorMs));
        steps++;
      }
    }
    await withTenant(input.orgId, (tx) =>
      tx
        .update(timeTravels)
        .set({ simulatedNow: to, travelLeaseUntil: null, updatedAt: new Date() })
        .where(eq(timeTravels.id, tm.id)),
    );
    committed = true;
  } finally {
    if (!committed) {
      // Clear ONLY the lease — `simulated_now` must not advance for work that did
      // not finish.
      await withTenant(input.orgId, (tx) =>
        tx
          .update(timeTravels)
          .set({ travelLeaseUntil: null, updatedAt: new Date() })
          .where(eq(timeTravels.id, tm.id)),
      );
    }
  }
  return { steps, from, to };
}

/**
 * The customer/transactional tables a stop-wipe clears for one business, in
 * FK-safe (child → parent) order. Catalog, coupons, tax rates, settings, gateway
 * accounts, api keys, webhook endpoints and the business itself are KEPT.
 */
const WIPE_TABLES = [
  "ledger_entries",
  "applied_taxes",
  "invoice_line_items",
  "credit_note_allocations",
  "credit_note_items",
  "refunds",
  "credit_notes",
  "receipts",
  "payments",
  "transactions",
  // after payments and transactions (both point at it); its invoice links cascade
  "payment_requests",
  "payment_intents",
  "invoices",
  "usage_records",
  "subscription_charge_log",
  "subscription_entitlements",
  "applied_coupons",
  "subscription_items",
  "scheduled_changes",
  "unbilled_charges",
  "subscriptions",
  "wallet_topups",
  "payment_methods",
  "contacts",
  "customers",
  // webhook_deliveries cascades from events (event_id ON DELETE CASCADE), so the
  // events delete below clears them; tmtest_vault is keyed by vault_id (no business
  // column) and is harmless sandbox card data — both intentionally omitted.
  "events",
  "provider_events",
  "imported_events",
  "import_records",
  "tmtest_outbound",
  "tmtest_charges",
] as const;

/**
 * Delete a test business's customers and everything transactional under them, and end
 * Time Travel. Catalog, settings, gateways, keys and webhook endpoints are kept (see
 * WIPE_TABLES). Test-only.
 */
export async function wipeTestBusinessData(input: {
  orgId: string;
  bizId: string;
}): Promise<{ wiped: number }> {
  await assertTestBusiness(input.orgId, input.bizId);
  // `systemDb`, not tmbilling_app: a test-only teardown across every transactional table.
  // business_id is a globally-unique UUID, so the filter is exact without RLS; the id is BOUND
  // and cast, not interpolated (audit L2). The ledger is append-only for every login, so its
  // rows go through `app_wipe_test_ledger`, which refuses a business that is not in test mode.
  let wiped = 0;
  for (const t of WIPE_TABLES) {
    if (t === "ledger_entries") {
      const [row] = (await systemDb.execute(
        sql`select public.app_wipe_test_ledger(${input.bizId}::uuid) as n`,
      )) as unknown as Array<{ n: string | number }>;
      wiped += Number(row?.n ?? 0);
      continue;
    }
    const res = await systemDb.execute(
      sql`delete from ${sql.identifier(t)} where business_id = ${input.bizId}::uuid`,
    );
    wiped += (res as unknown as { count?: number }).count ?? 0;
  }
  await withTenant(input.orgId, (tx) =>
    tx
      .update(timeTravels)
      .set({ status: "not_enabled", simulatedNow: null, updatedAt: new Date() })
      .where(eq(timeTravels.businessId, input.bizId)),
  );
  // A destructive teardown: always logged.
  log.info("test business data deleted", { businessId: input.bizId, wiped });
  return { wiped };
}

/**
 * stop (destroy): wipe the business's simulated customer/transactional data and
 * clear Time Travel, returning the business to normal real-clock operation.
 * Test-only.
 */
export async function stopTimeTravel(input: {
  orgId: string;
  bizId: string;
  wipe?: boolean;
}): Promise<{ wiped: number }> {
  if (input.wipe !== false) return wipeTestBusinessData(input);
  await assertTestBusiness(input.orgId, input.bizId);
  await withTenant(input.orgId, (tx) =>
    tx
      .update(timeTravels)
      .set({ status: "not_enabled", simulatedNow: null, updatedAt: new Date() })
      .where(eq(timeTravels.businessId, input.bizId)),
  );
  log.info("time travel stopped", { businessId: input.bizId, wiped: 0, wipeRequested: false });
  return { wiped: 0 };
}
