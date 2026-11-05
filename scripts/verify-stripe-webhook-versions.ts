/**
 * Stripe webhooks book the same money whatever API version renders them.
 *
 * An endpoint delivers events in ITS API version, not the SDK's. Each case below runs
 * through the real route twice: with events rendered at 2020-03-02 and at
 * 2026-05-27.dahlia (`test/unit/fixtures/stripe-webhook-versions.json`, captured from a
 * test account with the ids replaced). What regresses without it:
 *  - the card updater's pre-2020-08-27 name is ignored, so a reissued card stays expired;
 *  - on dahlia a Charge has no `refunds`, so a dashboard refund is booked without its
 *    refund id, and `refund.failed` cannot reverse it;
 *  - a pending refund of ours settles only from `charge.refunded`'s embedded list;
 *  - only one signing secret verifies, so an endpoint cannot be replaced without loss.
 *
 * Offline: Stripe is a double (`lib/stripe-double.ts`). A 2020-03-02 event is normalized
 * from its object read at our version, so the double serves that event's dahlia twin;
 * a refunds list returns only the refunds served so far.
 *
 *   pnpm verify:stripe-webhook-versions
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import Stripe from "stripe";
import { buildApp } from "@/index";
import { systemDb, withTenant, closeDb } from "@/platform/db";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createGatewayAccount, updateGatewayAccount } from "@/modules/gateway/service";
import { createCustomer } from "@/modules/customers/service";
import { publicId } from "@/platform/ids";
import { ledgerEntries, paymentMethods, payments, providerEvents, refunds } from "@db/schema";
import fixtures from "../test/unit/fixtures/stripe-webhook-versions.json";
import { installStripeDouble } from "./lib/stripe-double";

const checks: [string, boolean, string?][] = [];
const ok = (n: string, c: boolean, detail?: string) => checks.push([n, c, detail]);
const RUN = randomUUID().replace(/-/g, "").slice(0, 10);
const SECRET = `whsec_versions_${RUN}`;
const NEXT = `whsec_versions_next_${RUN}`;
let seq = 0;

type Fixture = Record<string, unknown>;
const VERSIONS: [string, Fixture][] = [
  ["2020-03-02", fixtures.v2020],
  ["dahlia", fixtures.dahlia],
];

/** A fixture event with its ids swapped for this run's, and a fresh event id. */
function rebind(event: unknown, ids: Record<string, string>, edit?: (o: any) => void): any {
  let body = JSON.stringify(event);
  for (const [from, to] of Object.entries(ids)) body = body.split(from).join(to);
  const out = JSON.parse(body);
  out.id = `evt_${RUN}${String(++seq).padStart(4, "0")}`;
  edit?.(out.data.object);
  return out;
}

/** The dahlia twin of a 2020-03-02 fixture: the same object read at our version. */
const TWIN: Record<string, string> = {
  "payment_method.card_automatically_updated": "payment_method.automatically_updated",
};

