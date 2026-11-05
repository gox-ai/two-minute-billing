/**
 * Razorpay conformance fixtures. Shapes follow Razorpay's documented webhook samples and the
 * offline suite `test/unit/razorpay-conformance.test.ts`. Every id is a same-shape fake.
 */
import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import { systemDb, withTenant } from "@/platform/db";
import { refundPayment } from "@/modules/refunds/service";
import { refundSetupAuth } from "@/modules/payment-methods/setup-auth-refund";
import { resolveAdapter } from "@/providers/registry";
import type { RazorpayProvider } from "@/providers/razorpay";
import { gatewayAccounts, paymentMethods, refunds as refundsTable } from "@db/schema";
import { createCustomer } from "@/modules/customers/service";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { FakeGateway, json, type FakeRequest } from "../fake-http";
import type { World } from "../harness";
import type {
  Body,
  DisputeStep,
  DocumentedStatus,
  GatewayDriver,
  GatewayFixture,
  RefundState,
  TokenKind,
} from "../types";

const HOST = "https://razorpay.conformance.invalid";
const READ = "2026-10-27";
const DOC = {
  paymentEvents: "https://razorpay.com/docs/webhooks/payloads/payments/",
  refundEvents: "https://razorpay.com/docs/webhooks/payloads/refunds/",
  disputeEvents: "https://razorpay.com/docs/webhooks/payloads/disputes/",
  tokenEvents: "https://razorpay.com/docs/api/payments/recurring-payments/webhooks/",
  paymentEntity: "https://razorpay.com/docs/api/payments/entity/",
  refundEntity: "https://razorpay.com/docs/api/refunds/entity/",
  disputeEntity: "https://razorpay.com/docs/api/disputes/entity/",
  disputes: "https://razorpay.com/docs/payments/disputes/",
  orderEntity: "https://razorpay.com/docs/api/orders/entity/",
  paymentsApi: "https://razorpay.com/docs/api/payments/",
  upiTokens: "https://razorpay.com/docs/api/payments/recurring-payments/upi/tokens/",
  refundIdempotent: "https://razorpay.com/docs/api/refunds/normal-refunds-idempotent/",
  refundCreate: "https://razorpay.com/docs/api/refunds/create-normal/",
  captureSettings: "https://razorpay.com/docs/payments/payments/capture-settings/",
  cardMandates: "https://razorpay.com/docs/payments/recurring-payments/cards/integrate/",
};
const ACCOUNT = "acc_CONF0000000001";
const secs = () => Math.floor(Date.now() / 1000);
const snap = <T>(o: T): T => JSON.parse(JSON.stringify(o)) as T;

type Obj = Record<string, unknown> & { id: string };
interface RzPayment extends Obj {
  amount: number;
  currency: string;
  status: string;
  captured: boolean;
  amount_refunded: number;
  refund_status: string | null;
  order_id: string | null;
  token_id: string | null;
}
interface RzRefund extends Obj {
  amount: number;
  payment_id: string;
  status: string;
  notes: Record<string, string>;
}

class FakeRazorpay extends FakeGateway {
  readonly host = HOST;
  readonly customers = new Map<string, Obj>();
  readonly tokens = new Map<string, Obj>();
  readonly orders = new Map<string, Obj>();
  readonly payments = new Map<string, RzPayment>();
  readonly refunds = new Map<string, RzRefund>();
  /** X-Refund-Idempotency → [refund id, the body it was made with]. */
  private readonly refundKeys = new Map<string, [string, string]>();
  /** The next N recurring-payment answers come back as an HTML page (after the payment exists). */
  htmlAnswers = 0;

  rid(prefix: string) {
    return this.id(prefix, 8);
  }

  token(): string {
    const id = this.rid("token_");
    this.tokens.set(id, {
      id,
      entity: "token",
      method: "card",
      recurring: true,
      recurring_details: { status: "confirmed", failure_reason: null },
      card: {
        last4: "1111",
        network: "Visa",
        type: "credit",
        issuer: "HDFC",
        international: false,
        expiry_month: 12,
        expiry_year: 2034,
      },
      max_amount: 1_000_000,
      expired_at: secs() + 5 * 365 * 86_400,
      created_at: secs(),
    });
    return id;
  }

  newOrder(
    amount: number,
    currency: string,
    notes: Record<string, string> = {},
    receipt?: string,
  ): Obj {
    const o: Obj = {
      id: this.rid("order_"),
      entity: "order",
      amount,
      amount_paid: 0,
      amount_due: amount,
      currency,
      receipt: receipt ?? null,
      status: "created",
      attempts: 0,
      notes,
      created_at: secs(),
    };
    this.orders.set(o.id, o);
    return o;
  }

  newPayment(over: Partial<RzPayment> & { amount: number; currency: string }): RzPayment {
    const p: RzPayment = {
      id: this.rid("pay_"),
      entity: "payment",
      status: "created",
      captured: false,
      amount_refunded: 0,
      refund_status: null,
      order_id: null,
      invoice_id: null,
      token_id: null,
      method: "card",
      international: false,
      fee: null,
      tax: null,
      error_code: null,
      error_reason: null,
      error_description: null,
      notes: [],
      created_at: secs(),
      ...over,
    };
    this.payments.set(p.id, p);
    return p;
  }

