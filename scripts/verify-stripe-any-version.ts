/**
 * Stripe webhooks book the same money whatever API version the endpoint is on.
 *
 * Drives every captured flow (`test/unit/fixtures/stripe-webhook-any-version.json`: a
 * charge, two partial refunds, a refund that fails, a dispute won, a decline, a card
 * update and detach, setup intents, a hold released, a late challenge) through the real
 * route at five API versions, and compares what each version booked with the pinned one:
 * the normalized event and outcome of every delivery, refunds, ledger, disputes and the
 * stored card.
 *
 * Stripe is a double (`lib/stripe-double.ts`) serving each object as it stood when its
 * event was raised, at our version. Also checked:
 *  - only events below our version read their object, once each, and only money events;
 *  - a payload cut to its id and kind books the same (the payload is not read);
 *  - a delivery read late, at the objects' final state, books the same money;
 *  - a failed read books nothing, answers 502, and the redelivery books once.
 *
 *   pnpm verify:stripe-any-version
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import Stripe from "stripe";
import { buildApp } from "@/index";
import { systemDb, withTenant, closeDb } from "@/platform/db";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createGatewayAccount } from "@/modules/gateway/service";
import { createCustomer } from "@/modules/customers/service";
import { publicId } from "@/platform/ids";
import { STRIPE_API_VERSION } from "@/providers/stripe";
import {
  disputes,
  ledgerEntries,
  paymentMethods,
  payments,
  providerEvents,
  refunds,
} from "@db/schema";
import fixture from "../test/unit/fixtures/stripe-webhook-any-version.json";
import { installStripeDouble } from "./lib/stripe-double";

type Obj = {
  id: string;
  object: string;
  charge?: string;
  payment_intent?: string;
  status?: string;
  created?: number;
} & Record<string, unknown>;
type Row = { id: string; type: string; created: number; objects: Record<string, Obj> };

const checks: [string, boolean, string?][] = [];
const ok = (n: string, c: boolean, detail?: string) => checks.push([n, c, detail]);
const RUN = randomUUID().replace(/-/g, "").slice(0, 8);
const SECRET = `whsec_any_${RUN}`;
const PINNED = STRIPE_API_VERSION;
const VERSIONS = fixture.versions;

/** Event types that book money or change an instrument: read once below our version. */
const READ_TYPES = new Set([
  "charge.succeeded",
  "charge.failed",
  "charge.refunded",
  "charge.refund.updated",
  "refund.created",
  "refund.updated",
  "refund.failed",
  "payment_intent.succeeded",
  "payment_intent.payment_failed",
  "payment_intent.amount_capturable_updated",
  "payment_intent.canceled",
  "payment_intent.requires_action",
  "charge.dispute.created",
  "charge.dispute.updated",
  "charge.dispute.funds_withdrawn",
  "charge.dispute.funds_reinstated",
  "charge.dispute.closed",
  "payment_method.updated",
  "payment_method.detached",
  "setup_intent.succeeded",
  "setup_intent.setup_failed",
  "setup_intent.requires_action",
  "mandate.updated",
]);

/** The fixture with every id made unique to one pass. */
function bind(tag: string): { rows: Row[]; final: Obj[] } {
  const text = JSON.stringify({ rows: fixture.events, final: fixture.final });
  return JSON.parse(text.split("_XXXXXXXXXXXX").join(`_${RUN}${tag}`));
}
const unbind = (v: unknown, tag: string) =>
  JSON.parse(JSON.stringify(v).split(`_${RUN}${tag}`).join("_XXXXXXXXXXXX"));

