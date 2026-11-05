/**
 * Settlement poll backoff — the three sweeps in `payments/stale-pending.ts` must stop
 * re-asking a gateway the same question every sixty seconds forever.
 *
 * ── What went wrong ─────────────────────────────────────────────────────────────
 * Each sweep records NOTHING when the gateway's answer changes nothing, which is the right
 * money policy — but it also meant remembering nothing, so the next tick asked again.
 * Measured on dev 2026-09-02, on EVERY tick: `stale_pending` examined 103 / settled 0,
 * `afa_recheck` examined 30 / recovered 0, `zero_due` examined 209 / closed 0. 10.3s of a
 * 10.6s tick — 98% of the billing clock — spent on answers we already had.
 *
 * ── What this suite pins ────────────────────────────────────────────────────────
 * Three things, in order of how quietly they can break:
 *
 *  1. The write LANDS. `deferPolls` swallows its own failures on purpose (bookkeeping about
 *     work must never undo the work), so a broken write is invisible: the sweeps just keep
 *     polling and everything looks healthy. That is exactly what happened when the RLS
 *     policy was written against `app.organization_id` instead of `app.org_id` — every
 *     insert was refused and nothing said so. Asserting the ROW EXISTS is the only way this
 *     class of bug is ever caught.
 *  2. The interval widens and CAPS. The last cap of this shape was applied after the
 *     multiplication and could never run; it took the mail lane down.
 *  3. The passes stay INDEPENDENT. One schedule per (transaction, pass), because deferring a
 *     row in `stale_pending` must not hide it from `zero_due` — which releases a live debit
 *     on an invoice the customer no longer owes.
 *
 *   pnpm verify:settlement-poll
 */
import { eq, and, sql } from "drizzle-orm";
import { systemDb, closeDb, withTenant } from "@/platform/db";
import { config } from "@/platform/config";
import { organizations, businesses, transactions, settlementPollSchedule } from "@db/schema";
import { publicId } from "@/platform/ids";
import {
  deferPolls,
  deferredUntilLater,
  nextPollAt,
  clearPollSchedule,
  reapFinishedPollSchedules,
  SETTLEMENT_POLL_PASSES,
  isSettlementPollPass,
} from "@/modules/payments/poll-schedule";

const checks: Array<[string, boolean]> = [];
const ok = (n: string, c: boolean) => checks.push([n, c]);

const NOW = new Date("2026-09-02T12:00:00Z");
const at = (ms: number) => new Date(NOW.getTime() + ms);

// ── the arithmetic ───────────────────────────────────────────────────────────────────
const waitFor = (attempts: number) => nextPollAt(attempts, NOW).getTime() - NOW.getTime();

ok("a first repeat waits one base interval", waitFor(1) === config.SETTLEMENT_POLL_BACKOFF_BASE_MS);
ok("it doubles", waitFor(2) === 2 * config.SETTLEMENT_POLL_BACKOFF_BASE_MS);
ok("…and again", waitFor(3) === 4 * config.SETTLEMENT_POLL_BACKOFF_BASE_MS);
ok("attempt 0 does not go negative", waitFor(0) === config.SETTLEMENT_POLL_BACKOFF_BASE_MS);
ok(
  "a negative attempt count is clamped too",
  waitFor(-5) === config.SETTLEMENT_POLL_BACKOFF_BASE_MS,
);
// The bug that killed the mail lane: a cap applied AFTER the multiplication never runs,
// because `base * 2 ** 60` is Infinity in JS and overflows bigint in Postgres.
ok("it caps", waitFor(50) === config.SETTLEMENT_POLL_MAX_BACKOFF_MS);
ok("it stays finite at an absurd count", Number.isFinite(waitFor(1e9)));
ok("…and still pinned at the cap", waitFor(1e9) === config.SETTLEMENT_POLL_MAX_BACKOFF_MS);
ok(
  "never exceeds the cap at any count",
  [0, 1, 7, 31, 60, 1e6, 1e9].every((a) => waitFor(a) <= config.SETTLEMENT_POLL_MAX_BACKOFF_MS),
);

ok("the pass list is closed", SETTLEMENT_POLL_PASSES.length === 4);
ok("a known pass is recognised", isSettlementPollPass("zero_due"));
ok("an unknown pass is not", !isSettlementPollPass("not_a_pass"));

// ── fixtures ─────────────────────────────────────────────────────────────────────────
const [org] = await systemDb
  .insert(organizations)
  .values({ publicId: publicId("org"), name: "settlement-poll verify" })
  .returning();