  capture(p: RzPayment) {
    p.status = "captured";
    p.captured = true;
    p.fee = Math.round(p.amount * 0.02);
    p.tax = Math.round(Number(p.fee) * 0.18);
    const o = p.order_id ? this.orders.get(p.order_id) : undefined;
    if (o) Object.assign(o, { status: "paid", amount_paid: p.amount, amount_due: 0 });
  }

  fail(p: RzPayment) {
    Object.assign(p, {
      status: "failed",
      error_code: "BAD_REQUEST_ERROR",
      error_reason: "payment_failed",
      error_description: "Payment failed",
    });
  }

  newRefund(
    p: RzPayment,
    amount: number,
    status = "pending",
    notes: Record<string, string> = {},
  ): RzRefund {
    const r: RzRefund = {
      id: this.rid("rfnd_"),
      entity: "refund",
      amount,
      currency: p.currency,
      payment_id: p.id,
      notes,
      receipt: null,
      acquirer_data: { arn: null },
      status,
      speed_processed: "normal",
      speed_requested: "normal",
      created_at: secs(),
    };
    this.refunds.set(r.id, r);
    if (status !== "failed") this.addRefunded(p, amount);
    return r;
  }

  addRefunded(p: RzPayment, amount: number) {
    p.amount_refunded += amount;
    p.refund_status =
      p.amount_refunded <= 0 ? null : p.amount_refunded >= p.amount ? "full" : "partial";
  }

  private err(status: number, code: string, description: string, reason = "NA") {
    return json(status, {
      error: { code, description, source: "NA", step: "NA", reason, metadata: {} },
    });
  }
  private missing() {
    return this.err(400, "BAD_REQUEST_ERROR", "The id provided does not exist");
  }

