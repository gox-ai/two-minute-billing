/**
 * Square conformance fixtures. Objects follow the shapes the sandbox returned
 * (`verify:square`, measured 2026-10-25). Every id is a same-shape fake.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { systemDb } from "@/platform/db";
import { resolveAdapter } from "@/providers/registry";
import {
  SQUARE_VERSION,
  SQUARE_WEBHOOK_EVENTS,
  signSquarePayload,
  type SquareProvider,
} from "@/providers/square";
import { gatewayAccounts } from "@db/schema";
import { FakeGateway, json, type FakeRequest } from "../fake-http";
import { AMOUNT, type World } from "../harness";
import { hostedApplePayRows } from "../hosted-wallet";
import type {
  Body,
  DisputeStep,
  DocumentedStatus,
  GatewayDriver,
  GatewayFixture,
  RefundState,
  TokenKind,
} from "../types";

const HOST = "https://square.conformance.invalid";
const READ = "2026-10-27";
const SPEC = "https://raw.githubusercontent.com/square/connect-api-specification/master/api.json";
const DOC = {
  ach: "https://developer.squareup.com/docs/payments-api/take-payments/ach-payments",
  disputeState: "https://developer.squareup.com/reference/square/enums/DisputeState",
};
const LOCATION = "LCONF0000001";
const schema = (name: string, ...rest: string[]) => ["components", "schemas", name, ...rest];

type Money = { amount: number; currency: string };
type Obj = Record<string, unknown> & { id: string };

class FakeSquare extends FakeGateway {
  readonly host = HOST;
  readonly customers = new Map<string, Obj>();
  readonly cards = new Map<string, Obj>();
  readonly payments = new Map<string, Obj>();
  readonly refunds = new Map<string, Obj>();
  readonly subscriptions = new Map<string, Obj>();
  /** Orders made for payment links, by order id. */
  readonly orders = new Map<string, Obj>();
  /** idempotency_key → [payment id, the body it was made with]. */
  private readonly keys = new Map<string, [string, string]>();

  newPayment(over: Partial<Obj> & { amount: number; currency: string }): Obj {
    const money: Money = { amount: over.amount, currency: over.currency };
    const p: Obj = {
      id: this.id("PCONF", 16),
      status: "COMPLETED",
      source_type: "CARD",
      location_id: LOCATION,
      created_at: new Date().toISOString(),
      amount_money: money,
      total_money: money,
      approved_money: money,
      refunded_money: { amount: 0, currency: over.currency },
      card_details: { status: "CAPTURED", card: { card_brand: "VISA", last_4: "1111" } },
      version_token: "v1",
      ...over,
    };
    delete p.amount;
    delete p.currency;
    this.payments.set(p.id, p);
    return p;
  }

  newRefund(p: Obj, amount: number, status = "PENDING"): Obj {
    const cur = (p.amount_money as Money).currency;
    const r: Obj = {
      id: `${p.id}_${this.id("R", 8)}`,
      status,
      amount_money: { amount, currency: cur },
      payment_id: p.id,
      location_id: LOCATION,
      created_at: new Date().toISOString(),
    };
    this.refunds.set(r.id, r);
    const rm = p.refunded_money as Money;
    p.refunded_money = { amount: rm.amount + amount, currency: cur };
    return r;
  }

  async route(req: FakeRequest): Promise<Response | null> {
    const { method, path, body } = req;
    const err = (status: number, category: string, code: string) =>
      json(status, { errors: [{ category, code, detail: code.toLowerCase().replace(/_/g, " ") }] });
    if (method === "GET" && path.startsWith("/v2/locations/"))
      return json(200, {
        location: {
          id: LOCATION,
          status: "ACTIVE",
          currency: "USD",
          country: "US",
          capabilities: ["CREDIT_CARD_PROCESSING"],
        },
      });
    if (method === "POST" && path === "/v2/customers/search") {
      const ref = (((body.query as Obj)?.filter as Obj)?.reference_id as Obj)?.exact;
      return json(200, {
        customers: [...this.customers.values()].filter((c) => c.reference_id === ref),
      });
    }
    if (method === "POST" && path === "/v2/customers") {
      const c: Obj = { id: this.id("CCONF", 16), reference_id: body.reference_id };
      this.customers.set(c.id, c);
      return json(200, { customer: c });
    }
    if (method === "POST" && path === "/v2/cards") {
      const src = String(body.source_id);
      const c: Obj = {
        id: `ccof:${this.id("CONF", 12)}`,
        card_brand: "VISA",
        last_4: "1111",
        exp_month: 12,
        exp_year: 2034,
        customer_id: (body.card as Obj)?.customer_id,
        enabled: true,
        fingerprint: `sq-1-${src.slice(5)}`,
      };
      this.cards.set(c.id, c);
      return json(200, { card: c });
    }
    // A payment link makes its own order from `order` (CreatePaymentLinkResponse).
    if (method === "POST" && path === "/v2/online-checkout/payment-links")
      return this.guarded("payment_link", req, () => {
        const o = body.order as Obj;
        const order: Obj = { ...o, id: this.id("OCONF", 16), state: "OPEN", tenders: [] };
        this.orders.set(order.id, order);
        const id = this.id("LCONF", 12);
        return json(200, {
          payment_link: { id, version: 1, order_id: order.id, url: `https://square.link/u/${id}` },
        });
      });
    const ord = path.match(/^\/v2\/orders\/([^/]+)$/);
    if (ord && method === "GET") {
      const o = this.orders.get(ord[1]!);
      return o ? json(200, { order: o }) : err(404, "INVALID_REQUEST_ERROR", "NOT_FOUND");
    }
    if (method === "POST" && path === "/v2/payments")
      return this.guarded("charge", req, () => {
        const key = String(body.idempotency_key);
        const shape = JSON.stringify({ ...body, idempotency_key: undefined });
        const seen = this.keys.get(key);
        if (seen && seen[1] !== shape)
          return err(400, "INVALID_REQUEST_ERROR", "IDEMPOTENCY_KEY_REUSED");
        if (seen) return json(200, { payment: this.payments.get(seen[0]) });
        const m = body.amount_money as Money;
        const p = this.newPayment({
          amount: m.amount,
          currency: m.currency,
          reference_id: body.reference_id,
          customer_id: body.customer_id,
          source_id: body.source_id,
          location_id: body.location_id,
          note: body.note,
          status: body.autocomplete === false ? "APPROVED" : "COMPLETED",
        });
        this.keys.set(key, [p.id, shape]);
        return json(200, { payment: p });
      });
    if (method === "GET" && path === "/v2/payments")
      return this.guarded("lookup", req, () => {
        const list = [...this.payments.values()]
          .filter((p) => p.location_id === req.url.searchParams.get("location_id"))
          .reverse();
        return json(200, { payments: list });
      });
    const pay = path.match(/^\/v2\/payments\/([^/]+)(?:\/(cancel|complete))?$/);
    if (pay) {
      const p = this.payments.get(pay[1]!);
      if (!p) return err(404, "INVALID_REQUEST_ERROR", "NOT_FOUND");
      if (method === "POST" && pay[2] === "cancel") {
        if (p.status === "APPROVED") p.status = "CANCELED";
        return json(200, { payment: p });
      }
      if (method === "POST" && pay[2] === "complete") {
        if (p.status !== "APPROVED" && p.status !== "COMPLETED")
          return err(400, "INVALID_REQUEST_ERROR", "BAD_REQUEST");
        p.status = "COMPLETED";
        return json(200, { payment: p });
      }
      return json(200, { payment: p });
    }
    if (method === "POST" && path === "/v2/refunds")
      return this.guarded("refund", req, () => {
        const p = this.payments.get(String(body.payment_id));
        if (!p) return err(404, "INVALID_REQUEST_ERROR", "NOT_FOUND");
        const r = this.newRefund(p, (body.amount_money as Money).amount);
        if (body.reason) r.reason = body.reason;
        return json(200, { refund: r });
      });
    if (method === "GET" && path.startsWith("/v2/refunds/")) {
      const r = this.refunds.get(decodeURIComponent(path.slice(12)));
      return r ? json(200, { refund: r }) : err(404, "INVALID_REQUEST_ERROR", "NOT_FOUND");
    }
    if (method === "GET" && path === "/v2/webhooks/subscriptions")
      return json(200, {
        subscriptions: [...this.subscriptions.values()].map(({ signature_key: _k, ...s }) => s),
      });
    const sub = path.match(/^\/v2\/webhooks\/subscriptions\/([^/]+)$/);
    if (sub) {
      const s = this.subscriptions.get(sub[1]!);
      if (!s) return err(404, "INVALID_REQUEST_ERROR", "NOT_FOUND");
      if (method === "PUT")
        return this.guarded("update_subscription", req, () => {
          Object.assign(s, body.subscription as Obj);
          return json(200, { subscription: s });
        });
      return json(200, { subscription: s });
    }
    return null;
  }
}

