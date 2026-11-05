/**
 * S1–S14, written once and run against every gateway's fixture module through the real
 * engine and the real webhook route. Each check is a ROW (`S2.exact-total`); the suite
 * compares the failing rows with `known-gaps.json`.
 */
import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { systemDb, withTenant } from "@/platform/db";
import { runWithClockScope } from "@/platform/clock";
import { refundPayment, RefundError } from "@/modules/refunds/service";
import { collectInvoice } from "@/modules/invoicing/service";
import { sweepStalePendingCharges } from "@/modules/payments/stale-pending";
import { cancelPendingDebit } from "@/modules/payments/pending-debit";
import { resolveAdapter } from "@/providers/registry";
import type { ProviderKey } from "@/providers/types";
import { gatewayAccounts, paymentMethods, payments } from "@db/schema";
import { installFake } from "./fake-http";
import {
  AMOUNT,
  drainStoredWebhooks,
  invoiceOf,
  newWorld,
  outcomeOf,
  subscriptionOf,
  txnsOf,
  type Org,
  type World,
} from "./harness";
import {
  SCENARIO_IDS,
  SCENARIOS,
  type Billed,
  type FaultBody,
  type GatewayDriver,
  type GatewayFixture,
  type ScenarioId,
} from "./types";

export interface RowResult {
  gateway: string;
  scenario: ScenarioId;
  id: string;
  outcome: "pass" | "fail" | "na";
  detail?: string;
}

interface Ctx {
  fixture: GatewayFixture;
  driver: GatewayDriver;
  world(label: string, currency?: string): Promise<World>;
  /** Records a row. */
  row(id: string, pass: boolean, detail?: unknown): void;
  /** False (and an n/a row) when the fixture declares this row or its scenario n/a. */
  applies(id: string): boolean;
}

const later = (ms: number) => new Date(Date.now() + ms);
const sweepAt = (w: World, at: Date) =>
  runWithClockScope({ onlyBusinessId: w.biz.id }, () => sweepStalePendingCharges(at));
const s = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));

async function instrument(w: World, paymentMethodId: string) {
  const [pm] = await withTenant(w.org.id, (tx) =>
    tx.select().from(paymentMethods).where(eq(paymentMethods.id, paymentMethodId)),
  );
  return pm!;
}

async function adapterOf(w: World) {
  const [acc] = await systemDb
    .select()
    .from(gatewayAccounts)
    .where(eq(gatewayAccounts.id, w.account.id));
  return resolveAdapter(acc!);
}

/** A refund of ours, or the error it threw. */
async function refund(w: World, b: Billed, amountMinor: number) {
  return refundPayment({
    organizationId: w.org.id,
    businessId: w.biz.id,
    paymentPublicId: b.paymentPublicId!,
    amountMinor,
  });
}

/** Every create of `op` meets `fault` (enough for the adapter's own retries). */
function failEvery(d: GatewayDriver, op: string, fault: FaultBody, afterCreate = false) {
  d.fake.inject(op, { kind: "http", ...fault, afterCreate }, 6);
}
function loseEvery(d: GatewayDriver, op: string, afterCreate: boolean) {
  d.fake.inject(op, { kind: "network", afterCreate }, 6);
}

// ── S1 ──────────────────────────────────────────────────────────────────────
async function s1(c: Ctx) {
  const w = await c.world("s1");
  for (const st of c.fixture.statuses) {
    const id = `S1.${st.object}.${st.status}`;
    if (!c.applies(id)) continue;
    try {
      const b = await w.collected();
      const bodies = c.driver.statusEvent(w, st, b.chargeId);
      const res = await w.deliver(bodies);
      const got = await w.recordedTypes(bodies.flatMap((x) => x.eventIds));
      const want = Array.isArray(st.expect) ? [...st.expect].sort() : null;
      const pass =
        res.status === 200 &&
        got.length > 0 &&
        (want ? s(got) === s(want) : got.every((t) => t === "unknown"));
      c.row(
        id,
        pass,
        `${res.status} got ${got.join(",") || "nothing"} want ${want?.join(",") ?? "unknown"}`,
      );
    } catch (e) {
      c.row(id, false, (e as Error).message);
    }
  }
  c.row("S1.balanced", await w.balanced());
}