  async route(req: FakeRequest): Promise<Response | null> {
    if (!req.path.startsWith("/v1/")) return null;
    const path = req.path.slice(3);
    const { method } = req;
    const body = req.body;

    if (method === "POST" && path === "/customers") {
      // `fail_existing: "0"` returns the customer with the same (email, contact) pair.
      const same = [...this.customers.values()].find(
        (c) => c.email === body.email && (c.contact ?? null) === (body.contact ?? null),
      );
      if (same && body.fail_existing === "0") return json(200, same);
      const c: Obj = {
        id: this.rid("cust_"),
        entity: "customer",
        name: body.name,
        email: body.email,
        contact: body.contact ?? null,
        notes: body.notes ?? [],
        created_at: secs(),
      };
      this.customers.set(c.id, c);
      return json(200, c);
    }
    const tok = path.match(/^\/customers\/([^/]+)\/tokens\/([^/]+)$/);
    if (method === "GET" && tok) {
      const t = this.tokens.get(tok[2]!);
      if (!t) return this.missing();
      t.customer_id ??= tok[1];
      return t.customer_id === tok[1] ? json(200, t) : this.missing();
    }
    const cust = path.match(/^\/customers\/([^/]+)$/);
    if (method === "GET" && cust) {
      const c = this.customers.get(cust[1]!);
      return c ? json(200, c) : this.missing();
    }

    // Fetch all orders (https://razorpay.com/docs/api/orders/fetch-all/): receipt, from,
    // count (max 100) and skip filters, newest first.
    if (method === "GET" && path === "/orders")
      return this.guarded("search", req, () => {
        const q = req.url.searchParams;
        const receipt = q.get("receipt");
        const from = Number(q.get("from") ?? 0);
        const count = Math.min(Number(q.get("count") ?? 10), 100);
        const skip = Number(q.get("skip") ?? 0);
        const items = [...this.orders.values()]
          .filter((o) => (!receipt || o.receipt === receipt) && Number(o.created_at) >= from)
          .reverse()
          .slice(skip, skip + count);
        return json(200, { entity: "collection", count: items.length, items });
      });
    if (method === "POST" && path === "/orders")
      return this.guarded("order", req, () => {
        const receipt = body.receipt == null ? undefined : String(body.receipt);
        if (receipt && receipt.length > 40)
          return this.err(
            400,
            "BAD_REQUEST_ERROR",
            "The receipt may not be greater than 40 characters.",
          );
        const notes = (body.notes ?? {}) as Record<string, string>;
        if (
          Object.keys(notes).length > 15 ||
          Object.values(notes).some((v) => String(v).length > 256)
        )
          return this.err(400, "BAD_REQUEST_ERROR", "notes: too many keys or a value too long");
        return json(200, this.newOrder(Number(body.amount), String(body.currency), notes, receipt));
      });
    const orderPays = path.match(/^\/orders\/([^/]+)\/payments$/);
    if (method === "GET" && orderPays)
      return this.guarded("lookup", req, () => {
        if (!this.orders.has(orderPays[1]!)) return this.missing();
        const items = [...this.payments.values()]
          .filter((p) => p.order_id === orderPays[1])
          .reverse();
        return json(200, { entity: "collection", count: items.length, items });
      });
    const order = path.match(/^\/orders\/([^/]+)$/);
    if (method === "GET" && order) {
      const o = this.orders.get(order[1]!);
      return o ? json(200, o) : this.missing();
    }

    // No idempotency key exists on this call: a repeat makes a second payment.
    if (method === "POST" && path === "/payments/create/recurring")
      return this.guarded("charge", req, () => {
        const o = this.orders.get(String(body.order_id));
        if (!o) return this.missing();
        if (Number(body.amount) !== o.amount)
          return this.err(400, "BAD_REQUEST_ERROR", "The amount must be equal to the order amount");
        if (!this.tokens.has(String(body.token))) return this.missing();
        o.status = "attempted";
        o.attempts = Number(o.attempts) + 1;
        const p = this.newPayment({
          amount: Number(body.amount),
          currency: String(body.currency),
          order_id: o.id,
          token_id: String(body.token),
          customer_id: body.customer_id,
          email: body.email ?? null,
          contact: body.contact ?? null,
          description: body.description ?? null,
          recurring: true,
        });
        if (this.htmlAnswers > 0) {
          this.htmlAnswers--;
          return new Response("<html><body>502 Bad Gateway</body></html>", {
            status: 200,
            headers: { "content-type": "text/html" },
          });
        }
        return json(200, {
          razorpay_payment_id: p.id,
          razorpay_order_id: o.id,
          razorpay_signature: createHmac("sha256", "conformance")
            .update(`${o.id}|${p.id}`)
            .digest("hex"),
        });
      });

    const refundOf = path.match(/^\/payments\/([^/]+)\/refund$/);
    if (method === "POST" && refundOf)
      return this.guarded("refund", req, () => {
        const p = this.payments.get(refundOf[1]!);
        if (!p) return this.missing();
        const key = req.headers["x-refund-idempotency"];
        const shape = req.text;
        const seen = key ? this.refundKeys.get(key) : undefined;
        if (seen && seen[1] !== shape)
          return this.err(
            400,
            "BAD_REQUEST_ERROR",
            "Different request with the same idempotency key has already been processed.",
          );
        if (seen) return json(200, this.refunds.get(seen[0]));
        const receipt = body.receipt == null ? undefined : String(body.receipt);
        if (
          receipt &&
          [...this.refunds.values()].some((r) => r.payment_id === p.id && r.receipt === receipt)
        )
          return this.err(
            400,
            "BAD_REQUEST_ERROR",
            "Duplicate receipt found for this refund request.",
          );
        if (!p.captured)
          return this.err(
            400,
            "BAD_REQUEST_ERROR",
            "The payment has not been captured",
            "input_validation_failed",
          );
        const amount = body.amount == null ? p.amount - p.amount_refunded : Number(body.amount);
        if (amount > p.amount - p.amount_refunded)
          return this.err(
            400,
            "BAD_REQUEST_ERROR",
            "The refund amount provided is greater than amount captured",
            "input_validation_failed",
          );
        const r = this.newRefund(
          p,
          amount,
          "pending",
          (body.notes ?? {}) as Record<string, string>,
        );
        if (receipt) r.receipt = receipt;
        if (key) this.refundKeys.set(key, [r.id, shape]);
        return json(200, r);
      });
    const refundList = path.match(/^\/payments\/([^/]+)\/refunds$/);
    if (method === "GET" && refundList)
      return this.guarded("refund_lookup", req, () => {
        const items = [...this.refunds.values()]
          .filter((r) => r.payment_id === refundList[1])
          .reverse();
        return json(200, { entity: "collection", count: items.length, items });
      });
    const pay = path.match(/^\/payments\/([^/]+)$/);
    if (method === "GET" && pay) {
      const p = this.payments.get(pay[1]!);
      return p ? json(200, p) : this.missing();
    }
    const ref = path.match(/^\/refunds\/([^/]+)$/);
    if (method === "GET" && ref) {
      const r = this.refunds.get(ref[1]!);
      return r ? json(200, r) : this.missing();
    }
    return null;
  }
}

class RazorpayDriver implements GatewayDriver {
  readonly fake = new FakeRazorpay();
  readonly forgedStatus = 400;
  readonly chargeOp = "charge";
  readonly refundOp = "refund";
  readonly lookupOp = "lookup";
  readonly errors = {
    // Razorpay documents no 409; this is the shape any Razorpay error takes.
    conflict: {
      status: 409,
      body: {
        error: {
          code: "BAD_REQUEST_ERROR",
          description: "Conflict",
          source: "NA",
          step: "NA",
          reason: "NA",
        },
      },
    },
    rateLimited: {
      status: 429,
      body: {
        error: {
          code: "BAD_REQUEST_ERROR",
          description: "Too many requests",
          source: "NA",
          step: "NA",
          reason: "NA",
        },
      },
    },
    server: {
      status: 500,
      body: {
        error: {
          code: "SERVER_ERROR",
          description: "The server encountered an error. The incident has been reported to admins.",
          source: "NA",
          step: "NA",
          reason: "NA",
        },
      },
    },
    refundRefused: {
      status: 400,
      body: {
        error: {
          code: "BAD_REQUEST_ERROR",
          description: "The refund amount provided is greater than amount captured",
          source: "business",
          step: "NA",
          reason: "input_validation_failed",
        },
      },
    },
  };
  /** Body → the `x-razorpay-event-id` it is delivered with (a redelivery keeps the id). */
  private readonly eventIds = new Map<string, string>();