async function main() {
  const stripe = installStripeDouble();
  const app = await buildApp({ logger: false });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;

  const org = await createOrganization({ name: "Stripe Versions Co" });
  const orgId = org.organization.id;
  const biz = await createBusiness({
    organizationId: orgId,
    name: "Versions Biz",
    defaultCurrency: "USD",
    livemode: "test",
  });
  const acct = await createGatewayAccount({
    organizationId: orgId,
    businessId: biz.id,
    gatewayKey: "stripe",
    label: "Stripe",
    credentials: { secret_key: "sk_test_versions", webhook_secret: SECRET },
  });
  const customer = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: `versions_${RUN}@example.com`,
  });

  const deliver = async (event: unknown, opts: { secret?: string; account?: string } = {}) => {
    const body = JSON.stringify(event);
    const res = await fetch(
      `${base}/v1/gateway_webhooks/stripe?id=${opts.account ?? acct.publicId}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "stripe-signature": Stripe.webhooks.generateTestHeaderString({
            payload: body,
            secret: opts.secret ?? SECRET,
          }),
        },
        body,
      },
    );
    return res.status;
  };
  /** Rebind fixture `key`, serve its object at our version, deliver it. */
  const send = (f: Fixture, key: string, ids: Record<string, string>, edit?: (o: any) => void) => {
    const twin = (fixtures.dahlia as Fixture)[TWIN[key] ?? key];
    stripe.serve(rebind(twin, ids, edit).data.object);
    const event = rebind(f[key], ids, edit);
    return deliver(event).then((status) => ({ event, status }));
  };
  const outcome = async (event: { id: string }) =>
    (
      await systemDb
        .select({ outcome: providerEvents.outcome })
        .from(providerEvents)
        .where(eq(providerEvents.providerEventId, event.id))
        .limit(1)
    )[0]?.outcome;

  const newPayment = async (pi: string) =>
    (
      await withTenant(orgId, (tx) =>
        tx
          .insert(payments)
          .values({
            organizationId: orgId,
            businessId: biz.id,
            customerId: customer.id,
            publicId: publicId("pay"),
            status: "succeeded",
            amountMinor: 3000n,
            currency: "USD",
            providerKey: "stripe",
            providerChargeId: pi,
          })
          .returning(),
      )
    )[0]!;
  const refundsOf = (paymentId: string) =>
    withTenant(orgId, (tx) => tx.select().from(refunds).where(eq(refunds.paymentId, paymentId)));
  const postings = async (sourceType: string, sourceIds: string[]) =>
    sourceIds.length === 0
      ? []
      : withTenant(orgId, (tx) =>
          tx
            .select()
            .from(ledgerEntries)
            .where(
              and(
                eq(ledgerEntries.sourceType, sourceType),
                inArray(ledgerEntries.sourceId, sourceIds),
              ),
            ),
        );

  for (const [version, f] of VERSIONS) {
    const v = version === "dahlia" ? "d" : "o";
    const tag = (s: string) => `${version}: ${s}`;

    // ── A · two dashboard partial refunds, each reported by four events ─────────
    {
      const ids = {
        pi_XXXXXXXXXXXX01: `pi_${RUN}${v}A`,
        ch_XXXXXXXXXXXX01: `ch_${RUN}${v}A`,
        re_XXXXXXXXXXXX01: `re_${RUN}${v}A1`,
        re_XXXXXXXXXXXX02: `re_${RUN}${v}A2`,
      };
      const pay = await newPayment(ids.pi_XXXXXXXXXXXX01);
      const order = [
        "charge.refunded#1",
        "refund.created#1",
        "refund.updated#1",
        "charge.refund.updated#1",
        "refund.created#2",
        "charge.refunded#2",
      ];
      const statuses: number[] = [];
      for (const key of order) statuses.push((await send(f, key, ids)).status);
      ok(
        tag("every refund event accepted (200)"),
        statuses.every((s) => s === 200),
        `${statuses}`,
      );
      const rows = await refundsOf(pay.id);
      const got = rows
        .map((r) => `${r.providerRefundId}:${r.amountMinor}:${r.status}`)
        .sort()
        .join(",");
      ok(
        tag("two partial refunds booked once each, with their gateway refund ids"),
        got === `${ids.re_XXXXXXXXXXXX01}:1000:succeeded,${ids.re_XXXXXXXXXXXX02}:500:succeeded`,
        got,
      );
      const lines = await postings(
        "refund",
        rows.map((r) => r.publicId),
      );
      const cash = lines
        .filter((l) => l.account === "cash" && l.direction === "credit")
        .reduce((s, l) => s + l.amountMinor, 0n);
      ok(tag("ledger credits cash 1500, not more"), cash === 1500n, `cash=${cash}`);
    }

    // ── B · a pending refund of ours settles from the Refund event ──────────────
    {
      const ids = {
        pi_XXXXXXXXXXXX01: `pi_${RUN}${v}B`,
        ch_XXXXXXXXXXXX01: `ch_${RUN}${v}B`,
        re_XXXXXXXXXXXX01: `re_${RUN}${v}B1`,
      };
      const pay = await newPayment(ids.pi_XXXXXXXXXXXX01);
      const ourRef = publicId("re");
      await withTenant(orgId, (tx) =>
        tx.insert(refunds).values({
          organizationId: orgId,
          businessId: biz.id,
          paymentId: pay.id,
          publicId: ourRef,
          status: "pending",
          amountMinor: 1000n,
          currency: "USD",
          providerKey: "stripe",
          providerRefundId: ids.re_XXXXXXXXXXXX01,
        }),
      );
      const { status } = await send(f, "refund.updated#1", ids, (o) => {
        o.metadata = { tmbilling_ref: ourRef };
      });
      const rows = await refundsOf(pay.id);
      ok(
        tag("our pending refund settles from refund.updated"),
        status === 200 && rows.length === 1 && rows[0]!.status === "succeeded",
        `${status} ${rows.map((r) => r.status)}`,
      );
      ok(tag("settling books nothing new"), (await postings("refund", [ourRef])).length === 0);

      // Ours but not yet recorded under its gateway id: left to our own refund path.
      const raceRef = publicId("re");
      await send(f, "refund.created#2", { ...ids, re_XXXXXXXXXXXX02: `re_${RUN}${v}B2` }, (o) => {
        o.metadata = { tmbilling_ref: raceRef };
      });
      ok(
        tag("an unrecorded refund of ours is not booked as out of band"),
        (await refundsOf(pay.id)).length === 1,
      );
    }

    // ── C · a dashboard refund that later fails is reversed by its id ───────────
    {
      const ids = {
        pi_XXXXXXXXXXXX02: `pi_${RUN}${v}C`,
        ch_XXXXXXXXXXXX02: `ch_${RUN}${v}C`,
        re_XXXXXXXXXXXX03: `re_${RUN}${v}C3`,
      };
      const pay = await newPayment(ids.pi_XXXXXXXXXXXX02);
      await send(f, "charge.refunded#failing", ids);
      await send(f, "refund.created#failing", ids);
      const booked = await refundsOf(pay.id);
      ok(
        tag("dashboard refund booked with its refund id"),
        booked.length === 1 &&
          booked[0]!.providerRefundId === ids.re_XXXXXXXXXXXX03 &&
          booked[0]!.amountMinor === 3000n,
        booked.map((r) => `${r.providerRefundId}:${r.amountMinor}`).join(","),
      );
      const { event: failed } = await send(f, "refund.failed", ids);
      await send(f, "charge.refund.updated#failed", ids);
      const after = await refundsOf(pay.id);
      const reversal = await postings(
        "refund_reversal",
        after.map((r) => r.publicId),
      );
      ok(
        tag("refund.failed reverses it once"),
        (await outcome(failed)) === "processed" &&
          after.length === 1 &&
          after[0]!.status === "failed" &&
          reversal.length === 2,
        `outcome=${await outcome(failed)} status=${after.map((r) => r.status)} lines=${reversal.length}`,
      );
    }

    // ── E · the card updater, under this version's event name ───────────────────
    {
      const pmId = `pm_${RUN}${v}E`;
      const [pm] = await withTenant(orgId, (tx) =>
        tx
          .insert(paymentMethods)
          .values({
            organizationId: orgId,
            businessId: biz.id,
            customerId: customer.id,
            publicId: publicId("pm"),
            providerKey: "stripe",
            providerCustomerId: `cus_${RUN}${v}`,
            providerPaymentMethodId: pmId,
            type: "card",
            brand: "visa",
            last4: "4242",
            expMonth: 10,
            expYear: 2027,
            status: "expired",
          })
          .returning(),
      );
      const key =
        version === "dahlia"
          ? "payment_method.automatically_updated"
          : "payment_method.card_automatically_updated";
      const { status } = await send(f, key, { pm_XXXXXXXXXXXX01: pmId });
      const [row] = await withTenant(orgId, (tx) =>
        tx.select().from(paymentMethods).where(eq(paymentMethods.id, pm!.id)),
      );
      ok(
        tag(`${key} refreshes the expiry and revives the card`),
        status === 200 && row?.expMonth === 4 && row?.expYear === 2030 && row?.status === "valid",
        `${status} ${row?.expMonth}/${row?.expYear} ${row?.status}`,
      );
    }
  }

  // ── F · a second signing secret, kept across a credential update ──────────────
  {
    const second = await createGatewayAccount({
      organizationId: orgId,
      businessId: biz.id,
      gatewayKey: "stripe",
      label: "Stripe (replacing endpoint)",
      credentials: {
        secret_key: "sk_test_versions",
        webhook_secret: SECRET,
        webhook_secret_next: NEXT,
      },
    });
    const ping = () => rebind(fixtures.dahlia["payment_method.automatically_updated"], {});
    ok(
      "second signing secret accepted (200)",
      (await deliver(ping(), { secret: NEXT, account: second.publicId })) === 200,
    );
    ok(
      "first signing secret still accepted (200)",
      (await deliver(ping(), { account: second.publicId })) === 200,
    );
    ok(
      "any other secret refused (400)",
      (await deliver(ping(), { secret: `whsec_other_${RUN}`, account: second.publicId })) === 400,
    );
    ok(
      "an account without it refuses the second secret (400)",
      (await deliver(ping(), { secret: NEXT })) === 400,
    );
    await updateGatewayAccount({
      organizationId: orgId,
      businessId: biz.id,
      gwaPublicId: second.publicId,
      credentials: { secret_key: "sk_test_versions_rotated" },
    });
    ok(
      "a secret-key rotation keeps the second signing secret (200)",
      (await deliver(ping(), { secret: NEXT, account: second.publicId })) === 200,
    );
  }

  // Object reads, not refund lists: `GET /v1/<kind>/<id>`.
  const objectReads = stripe.reads.filter((r) => /^GET \/v1\/\w+\/\w+$/.test(r));
  ok(
    "a 2020-03-02 event reads its object at our version; a dahlia event does not",
    objectReads.length > 0 && objectReads.every((r) => r.includes(`_${RUN}o`)),
    objectReads.filter((r) => !r.includes(`_${RUN}o`)).join(" | ") || `reads=${objectReads.length}`,
  );
  stripe.restore();
  await app.close();
  await closeDb();
  let pass = true;
  console.log("");
  for (const [n, c, d] of checks) {
    console.log(`  ${c ? "✓" : "✗"} ${n}${!c && d ? `  — ${d}` : ""}`);
    if (!c) pass = false;
  }
  console.log("");
  console.log(pass ? "✅ STRIPE WEBHOOK VERSIONS: PASS" : "❌ STRIPE WEBHOOK VERSIONS: FAIL");
  process.exit(pass ? 0 : 1);
}

void main();
