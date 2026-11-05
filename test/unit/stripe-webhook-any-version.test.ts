/**
 * A Stripe endpoint delivers events in its own API version, which can be any version
 * since 2015. These events were captured from a test account (ids, emails and names
 * replaced) and rendered at five versions: each object read at that version right after
 * the step that raised the event. 2020-03-02 is the real delivered payload.
 *
 * What regresses without the fix: an event below our pinned version is parsed from its
 * old shape, so a field that moved or vanished in that version books wrong or not at
 * all. With it, every money event is normalized from its object read at our version,
 * and the payload gives only the id, the kind, the event type and `created`.
 */
import { beforeAll, describe, it, expect, vi } from "vitest";
import Stripe from "stripe";
import { StripeProvider, STRIPE_API_VERSION } from "@/providers/stripe";
import type { NormalizedProviderEvent } from "@/providers/types";
import fixture from "./fixtures/stripe-webhook-any-version.json";

type Obj = { id: string; object: string; charge?: string; created?: number } & Record<
  string,
  unknown
>;
type Row = { id: string; type: string; created: number; objects: Record<string, Obj> };
const ROWS = fixture.events as unknown as Row[];
const FINAL = fixture.final as unknown as Obj[];
const VERSIONS = fixture.versions;
const PINNED = STRIPE_API_VERSION;
const SECRET = "whsec_unit_any_version";

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

/** Every flow the fixture must carry. */
const CAPTURED = [
  "payment_intent.created",
  "payment_intent.succeeded",
  "charge.succeeded",
  "charge.refunded",
  "refund.created",
  "refund.updated",
  "charge.refund.updated",
  "refund.failed",
  "charge.dispute.created",
  "charge.dispute.funds_withdrawn",
  "charge.dispute.updated",
  "charge.dispute.closed",
  "charge.dispute.funds_reinstated",
  "charge.failed",
  "payment_intent.payment_failed",
  "payment_method.attached",
  "payment_method.updated",
  "payment_method.detached",
  "setup_intent.created",
  "setup_intent.succeeded",
  "setup_intent.setup_failed",
  "payment_intent.amount_capturable_updated",
  "payment_intent.canceled",
  "payment_intent.requires_action",
  "setup_intent.requires_action",
  "mandate.updated",
];

/**
 * A provider whose Stripe client serves each object as it stood when the event being
 * delivered was raised, at our version. `late` serves the final state instead.
 */
function provider(opts: { late?: boolean; failReads?: boolean } = {}) {
  const p = new StripeProvider("sk_test_unit", SECRET);
  let now = 0;
  const asOf = (id: string): Obj | undefined => {
    if (!opts.late) {
      for (let i = now; i >= 0; i--) {
        const o = ROWS[i]!.objects[PINNED]!;
        if (o.id === id) return o;
      }
    }
    return FINAL.find((o) => o.id === id);
  };
  const retrieve = vi.fn(async (id: string) => {
    if (opts.failReads) throw new Stripe.errors.StripeAPIError({ message: "Stripe is down" });
    const o = asOf(id);
    if (!o) throw new Error(`no object ${id}`);
    return structuredClone(o);
  });
  const list = vi.fn(async (q: { charge: string; created: { lte: number } }) => {
    const ids = new Set(
      [...ROWS.slice(0, now + 1).map((r) => r.objects[PINNED]!), ...(opts.late ? FINAL : [])]
        .filter((o) => o.object === "refund" && o.charge === q.charge)
        .map((o) => o.id),
    );
    const data = [...ids]
      .map((id) => asOf(id)!)
      .filter((o) => (o.created ?? 0) <= q.created.lte)
      .sort((a, b) => (b.created ?? 0) - (a.created ?? 0));
    return { data, has_more: false };
  });
  const client = (p as unknown as { stripe: Record<string, Record<string, unknown>> }).stripe;
  for (const r of [
    "charges",
    "paymentIntents",
    "refunds",
    "disputes",
    "paymentMethods",
    "setupIntents",
    "mandates",
  ]) {
    client[r]!.retrieve = retrieve;
  }
  client.refunds!.list = list;
  const deliver = (i: number, version: string, reshape?: (o: Obj) => Obj) => {
    now = i;
    const row = ROWS[i]!;
    const object = reshape ? reshape(structuredClone(row.objects[version]!)) : row.objects[version];
    const body = JSON.stringify({
      id: row.id,
      object: "event",
      api_version: version,
      created: row.created,
      livemode: false,
      type: row.type,
      data: { object },
    });
    const header = Stripe.webhooks.generateTestHeaderString({ payload: body, secret: SECRET });
    return p.normalizeWebhook({ payload: body, headers: { "stripe-signature": header } });
  };
  return { p, retrieve, list, deliver };
}