// ── S2 ──────────────────────────────────────────────────────────────────────
async function s2(c: Ctx) {
  const w = await c.world("s2");
  const b = await w.collected();
  const cash0 = await w.cash();
  const r1 = await refund(w, b, 3000);
  const r2 = await refund(w, b, 2000);
  await w.deliver(c.driver.refundEvent(w, b.chargeId, r1.providerRefundId!, "succeeded"));
  await w.deliver(c.driver.refundEvent(w, b.chargeId, r2.providerRefundId!, "succeeded"));
  const rows = await w.refundRows(b.paymentId!);
  c.row(
    "S2.exact-total",
    (await w.cash()) === cash0 - 5000n && rows.every((r) => r.status === "succeeded"),
    `cash ${(await w.cash()) - cash0} rows ${rows.map((r) => `${r.amountMinor}:${r.status}`)}`,
  );
  const n = await w.entries();
  await w.deliver(c.driver.refundEvent(w, b.chargeId, r1.providerRefundId!, "succeeded"));
  await w.redeliver();
  c.row("S2.redelivery-posts-nothing", (await w.entries()) === n);
  c.row("S2.balanced", await w.balanced());
}

// ── S3 ──────────────────────────────────────────────────────────────────────
async function s3(c: Ctx) {
  const w = await c.world("s3");
  const b = await w.collected();
  const cash0 = await w.cash();
  const a = c.driver.dashboardRefund(w, b.chargeId, 3000n);
  await w.deliver(a.events);
  c.row(
    "S3.first-at-own-amount",
    (await w.cash()) === cash0 - 3000n,
    `cash ${(await w.cash()) - cash0}`,
  );
  const d = c.driver.dashboardRefund(w, b.chargeId, 2000n);
  await w.deliver(d.events);
  const rows = await w.refundRows(b.paymentId!);
  c.row(
    "S3.second-at-own-amount",
    (await w.cash()) === cash0 - 5000n &&
      s(rows.map((r) => r.amountMinor).sort()) === s([2000n, 3000n]),
    `cash ${(await w.cash()) - cash0} rows ${rows.map((r) => r.amountMinor)}`,
  );
  const n = await w.entries();
  await w.deliver(a.events);
  await w.deliver(d.events);
  c.row("S3.redelivery-posts-nothing", (await w.entries()) === n);

  // Ours first, then one from the dashboard.
  const b2 = await w.collected();
  const c2 = await w.cash();
  const ours = await refund(w, b2, 3000);
  await w.deliver(c.driver.refundEvent(w, b2.chargeId, ours.providerRefundId!, "succeeded"));
  const e = c.driver.dashboardRefund(w, b2.chargeId, 3000n);
  await w.deliver(e.events);
  c.row(
    "S3.after-our-refund",
    (await w.cash()) === c2 - 6000n,
    `cash ${(await w.cash()) - c2} (want -6000)`,
  );
  c.row("S3.balanced", await w.balanced());
}

// ── S4 ──────────────────────────────────────────────────────────────────────
async function s4(c: Ctx) {
  const w = await c.world("s4");
  const b = await w.collected();
  const cash0 = await w.cash();
  const r = await refund(w, b, 4000);
  await w.deliver(c.driver.refundEvent(w, b.chargeId, r.providerRefundId!, "failed"));
  const [row] = (await w.refundRows(b.paymentId!)).filter((x) => x.id === r.id);
  c.row(
    "S4.reverses",
    (await w.cash()) === cash0 && row?.status === "failed",
    `cash ${(await w.cash()) - cash0} refund ${row?.status}`,
  );
  const n = await w.entries();
  await w.redeliver();
  await w.deliver(c.driver.refundEvent(w, b.chargeId, r.providerRefundId!, "failed"));
  c.row("S4.once", (await w.entries()) === n && (await w.cash()) === cash0);
  c.row("S4.balanced", await w.balanced());
}

