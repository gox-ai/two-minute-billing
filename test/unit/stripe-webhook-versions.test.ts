/**
 * Stripe renders a webhook in the endpoint's API version, not the SDK's. Every mapped
 * event here is driven through the real signature check in two renderings: 2020-03-02
 * (captured from a test account, ids replaced) and 2026-05-27.dahlia (the same objects
 * read at that version). A 2020-03-02 event is normalized from its object read at our
 * version, so the stub client serves the dahlia rendering of that object.
 *
 * What regresses without it: the card updater's pre-2020-08-27 name is dropped, so an
 * expiry the network reissued never reaches us; and on dahlia, where a Charge has no
 * `refunds`, a refund is booked with no refund id, so `refund.failed` cannot reverse it.
 */
import { describe, it, expect, vi } from "vitest";
import Stripe from "stripe";
import { StripeProvider } from "@/providers/stripe";
import { normalizeStripeDecline } from "@/providers/decline-codes";
import { classifyDecline } from "@/modules/subscriptions/decline-policy";
import { isHardDecline } from "@/modules/invoicing/collection";
import fixtures from "./fixtures/stripe-webhook-versions.json";

type Fixture = Record<string, { type: string; created: number; data: { object: any } }>;
const VERSIONS = { "2020-03-02": fixtures.v2020, dahlia: fixtures.dahlia } as Record<
  string,
  Fixture
>;

const SECRET = "whsec_unit_versions";
const NEXT = "whsec_unit_versions_next";

const sign = (body: string, secret = SECRET) =>
  Stripe.webhooks.generateTestHeaderString({ payload: body, secret });

/** The dahlia twin of a 2020-03-02 fixture: the same object read at our version. */
const TWIN: Record<string, string> = {
  "payment_method.card_automatically_updated": "payment_method.automatically_updated",
};

function provider(listed?: unknown[] | Error, next?: string) {
  const p = new StripeProvider("sk_test_unit", SECRET, undefined, next);
  const list = vi.fn(async () => {
    if (listed instanceof Error) throw listed;
    return { data: listed ?? [] };
  });
  const served = new Map<string, unknown>();
  const retrieve = vi.fn(async (id: string) => {
    if (!served.has(id)) throw new Error(`not served: ${id}`);
    return structuredClone(served.get(id));
  });
  const client = (p as unknown as { stripe: Record<string, Record<string, unknown>> }).stripe;
  client.refunds!.list = list;
  for (const r of ["charges", "refunds", "paymentMethods", "paymentIntents"]) {
    client[r]!.retrieve = retrieve;
  }
  /** Serve the dahlia object for `key`, edited like the delivered one. */
  const serve = (key: string, edit?: (o: any) => void) => {
    const obj = structuredClone(
      fixtures.dahlia[(TWIN[key] ?? key) as keyof typeof fixtures.dahlia]!.data.object,
    ) as any;
    edit?.(obj);
    served.set(obj.id, obj);
  };
  return { p, list, retrieve, serve };
}

const deliver = (p: StripeProvider, event: unknown, secret = SECRET) => {
  const body = JSON.stringify(event);
  return p.normalizeWebhook({ payload: body, headers: { "stripe-signature": sign(body, secret) } });
};

const ids = (records: { providerRefundId: string; amountMinor: bigint; status: string }[] = []) =>
  records.map((r) => `${r.providerRefundId}:${r.amountMinor}:${r.status}`);