/** What the engine books from: everything except the raw payload. */
const booked = (evs: NormalizedProviderEvent[]) =>
  evs.map(({ raw: _raw, ...ev }) =>
    JSON.parse(JSON.stringify(ev, (_k, v) => (typeof v === "bigint" ? `${v}n` : v))),
  );

async function run(
  version: string,
  opts?: Parameters<typeof provider>[0],
  reshape?: (o: Obj) => Obj,
) {
  const stub = provider(opts);
  const out = [];
  for (let i = 0; i < ROWS.length; i++) out.push(booked(await stub.deliver(i, version, reshape)));
  return { out, stub };
}

const at = (type: string, n = 1) => {
  let seen = 0;
  const i = ROWS.findIndex((r) => r.type === type && ++seen === n);
  if (i < 0) throw new Error(`no ${type} #${n} in the fixture`);
  return i;
};

describe("the fixture", () => {
  it("covers each money flow at five versions, pinned last", () => {
    expect(VERSIONS).toEqual(["2017-08-15", "2019-02-19", "2020-03-02", "2022-11-15", PINNED]);
    const types = new Set(ROWS.map((r) => r.type));
    for (const t of CAPTURED) expect(types.has(t), t).toBe(true);
  });
});

describe("Stripe money events book the same at every API version", () => {
  let pinned: Awaited<ReturnType<typeof run>>;
  beforeAll(async () => {
    pinned = await run(PINNED);
  });

  it.each(VERSIONS.filter((v) => v !== PINNED))(
    "%s books what the pinned version books",
    async (v) => {
      const { out } = await run(v);
      for (let i = 0; i < ROWS.length; i++)
        expect(out[i], `${ROWS[i]!.type} #${i}`).toEqual(pinned.out[i]);
    },
  );

  it("reads each money object once below our version, and never at it", async () => {
    expect(pinned.stub.retrieve).not.toHaveBeenCalled();
    for (const v of VERSIONS.filter((x) => x !== PINNED)) {
      const stub = provider();
      for (let i = 0; i < ROWS.length; i++) {
        stub.retrieve.mockClear();
        await stub.deliver(i, v);
        const row = ROWS[i]!;
        expect(stub.retrieve, `${v} ${row.type}`).toHaveBeenCalledTimes(
          READ_TYPES.has(row.type) ? 1 : 0,
        );
        if (READ_TYPES.has(row.type)) {
          expect(stub.retrieve).toHaveBeenCalledWith(row.objects[v]!.id);
        }
      }
    }
  });

  it("books from the object, not the payload: a payload cut to its id and kind books the same", async () => {
    const cut = (o: Obj) => ({ id: o.id, object: o.object }) as Obj;
    for (const v of ["2017-08-15", "2019-02-19"]) {
      const { out } = await run(v, {}, cut);
      for (let i = 0; i < ROWS.length; i++) {
        if (!READ_TYPES.has(ROWS[i]!.type)) continue;
        expect(out[i], `${v} ${ROWS[i]!.type} #${i}`).toEqual(pinned.out[i]);
      }
    }
  });

  it("books the flows' money", () => {
    const one = (type: string, n = 1) => pinned.out[at(type, n)]![0];
    const refunds = (type: string, n = 1) =>
      (one(type, n).refunds ?? []).map(
        (r: { amountMinor: string; status: string }) => `${r.amountMinor}:${r.status}`,
      );
    expect(one("charge.succeeded").type).toBe("charge.succeeded");
    expect(refunds("charge.refunded", 1)).toEqual(["1000n:succeeded"]);
    expect(refunds("charge.refunded", 2)).toEqual(["500n:succeeded", "1000n:succeeded"]);
    // A Charge's `failure_code` is the generic code; the intent carries the issuer's.
    expect(one("charge.failed")).toMatchObject({
      type: "charge.failed",
      providerFailureCode: "card_declined",
    });
    expect(one("payment_intent.payment_failed")).toMatchObject({
      type: "charge.failed",
      providerFailureCode: "insufficient_funds",
    });
    // The `pm_card_refundFail` refund: booked when it succeeded, failed 68 minutes later.
    expect(one("refund.failed")).toMatchObject({
      type: "refund.failed",
      providerRefundId: one("refund.created", 3).providerRefundId,
      providerFailureCode: "expired_or_canceled_card",
      amountRefundedMinor: "3000n",
    });
    expect(one("charge.refund.updated", 5)).toMatchObject({ type: "refund.failed" });
    expect(one("charge.dispute.created")).toMatchObject({
      type: "dispute.created",
      disputeAmountMinor: "3000n",
      disputeReason: "fraudulent",
    });
    expect(one("charge.dispute.closed").type).toBe("dispute.won");
    expect(one("payment_method.updated").card).toMatchObject({ expMonth: 4, expYear: 2030 });
    expect(one("payment_method.detached").type).toBe("payment_method.detached");
    expect(one("setup_intent.setup_failed")).toMatchObject({
      type: "intent.setup_failed",
      providerFailureCode: "generic_decline",
    });
    expect(one("payment_intent.amount_capturable_updated").type).toBe("intent.authorized");
    expect(one("payment_intent.canceled").type).toBe("intent.voided");
    expect(one("payment_intent.requires_action")).toMatchObject({
      type: "intent.requires_action",
      actionType: "redirect_to_url",
    });
    // India e-mandate: the setup asks for the bank's page, the mandate goes active, and
    // the off-session debit waits out the pre-debit notification, then settles.
    expect(one("setup_intent.requires_action")).toMatchObject({
      type: "intent.requires_action",
      actionType: "redirect_to_url",
    });
    const india = one("setup_intent.succeeded", 2);
    expect(india.type).toBe("intent.setup_succeeded");
    expect(one("mandate.updated")).toMatchObject({
      type: "payment_method.mandate_updated",
      providerPaymentMethodId: india.providerPaymentMethodId,
      mandate: { rail: "card", status: "confirmed" },
    });
    const debit = one("payment_intent.requires_action", 2);
    expect(debit).toMatchObject({
      type: "intent.requires_action",
      actionType: "card_await_notification",
    });
    // The pre-debit wait carries when Stripe will charge: `charge_attempt_at` on next_action.
    const waiting = ROWS[at("payment_intent.requires_action", 2)]!.objects[PINNED]! as unknown as {
      next_action: { card_await_notification: { charge_attempt_at: number } };
    };
    const attemptAt = waiting.next_action.card_await_notification.charge_attempt_at;
    expect(attemptAt).toBeGreaterThan(0);
    expect(debit.actionDeadline).toBe(new Date(attemptAt * 1000).toISOString());
    expect(one("payment_intent.succeeded", 4)).toMatchObject({
      type: "charge.succeeded",
      providerChargeId: debit.providerIntentId,
    });
    // Each dispute event names the PaymentIntent we store as the charge id.
    expect(one("charge.dispute.created").providerChargeId).toMatch(/^pi_/);
  });
});