// ── S5 ──────────────────────────────────────────────────────────────────────
async function s5(c: Ctx) {
  for (const flow of ["won", "lost", "win_after_loss"] as const) {
    const id = `S5.${flow}`;
    if (!c.applies(id)) continue;
    const w = await c.world(`s5${flow}`);
    const b = await w.collected();
    const cash0 = await w.cash();
    const steps = c.driver.disputeSteps(w, b.chargeId, flow);
    if (!steps) {
      c.row(id, false, "the driver cannot express this flow; declare it n/a with a reason");
      continue;
    }
    const want = {
      opened: [cash0, 0n],
      withdrawn: [cash0 - AMOUNT, 0n],
      lost: [cash0 - AMOUNT, AMOUNT],
      won: [cash0, 0n],
    } as const;
    const bad: string[] = [];
    for (const step of steps) {
      await w.deliver(step.bodies);
      const [cash, losses] = [await w.cash(), await w.bal("dispute_losses")];
      const [wc, wl] = want[step.after];
      if (cash !== wc || losses !== wl)
        bad.push(`${step.after}: cash ${cash - cash0} losses ${losses}`);
    }
    c.row(id, bad.length === 0, bad.join("; "));
    const n = await w.entries();
    await w.redeliver();
    c.row(`${id}.redelivery-posts-nothing`, (await w.entries()) === n);
    c.row(`${id}.balanced`, await w.balanced());
  }
}

// ── S6 ──────────────────────────────────────────────────────────────────────
async function s6(c: Ctx) {
  if (!c.applies("S6.after-failure")) return;
  const w = await c.world("s6");
  const cash0 = await w.cash();
  let b: Billed;
  if (c.driver.token("declines")) b = await w.bill("declines");
  else {
    b = await w.bill("pays");
    await w.deliver(c.driver.paymentFailed(w, b.chargeId, false));
    b = await w.reload(b);
  }
  if (outcomeOf(b) !== "failed" || !b.chargeId) {
    c.row(
      "S6.after-failure",
      false,
      `setup: expected a failed charge with an id, got ${outcomeOf(b)} ${b.chargeId}`,
    );
    return;
  }
  const res = await w.deliver(c.driver.paymentSucceeded(w, b.chargeId));
  const after = await w.reload(b);
  c.row(
    "S6.after-failure",
    after.txnStatus === "succeeded" &&
      (await w.invoiceStatus(b.invoiceId)) === "paid" &&
      (await w.cash()) === cash0 + AMOUNT,
    `txn ${after.txnStatus} invoice ${await w.invoiceStatus(b.invoiceId)} cash ${(await w.cash()) - cash0} webhook ${res.status} ${res.results}`,
  );
  const n = await w.entries();
  await w.redeliver();
  c.row("S6.redelivery-posts-nothing", (await w.entries()) === n);
  c.row("S6.balanced", await w.balanced());
}