const [biz] = await systemDb
  .insert(businesses)
  .values({
    organizationId: org!.id,
    publicId: publicId("biz"),
    name: "b",
    defaultCurrency: "INR",
    timezone: "UTC",
  })
  .returning();

const mkTxn = async (suffix: string, status = "in_progress") => {
  const [t] = await systemDb
    .insert(transactions)
    .values({
      organizationId: org!.id,
      businessId: biz!.id,
      publicId: `txn_verify_sp_${suffix}_${Date.now()}`,
      type: "payment",
      status,
      amountMinor: 1000n,
      currency: "INR",
      idAtGateway: `pg_${suffix}`,
      occurredAt: NOW,
    })
    .returning();
  return t!;
};

const a = await mkTxn("a");
const b = await mkTxn("b");

const scheduleFor = async (txnId: string, pass: string) => {
  const [row] = await systemDb
    .select()
    .from(settlementPollSchedule)
    .where(
      and(eq(settlementPollSchedule.transactionId, txnId), eq(settlementPollSchedule.pass, pass)),
    );
  return row;
};

// ── (1) the write lands ──────────────────────────────────────────────────────────────
await deferPolls("stale_pending", [{ organizationId: org!.id, transactionId: a.id }], NOW);
const first = await scheduleFor(a.id, "stale_pending");
// THE assertion. `deferPolls` swallows failures by design, so without this a refused write
// is completely silent and the sweeps quietly keep their old behaviour.
ok("deferring WRITES A ROW (not merely swallowed)", first !== undefined);
ok("…starting at one attempt", Number(first?.attempts) === 1);
ok(
  "…scheduled one base interval out",
  first !== undefined &&
    Math.abs(first.nextAt.getTime() - (NOW.getTime() + config.SETTLEMENT_POLL_BACKOFF_BASE_MS)) <
      1000,
);
ok("…and carries the tenant for RLS", first?.organizationId === org!.id);

// ── (2) escalation, through the real SQL path ────────────────────────────────────────
await deferPolls("stale_pending", [{ organizationId: org!.id, transactionId: a.id }], NOW);
const second = await scheduleFor(a.id, "stale_pending");
ok("a second fruitless poll increments", Number(second?.attempts) === 2);
ok(
  "…and doubles the interval",
  second !== undefined &&
    Math.abs(
      second.nextAt.getTime() - (NOW.getTime() + 2 * config.SETTLEMENT_POLL_BACKOFF_BASE_MS),
    ) < 1000,
);

// Drive it far past the point where an unclamped exponent overflows. In SQL this is
// `power(2, attempts)`; at attempt 60 the unclamped form is 6.9e19 and bigint stops at 9.2e18.
for (let i = 0; i < 70; i++) {
  await deferPolls("stale_pending", [{ organizationId: org!.id, transactionId: a.id }], NOW);
}
const far = await scheduleFor(a.id, "stale_pending");
ok("72 consecutive deferrals do not overflow", far !== undefined);
ok("…the count kept climbing", Number(far?.attempts) === 72);
ok(
  "…and the interval is pinned at the cap, not wrapped or thrown",
  far !== undefined &&
    Math.abs(far.nextAt.getTime() - (NOW.getTime() + config.SETTLEMENT_POLL_MAX_BACKOFF_MS)) < 1000,
);

// ── (3) the due filter ───────────────────────────────────────────────────────────────
const deferred = await deferredUntilLater("stale_pending", NOW);
ok("a deferred row is reported as not-due", deferred.has(a.id));
ok("an unscheduled row is due", !deferred.has(b.id));
const later = await deferredUntilLater(
  "stale_pending",
  at(config.SETTLEMENT_POLL_MAX_BACKOFF_MS + 60_000),
);
ok("once its time arrives it is due again", !later.has(a.id));

// ── (4) passes are independent ───────────────────────────────────────────────────────
// The reason this is a table keyed by (transaction, pass) and not two columns: a row
// deferred by `stale_pending` must still be visible to `zero_due`, which releases a live
// debit against an invoice that owes nothing. Sharing one schedule would hold the buyer's
// money for up to an hour to save a poll.
const zeroDue = await deferredUntilLater("zero_due", NOW);
ok("deferring one pass does NOT defer another", !zeroDue.has(a.id));
await deferPolls("zero_due", [{ organizationId: org!.id, transactionId: a.id }], NOW);
ok("…and each keeps its own count", Number((await scheduleFor(a.id, "zero_due"))?.attempts) === 1);
ok(
  "…without disturbing the first",
  Number((await scheduleFor(a.id, "stale_pending"))?.attempts) === 72,
);