describe("a read that fails", () => {
  it("books nothing from the old payload and marks the event unresolved", async () => {
    const stub = provider({ failReads: true });
    const i = at("charge.refunded");
    const [ev, ...rest] = await stub.deliver(i, "2017-08-15");
    expect(rest).toEqual([]);
    expect(ev?.type).toBe("charge.refunded");
    expect(ev?.unresolved).toMatch(
      /^We could not read charge ch_\w+ from Stripe\. Stripe is down\. Stripe sends the event again\.$/,
    );
    expect(ev?.refunds).toBeUndefined();
    expect(ev?.providerChargeId).toBeUndefined();
    expect(ev?.amountRefundedMinor).toBeUndefined();
  });

  it("costs nothing on an event we ignore or only record", async () => {
    const stub = provider({ failReads: true });
    for (const type of [
      "payment_intent.created",
      "payment_method.attached",
      "setup_intent.created",
    ]) {
      const [ev] = await stub.deliver(at(type), "2017-08-15");
      expect(ev?.unresolved, type).toBeUndefined();
    }
    expect(stub.retrieve).not.toHaveBeenCalled();
  });

  it("does not touch an event at our version", async () => {
    const stub = provider({ failReads: true });
    const [ev] = await stub.deliver(at("refund.created"), PINNED);
    expect(ev?.unresolved).toBeUndefined();
    expect(ev?.type).toBe("charge.refunded");
  });
});