// ── S7 ──────────────────────────────────────────────────────────────────────
async function s7(c: Ctx) {
  const d = c.driver;
  const w = await c.world("s7");
  const pmId = async (b: Billed) =>
    (await instrument(w, b.paymentMethodId)).providerPaymentMethodId;

  if (c.applies("S7.replay")) {
    d.fake.inject(d.chargeOp, { kind: "network", afterCreate: true }, 1);
    const b = await w.bill();
    d.fake.clearFaults();
    const made = d.chargesOn(await pmId(b));
    c.row(
      "S7.replay",
      made.length === 1 && b.chargeId === made[0] && outcomeOf(b) !== "failed",
      `charges ${made.length} id ${b.chargeId || "none"} attempt ${outcomeOf(b)}`,
    );
  }

  // The whole answer is lost (the in-call replay and any lookup too); the gateway made it.
  const lost = async () => {
    loseEvery(d, d.chargeOp, true);
    if (d.lookupOp) loseEvery(d, d.lookupOp, false);
    try {
      return await w.bill();
    } finally {
      d.fake.clearFaults();
    }
  };

  if (c.applies("S7.lost-books-timeout")) {
    const cash0 = await w.cash();
    const b = await lost();
    const made = d.chargesOn(await pmId(b));
    c.row(
      "S7.lost-books-timeout",
      b.txnStatus === "timeout" && (await w.cash()) === cash0,
      `attempt ${outcomeOf(b)} ${b.failureCode ?? ""}; charges at the gateway ${made.length}`,
    );
    if (c.applies("S7.webhook-adopts") && made[0]) {
      await w.deliver(d.paymentSucceeded(w, made[0]));
      const after = await w.reload(b);
      c.row(
        "S7.webhook-adopts",
        after.txnStatus === "succeeded" &&
          after.chargeId === made[0] &&
          (await w.cash()) === cash0 + AMOUNT,
        `attempt ${outcomeOf(after)} id ${after.chargeId || "none"} cash ${(await w.cash()) - cash0}`,
      );
    }
  }

  if (c.applies("S7.locate-found")) {
    const cash0 = await w.cash();
    const b = await lost();
    await sweepAt(w, later(15 * 60_000));
    let after = await w.reload(b);
    const made = d.chargesOn(await pmId(b));
    // An async debit is found as created (pending). Once the lookup has adopted its id, the
    // money arrives as for any charge (`collect`, empty for a card).
    if (made[0] && after.chargeId === made[0]) {
      const bodies = d.collect(w, made[0]);
      if (bodies.length) {
        await w.deliver(bodies);
        after = await w.reload(b);
      }
    }
    c.row(
      "S7.locate-found",
      after.txnStatus === "succeeded" &&
        after.chargeId === made[0] &&
        (await w.cash()) === cash0 + AMOUNT,
      `attempt ${outcomeOf(after)} id ${after.chargeId || "none"} cash ${(await w.cash()) - cash0}`,
    );
  }

  if (c.applies("S7.locate-none")) {
    loseEvery(d, d.chargeOp, false);
    if (d.lookupOp) loseEvery(d, d.lookupOp, false);
    let b: Billed;
    try {
      b = await w.bill();
    } finally {
      d.fake.clearFaults();
    }
    await sweepAt(w, later(15 * 60_000));
    const early = outcomeOf(await w.reload(b));
    await sweepAt(w, later(25 * 3_600_000));
    const late = await w.reload(b);
    c.row(
      "S7.locate-none",
      early === "timeout" &&
        late.txnStatus === "failed" &&
        late.failureCode === "gateway_charge_not_created",
      `at 15 min ${early}; at 25 h ${outcomeOf(late)} ${late.failureCode ?? ""}`,
    );
  }

  if (c.applies("S7.no-double-charge")) {
    const b = await lost();
    // The next collection pass on the same invoice.
    const inv = await invoiceOf(w, b.invoiceId);
    await collectInvoice({
      organizationId: w.org.id,
      businessId: w.biz.id,
      invoice: inv,
      subscription: await subscriptionOf(w, b.subscriptionId),
    }).catch(() => null);
    const made = d.chargesOn(await pmId(b));
    c.row(
      "S7.no-double-charge",
      made.length === 1,
      `charges at the gateway after a second collection: ${made.length}`,
    );
  }
  c.row("S7.balanced", await w.balanced());
}

// ── S8 ──────────────────────────────────────────────────────────────────────
async function s8(c: Ctx) {
  const d = c.driver;
  const w = await c.world("s8");
  const classes = [
    ["S8.charge-409", d.errors.conflict, false],
    ["S8.charge-429", d.errors.rateLimited, !!d.rateLimitCreatesNothing],
    ["S8.charge-5xx", d.errors.server, false],
    ...(d.errors.internal ? [["S8.charge-internal", d.errors.internal, false] as const] : []),
  ] as const;
  for (const [id, fault, definiteAllowed] of classes) {
    if (!c.applies(id)) continue;
    failEvery(d, d.chargeOp, fault);
    try {
      const b = await w.bill();
      const [t] = await txnsOf(w, b.invoiceId);
      const definite = outcomeOf(b) === "failed";
      c.row(
        id,
        !definite || (definiteAllowed && t?.retriable === true),
        `attempt ${outcomeOf(b)} ${b.failureCode ?? ""} retriable=${t?.retriable ?? "n/a"}`,
      );
    } catch (e) {
      c.row(id, false, (e as Error).message);
    } finally {
      d.fake.clearFaults();
    }
  }

  if (c.applies("S8.refund-4xx-releases")) {
    const b = await w.collected();
    failEvery(d, d.refundOp, d.errors.refundRefused);
    let refused = false;
    try {
      await refund(w, b, 4000);
    } catch (e) {
      refused = e instanceof RefundError;
    } finally {
      d.fake.clearFaults();
    }
    const full = await refundPayment({
      organizationId: w.org.id,
      businessId: w.biz.id,
      paymentPublicId: b.paymentPublicId!,
    }).catch((e: Error) => e);
    c.row(
      "S8.refund-4xx-releases",
      refused && !(full instanceof Error) && full.amountMinor === AMOUNT,
      `refused=${refused} then full refund ${full instanceof Error ? full.message : full.amountMinor}`,
    );
  }

  if (c.applies("S8.refund-5xx-not-refused")) {
    const b = await w.collected();
    failEvery(d, d.refundOp, d.errors.server);
    let refused = false;
    try {
      await refund(w, b, 4000);
    } catch (e) {
      refused = e instanceof RefundError;
    } finally {
      d.fake.clearFaults();
    }
    const rows = await w.refundRows(b.paymentId!);
    c.row(
      "S8.refund-5xx-not-refused",
      !refused && rows.some((r) => r.status === "pending"),
      `refused=${refused} rows ${rows.map((r) => r.status)}`,
    );
  }
  c.row("S8.balanced", await w.balanced());
}