class SquareDriver implements GatewayDriver {
  readonly fake = new FakeSquare();
  readonly forgedStatus = 400;
  readonly chargeOp = "charge";
  readonly refundOp = "refund";
  readonly lookupOp = "lookup";
  readonly errors = {
    conflict: {
      status: 409,
      body: {
        errors: [{ category: "INVALID_REQUEST_ERROR", code: "CONFLICT", detail: "conflict" }],
      },
    },
    rateLimited: {
      status: 429,
      body: { errors: [{ category: "RATE_LIMIT_ERROR", code: "RATE_LIMITED" }] },
    },
    server: {
      status: 500,
      body: { errors: [{ category: "API_ERROR", code: "INTERNAL_SERVER_ERROR" }] },
    },
    internal: {
      status: 503,
      body: { errors: [{ category: "API_ERROR", code: "SERVICE_UNAVAILABLE" }] },
    },
    refundRefused: {
      status: 400,
      body: {
        errors: [
          {
            category: "INVALID_REQUEST_ERROR",
            code: "PAYMENT_NOT_REFUNDABLE",
            detail: "payment not refundable",
          },
        ],
      },
    },
  };

  credentials(webhookSecret: string) {
    return {
      access_token: "EAAAconformance000000000000000001",
      application_id: "sandbox-sq0idb-CONFORMANCE00000000001",
      location_id: LOCATION,
      webhook_secret: webhookSecret,
      api_base: HOST,
    };
  }
  token(kind: TokenKind) {
    return kind === "pays" ? `cnon:card-nonce-ok-${randomUUID().slice(0, 8)}` : null;
  }
  sign(w: World, body: string, secret: string) {
    return { "x-square-hmacsha256-signature": signSquarePayload(secret, w.notificationUrl, body) };
  }