describe("a late delivery reads the object as it stands now", () => {
  const succeeded = (out: Awaited<ReturnType<typeof run>>["out"]) =>
    new Set(
      out
        .flat()
        .flatMap((ev) => ev.refunds ?? [])
        .filter((r: { status: string }) => r.status === "succeeded")
        .map((r: { providerRefundId: string }) => r.providerRefundId),
    );

  it("books each refund that stayed succeeded, never one that failed since, and the verdict", async () => {
    const late = succeeded((await run("2017-08-15", { late: true })).out);
    const failedSince = new Set(
      FINAL.filter((o) => o.object === "refund" && o.status === "failed").map((o) => o.id),
    );
    expect(failedSince.size).toBe(1);
    const prompt = [...succeeded((await run(PINNED)).out)].filter((id) => !failedSince.has(id));
    expect([...late].sort()).toEqual(prompt.sort());
    const { out } = await run("2017-08-15", { late: true });
    expect(out[at("charge.dispute.created")]![0].disputeStatus).toBe("won");
  });
});

describe("provisioning a webhook endpoint", () => {
  const stubbed = (create: (params: Record<string, unknown>) => Promise<unknown>) => {
    const p = new StripeProvider("sk_test_unit");
    const calls: Record<string, unknown>[] = [];
    const client = (p as unknown as { stripe: { webhookEndpoints: Record<string, unknown> } })
      .stripe;
    client.webhookEndpoints.list = async () => ({ data: [] });
    client.webhookEndpoints.create = async (params: Record<string, unknown>) => {
      calls.push(params);
      return create(params);
    };
    return { p, calls };
  };

  it("pins the endpoint to the SDK's API version", async () => {
    const { p, calls } = stubbed(async () => ({ id: "we_XXXXXXXXXXXX01", secret: "whsec_x" }));
    const out = await p.provisionWebhookEndpoint({ url: "https://example.com/hook" });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ api_version: Stripe.API_VERSION, enabled_events: ["*"] });
    expect(out).toEqual({ webhookSecret: "whsec_x", providerEndpointId: "we_XXXXXXXXXXXX01" });
  });

  it("falls back to an unpinned endpoint when Stripe refuses the version", async () => {
    // Stripe's answer, measured on a test account with three pinned versions in use.
    const refusal = new Stripe.errors.StripeInvalidRequestError({
      type: "invalid_request_error",
      message:
        "You have reached the maximum of 3 unique versions of test webhook endpoints. Please upgrade the versions of older test webhook endpoints to match the versions of newer test webhook endpoints.",
    });
    const { p, calls } = stubbed(async (params) => {
      if (params.api_version) throw refusal;
      return { id: "we_XXXXXXXXXXXX02", secret: "whsec_y" };
    });
    const out = await p.provisionWebhookEndpoint({ url: "https://example.com/hook" });
    expect(calls).toHaveLength(2);
    expect(calls[1]).not.toHaveProperty("api_version");
    expect(out.providerEndpointId).toBe("we_XXXXXXXXXXXX02");
  });

  it("does not hide any other failure", async () => {
    const { p, calls } = stubbed(async () => {
      throw new Stripe.errors.StripeAuthenticationError({ message: "Invalid API Key provided" });
    });
    await expect(p.provisionWebhookEndpoint({ url: "https://example.com/hook" })).rejects.toThrow(
      /Invalid API Key/,
    );
    expect(calls).toHaveLength(1);
  });
});