// ── S9 ──────────────────────────────────────────────────────────────────────
async function s9(c: Ctx) {
  const w = await c.world("s9");
  const b = await w.collected();
  const cash0 = await w.cash();
  await w.deliver(c.driver.paymentFailed(w, b.chargeId, true));
  const after = await w.reload(b);
  c.row(
    "S9.reverses",
    (await w.cash()) === cash0 - AMOUNT && (await w.invoiceStatus(b.invoiceId)) !== "paid",
    `cash ${(await w.cash()) - cash0} invoice ${await w.invoiceStatus(b.invoiceId)} txn ${after.txnStatus}`,
  );
  const n = await w.entries();
  await w.redeliver();
  c.row("S9.once", (await w.entries()) === n);
  c.row("S9.balanced", await w.balanced());
}

// ── S10 ─────────────────────────────────────────────────────────────────────
async function s10(c: Ctx) {
  const w = await c.world("s10");
  const kind = c.driver.token("bank_debit") ? "bank_debit" : "pays";
  const b = await w.bill(kind);
  const cash0 = await w.cash();
  const [pay] = await withTenant(w.org.id, (tx) =>
    tx.select().from(payments).where(eq(payments.id, b.paymentId!)),
  );
  if (pay?.status !== "pending") {
    c.row("S10.cancels", false, `setup: expected a pending debit, got ${pay?.status}`);
    return;
  }
  const cancel = () =>
    cancelPendingDebit({
      organizationId: w.org.id,
      businessId: w.biz.id,
      paymentId: pay.id,
      purpose: "operator",
    });
  const r = await cancel();
  c.row("S10.cancels", r.outcome === "cancelled" && (await w.cash()) === cash0, s(r));
  const again = await cancel();
  c.row(
    "S10.repeat-is-harmless",
    again.outcome !== "cancelled" || (await w.cash()) === cash0,
    s(again),
  );
  c.row("S10.balanced", await w.balanced());
}

// ── S11 ─────────────────────────────────────────────────────────────────────
async function s11(c: Ctx) {
  const w = await c.world("s11");
  const b = await w.collected();
  const cash0 = await w.cash();
  const n0 = await w.entries();
  const ok = c.driver.paymentSucceeded(w, b.chargeId);
  await w.deliver(ok);
  await w.deliver(ok);
  c.row("S11.duplicate-success", (await w.entries()) === n0 && (await w.cash()) === cash0);

  const r = c.driver.dashboardRefund(w, b.chargeId, 1500n);
  await w.deliver([...r.events].reverse());
  c.row(
    "S11.out-of-order-refund",
    (await w.cash()) === cash0 - 1500n,
    `cash ${(await w.cash()) - cash0} (want -1500)`,
  );
  const n = await w.entries();
  await w.deliver(r.events);
  c.row("S11.duplicate-refund", (await w.entries()) === n);

  // A delivery whose handler fails is booked by our own retry job, without a redelivery.
  const late = c.driver.dashboardRefund(w, b.chargeId, 500n);
  const cash1 = await w.cash();
  const failed = await failingRefunds(w, () => w.deliver(late.events));
  const cashFailed = await w.cash();
  await systemDb.execute(
    sql`update graphile_worker._private_jobs set run_at = now() where key like ${`gwhook:${c.fixture.key}:${w.biz.id}:%`}`,
  );
  await drainStoredWebhooks();
  const nRetried = await w.entries();
  await w.redeliver();
  c.row(
    "S11.errored-retried-by-us",
    cashFailed === cash1 && (await w.cash()) === cash1 - 500n && (await w.entries()) === nRetried,
    `answer ${failed.status} cash on failure ${cashFailed - cash1} after job ${(await w.cash()) - cash1} (want -500)`,
  );
  c.row("S11.balanced", await w.balanced());
}