  credentials(webhookSecret: string) {
    return {
      key_id: "rzp_test_CONF0000000001",
      key_secret: "conformance_key_secret_0001",
      webhook_secret: webhookSecret,
      api_base: `${HOST}/v1`,
    };
  }
  token(kind: TokenKind) {
    return kind === "pays" ? this.fake.token() : null;
  }
  sign(_w: World, body: string, secret: string) {
    return {
      "x-razorpay-signature": createHmac("sha256", secret).update(body).digest("hex"),
      "x-razorpay-event-id": this.eventIds.get(body) ?? "",
    };
  }

  event(name: string, entities: Record<string, Obj | undefined>): Body {
    const contains = Object.keys(entities).filter((k) => entities[k]);
    const body = JSON.stringify({
      entity: "event",
      account_id: ACCOUNT,
      event: name,
      contains,
      payload: Object.fromEntries(contains.map((k) => [k, { entity: snap(entities[k]) }])),
      created_at: secs(),
    });
    const id = this.fake.rid("EvCONF");
    this.eventIds.set(body, id);
    return { body, eventIds: [id] };
  }
  payment(id: string) {
    const p = this.fake.payments.get(id);
    if (!p) throw new Error(`fake Razorpay has no payment ${id}`);
    return p;
  }
  refundEntity(id: string) {
    const r = this.fake.refunds.get(id);
    if (!r) throw new Error(`fake Razorpay has no refund ${id}`);
    return r;
  }
  refundNote(r: RzRefund, name: string) {
    return this.event(name, { refund: r, payment: this.payment(r.payment_id) });
  }

  collect(w: World, chargeId: string) {
    return this.paymentSucceeded(w, chargeId);
  }
  paymentSucceeded(_w: World, chargeId: string) {
    const p = this.payment(chargeId);
    this.fake.capture(p);
    return [this.event("payment.captured", { payment: p })];
  }
  paymentFailed(_w: World, chargeId: string) {
    const p = this.payment(chargeId);
    this.fake.fail(p);
    return [this.event("payment.failed", { payment: p })];
  }
  refundEvent(_w: World, _chargeId: string, refundId: string, state: RefundState) {
    const r = this.refundEntity(refundId);
    if (state === "succeeded") r.status = "processed";
    if (state === "failed" && r.status !== "failed") {
      r.status = "failed";
      this.fake.addRefunded(this.payment(r.payment_id), -r.amount);
    }
    const name = {
      pending: "refund.created",
      succeeded: "refund.processed",
      failed: "refund.failed",
    }[state];
    return [this.refundNote(r, name)];
  }
  dashboardRefund(_w: World, chargeId: string, amountMinor: bigint) {
    const r = this.fake.newRefund(this.payment(chargeId), Number(amountMinor));
    const created = this.refundNote(r, "refund.created");
    r.status = "processed";
    return { refundId: r.id, events: [created, this.refundNote(r, "refund.processed")] };
  }
  disputeObj(chargeId: string, amount: number): Obj {
    const p = this.payment(chargeId);
    return {
      id: this.fake.rid("disp_"),
      entity: "dispute",
      payment_id: p.id,
      amount,
      currency: p.currency,
      amount_deducted: 0,
      reason_code: "chargeback",
      reason_description: "The customer does not recognise the transaction.",
      respond_by: secs() + 7 * 86_400,
      status: "open",
      phase: "chargeback",
      created_at: secs(),
    };
  }
  disputeNote(chargeId: string, d: Obj, name: string, status: string) {
    d.status = status;
    if (status === "lost") d.amount_deducted = d.amount;
    return this.event(name, { payment: this.payment(chargeId), dispute: d });
  }
  disputeSteps(
    _w: World,
    chargeId: string,
    flow: "won" | "lost" | "win_after_loss",
  ): DisputeStep[] | null {
    if (flow === "win_after_loss") return null;
    const d = this.disputeObj(chargeId, this.payment(chargeId).amount);
    // Razorpay deducts the money only when the dispute is lost (see DOC.disputes).
    return [
      {
        after: "opened",
        bodies: [this.disputeNote(chargeId, d, "payment.dispute.created", "open")],
      },
      flow === "won"
        ? { after: "won", bodies: [this.disputeNote(chargeId, d, "payment.dispute.won", "won")] }
        : {
            after: "lost",
            bodies: [this.disputeNote(chargeId, d, "payment.dispute.lost", "lost")],
          },
    ];
  }
  chargesOn(tokenId: string) {
    return [...this.fake.payments.values()].filter((p) => p.token_id === tokenId).map((p) => p.id);
  }