// ── (5) clearing, for the hand-off between passes ────────────────────────────────────
await withTenant(org!.id, async (tx) => {
  await clearPollSchedule(tx, a.id, ["stale_pending"]);
});
ok("clearing one pass removes it", (await scheduleFor(a.id, "stale_pending")) === undefined);
ok("…and leaves the others", (await scheduleFor(a.id, "zero_due")) !== undefined);

// ── (6) the reaper ───────────────────────────────────────────────────────────────────
// A transaction can leave every sweep's population by a route that never calls
// clearPollSchedule — a webhook settling it, an operator reconciling by hand.
await systemDb.update(transactions).set({ status: "succeeded" }).where(eq(transactions.id, a.id));
await reapFinishedPollSchedules();
ok(
  "a settled transaction's schedule is reaped",
  (await scheduleFor(a.id, "zero_due")) === undefined,
);

// Per-pass, because the passes watch different statuses. `afa_recheck` wants `failed`;
// the other two want `in_progress`. A single "is it finished?" rule leaked a row for every
// debit that ended in failure — done with `stale_pending` forever, but never reaped because
// `failed` is what `afa_recheck` looks for.
await systemDb.update(transactions).set({ status: "failed" }).where(eq(transactions.id, b.id));
await deferPolls("afa_recheck", [{ organizationId: org!.id, transactionId: b.id }], NOW);
await deferPolls("stale_pending", [{ organizationId: org!.id, transactionId: b.id }], NOW);
await reapFinishedPollSchedules();
ok(
  "a failed debit KEEPS its afa_recheck schedule",
  (await scheduleFor(b.id, "afa_recheck")) !== undefined,
);
ok(
  "…and LOSES its stale_pending one, which is done with it",
  (await scheduleFor(b.id, "stale_pending")) === undefined,
);
await systemDb.update(transactions).set({ status: "in_progress" }).where(eq(transactions.id, b.id));
await deferPolls("zero_due", [{ organizationId: org!.id, transactionId: b.id }], NOW);
await reapFinishedPollSchedules();
ok(
  "an in-flight debit keeps its zero_due schedule",
  (await scheduleFor(b.id, "zero_due")) !== undefined,
);
ok(
  "…and its now-irrelevant afa_recheck one is dropped",
  (await scheduleFor(b.id, "afa_recheck")) === undefined,
);

// ── (7) RLS actually applies ─────────────────────────────────────────────────────────
// The policy reads `app.org_id`. Written first as `app.organization_id`, `current_setting`
// returned NULL, the comparison was NULL rather than false, and EVERY insert was silently
// refused. A wrong setting name is invisible unless something asserts a foreign tenant is
// blocked as well as that the right one is allowed.
const [other] = await systemDb
  .insert(organizations)
  .values({ publicId: publicId("org"), name: "settlement-poll other" })
  .returning();
let blocked = false;
try {
  await withTenant(other!.id, async (tx) => {
    await tx.execute(sql`insert into settlement_poll_schedule
      (transaction_id, pass, organization_id, attempts, next_at)
      values (${b.id}::uuid, 'zero_due', ${org!.id}::uuid, 1, ${NOW.toISOString()}::timestamptz)`);
  });
} catch {
  blocked = true;
}
ok("a tenant cannot write another tenant's schedule", blocked);

// ── cleanup ──────────────────────────────────────────────────────────────────────────
await systemDb
  .delete(settlementPollSchedule)
  .where(eq(settlementPollSchedule.organizationId, org!.id));
await systemDb.delete(transactions).where(eq(transactions.organizationId, org!.id));
await systemDb.delete(businesses).where(eq(businesses.organizationId, org!.id));
await systemDb.delete(organizations).where(eq(organizations.id, org!.id));
await systemDb.delete(organizations).where(eq(organizations.id, other!.id));

let failed = 0;
for (const [label, passed] of checks) {
  console.log(`${passed ? "  ✓" : "  ✗ FAIL"} ${label}`);
  if (!passed) failed++;
}
console.log(
  `\n${failed === 0 ? `✅ SETTLEMENT POLL: PASS (${checks.length})` : `❌ SETTLEMENT POLL: FAIL (${failed}/${checks.length})`}`,
);
await closeDb();
process.exit(failed ? 1 : 0);