  notification(
    type: string,
    dataType: string,
    object: Obj,
    key: "payment" | "refund" | "dispute",
  ): Body {
    const eventId = randomUUID();
    return {
      body: JSON.stringify({
        merchant_id: "MLCONF00000001",
        type,
        event_id: eventId,
        created_at: new Date().toISOString(),
        data: {
          type: dataType,
          id: object.id ?? object.dispute_id,
          object: { [key]: { ...object } },
        },
      }),
      eventIds: [`sq_${eventId}`],
    };
  }
  payment(id: string) {
    const p = this.fake.payments.get(id);
    if (!p) throw new Error(`fake Square has no payment ${id}`);
    return p;
  }
  paymentEvent(p: Obj) {
    return this.notification("payment.updated", "payment", p, "payment");
  }
  refundNote(r: Obj, created = false) {
    return this.notification(created ? "refund.created" : "refund.updated", "refund", r, "refund");
  }

  collect() {
    return [];
  }
  paymentSucceeded(_w: World, id: string) {
    const p = this.payment(id);
    p.status = "COMPLETED";
    return [this.paymentEvent(p)];
  }
  paymentFailed(_w: World, id: string) {
    const p = this.payment(id);
    p.status = "FAILED";
    return [this.paymentEvent(p)];
  }
  refundEvent(_w: World, _id: string, refundId: string, state: RefundState) {
    const r = this.fake.refunds.get(refundId);
    if (!r) throw new Error(`fake Square has no refund ${refundId}`);
    r.status = { pending: "PENDING", succeeded: "COMPLETED", failed: "FAILED" }[state];
    return [this.refundNote(r, state === "pending")];
  }
  dashboardRefund(_w: World, id: string, amountMinor: bigint) {
    const r = this.fake.newRefund(this.payment(id), Number(amountMinor));
    const created = this.refundNote({ ...r }, true);
    r.status = "COMPLETED";
    return { refundId: r.id, events: [created, this.refundNote(r)] };
  }
  disputeObj(id: string): Obj {
    const p = this.payment(id);
    return {
      id: this.fake.id("DCONF", 16),
      amount_money: { ...(p.amount_money as Money) },
      reason: "NO_KNOWLEDGE",
      state: "EVIDENCE_REQUIRED",
      due_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      disputed_payment: { payment_id: p.id },
      location_id: LOCATION,
    };
  }
  disputeNote(d: Obj, state: string, created = false) {
    d.state = state;
    return this.notification(
      created ? "dispute.created" : "dispute.state.updated",
      "dispute",
      d,
      "dispute",
    );
  }
  disputeSteps(_w: World, id: string, flow: "won" | "lost" | "win_after_loss"): DisputeStep[] {
    const d = this.disputeObj(id);
    // A chargeback opens with the money withheld (one notification, two events).
    const steps: DisputeStep[] = [
      { after: "withdrawn", bodies: [this.disputeNote(d, "EVIDENCE_REQUIRED", true)] },
    ];
    const won: DisputeStep = { after: "won", bodies: [this.disputeNote(d, "WON")] };
    const lost: DisputeStep = { after: "lost", bodies: [this.disputeNote(d, "LOST")] };
    return flow === "won"
      ? [...steps, won]
      : flow === "lost"
        ? [...steps, lost]
        : [...steps, lost, won];
  }
  chargesOn(cardId: string) {
    return [...this.fake.payments.values()].filter((p) => p.source_id === cardId).map((p) => p.id);
  }