/** Run `fn` while every refund insert for this world's business fails. */
async function failingRefunds<T>(w: World, fn: () => Promise<T>): Promise<T> {
  const name = `conf_fail_refunds_${w.biz.id.replace(/-/g, "")}`;
  await systemDb.execute(
    sql.raw(`create function ${name}() returns trigger language plpgsql as $f$
      begin raise exception 'injected refund fault'; end $f$`),
  );
  await systemDb.execute(
    sql.raw(`create trigger ${name} before insert on refunds for each row
      when (new.business_id = '${w.biz.id}') execute function ${name}()`),
  );
  try {
    return await fn();
  } finally {
    await systemDb.execute(sql.raw(`drop trigger if exists ${name} on refunds`));
    await systemDb.execute(sql.raw(`drop function if exists ${name}()`));
  }
}

// ── S12 ─────────────────────────────────────────────────────────────────────
async function s12(c: Ctx) {
  const w = await c.world("s12");
  const b = await w.collected();
  const n = await w.entries();
  const r = c.driver.dashboardRefund(w, b.chargeId, 1000n);
  const res = await w.deliver(r.events, { secret: "whsec_conf_not_the_secret_000000" });
  const rows = await w.eventRows(r.events.flatMap((e) => e.eventIds));
  c.row(
    "S12.refused",
    res.status === c.driver.forgedStatus && rows.length === 0 && (await w.entries()) === n,
    `status ${res.status} (want ${c.driver.forgedStatus}) rows ${rows.length}`,
  );
}

// ── S14 ─────────────────────────────────────────────────────────────────────
function field(body: Record<string, unknown>, headers: Record<string, string>, path: string) {
  if (path.startsWith("header:")) return headers[path.slice(7).toLowerCase()];
  if (path in body) return body[path];
  return path
    .split(".")
    .reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], body);
}

async function s14(c: Ctx) {
  const d = c.driver;
  const w = await c.world("s14");
  const b = await w.bill();
  const pm = await instrument(w, b.paymentMethodId);
  const adapter = await adapterOf(w);
  // Engine-made fields at their real shape (`sub_<id>_first_charge_<pm>`, a public id);
  // over-long text only where an operator or a customer writes it.
  const id28 = (c0: string) => c0.repeat(28);
  const engineKey = (tag: string) => `sub_${id28("S")}_${tag}_${id28("P")}`;
  const long = "x".repeat(2000);
  const key = c.fixture.key as ProviderKey;
  const charge = (currency: string, amountMinor: bigint, tag: string) =>
    adapter
      .charge({
        amountMinor,
        currency,
        customer: { providerKey: key, providerCustomerId: pm.providerCustomerId },
        paymentMethod: {
          providerKey: key,
          providerPaymentMethodId: pm.providerPaymentMethodId,
          providerCustomerId: pm.providerCustomerId,
          display: {} as never,
        },
        idempotencyKey: engineKey(tag),
        ownershipRef: `inv_${id28("0")}`,
        description: long,
        // The longest address RFC 5321 allows.
        email: `${"a".repeat(64)}@${"b".repeat(184)}.test`,
      })
      .catch((e: Error) => e);
  await charge(c.fixture.currency, 1234n, "limits");
  const lastCharge = d.fake.callsOf(d.chargeOp).at(-1);
  await adapter
    .refund({
      providerChargeId: b.chargeId,
      amountMinor: 100n,
      currency: c.fixture.currency,
      idempotencyKey: `re_${id28("R")}`,
      ownershipRef: `re_${id28("R")}`,
      reason: long,
    })
    .catch((e: Error) => e);
  const lastRefund = d.fake.callsOf(d.refundOp).at(-1);
  for (const lim of c.fixture.limits ?? []) {
    const id = `S14.${lim.op}.${lim.field}`;
    if (!c.applies(id)) continue;
    const call =
      lim.op === d.chargeOp
        ? lastCharge
        : lim.op === d.refundOp
          ? lastRefund
          : d.fake.callsOf(lim.op).at(-1);
    const v = call ? field(call.body, call.headers, lim.field) : undefined;
    const len = typeof v === "string" ? v.length : v == null ? 0 : String(v).length;
    c.row(id, !!call && len <= lim.max, `${lim.field} length ${len} (max ${lim.max})`);
  }
  for (const ca of c.fixture.currencyAmounts ?? []) {
    const id = `S14.amount.${ca.currency}`;
    if (!c.applies(id)) continue;
    await charge(ca.currency, ca.minor, `cur_${ca.currency}`);
    const call = d.fake.callsOf(d.chargeOp).at(-1);
    const sent = call
      ? (field(call.body, call.headers, "amount") ??
        field(call.body, call.headers, "amount_money.amount") ??
        field(call.body, call.headers, "payments.amount"))
      : undefined;
    c.row(
      id,
      Number(sent) === ca.sent,
      `${ca.minor} ${ca.currency} sent as ${String(sent)} (want ${ca.sent})`,
    );
  }
}