  statusEvent(_w: World, st: DocumentedStatus, chargeId: string): Body[] {
    const p = this.payment(chargeId);
    if (st.object === "event:payment") {
      if (st.status === "payment.captured") return [this.event(st.status, { payment: p })];
      if (st.status === "order.paid")
        return [
          this.event(st.status, {
            payment: p,
            order: p.order_id ? this.fake.orders.get(p.order_id) : undefined,
          }),
        ];
      if (st.status.startsWith("payment.downtime."))
        return [
          this.event(st.status, {
            "payment.downtime": {
              id: this.fake.rid("down_"),
              entity: "payment.downtime",
              method: "card",
              status: st.status.endsWith("resolved") ? "resolved" : "started",
              severity: "high",
              begin: secs(),
              end: null,
            },
          }),
        ];
      // A new attempt on its own order, so the collected charge keeps its state.
      const o = this.fake.newOrder(p.amount, p.currency, { tmbilling_ref: `conf_${st.status}` });
      const q = this.fake.newPayment({
        amount: p.amount,
        currency: p.currency,
        order_id: o.id,
        token_id: p.token_id,
      });
      if (st.status === "payment.authorized") q.status = "authorized";
      if (st.status === "payment.failed") this.fake.fail(q);
      if (st.status === "payment.pending") Object.assign(q, { status: "pending", method: "cod" });
      return [this.event(st.status, { payment: q })];
    }
    if (st.object === "event:refund") {
      const r = this.fake.newRefund(p, 500);
      if (st.status === "refund.processed") r.status = "processed";
      if (st.status === "refund.failed") {
        r.status = "failed";
        this.fake.addRefunded(p, -r.amount);
      }
      return [this.refundNote(r, st.status)];
    }
    if (st.object === "event:dispute") {
      const status: Record<string, string> = {
        "payment.dispute.created": "open",
        "payment.dispute.action_required": "open",
        "payment.dispute.under_review": "under_review",
        "payment.dispute.won": "won",
        "payment.dispute.lost": "lost",
        "payment.dispute.closed": "closed",
      };
      return [
        this.disputeNote(chargeId, this.disputeObj(chargeId, 500), st.status, status[st.status]!),
      ];
    }
    const t = this.fake.tokens.get(String(p.token_id));
    if (!t) throw new Error(`fake Razorpay has no token for ${chargeId}`);
    t.recurring_details = { status: st.status.slice("token.".length), failure_reason: null };
    return [this.event(st.status, { token: t })];
  }
}

const ev =
  (object: string, doc: string) =>
  (status: string, expect: DocumentedStatus["expect"]): DocumentedStatus => ({
    object,
    status,
    doc,
    expect,
  });
const payEv = ev("event:payment", "payment-events");
const refEv = ev("event:refund", "refund-events");
const dspEv = ev("event:dispute", "dispute-events");
const tokEv = ev("event:token", "token-events");

const adapterOf = async (w: World) => {
  const [acc] = await systemDb
    .select()
    .from(gatewayAccounts)
    .where(eq(gatewayAccounts.id, w.account.id));
  return resolveAdapter(acc!) as unknown as RazorpayProvider;
};