  statusEvent(_w: World, st: DocumentedStatus, id: string): Body[] {
    const p = this.payment(id);
    if (st.object === "payment") return [this.paymentEvent({ ...p, status: st.status })];
    if (st.object === "refund") {
      const r = this.fake.newRefund(p, 500, st.status);
      return [this.refundNote(r, st.status === "PENDING")];
    }
    const d = this.disputeObj(id);
    return [this.disputeNote(d, st.status, true)];
  }
}

const st = (
  object: string,
  s: string,
  doc: string,
  expect: DocumentedStatus["expect"],
): DocumentedStatus => ({
  object,
  status: s,
  doc,
  expect,
});

const adapterOf = async (w: World) => {
  const [acc] = await systemDb
    .select()
    .from(gatewayAccounts)
    .where(eq(gatewayAccounts.id, w.account.id));
  return resolveAdapter(acc!) as unknown as SquareProvider;
};

/** The buyer pays the link: a completed payment naming the link's order, not our reference. */
function payLink(w: World, intentAtGateway: string) {
  const d = w.driver as SquareDriver;
  const order = d.fake.orders.get(intentAtGateway.slice("sqh_".length));
  if (!order) throw new Error(`fake Square has no order ${intentAtGateway}`);
  const m = ((order.line_items as Obj[])[0]!.base_price_money as Money) ?? { amount: 0 };
  const p = d.fake.newPayment({
    amount: m.amount,
    currency: m.currency,
    order_id: order.id,
    status: "COMPLETED",
  });
  (order.tenders as Obj[]).push({ id: p.id, payment_id: p.id });
  return { chargeId: p.id, bodies: [d.paymentEvent(p)] };
}