describe.each(Object.entries(VERSIONS))("Stripe events rendered at %s", (version, f) => {
  const cardKey =
    version === "dahlia"
      ? "payment_method.automatically_updated"
      : "payment_method.card_automatically_updated";
  const card = f[cardKey];
  /** Deliver fixture `key`, serving its object at our version for the read. */
  const send = (stub: ReturnType<typeof provider>, key: string, edit?: (o: any) => void) => {
    stub.serve(key, edit);
    const event = structuredClone(f[key]!);
    edit?.(event.data.object);
    return deliver(stub.p, event);
  };
  /** One read per event below our version; none at our version. */
  const readsFor = (events: number) => (version === "dahlia" ? 0 : events);

  it("the card updater refreshes the stored card under its name for this version", async () => {
    const stub = provider();
    const [ev] = await send(stub, cardKey);
    expect(stub.retrieve).toHaveBeenCalledTimes(readsFor(1));
    expect(ev?.type).toBe("payment_method.updated");
    expect(ev?.providerPaymentMethodId).toBe("pm_XXXXXXXXXXXX01");
    expect(ev?.card).toMatchObject({
      expMonth: 4,
      expYear: 2030,
      last4: card!.data.object.card.last4,
    });
  });

  it("charge.refunded carries every refund with its id, and a second partial adds one", async () => {
    // At our version a Charge has no `refunds`, so the adapter lists them.
    const stub = provider(fixtures.dahliaRefundList.data.slice(1));
    const [first] = await send(stub, "charge.refunded#1");
    expect(stub.retrieve).toHaveBeenCalledTimes(readsFor(1));
    expect(first?.type).toBe("charge.refunded");
    expect(first?.providerChargeId).toBe("pi_XXXXXXXXXXXX01");
    expect(ids(first?.refunds)).toEqual(["re_XXXXXXXXXXXX01:1000:succeeded"]);

    const [second] = await send(provider(fixtures.dahliaRefundList.data), "charge.refunded#2");
    expect(ids(second?.refunds)).toEqual([
      "re_XXXXXXXXXXXX02:500:succeeded",
      "re_XXXXXXXXXXXX01:1000:succeeded",
    ]);
    expect(stub.list).toHaveBeenCalledWith({
      charge: "ch_XXXXXXXXXXXX01",
      created: { lte: f["charge.refunded#1"]!.created },
      limit: 100,
    });
  });

  it("a succeeded Refund event books by refund id (created, updated, charge.refund.updated)", async () => {
    const stub = provider();
    for (const key of ["refund.created#1", "refund.updated#1", "charge.refund.updated#1"]) {
      const [ev] = await send(stub, key);
      expect(ev?.type, key).toBe("charge.refunded");
      expect(ev?.providerChargeId, key).toBe("pi_XXXXXXXXXXXX01");
      expect(ev?.providerRefundId, key).toBe("re_XXXXXXXXXXXX01");
      expect(ids(ev?.refunds), key).toEqual(["re_XXXXXXXXXXXX01:1000:succeeded"]);
    }
  });

  it("a failed refund reaches the reversal path, by name or by status", async () => {
    const stub = provider();
    for (const key of ["refund.failed", "charge.refund.updated#failed"]) {
      const [ev] = await send(stub, key);
      expect(ev?.type, key).toBe("refund.failed");
      expect(ev?.providerRefundId, key).toBe("re_XXXXXXXXXXXX03");
      expect(ev?.providerFailureCode, key).toBe("expired_or_canceled_card");
      expect(ev?.refunds, key).toBeUndefined();
    }
  });

  it("a refund that is still pending books nothing", async () => {
    const stub = provider();
    const pending = (o: any) => {
      o.status = "pending";
    };
    const [created] = await send(stub, "refund.created#1", pending);
    expect(created?.type).toBe("refund.pending");
    const [updated] = await send(stub, "refund.updated#1", pending);
    expect(updated?.type).toBe("unknown");
  });

  it("a refund we issued carries our tag, so the engine leaves its booking to us", async () => {
    const [ev] = await send(provider(), "refund.updated#1", (o) => {
      o.metadata = { tmbilling_ref: "re_ours_1" };
    });
    expect(ev?.refunds?.[0]?.ownershipRef).toBe("re_ours_1");
  });
});

describe("dahlia charge.refunded when the refunds cannot be read", () => {
  it("reports no refunds, so the Refund events do the booking", async () => {
    const { p } = provider(new Error("network down"));
    const [ev] = await deliver(p, fixtures.dahlia["charge.refunded#1"]);
    expect(ev?.type).toBe("charge.refunded");
    expect(ev?.refunds).toEqual([]);
    expect(ev?.amountRefundedMinor).toBe(1000n);
  });
});

describe("two signing secrets", () => {
  const event = fixtures.dahlia["refund.created#1"];

  it("accepts a delivery signed with the second secret", async () => {
    const { p } = provider(undefined, NEXT);
    expect((await deliver(p, event, NEXT))[0]?.type).toBe("charge.refunded");
    expect((await deliver(p, event, SECRET))[0]?.type).toBe("charge.refunded");
  });

  it("still refuses any other secret", async () => {
    const { p } = provider(undefined, NEXT);
    await expect(deliver(p, event, "whsec_someone_else")).rejects.toThrow();
  });

  it("without a second secret, only the first verifies", async () => {
    const { p } = provider();
    await expect(deliver(p, event, NEXT)).rejects.toThrow();
  });
});

describe("decline codes added in API version 2022-11-15", () => {
  it.each([
    ["payment_intent_payment_attempt_expired", "authentication_required", "park"],
    ["payment_method_customer_decline", "authentication_required", "park"],
    ["payment_method_provider_decline", "card_declined", "retry"],
  ])("%s → %s (%s)", (raw, code, policy) => {
    const n = normalizeStripeDecline(raw);
    expect(n.code).toBe(code);
    expect(n.retriable).toBe(true);
    expect(classifyDecline(n.code)).toBe(policy);
    // The payer did not finish, or the issuer gave no reason: the card stays usable.
    expect(isHardDecline({ status: "failed", failure: n })).toBe(false);
  });

  it("arrives on an async failure as the same code", async () => {
    const { p } = provider();
    const [ev] = await deliver(p, {
      ...fixtures.dahlia["refund.created#1"],
      type: "payment_intent.payment_failed",
      data: {
        object: {
          object: "payment_intent",
          id: "pi_XXXXXXXXXXXX09",
          metadata: {},
          created: 1793012400,
          last_payment_error: { code: "payment_method_customer_decline" },
        },
      },
    });
    expect(ev?.type).toBe("charge.failed");
    expect(ev?.failureCode).toBe("authentication_required");
    expect(ev?.providerFailureCode).toBe("payment_method_customer_decline");
  });
});