async function main() {
  const stripe = installStripeDouble();
  const app = await buildApp({ logger: false });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;

  const org = await createOrganization({ name: "Stripe Any Version Co" });
  const orgId = org.organization.id;
  const biz = await createBusiness({
    organizationId: orgId,
    name: "Any Version Biz",
    defaultCurrency: "USD",
    livemode: "test",
  });
  const acct = await createGatewayAccount({
    organizationId: orgId,
    businessId: biz.id,
    gatewayKey: "stripe",
    label: "Stripe",
    credentials: { secret_key: "sk_test_any_version", webhook_secret: SECRET },
  });
  const customer = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: `any_version_${RUN}@example.com`,
  });

  const post = async (event: unknown) => {
    const body = JSON.stringify(event);
    const res = await fetch(`${base}/v1/gateway_webhooks/stripe?id=${acct.publicId}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "stripe-signature": Stripe.webhooks.generateTestHeaderString({
          payload: body,
          secret: SECRET,
        }),
      },
      body,
    });
    return res.status;
  };
  const envelope = (row: Row, version: string, object: Obj, id = row.id) => ({
    id,
    object: "event",
    api_version: version,
    created: row.created,
    livemode: false,
    type: row.type,
    data: { object },
  });

  /** The local records a flow needs: our payments and the stored card. */
  async function seed(rows: Row[]) {
    const pinned = rows.map((r) => r.objects[PINNED]!);
    const paid = [
      ...new Set(
        pinned
          .filter((o) => o.object === "payment_intent" && o.status === "succeeded")
          .map((o) => o.id),
      ),
    ];
    const pays = await withTenant(orgId, (tx) =>
      tx
        .insert(payments)
        .values(
          paid.map((pi) => ({
            organizationId: orgId,
            businessId: biz.id,
            customerId: customer.id,
            publicId: publicId("pay"),
            status: "succeeded" as const,
            amountMinor: 3000n,
            currency: "USD",
            providerKey: "stripe",
            providerChargeId: pi,
          })),
        )
        .returning(),
    );
    const pmIds = [
      ...new Set(pinned.filter((o) => o.object === "payment_method").map((o) => o.id)),
    ];
    const pms = pmIds.length
      ? await withTenant(orgId, (tx) =>
          tx
            .insert(paymentMethods)
            .values(
              pmIds.map((id) => ({
                organizationId: orgId,
                businessId: biz.id,
                customerId: customer.id,
                publicId: publicId("pm"),
                providerKey: "stripe",
                providerCustomerId: `cus_${RUN}`,
                providerPaymentMethodId: id,
                type: "card" as const,
                brand: "visa",
                last4: "4242",
                expMonth: 10,
                expYear: 2027,
                status: "valid" as const,
              })),
            )
            .returning(),
        )
      : [];
    const pm = pms[0];
    return { pays, pm, pms };
  }

  /** What one pass booked, with its ids put back to the fixture's. */
  async function summary(tag: string, rows: Row[], seeded: Awaited<ReturnType<typeof seed>>) {
    const ids = rows.map((r) => r.id);
    const events = await systemDb
      .select()
      .from(providerEvents)
      .where(
        and(eq(providerEvents.providerKey, "stripe"), inArray(providerEvents.providerEventId, ids)),
      );
    const byId = new Map(events.map((e) => [e.providerEventId, e]));
    const delivered = rows.map((r) => {
      const e = byId.get(r.id);
      const n = (e?.normalized ?? {}) as Record<string, unknown>;
      const { raw: _raw, ...rest } = n;
      return { type: r.type, outcome: e?.outcome ?? null, normalized: rest };
    });
    const payIds = seeded.pays.map((p) => p.id);
    const refundRows = payIds.length
      ? await withTenant(orgId, (tx) =>
          tx.select().from(refunds).where(inArray(refunds.paymentId, payIds)),
        )
      : [];
    const sources = refundRows.map((r) => r.publicId);
    const lines = sources.length
      ? await withTenant(orgId, (tx) =>
          tx.select().from(ledgerEntries).where(inArray(ledgerEntries.sourceId, sources)),
        )
      : [];
    const cash = lines
      .filter((l) => l.account === "cash")
      .reduce((s, l) => s + (l.direction === "credit" ? -l.amountMinor : l.amountMinor), 0n);
    const disputeRows = payIds.length
      ? await withTenant(orgId, (tx) =>
          tx.select().from(disputes).where(inArray(disputes.paymentId, payIds)),
        )
      : [];
    const [card] = seeded.pm
      ? await withTenant(orgId, (tx) =>
          tx.select().from(paymentMethods).where(eq(paymentMethods.id, seeded.pm!.id)),
        )
      : [];
    const instruments = await withTenant(orgId, (tx) =>
      tx
        .select()
        .from(paymentMethods)
        .where(
          inArray(
            paymentMethods.id,
            seeded.pms.map((p) => p.id),
          ),
        ),
    );
    return unbind(
      {
        delivered,
        refunds: refundRows.map((r) => `${r.providerRefundId}:${r.amountMinor}:${r.status}`).sort(),
        ledgerLines: lines.length,
        cash: String(cash),
        disputes: disputeRows
          .map((d) => `${d.providerDisputeId}:${d.status}:${d.amountMinor}:${d.fundsWithdrawn}`)
          .sort(),
        card: card ? `${card.expMonth}/${card.expYear}:${card.status}` : null,
        instruments: instruments
          .map(
            (p) =>
              `${p.providerPaymentMethodId}:${p.status}:${p.mandateStatus}:${p.mandateRail}:${p.mandateReference}`,
          )
          .sort(),
      },
      tag,
    );
  }

  /** One pass: deliver every event at `version`, serving each object as of its event. */
  async function pass(tag: string, version: string, opts: { late?: boolean; cut?: boolean } = {}) {
    const { rows, final } = bind(tag);
    const seeded = await seed(rows);
    if (opts.late) stripe.serve(...final);
    const readsBefore = stripe.reads.length;
    const statuses: number[] = [];
    const reads: number[] = [];
    for (const row of rows) {
      if (!opts.late) stripe.serve(row.objects[PINNED]!);
      const object = row.objects[version]!;
      const n = stripe.reads.length;
      statuses.push(
        await post(
          envelope(
            row,
            version,
            opts.cut ? ({ id: object.id, object: object.object } as Obj) : object,
          ),
        ),
      );
      reads.push(stripe.reads.slice(n).filter((r) => /^GET \/v1\/\w+\/\w+$/.test(r)).length);
    }
    return {
      statuses,
      reads,
      allReads: stripe.reads.slice(readsBefore),
      summary: await summary(tag, rows, seeded),
      rows,
    };
  }

  // ── every version books what the pinned version books ───────────────────────
  const pinned = await pass("p", PINNED);
  ok(
    `${PINNED}: every delivery answered 200`,
    pinned.statuses.every((s) => s === 200),
    `${pinned.statuses}`,
  );
  ok(
    `${PINNED}: no object read at our version`,
    pinned.reads.every((n) => n === 0),
    `${pinned.reads}`,
  );
  const s = pinned.summary as {
    refunds: string[];
    cash: string;
    disputes: string[];
    card: string;
    instruments: string[];
    delivered: { type: string; outcome: string }[];
  };
  const outcomes: Record<string, number> = {};
  for (const d of s.delivered) outcomes[d.outcome] = (outcomes[d.outcome] ?? 0) + 1;
  console.log(
    `  pinned books: ${JSON.stringify(outcomes)} refunds=${s.refunds.length} cash=${s.cash} ` +
      `disputes=${s.disputes.length} card=${s.card}`,
  );
  ok(
    "two partial refunds booked once each",
    s.refunds.filter((r) => /:1000:succeeded$|:500:succeeded$/.test(r)).length === 2,
    s.refunds.join(","),
  );
  ok(
    "the refund that failed 68 minutes later is reversed: row failed, cash nets to the two partials",
    s.refunds.some((r) => r.endsWith(":3000:failed")) && s.cash === "-1500",
    `${s.refunds.join(",")} cash=${s.cash}`,
  );
  ok(
    "the India e-mandate is stored as confirmed on its card",
    s.instruments.some((i) => /:confirmed:card:mandate_/.test(i)),
    s.instruments.join(","),
  );
  ok(
    "the dispute is recorded as won",
    s.disputes.some((d) => d.includes(":won:3000:")),
    s.disputes.join(","),
  );
  ok("the card update is stored", s.card === "4/2030:invalid" || s.card === "4/2030:valid", s.card);

  for (const [i, version] of VERSIONS.entries()) {
    if (version === PINNED) continue;
    const r = await pass(`v${i}`, version);
    ok(
      `${version}: every delivery answered 200`,
      r.statuses.every((x) => x === 200),
      `${r.statuses}`,
    );
    const wrongReads = r.rows
      .map((row, k) => [row.type, r.reads[k]!, READ_TYPES.has(row.type) ? 1 : 0] as const)
      .filter(([, got, want]) => got !== want);
    ok(
      `${version}: each money event read its object once; no other event read anything`,
      wrongReads.length === 0,
      wrongReads.map(([t, got, want]) => `${t} read ${got}, want ${want}`).join("; "),
    );
    const same = JSON.stringify(r.summary) === JSON.stringify(pinned.summary);
    ok(
      `${version}: books exactly what ${PINNED} books`,
      same,
      same ? "" : diff(pinned.summary, r.summary),
    );
  }

  // ── the payload is not read: cut to id and kind, it books the same ──────────
  for (const version of ["2017-08-15", "2019-02-19"]) {
    const r = await pass(`c${version.slice(2, 4)}`, version, { cut: true });
    const money = (x: typeof r.summary) =>
      JSON.stringify({
        ...x,
        delivered: x.delivered.filter((d: { type: string }) => READ_TYPES.has(d.type)),
      });
    const same = money(r.summary) === money(pinned.summary);
    ok(
      `${version}, payload cut to id and kind: books the same`,
      same,
      same ? "" : diff(pinned.summary, r.summary),
    );
  }

  // ── read late, at the final state: the same money ─────────────────────────────
  {
    const r = await pass("late", "2017-08-15", { late: true });
    const late = r.summary as typeof s;
    ok(
      "late delivery: same cash, disputes and card",
      late.cash === s.cash &&
        JSON.stringify(late.disputes) === JSON.stringify(s.disputes) &&
        late.card === s.card,
      `cash ${late.cash} vs ${s.cash}; ${late.disputes} vs ${s.disputes}; ${late.card} vs ${s.card}`,
    );
    ok(
      "late delivery: every delivery answered 200",
      r.statuses.every((x) => x === 200),
      `${r.statuses}`,
    );
  }

  // ── a failed read books nothing; the redelivery books once ─────────────────────
  {
    const { rows } = bind("f");
    const seeded = await seed(rows);
    const k = rows.findIndex((row) => row.type === "refund.created");
    const row = rows[k]!;
    const old = row.objects["2017-08-15"]!;
    for (const prior of rows.slice(0, k)) stripe.serve(prior.objects[PINNED]!);
    stripe.serve(row.objects[PINNED]!);
    stripe.failing.add(old.id);
    const event = envelope(row, "2017-08-15", old);
    const first = await post(event);
    const [logged] = await systemDb
      .select()
      .from(providerEvents)
      .where(eq(providerEvents.providerEventId, row.id));
    const pay = seeded.pays.find((p) => p.providerChargeId === old.payment_intent)!;
    const before = await withTenant(orgId, (tx) =>
      tx.select().from(refunds).where(eq(refunds.paymentId, pay.id)),
    );
    ok(
      "failed read: answered 502, logged as error, nothing booked",
      first === 502 &&
        logged?.outcome === "error" &&
        /^We could not read refund re_/.test(logged?.error ?? "") &&
        before.length === 0,
      `${first} ${logged?.outcome} ${logged?.error} refunds=${before.length}`,
    );
    stripe.failing.delete(old.id);
    const second = await post(event);
    const third = await post(event);
    const after = await withTenant(orgId, (tx) =>
      tx.select().from(refunds).where(eq(refunds.paymentId, pay.id)),
    );
    const [relogged] = await systemDb
      .select()
      .from(providerEvents)
      .where(eq(providerEvents.providerEventId, row.id));
    ok(
      "redelivery after the read recovers: booked once, a third delivery is a duplicate",
      second === 200 &&
        third === 200 &&
        relogged?.outcome === "processed" &&
        after.length === 1 &&
        after[0]!.amountMinor === 1000n,
      `${second} ${third} ${relogged?.outcome} ${after.map((r) => `${r.amountMinor}`)}`,
    );
  }

  stripe.restore();
  await app.close();
  await closeDb();
  let passed = true;
  console.log("");
  for (const [n, c, d] of checks) {
    console.log(`  ${c ? "✓" : "✗"} ${n}${!c && d ? `  — ${d}` : ""}`);
    if (!c) passed = false;
  }
  console.log("");
  console.log(passed ? "✅ STRIPE ANY VERSION: PASS" : "❌ STRIPE ANY VERSION: FAIL");
  process.exit(passed ? 0 : 1);
}

/** The first few paths where two summaries differ. */
function diff(a: unknown, b: unknown, path = "", out: string[] = []): string {
  if (out.length >= 6) return out.join("; ");
  if (JSON.stringify(a) === JSON.stringify(b)) return out.join("; ");
  if (a && b && typeof a === "object" && typeof b === "object") {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      diff(
        (a as Record<string, unknown>)[k],
        (b as Record<string, unknown>)[k],
        `${path}.${k}`,
        out,
      );
    }
  } else {
    out.push(`${path}: ${JSON.stringify(a)?.slice(0, 80)} → ${JSON.stringify(b)?.slice(0, 80)}`);
  }
  return out.join("; ");
}

void main();