export const squareFixture: GatewayFixture = {
  key: "square",
  currency: "USD",
  docs: [
    {
      id: "payment-status",
      url: SPEC,
      read: READ,
      check: {
        kind: "openapi-text",
        path: schema("Payment", "properties", "status", "description"),
      },
    },
    {
      id: "refund-status",
      url: SPEC,
      read: READ,
      check: {
        kind: "openapi-text",
        path: schema("PaymentRefund", "properties", "status", "description"),
      },
    },
    {
      id: "dispute-state",
      url: SPEC,
      read: READ,
      check: { kind: "openapi-enum", path: schema("DisputeState", "enum") },
    },
  ],
  statuses: [
    st("payment", "APPROVED", "payment-status", ["intent.authorized"]),
    st("payment", "PENDING", "payment-status", ["charge.pending"]),
    st("payment", "COMPLETED", "payment-status", ["charge.succeeded"]),
    st("payment", "CANCELED", "payment-status", ["intent.voided"]),
    st("payment", "FAILED", "payment-status", ["charge.failed"]),
    st("refund", "PENDING", "refund-status", ["refund.pending"]),
    st("refund", "COMPLETED", "refund-status", ["charge.refunded"]),
    st("refund", "REJECTED", "refund-status", ["refund.failed"]),
    st("refund", "FAILED", "refund-status", ["refund.failed"]),
    st("dispute", "INQUIRY_EVIDENCE_REQUIRED", "dispute-state", ["dispute.created"]),
    st("dispute", "INQUIRY_PROCESSING", "dispute-state", ["dispute.created"]),
    st("dispute", "INQUIRY_CLOSED", "dispute-state", ["dispute.closed"]),
    st("dispute", "EVIDENCE_REQUIRED", "dispute-state", [
      "dispute.created",
      "dispute.funds_withdrawn",
    ]),
    st("dispute", "PROCESSING", "dispute-state", ["dispute.created", "dispute.funds_withdrawn"]),
    st("dispute", "WON", "dispute-state", ["dispute.won"]),
    st("dispute", "LOST", "dispute-state", ["dispute.lost"]),
    st("dispute", "ACCEPTED", "dispute-state", ["dispute.lost"]),
  ],
  na: {
    "S6.after-failure": "A FAILED Square payment is final; a retry is a new payment with a new id.",
    S9: `Square documents no failure after COMPLETED; ACH "moves to COMPLETED or FAILED": ${DOC.ach} (read 2026-10-26).`,
    S10: `"ACH payments cannot be canceled or completed using the Payments API", and renewals charge cards only: ${DOC.ach} (read 2026-10-26).`,
  },
  limits: [
    { op: "charge", field: "idempotency_key", max: 45, source: SPEC },
    { op: "charge", field: "reference_id", max: 40, source: SPEC },
    { op: "charge", field: "note", max: 500, source: SPEC },
    { op: "charge", field: "buyer_email_address", max: 255, source: SPEC },
    { op: "refund", field: "reason", max: 192, source: SPEC },
  ],
  driver: () => new SquareDriver(),
  extraRows: [
    // https://developer.squareup.com/docs/checkout-api/guidelines-and-limitations
    ...hostedApplePayRows({
      createOp: "payment_link",
      intentPrefix: "sqh_",
      // The page also takes cards, and an online Apple Pay payment reads as CARD.
      methodUsed: null,
      checkCreate(call, ref) {
        const b = call.body as Record<string, Obj>;
        const o = b.order as Obj;
        const opts = b.checkout_options as Obj;
        if ((opts?.accepted_payment_methods as Obj)?.apple_pay !== true) return "Apple Pay not on";
        if (!String(o?.reference_id).startsWith(`th-${ref}-`))
          return `reference ${String(o?.reference_id)}`;
        if (String(o.reference_id).length > 40) return "reference over 40 characters";
        const price = (o.line_items as Obj[])?.[0]?.base_price_money as Money | undefined;
        if (price?.amount !== Number(AMOUNT)) return "not the invoice amount";
        if (!b.idempotency_key) return "no idempotency_key";
        return null;
      },
      pay: payLink,
    }),
    {
      scenario: "S6",
      id: "S6.intent-id",
      title: "payment events name the intent, so a capture made outside our flow can be matched",
      async run({ world }) {
        const w = await world("s6sq");
        const d = w.driver as SquareDriver;
        const b = await w.collected();
        const ev = d.paymentEvent(d.payment(b.chargeId));
        await w.deliver(ev);
        const [row] = await w.eventRows(ev.eventIds);
        const intent = (row?.normalized as { providerIntentId?: string } | null)?.providerIntentId;
        return { pass: intent === b.chargeId, detail: `providerIntentId ${intent ?? "absent"}` };
      },
    },
    {
      scenario: "S6",
      id: "S6.consume-canceled",
      title: "consuming an authorization Square already cancelled answers failed, not a throw",
      async run({ world }) {
        const w = await world("s6cc");
        const d = w.driver as SquareDriver;
        const p = d.fake.newPayment({ amount: 10_000, currency: "USD", status: "CANCELED" });
        const adapter = await adapterOf(w);
        const r = await adapter
          .consumeIntent({
            intentId: p.id,
            idempotencyKey: `conf_${p.id}`,
            purpose: "payment",
            amountMinor: 10_000n,
            currency: "USD",
          })
          .catch((e: Error) => e);
        const ok =
          !(r instanceof Error) && r.purpose === "payment" && r.charge?.status === "failed";
        return {
          pass: ok,
          detail: r instanceof Error ? `threw: ${r.message}` : JSON.stringify(r).slice(0, 200),
        };
      },
    },
    {
      scenario: "S8",
      id: "S8.idempotency-key-reused",
      title: "IDEMPOTENCY_KEY_REUSED (a payment exists for the key) is never a definite failure",
      async run({ world }) {
        const w = await world("s8ik");
        const d = w.driver as SquareDriver;
        d.fake.inject(
          "charge",
          {
            kind: "http",
            status: 400,
            body: {
              errors: [{ category: "INVALID_REQUEST_ERROR", code: "IDEMPOTENCY_KEY_REUSED" }],
            },
            afterCreate: true,
          },
          4,
        );
        const b = await w.bill().finally(() => d.fake.clearFaults());
        const outcome = b.txnStatus ?? b.paymentStatus;
        return { pass: outcome !== "failed", detail: `attempt ${outcome} ${b.failureCode ?? ""}` };
      },
    },
    {
      scenario: "S11",
      id: "S11.other-location",
      title: "a payment from another location of the same seller is not ours",
      async run({ world }) {
        const w = await world("s11loc");
        const d = w.driver as SquareDriver;
        const b = await w.collected();
        const other = d.fake.newPayment({
          amount: 4200,
          currency: "USD",
          location_id: "LOTHER000001",
          reference_id: d.payment(b.chargeId).reference_id,
        });
        const ev = d.paymentEvent(other);
        await w.deliver(ev);
        const [row] = await w.eventRows(ev.eventIds);
        const own = (row?.normalized as { ownership?: string } | null)?.ownership;
        return { pass: own === "foreign", detail: `ownership ${own ?? "absent"}` };
      },
    },
    {
      scenario: "S13",
      id: "S13.deprecated-dispute-id",
      title: "a dispute payload with the deprecated `dispute_id` field is booked",
      async run({ world }) {
        const w = await world("s13dd");
        const d = w.driver as SquareDriver;
        const b = await w.collected();
        const cash0 = await w.cash();
        const { id, ...rest } = d.disputeObj(b.chargeId);
        await w.deliver(
          d.notification(
            "dispute.created",
            "dispute",
            { ...rest, dispute_id: id } as unknown as Obj,
            "dispute",
          ),
        );
        const row = await w.dispute(id);
        return {
          pass: !!row && (await w.cash()) === cash0 - b.amountMinor,
          detail: `dispute ${row?.status ?? "missing"} cash ${(await w.cash()) - cash0}`,
        };
      },
    },
    {
      scenario: "S13",
      id: "S13.subscription-api-version",
      title: "re-registering an existing webhook subscription brings its api_version to ours",
      async run({ world }) {
        const w = await world("s13av");
        const d = w.driver as SquareDriver;
        const url = `https://hooks.example.com/v1/gateway_webhooks/square?id=${w.account.publicId}`;
        const id = d.fake.id("wbhk_conf", 8);
        d.fake.subscriptions.set(id, {
          id,
          name: "tmbilling",
          enabled: true,
          event_types: [...SQUARE_WEBHOOK_EVENTS],
          notification_url: url,
          api_version: "2021-01-21",
          signature_key: "conformance-signature-key-0001",
        });
        await (await adapterOf(w)).provisionWebhookEndpoint({ url });
        const v = d.fake.subscriptions.get(id)!.api_version;
        return {
          pass: v === SQUARE_VERSION,
          detail: `subscription api_version ${String(v)} (want ${SQUARE_VERSION})`,
        };
      },
    },
  ],
};