export const razorpayFixture: GatewayFixture = {
  key: "razorpay",
  currency: "INR",
  docs: [
    { id: "payment-events", url: DOC.paymentEvents, read: READ, check: { kind: "page" } },
    { id: "refund-events", url: DOC.refundEvents, read: READ, check: { kind: "page" } },
    { id: "dispute-events", url: DOC.disputeEvents, read: READ, check: { kind: "page" } },
    { id: "token-events", url: DOC.tokenEvents, read: READ, check: { kind: "page" } },
  ],
  // Razorpay reports state as event names; these are every event on the four pages.
  statuses: [
    payEv("payment.authorized", ["intent.authorized"]),
    payEv("payment.captured", ["charge.succeeded"]),
    payEv("payment.failed", ["charge.failed"]),
    payEv("payment.pending", {
      none: "Sent only for a Cash on Delivery order; we never create one.",
    }),
    payEv("order.paid", ["charge.succeeded"]),
    payEv("payment.downtime.started", ["gateway.downtime_started"]),
    payEv("payment.downtime.resolved", ["gateway.downtime_resolved"]),
    payEv("payment.downtime.updated", {
      none: "Amends a downtime window already open; started and resolved carry its state.",
    }),
    refEv("refund.created", ["refund.pending"]),
    refEv("refund.processed", ["charge.refunded"]),
    refEv("refund.failed", ["refund.failed"]),
    refEv("refund.speed_changed", {
      none: "The refund's speed changed; processed and failed carry its money.",
    }),
    dspEv("payment.dispute.created", ["dispute.created"]),
    dspEv("payment.dispute.action_required", ["dispute.created"]),
    dspEv("payment.dispute.under_review", ["dispute.created"]),
    dspEv("payment.dispute.won", ["dispute.won"]),
    dspEv("payment.dispute.lost", ["dispute.lost"]),
    dspEv("payment.dispute.closed", ["dispute.closed"]),
    tokEv("token.confirmed", ["payment_method.mandate_updated"]),
    tokEv("token.rejected", ["payment_method.mandate_updated"]),
    tokEv("token.cancelled", ["payment_method.mandate_updated"]),
    tokEv("token.paused", ["payment_method.mandate_updated"]),
  ],
  na: {
    "S5.win_after_loss": `Razorpay's later dispute phases (pre_arbitration, arbitration) challenge a chargeback you WON, not one you lost: ${DOC.disputeEntity} (read ${READ}).`,
    S9: `Razorpay documents no failure after \`captured\` (statuses: created, authorized, captured, refunded, failed): ${DOC.paymentEntity} (read ${READ}).`,
    S10: `Razorpay documents no call that cancels a payment in flight; the Payments API fetches and captures only: ${DOC.paymentsApi} (read ${READ}).`,
    S13: "Razorpay has one API version (v1) and one webhook payload shape; no version is chosen per endpoint.",
  },
  limits: [
    { op: "order", field: "receipt", max: 40, source: DOC.orderEntity },
    { op: "order", field: "notes.tmbilling_ref", max: 256, source: DOC.orderEntity },
  ],
  // Same units as ISO 4217: three-decimal currencies in thousandths, zero-decimal as is.
  currencyAmounts: [
    { currency: "KWD", minor: 295_990n, sent: 295_990, source: DOC.orderEntity },
    { currency: "JPY", minor: 295n, sent: 295, source: DOC.orderEntity },
  ],
  driver: () => new RazorpayDriver(),
  extraRows: [
    {
      scenario: "S1",
      id: "S1.poll-statuses",
      title: "every documented payment and refund status reads back as the webhook path books it",
      async run({ world }) {
        const w = await world("s1poll");
        const d = w.driver as RazorpayDriver;
        const a = await adapterOf(w);
        const bad: string[] = [];
        const payments: Array<[string, boolean, string]> = [
          ["created", false, "pending"],
          ["authorized", false, "pending"],
          ["captured", true, "succeeded"],
          // An authorization Razorpay returned on its own: no money was taken.
          ["refunded", false, "failed"],
          ["refunded", true, "succeeded"],
          ["failed", false, "failed"],
        ];
        for (const [status, captured, want] of payments) {
          const p = d.fake.newPayment({ amount: 1000, currency: "INR", status, captured });
          const got = (await a.fetchChargeStatus({ providerChargeId: p.id })).status;
          if (got !== want)
            bad.push(`payment ${status}/captured=${captured}: ${got} (want ${want})`);
        }
        const host = d.fake.newPayment({
          amount: 1000,
          currency: "INR",
          status: "captured",
          captured: true,
        });
        for (const [status, want] of [
          ["pending", "pending"],
          ["processed", "succeeded"],
          ["failed", "failed"],
        ]) {
          const r = d.fake.newRefund(host, 10, status);
          const got = (await a.fetchRefundStatus({ providerRefundId: r.id })).status;
          if (got !== want) bad.push(`refund ${status}: ${got} (want ${want})`);
        }
        return {
          pass: bad.length === 0,
          detail: `${bad.join("; ")} (${DOC.paymentEntity}, ${DOC.refundEntity})`,
        };
      },
    },
    {
      scenario: "S1",
      id: "S1.mandate-ended-statuses",
      title: "a token at cancellation_initiated or expired reads as a cancelled mandate",
      async run({ world }) {
        const w = await world("s1tok");
        const d = w.driver as RazorpayDriver;
        const b = await w.bill();
        const t = d.fake.tokens.get(String(d.payment(b.chargeId).token_id))!;
        const bad: string[] = [];
        for (const status of ["cancellation_initiated", "expired"]) {
          t.recurring_details = { status, failure_reason: null };
          const e = d.event("token.cancelled", { token: t });
          await w.deliver(e);
          const [row] = await w.eventRows(e.eventIds);
          const got = (row?.normalized as { mandate?: { status?: string } } | null)?.mandate
            ?.status;
          if (got !== "cancelled") bad.push(`${status}: ${got ?? "absent"}`);
        }
        return { pass: bad.length === 0, detail: `${bad.join("; ")} (${DOC.upiTokens})` };
      },
    },
    {
      scenario: "S7",
      id: "S7.non-json-answer",
      title:
        "a debit answered with a page that is not JSON resolves through the order, never a decline",
      async run({ world }) {
        const w = await world("s7html");
        const d = w.driver as RazorpayDriver;
        d.fake.htmlAnswers = 1;
        const b = await w.bill().finally(() => (d.fake.htmlAnswers = 0));
        const made = d.chargesOn(String(d.fake.payments.get(b.chargeId)?.token_id ?? ""));
        const outcome = b.txnStatus ?? b.paymentStatus;
        return {
          pass: made.length === 1 && b.chargeId === made[0] && outcome !== "failed",
          detail: `attempt ${outcome} id ${b.chargeId || "none"} charges ${made.length}`,
        };
      },
    },
    {
      scenario: "S8",
      id: "S8.refund-lost-answer-found",
      title: "a refund whose create answer was lost is found by our tag and keeps its gateway id",
      async run({ world }) {
        const w = await world("s8rl");
        const d = w.driver as RazorpayDriver;
        const b = await w.collected();
        d.fake.inject("refund", { kind: "network", afterCreate: true }, 1);
        const r = await refundPayment({
          organizationId: w.org.id,
          businessId: w.biz.id,
          paymentPublicId: b.paymentPublicId!,
          amountMinor: 2500,
        })
          .catch((e: Error) => e)
          .finally(() => d.fake.clearFaults());
        const atGateway = [...d.fake.refunds.values()].filter((x) => x.payment_id === b.chargeId);
        const rows = await withTenant(w.org.id, (tx) =>
          tx.select().from(refundsTable).where(eq(refundsTable.paymentId, b.paymentId!)),
        );
        const pass =
          !(r instanceof Error) &&
          atGateway.length === 1 &&
          rows.length === 1 &&
          rows[0]!.providerRefundId === atGateway[0]!.id;
        return {
          pass,
          detail: `${r instanceof Error ? `threw: ${r.message}` : `refund ${r.providerRefundId}`}; at gateway ${atGateway.length}; rows ${rows.map((x) => `${x.status}:${x.providerRefundId ?? "none"}`)}`,
        };
      },
    },
    {
      scenario: "S11",
      id: "S11.refund-on-unsettled",
      title: "a refund event on a payment we never received books nothing",
      async run({ world }) {
        const w = await world("s11un");
        const d = w.driver as RazorpayDriver;
        const b = await w.bill();
        const cash0 = await w.cash();
        const n = await w.entries();
        // Razorpay returns an uncaptured authorization by itself, as a refund.
        const p = d.payment(b.chargeId);
        p.status = "authorized";
        const r = d.fake.newRefund(p, p.amount, "processed");
        p.status = "refunded";
        await w.deliver(d.refundNote(r, "refund.processed"));
        const rows = await w.refundRows(b.paymentId!);
        return {
          pass: (await w.entries()) === n && (await w.cash()) === cash0 && rows.length === 0,
          detail: `entries +${(await w.entries()) - n} cash ${(await w.cash()) - cash0} refund rows ${rows.length}`,
        };
      },
    },
    {
      scenario: "S14",
      id: "S14.intent-notes",
      title: "an intent's order keeps notes inside 15 pairs of 256 characters, our tag included",
      async run({ world }) {
        const w = await world("s14n");
        const d = w.driver as RazorpayDriver;
        const a = await adapterOf(w);
        const cust = d.fake.customers.size
          ? [...d.fake.customers.keys()][0]!
          : (
              await a.ensureCustomer({
                customerRef: "cus_conf_notes",
                email: "conf-notes@example.com",
                name: "Conformance Payer",
              })
            ).providerCustomerId;
        await a
          .createIntent({
            purpose: "payment",
            currency: "INR",
            amountMinor: 5000n,
            customer: { providerKey: "razorpay", providerCustomerId: cust },
            idempotencyKey: "pi_conf_notes",
            ownershipRef: "pi_conf_notes_ref",
            session: "on_session",
            metadata: Object.fromEntries(
              Array.from({ length: 20 }, (_, i) => [`k${i}`, "v".repeat(400)]),
            ),
            description: "d".repeat(1000),
            methodTypes: ["card"],
          } as Parameters<RazorpayProvider["createIntent"]>[0])
          .catch((e: Error) => e);
        const call = d.fake.callsOf("order").at(-1);
        const notes = (call?.body.notes ?? {}) as Record<string, string>;
        const pass =
          !!call &&
          call.status === 200 &&
          Object.keys(notes).length <= 15 &&
          Object.values(notes).every((v) => v.length <= 256) &&
          notes.tmbilling_ref === "pi_conf_notes_ref";
        return {
          pass,
          detail: `order ${String(call?.status)} notes ${Object.keys(notes).length} pairs, tag ${notes.tmbilling_ref ?? "absent"}`,
        };
      },
    },
    {
      scenario: "S3",
      id: "S3.setup-auth-refunded",
      title: "a mandate's captured auth amount is refunded once, and never an invoice payment",
      async run({ world }) {
        const w = await world("s3setup");
        const d = w.driver as RazorpayDriver;
        const a = await adapterOf(w);
        const cust = "cust_CONFSETUP00001";
        const tok = d.fake.token();
        const order = d.fake.newOrder(100, "INR", { tmbilling_ref: "cus_conf_setup" });
        order.token = { max_amount: 50_000, frequency: "monthly" };
        const auth = d.fake.newPayment({
          amount: 100,
          currency: "INR",
          order_id: order.id,
          token_id: tok,
          customer_id: cust,
        });
        d.fake.capture(auth);
        const ref = await a.vaultPaymentMethod({
          customer: { providerKey: "razorpay", providerCustomerId: cust },
          token: auth.id,
        });
        // An invoice debit on the same token: never a setup auth, whatever it is handed as.
        const inv = d.fake.newOrder(50_000, "INR");
        const debit = d.fake.newPayment({
          amount: 50_000,
          currency: "INR",
          order_id: inv.id,
          token_id: tok,
          customer_id: cust,
        });
        d.fake.capture(debit);
        const invRef = await a.vaultPaymentMethod({
          customer: { providerKey: "razorpay", providerCustomerId: cust },
          token: debit.id,
        });
        const job = {
          organizationId: w.org.id,
          businessId: w.biz.id,
          gatewayAccountId: w.account.id,
          providerKey: "razorpay",
          providerCustomerId: cust,
          providerPaymentMethodId: tok,
          providerChargeId: auth.id,
          amountMinor: String(ref.setupAuthCharge?.amountMinor ?? 0n),
          currency: "INR",
          paymentMethod: "pm_conf_setup",
        };
        const at = { attempts: 1, maxAttempts: 12 };
        const first = await refundSetupAuth(job, at);
        const again = await refundSetupAuth(job, at);
        const made = [...d.fake.refunds.values()].filter((r) => r.payment_id === auth.id);
        const pass =
          ref.setupAuthCharge?.amountMinor === 100n &&
          !invRef.setupAuthCharge &&
          first === "refunded" &&
          again === "already_refunded" &&
          made.length === 1 &&
          made[0]!.amount === 100 &&
          auth.amount_refunded === 100 &&
          debit.amount_refunded === 0;
        return {
          pass,
          detail:
            `setup ${String(ref.setupAuthCharge?.amountMinor)} invoice ${invRef.setupAuthCharge ? "flagged" : "not flagged"}; ` +
            `${first} then ${again}; ${made.length} refund(s) (${DOC.captureSettings}, ${DOC.cardMandates})`,
        };
      },
    },
    {
      scenario: "S14",
      id: "S14.card-mandate-currency-label",
      title:
        "a card mandate stored as INR is charged for a USD invoice: the stored currency of a RazorPay card does not refuse it",
      async run({ world }) {
        const w = await world("s14rzlabel", "USD");
        const d = w.driver as RazorpayDriver;
        const before = d.fake.callsOf("charge").length;
        // A row vaulted before the card's currency was recorded: every card read as INR.
        const b = await w.bill("pays", {
          onVaulted: async (id) => {
            await withTenant(w.org.id, (tx) =>
              tx
                .update(paymentMethods)
                .set({ mandateCurrency: "INR", mandateRail: "card" })
                .where(eq(paymentMethods.id, id)),
            );
          },
        });
        const sent = d.fake.callsOf("charge").length - before;
        const p = d.fake.payments.get(b.chargeId);
        return {
          pass:
            sent === 1 && b.failureCode !== "mandate_currency_mismatch" && p?.currency === "USD",
          detail: `${sent} charge call(s), ${p?.currency ?? "no payment"}, ${b.txnStatus} ${b.failureCode ?? ""}`,
        };
      },
    },
    {
      scenario: "S14",
      id: "S14.card-mandate-registered-currency",
      title:
        "a card mandate registered in USD is stored as USD; a token with no registration payment stores no currency",
      async run({ world }) {
        const w = await world("s14rzreg", "USD");
        const d = w.driver as RazorpayDriver;
        const a = await adapterOf(w);
        const customer = await createCustomer({
          organizationId: w.org.id,
          businessId: w.biz.id,
          email: `s14rzreg-${Date.now()}@example.com`,
        });
        const tok = d.fake.token();
        const order = d.fake.newOrder(100, "USD", { tmbilling_ref: "cus_conf_usd" });
        order.token = { max_amount: 50_000, frequency: "monthly" };
        const auth = d.fake.newPayment({
          amount: 100,
          currency: "USD",
          order_id: order.id,
          token_id: tok,
        });
        d.fake.capture(auth);
        // The engine vault, as the storefront's card setup reaches it (`pay_…`).
        const pm = await vaultPaymentMethod({
          organizationId: w.org.id,
          businessId: w.biz.id,
          customer,
          token: auth.id,
          gatewayAccountId: w.account.publicId,
        });
        // A bare token names no payment: its card currency is unknown, never INR.
        const bare = await a.vaultPaymentMethod({
          customer: { providerKey: "razorpay", providerCustomerId: "cust_CONFBARE00001" },
          token: d.fake.token(),
        });
        return {
          pass: pm.mandateCurrency === "USD" && bare.mandate?.currency === undefined,
          detail: `vaulted ${pm.mandateCurrency ?? "none"}, bare token ${bare.mandate?.currency ?? "none"}`,
        };
      },
    },
  ],
};