const RUNNERS: Partial<Record<ScenarioId, (c: Ctx) => Promise<void>>> = {
  S1: s1,
  S2: s2,
  S3: s3,
  S4: s4,
  S5: s5,
  S6: s6,
  S7: s7,
  S8: s8,
  S9: s9,
  S10: s10,
  S11: s11,
  S12: s12,
  // S13 has no generic body: an alternate version is gateway-specific (extra rows).
  S14: s14,
};

/** Run every scenario of one fixture module. */
export async function runFixture(
  fixture: GatewayFixture,
  app: FastifyInstance,
  org: Org,
): Promise<RowResult[]> {
  const driver = fixture.driver();
  installFake(driver.fake);
  const out: RowResult[] = [];
  let worlds = 0;
  for (const scenario of SCENARIO_IDS) {
    const add = (id: string, outcome: RowResult["outcome"], detail?: unknown) =>
      out.push({
        gateway: fixture.key,
        scenario,
        id,
        outcome,
        ...(detail !== undefined && detail !== "" ? { detail: String(detail) } : {}),
      });
    const naScenario = fixture.na[scenario];
    const extras = (fixture.extraRows ?? []).filter((r) => r.scenario === scenario);
    if (naScenario && extras.length === 0) {
      add(scenario, "na", naScenario);
      continue;
    }
    const ctx: Ctx = {
      fixture,
      driver,
      world: (label, currency) =>
        newWorld(
          currency ? { ...fixture, currency } : fixture,
          driver,
          app,
          org,
          `${label}-${++worlds}`,
        ),
      row: (id, pass, detail) => add(id, pass ? "pass" : "fail", pass ? undefined : detail),
      applies: (id) => {
        const reason = fixture.na[id];
        if (reason) add(id, "na", reason);
        return !reason;
      },
    };
    const run = RUNNERS[scenario];
    if (!naScenario && run) {
      try {
        await run(ctx);
      } catch (e) {
        add(`${scenario}.ran`, "fail", (e as Error).stack?.split("\n").slice(0, 3).join(" | "));
      } finally {
        driver.fake.clearFaults();
      }
    } else if (!naScenario && extras.length === 0) {
      add(
        `${scenario}.declared`,
        "fail",
        `${SCENARIOS[scenario]}: add rows for it, or declare it n/a`,
      );
    }
    for (const extra of extras) {
      if (!ctx.applies(extra.id)) continue;
      try {
        const r = await extra.run({ world: ctx.world });
        add(extra.id, r.pass ? "pass" : "fail", r.pass ? undefined : r.detail);
      } catch (e) {
        add(extra.id, "fail", (e as Error).message);
      } finally {
        driver.fake.clearFaults();
      }
    }
  }
  return out;
}
