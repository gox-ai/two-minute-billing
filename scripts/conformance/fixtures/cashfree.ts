/**
 * Cashfree conformance fixtures. Recurring debits are Subscriptions API payments
 * (`sub:<payment id>`); objects follow the 2026-01-01 webhook samples on Cashfree's pages
 * and the shapes in `verify:cashfree`. Every id is a same-shape fake.
 */
import { createHash, createHmac, randomUUID } from "node:crypto";
import { and, desc, eq, gte } from "drizzle-orm";
import { systemDb } from "@/platform/db";
import { resolveAdapter } from "@/providers/registry";
import { GATEWAYS } from "@/providers/gateway-catalog";
import {
  CASHFREE_SANDBOX_BASE,
  CASHFREE_WEBHOOK_MAX_AGE_MS,
  subChargeRef,
  type CashfreeProvider,
} from "@/providers/cashfree";
import { auditLogs, customers, gatewayAccounts, paymentMethods } from "@db/schema";
import { detachPaymentMethod } from "@/modules/payment-methods/service";
import { FakeGateway, json, type FakeRequest } from "../fake-http";
import { txnsOf, type World } from "../harness";
import { ProviderRefusalError, type NormalizedProviderEvent } from "@/providers/types";
import type {
  Body,
  DocumentedStatus,
  GatewayDriver,
  GatewayFixture,
  RefundState,
  TokenKind,
} from "../types";

const HOST = CASHFREE_SANDBOX_BASE;
const READ = "2026-10-27";
const DOC = {
  spec: "https://www.cashfree.com/docs/openapi/payments/v2026-01-01.yaml",
  subEvents: "https://www.cashfree.com/docs/payments/subscription/webhooks",
  payEvents: "https://www.cashfree.com/docs/api-reference/payments/latest/payments/webhooks",
  refundEvents: "https://www.cashfree.com/docs/api-reference/payments/latest/refunds/webhooks",
  disputeEvents:
    "https://www.cashfree.com/docs/api-reference/payments/latest/disputes/dispute-webhooks",
  faq: "https://www.cashfree.com/docs/payments/subscription/faq",
};
const LATEST = "2026-01-01";
const REF_TAG = "tmbilling_ref";
const CUSTOMER_TAG = "tmbilling_customer";

type Obj = Record<string, unknown>;
type Rail = "card" | "enach";
interface CfSub {
  subscription_id: string;
  cf_subscription_id: string;
  subscription_status: string;
  subscription_tags: Record<string, string> | null;
  rail: Rail;
  /** When the token was made: the customer the harness creates next is its owner. */
  mintedAt: Date;
}
interface CfPay {
  payment_id: string;
  cf_payment_id: string;
  cf_order_id: string;
  subscription_id: string;
  payment_amount: number;
  payment_status: string;
  payment_type: string;
  payment_schedule_date: string | null;
  payment_remarks: string | null;
  failure_reason: string | null;
  /** Minor units refunded and not failed. */
  refunded: number;
}
interface CfRefund {
  refund_id: string;
  cf_refund_id: string;
  payment_id: string;
  cf_payment_id: string;
  refund_amount: number;
  refund_speed: string;
  refund_note: string;
  refund_status: string;
}

const minor = (rupees: unknown) => Math.round(Number(rupees) * 100);
const exp = (currency: string) => (currency === "JPY" ? 0 : 2);
const rupees = (m: number) => m / 100;
const err = (status: number, type: string, code: string, message: string) =>
  json(status, {
    message,
    code,
    type,
    help: "Check latest errors in the Merchant Dashboard API logs.",
  });

class FakeCashfree extends FakeGateway {
  readonly host = HOST;
  readonly subs = new Map<string, CfSub>();
  readonly pays = new Map<string, CfPay>();
  readonly refunds = new Map<string, CfRefund>();
  readonly orderRefunds: Obj[] = [];
  /** Paid pay-now orders: order id → the order's own amount (minor units) and currency. */
  readonly orders = new Map<
    string,
    { amountMinor: number; currency: string; cfPaymentId: string }
  >();
  /** x-idempotency-key → [the answer, the body it was made with]. */
  private readonly keys = new Map<string, [Obj, string]>();
  private digitSeq = 0;

  digits(): string {
    return String(49_000_000 + ++this.digitSeq) + String(Date.now() % 1000).padStart(3, "0");
  }

  /** `tms_<16 hex>`: the shape the adapter parses back out of a payment id. */
  subscription(rail: Rail, status = "ACTIVE"): string {
    const id = `tms_${this.id("", 10).toLowerCase()}`;
    this.subs.set(id, {
      subscription_id: id,
      cf_subscription_id: this.digits(),
      subscription_status: status,
      subscription_tags: null,
      rail,
      mintedAt: new Date(Date.now() - 2000),
    });
    return id;
  }

  /** The harness makes the customer after the token, so the tag is bound on first read. */
  private async bind(s: CfSub): Promise<void> {
    if (s.subscription_tags) return;
    const [c] = await systemDb
      .select({ publicId: customers.publicId })
      .from(customers)
      .innerJoin(
        gatewayAccounts,
        and(
          eq(gatewayAccounts.businessId, customers.businessId),
          eq(gatewayAccounts.gatewayKey, "cashfree"),
        ),
      )
      .where(gte(customers.createdAt, s.mintedAt))
      .orderBy(desc(customers.createdAt))
      .limit(1);
    if (c) s.subscription_tags = { [REF_TAG]: c.publicId, [CUSTOMER_TAG]: c.publicId };
  }

  authorization(s: CfSub): Obj {
    const method =
      s.rail === "enach"
        ? {
            enach: {
              channel: "link",
              auth_mode: "net_banking",
              account_number: "XXXXXXXX1111",
              account_ifsc: "TEST0000001",
            },
          }
        : {
            card: {
              channel: null,
              card_number: "XXXXXXXXXXXX1111",
              card_network: "visa",
              card_type: "debit_card",
              card_country: "IN",
              card_bank_name: "TEST BANK",
            },
          };
    return {
      authorization_amount: s.rail === "enach" ? 0 : 1,
      authorization_amount_refund: true,
      authorization_reference: `AUTHCONF${s.cf_subscription_id}`,
      authorization_status: "ACTIVE",
      payment_method: method,
      payment_group: s.rail === "enach" ? "enach" : "debit_card",
    };
  }

  subDetails(s: CfSub): Obj {
    return {
      cf_subscription_id: s.cf_subscription_id,
      subscription_id: s.subscription_id,
      subscription_status: s.subscription_status,
      subscription_expiry_time: "2055-01-01T00:00:00",
      subscription_first_charge_time: null,
      subscription_tags: s.subscription_tags,
      next_schedule_date: null,
    };
  }

  subObject(s: CfSub): Obj {
    return {
      ...this.subDetails(s),
      customer_details: { customer_email: "payer@example.com", customer_phone: "9000000000" },
      plan_details: { plan_type: "ON_DEMAND", plan_max_amount: 15000, plan_currency: "INR" },
      authorization_details: this.authorization(s),
    };
  }

  newRefund(
    p: CfPay,
    amountMinor: number,
    refundId: string,
    status: string,
    speed = "STANDARD",
    note = "Refund",
  ): CfRefund {
    const r: CfRefund = {
      refund_id: refundId,
      cf_refund_id: this.id("SUB_", 12),
      payment_id: p.payment_id,
      cf_payment_id: p.cf_payment_id,
      refund_amount: rupees(amountMinor),
      refund_speed: speed,
      refund_note: note,
      refund_status: status,
    };
    this.refunds.set(refundId, r);
    p.refunded += amountMinor;
    return r;
  }

  setRefundStatus(r: CfRefund, status: string): void {
    const gone = (s: string) =>
      s === "FAILED" || s === "CANCEL" || s === "CANCELLED" || s === "REJECTED";
    if (gone(status) && !gone(r.refund_status))
      this.pays.get(r.payment_id)!.refunded -= minor(r.refund_amount);
    r.refund_status = status;
  }

  /** Same key + same body replays the first answer; a different body is a 422. */
  private idem(req: FakeRequest, make: () => [number, Obj]): Response {
    const key = req.headers["x-idempotency-key"];
    const shape = req.text;
    const seen = key ? this.keys.get(key) : undefined;
    if (seen && seen[1] !== shape)
      return err(
        422,
        "idempotency_error",
        "request_invalid",
        "Different request body with the same idempotency key",
      );
    if (seen) return json(200, seen[0], { "x-idempotency-replayed": "true" });
    const [status, body] = make();
    if (key && status < 300) this.keys.set(key, [body, shape]);
    return json(status, body, key ? { "x-idempotency-replayed": "false" } : {});
  }

  payObject(p: CfPay): Obj {
    return {
      cf_payment_id: p.cf_payment_id,
      payment_id: p.payment_id,
      subscription_id: p.subscription_id,
      payment_type: p.payment_type,
      payment_amount: p.payment_amount,
      payment_status: p.payment_status,
      payment_schedule_date: p.payment_schedule_date,
      payment_remarks: p.payment_remarks,
      failure_details: { failure_reason: p.failure_reason },
    };
  }

  async route(req: FakeRequest): Promise<Response | null> {
    const { method, body } = req;
    const path = req.path.replace(/^\/pg/, "");
    if (method === "POST" && path === "/subscriptions")
      return this.guarded("vault_setup", req, () =>
        this.idem(req, () => [
          200,
          {
            subscription_id: body.subscription_id,
            subscription_session_id: `sub-session-${this.id("", 12)}`,
          },
        ]),
      );
    if (method === "POST" && path === "/orders")
      return this.guarded("intent", req, () =>
        this.idem(req, () => [
          200,
          {
            order_id: body.order_id,
            order_status: "ACTIVE",
            payment_session_id: `session_${this.id("", 12)}`,
          },
        ]),
      );
    const order = path.match(/^\/orders\/([^/]+)$/);
    if (method === "GET" && order)
      return this.guarded("order_read", req, () => {
        const o = this.orders.get(decodeURIComponent(order[1]!));
        return o
          ? json(200, {
              order_id: decodeURIComponent(order[1]!),
              order_status: "PAID",
              order_amount: o.amountMinor / 10 ** exp(o.currency),
              order_currency: o.currency,
            })
          : err(404, "invalid_request_error", "order_not_found", "order not found");
      });
    const orderRefunds = path.match(/^\/orders\/([^/]+)\/refunds$/);
    // Measured 2026-10-30: taken in the order's currency, decimals NOT checked, over-refund refused.
    if (method === "POST" && orderRefunds)
      return this.guarded("order_refund", req, () =>
        this.idem(req, () => {
          const oid = decodeURIComponent(orderRefunds[1]!);
          const o = this.orders.get(oid);
          if (!o)
            return [
              404,
              {
                message: "order not found",
                code: "order_not_found",
                type: "invalid_request_error",
              },
            ];
          const scale = 10 ** exp(o.currency);
          const taken = this.orderRefunds
            .filter((r) => r.order_id === oid && r.refund_status !== "CANCELLED")
            .reduce((a, r) => a + Number(r.refund_amount) * scale, 0);
          const amount = Number(body.refund_amount) * scale;
          if (taken + amount > o.amountMinor)
            return [
              400,
              {
                message: "Total amount of Refunds cannot be greater than the transaction amount",
                code: "refund_post_failed",
                type: "invalid_request_error",
              },
            ];
          const r = {
            order_id: oid,
            cf_payment_id: o.cfPaymentId,
            refund_id: String(body.refund_id),
            cf_refund_id: this.digits(),
            refund_amount: Number(body.refund_amount),
            refund_currency: o.currency,
            refund_status: "ONHOLD",
          };
          this.orderRefunds.push(r);
          return [200, { ...r }];
        }),
      );
    if (method === "GET" && orderRefunds)
      return this.guarded("order_refunds_list", req, () =>
        json(
          200,
          this.orderRefunds.filter((r) => r.order_id === decodeURIComponent(orderRefunds[1]!)),
        ),
      );
    if (method === "POST" && path === "/subscriptions/pay/controlled/execute-mandate")
      return this.guarded("execute", req, () =>
        err(
          400,
          "invalid_request_error",
          "payment_execution_error",
          "Payment attempt date cannot be before the scheduled date 2099-01-01",
        ),
      );
    if (method === "POST" && path === "/subscriptions/pay")
      return this.guarded("charge", req, () => {
        const s = this.subs.get(String(body.subscription_id));
        if (!s)
          return err(
            404,
            "invalid_request_error",
            "subscription_not_found",
            "subscription not found",
          );
        const pid = String(body.payment_id);
        const key = req.headers["x-idempotency-key"];
        if (this.pays.has(pid) && !(key && this.keys.has(key)))
          return err(
            409,
            "invalid_request_error",
            "payment_already_exists",
            "payment with same id is already present",
          );
        return this.idem(req, () => {
          const p: CfPay = {
            payment_id: pid,
            cf_payment_id: this.digits(),
            cf_order_id: this.digits(),
            subscription_id: s.subscription_id,
            payment_amount: Number(body.payment_amount),
            payment_status: "PENDING",
            payment_type: String(body.payment_type ?? "CHARGE"),
            payment_schedule_date: (body.payment_schedule_date as string | undefined) ?? null,
            payment_remarks: (body.payment_remarks as string | undefined) ?? null,
            failure_reason: null,
            refunded: 0,
          };
          this.pays.set(pid, p);
          return [200, this.payObject(p)];
        });
      });
    const manage = path.match(/^\/subscriptions\/([^/]+)\/payments\/([^/]+)\/manage$/);
    if (method === "POST" && manage)
      return this.guarded("cancel_charge", req, () => {
        const p = this.pays.get(decodeURIComponent(manage[2]!));
        if (!p) return err(404, "invalid_request_error", "payment_not_found", "payment not found");
        if (p.payment_status === "PENDING" || p.payment_status === "INITIALIZED")
          p.payment_status = "CANCELLED";
        if (p.payment_status !== "CANCELLED")
          return err(
            400,
            "invalid_request_error",
            "request_invalid",
            `payment in ${p.payment_status} state cannot be cancelled`,
          );
        return json(200, this.payObject(p));
      });
    const list = path.match(/^\/subscriptions\/([^/]+)\/payments$/);
    if (method === "GET" && list)
      return this.guarded("list_payments", req, () => {
        const sid = decodeURIComponent(list[1]!);
        if (!this.subs.has(sid))
          return err(
            404,
            "invalid_request_error",
            "subscription_not_found",
            "subscription not found",
          );
        return json(
          200,
          [...this.pays.values()]
            .filter((p) => p.subscription_id === sid)
            .map((p) => this.payObject(p)),
        );
      });
    // Measured 2026-10-31: the subscription's CANCEL leaves its scheduled payments INITIALIZED.
    const subManage = path.match(/^\/subscriptions\/([^/]+)\/manage$/);
    if (method === "POST" && subManage)
      return this.guarded("cancel_mandate", req, () => {
        const s = this.subs.get(decodeURIComponent(subManage[1]!));
        if (!s)
          return err(
            404,
            "invalid_request_error",
            "subscription_not_found",
            "subscription not found",
          );
        if (body.action === "CANCEL") s.subscription_status = "CANCELLED";
        return json(200, this.subObject(s));
      });
    const pay = path.match(/^\/subscriptions\/([^/]+)\/payments\/([^/]+)$/);
    if (method === "GET" && pay)
      return this.guarded("lookup", req, () => {
        const p = this.pays.get(decodeURIComponent(pay[2]!));
        return p
          ? json(200, this.payObject(p))
          : err(404, "invalid_request_error", "payment_not_found", "payment not found");
      });
    const refunds = path.match(/^\/subscriptions\/([^/]+)\/refunds$/);
    if (method === "POST" && refunds)
      return this.guarded("refund", req, () =>
        this.idem(req, () => {
          const p = this.pays.get(String(body.payment_id));
          if (!p)
            return [
              404,
              {
                message: "payment not found",
                code: "payment_not_found",
                type: "invalid_request_error",
              },
            ];
          const amount = minor(body.refund_amount);
          if (p.payment_status !== "SUCCESS" || amount > minor(p.payment_amount) - p.refunded)
            return [
              400,
              {
                message: "refund amount is more than the refundable amount",
                code: "refund_amount_invalid",
                type: "invalid_request_error",
              },
            ];
          const r = this.newRefund(
            p,
            amount,
            String(body.refund_id),
            "INITIALIZED",
            String(body.refund_speed),
            String(body.refund_note),
          );
          return [200, { ...r }];
        }),
      );
    const refund = path.match(/^\/subscriptions\/([^/]+)\/refunds\/([^/]+)$/);
    if (method === "GET" && refund) {
      const r = this.refunds.get(decodeURIComponent(refund[2]!));
      return r
        ? json(200, r)
        : err(404, "invalid_request_error", "refund_not_found", "refund not found");
    }
    const sub = path.match(/^\/subscriptions\/([^/]+)$/);
    if (method === "GET" && sub) {
      const s = this.subs.get(decodeURIComponent(sub[1]!));
      if (!s)
        return err(
          404,
          "invalid_request_error",
          "subscription_not_found",
          "subscription not found",
        );
      await this.bind(s);
      return json(200, this.subObject(s));
    }
    return null;
  }
}

/** A subscription payment's id inside our charge id `sub:<payment id>`. */
const pidOf = (chargeId: string) => decodeURIComponent(chargeId.replace(/^sub:/, ""));
/** Our refund id `subrf:<payment id>:<refund id>` → Cashfree's `refund_id`. */
const ridOf = (refundId: string) => decodeURIComponent(refundId.split(":")[2] ?? "");

class CashfreeDriver implements GatewayDriver {
  readonly fake = new FakeCashfree();
  readonly forgedStatus = 400;
  readonly chargeOp = "charge";
  readonly refundOp = "refund";
  /** GET of a subscription payment: the adapter's read after a lost answer, and `locateCharge`. */
  readonly lookupOp = "lookup";
  readonly errors = {
    conflict: {
      status: 409,
      body: {
        message: "payment with same id is already present",
        code: "payment_already_exists",
        type: "invalid_request_error",
      },
    },
    rateLimited: {
      status: 429,
      body: {
        message: "Too many requests from IP. Check headers",
        code: "request_failed",
        type: "rate_limit_error",
      },
      headers: { "x-ratelimit-retry": "1" },
    },
    server: {
      status: 500,
      body: { message: "internal Server Error", code: "internal_error", type: "api_error" },
    },
    // ApiError502: "Error when there is error at partner bank".
    internal: {
      status: 502,
      body: {
        message: "bank processing failure",
        code: "bank_processing_failure",
        type: "api_error",
      },
    },
    refundRefused: {
      status: 400,
      body: {
        message: "refund amount is more than the refundable amount",
        code: "refund_amount_invalid",
        type: "invalid_request_error",
      },
    },
  };
  /** Body → webhook version, for deliveries that are not on the latest one. */
  readonly versions = new Map<string, string>();

  credentials(webhookSecret: string) {
    return {
      app_id: "CFCONF00000000000000000001",
      secret_key: "cfsk_ma_test_conformance_000000000001",
      webhook_secret: webhookSecret,
    };
  }
  token(kind: TokenKind) {
    if (kind === "pays") return this.fake.subscription("card");
    if (kind === "bank_debit") return this.fake.subscription("enach");
    return null;
  }
  sign(_w: World, body: string, secret: string) {
    const ts = String(Date.now());
    const version = this.versions.get(body) ?? LATEST;
    return {
      "x-webhook-timestamp": ts,
      "x-webhook-signature": createHmac("sha256", secret)
        .update(ts + body)
        .digest("base64"),
      "x-webhook-version": version,
      "x-webhook-attempt": "1",
      // Sent from version 2025-01-01 on.
      ...(version >= "2025-01-01" ? { "x-idempotency-key": eventKey(body) } : {}),
    };
  }

  event(type: string, data: Obj, version = LATEST): Body {
    const body = JSON.stringify({ data, event_time: new Date().toISOString(), type });
    if (version !== LATEST) this.versions.set(body, version);
    return { body, eventIds: version >= "2025-01-01" ? [eventKey(body)] : [] };
  }

  pay(chargeId: string): CfPay {
    const p = this.fake.pays.get(pidOf(chargeId));
    if (!p) throw new Error(`fake Cashfree has no payment ${chargeId}`);
    return p;
  }

  /** A subscription payment event in the 2026-01-01 shape. */
  payData(p: CfPay): Obj {
    const s = this.fake.subs.get(p.subscription_id)!;
    return {
      payment_id: p.payment_id,
      cf_payment_id: p.cf_payment_id,
      cf_txn_id: p.cf_order_id,
      cf_order_id: p.cf_order_id,
      subscription_id: s.subscription_id,
      cf_subscription_id: s.cf_subscription_id,
      payment_type: p.payment_type,
      subscription_details: this.fake.subDetails(s),
      authorization_details: { ...this.fake.authorization(s), authorization_status: null },
      payment_amount: p.payment_amount,
      payment_currency: "INR",
      payment_schedule_date: p.payment_schedule_date ?? "",
      payment_initiated_date: new Date().toISOString(),
      payment_remarks: p.payment_remarks ?? "",
      retry_attempts: 0,
      failure_details: { failure_reason: p.failure_reason },
      payment_status: p.payment_status,
      payment_gateway_details: {
        gateway_name: "CASHFREE",
        gateway_subscription_id: s.cf_subscription_id,
        gateway_payment_id: p.cf_payment_id,
      },
    };
  }

  payEvent(
    p: CfPay,
    status: "SUCCESS" | "FAILED" | "CANCELLED",
    reason: string | null = null,
  ): Body {
    p.payment_status = status;
    p.failure_reason = reason;
    const type = {
      SUCCESS: "SUBSCRIPTION_PAYMENT_SUCCESS",
      FAILED: "SUBSCRIPTION_PAYMENT_FAILED",
      CANCELLED: "SUBSCRIPTION_PAYMENT_CANCELLED",
    }[status];
    return this.event(type, this.payData(p));
  }

  /** SUBSCRIPTION_REFUND_STATUS, 2025-01-01: the latest version the page documents. */
  refundNote(r: CfRefund): Body {
    return this.event("SUBSCRIPTION_REFUND_STATUS", {
      payment_id: r.payment_id,
      cf_payment_id: r.cf_payment_id,
      refund_id: r.refund_id,
      cf_refund_id: r.cf_refund_id,
      refund_amount: r.refund_amount,
      refund_speed: r.refund_speed,
      refund_note: r.refund_note,
      refund_status: r.refund_status,
      failure_details: "",
      refund_gateway_details: {
        gateway_name: "CASHFREE",
        gateway_payment_id: r.cf_payment_id,
        gateway_refund_id: r.cf_refund_id,
      },
    });
  }

  collect(w: World, chargeId: string) {
    return this.paymentSucceeded(w, chargeId);
  }
  paymentSucceeded(_w: World, chargeId: string) {
    return [this.payEvent(this.pay(chargeId), "SUCCESS")];
  }
  paymentFailed(_w: World, chargeId: string) {
    return [
      this.payEvent(
        this.pay(chargeId),
        "FAILED",
        "DEBIT FAILED | Insufficient Funds In Customer (Remitter) Account",
      ),
    ];
  }
  refundEvent(_w: World, _chargeId: string, refundId: string, state: RefundState) {
    const r = this.fake.refunds.get(ridOf(refundId));
    if (!r) throw new Error(`fake Cashfree has no refund ${refundId}`);
    this.fake.setRefundStatus(
      r,
      { pending: "PENDING", succeeded: "SUCCESS", failed: "FAILED" }[state],
    );
    return [this.refundNote(r)];
  }
  /** Cashfree sends the refund event on success, failure or cancellation only. */
  dashboardRefund(_w: World, chargeId: string, amountMinor: bigint) {
    const r = this.fake.newRefund(
      this.pay(chargeId),
      Number(amountMinor),
      this.fake.id("refund_", 10),
      "SUCCESS",
    );
    return { refundId: r.refund_id, events: [this.refundNote(r)] };
  }
  disputeSteps() {
    return null;
  }
  /** Our charge ids (`sub:<payment id>`), the ids the scenarios compare with. */
  chargesOn(subscriptionId: string) {
    return [...this.fake.pays.values()]
      .filter((p) => p.subscription_id === subscriptionId)
      .map((p) => subChargeRef(p.payment_id));
  }

  disputeEvent(status: string, chargeId: string, type?: string): Body {
    const p = this.pay(chargeId);
    const stage =
      /^(DISPUTE|CHARGEBACK|RETRIEVAL|PRE_ARBITRATION|ARBITRATION)_/.exec(status)?.[1] ?? "DISPUTE";
    const t =
      type ??
      (/_CREATED$/.test(status)
        ? "DISPUTE_CREATED"
        : /_(MERCHANT_WON|MERCHANT_LOST|MERCHANT_ACCEPTED)$/.test(status)
          ? "DISPUTE_CLOSED"
          : "DISPUTE_UPDATED");
    return this.event(t, {
      dispute: {
        dispute_id: this.fake.digits(),
        dispute_type: stage,
        reason_code: "1402",
        reason_description: "Duplicate Processing",
        dispute_amount: p.payment_amount,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        respond_by: new Date(Date.now() + 3 * 86_400_000).toISOString(),
        dispute_status: status,
        cf_dispute_remarks: "Dispute is created, please take action",
        dispute_action_on: "MERCHANT",
        dispute_amount_currency: "INR",
      },
      order_details: {
        order_id: `order_${p.cf_order_id}`,
        order_amount: p.payment_amount,
        order_currency: "INR",
        cf_payment_id: Number(p.cf_payment_id),
        payment_amount: p.payment_amount,
        payment_currency: "INR",
      },
      customer_details: {
        customer_name: "Conformance Payer",
        customer_phone: "9000000000",
        customer_email: "payer@example.com",
      },
    });
  }

  statusEvent(_w: World, st: DocumentedStatus, chargeId: string): Body[] {
    const p = this.pay(chargeId);
    const s = this.fake.subs.get(p.subscription_id)!;
    switch (st.object) {
      case "event:subscription": {
        if (st.status === "SUBSCRIPTION_PAYMENT_SUCCESS") return [this.payEvent(p, "SUCCESS")];
        if (st.status === "SUBSCRIPTION_PAYMENT_FAILED") return this.paymentFailed(_w, chargeId);
        if (st.status === "SUBSCRIPTION_PAYMENT_CANCELLED") return [this.payEvent(p, "CANCELLED")];
        if (st.status === "SUBSCRIPTION_PAYMENT_NOTIFICATION_INITIATED")
          return [this.event(st.status, { ...this.payData(p), payment_status: "PENDING" })];
        if (st.status === "SUBSCRIPTION_CARD_EXPIRY_REMINDER")
          return [
            this.event(st.status, {
              subscription_status_webhook: { subscription_details: this.fake.subDetails(s) },
              card_expiry_date: "2034-12-31",
            }),
          ];
        if (st.status === "SUBSCRIPTION_REFUND_STATUS") {
          p.payment_status = "SUCCESS";
          return [
            this.refundNote(this.fake.newRefund(p, 500, this.fake.id("refund_", 10), "SUCCESS")),
          ];
        }
        if (st.status === "SUBSCRIPTION_STATUS_CHANGED")
          return [
            this.event(st.status, {
              subscription_details: this.fake.subDetails(s),
              authorization_details: this.fake.authorization(s),
            }),
          ];
        if (st.status === "SUBSCRIPTION_AUTH_STATUS")
          return [
            this.event(st.status, {
              ...this.payData(p),
              payment_type: "AUTH",
              payment_status: "SUCCESS",
            }),
          ];
        const ctl = st.status.includes("NOTIFICATION")
          ? {
              notification_id: `${p.payment_id}-n`,
              notification_status: "SUCCESS",
              notification_completed_time: new Date().toISOString(),
            }
          : { execution_id: `${p.payment_id}-x`, execution_status: "SUCCESS" };
        return [
          this.event(st.status, {
            ...ctl,
            payment_id: p.payment_id,
            payment_amount: p.payment_amount,
            subscription_id: s.subscription_id,
          }),
        ];
      }
      case "subscription-status":
        return [
          this.event("SUBSCRIPTION_STATUS_CHANGED", {
            subscription_details: { ...this.fake.subDetails(s), subscription_status: st.status },
            plan_details: { plan_type: "ON_DEMAND", plan_max_amount: 15000, plan_currency: "INR" },
            authorization_details: this.fake.authorization(s),
          }),
        ];
      case "subscription-refund": {
        p.payment_status = "SUCCESS";
        return [
          this.refundNote(this.fake.newRefund(p, 500, this.fake.id("refund_", 10), st.status)),
        ];
      }
      case "event:order": {
        const orderId = this.fake.id("order_", 10);
        const status = {
          PAYMENT_SUCCESS_WEBHOOK: "SUCCESS",
          PAYMENT_FAILED_WEBHOOK: "FAILED",
          PAYMENT_USER_DROPPED_WEBHOOK: "USER_DROPPED",
        }[st.status];
        return [
          this.event(st.status, {
            order: {
              order_id: orderId,
              order_amount: 100,
              order_currency: "INR",
              order_tags: null,
            },
            payment: {
              cf_payment_id: Number(this.fake.digits()),
              payment_status: status ?? "SUCCESS",
              payment_amount: 100,
              payment_currency: "INR",
            },
            ...(st.status === "PAYMENT_CHARGES_WEBHOOK"
              ? { charges_details: { service_charge: 2, service_tax: 0.36 } }
              : {}),
          }),
        ];
      }
      case "order-refund":
      case "event:auto-refund": {
        const auto = st.object === "event:auto-refund";
        const oid = this.fake.id("order_", 10);
        const cfp = this.fake.digits();
        this.fake.orders.set(oid, { amountMinor: 10_000, currency: "INR", cfPaymentId: cfp });
        const r = {
          order_id: oid,
          cf_payment_id: Number(cfp),
          refund_id: this.fake.id("refund_", 10),
          cf_refund_id: Number(this.fake.digits()),
          refund_amount: 50,
          refund_currency: "INR",
          refund_status: auto ? "SUCCESS" : st.status,
          refund_type: auto ? "PAYMENT_AUTO_REFUND" : "MERCHANT_INITIATED",
        };
        this.fake.orderRefunds.push(r);
        return [
          this.event(
            auto ? "AUTO_REFUND_STATUS_WEBHOOK" : "REFUND_STATUS_WEBHOOK",
            auto ? { auto_refund: r } : { refund: r },
          ),
        ];
      }
      case "dispute":
        return [this.disputeEvent(st.status, chargeId)];
    }
    throw new Error(`no status event for ${st.object}`);
  }
}

/** Version 2025-01-01 and later name each delivery with `x-idempotency-key`. */
const eventKey = (body: string) => createHash("sha256").update(body).digest("base64");

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
  return resolveAdapter(acc!) as unknown as CashfreeProvider;
};

/** A Payments-tab delivery (version 2025-01-01) read by the adapter itself. */
const adapterRead = async (w: World, type: string, data: Obj) => {
  const d = w.driver as CashfreeDriver;
  const body = d.event(type, data, "2025-01-01").body;
  return (await adapterOf(w)).normalizeWebhook({
    payload: body,
    headers: d.sign(w, body, w.secret),
  });
};

/** A paid pay-now order in the fake: its id and Cashfree payment id. */
const paidOrder = (d: CashfreeDriver, amountMinor: number, currency: string) => {
  const oid = d.fake.id("order_", 10);
  const cfp = d.fake.digits();
  d.fake.orders.set(oid, { amountMinor, currency, cfPaymentId: cfp });
  return { oid, cfp };
};

/** The order-payment dispute shape on Cashfree's dispute webhook page. */
const disputeData = (oid: string, cfp: string, dispute: Obj, order: Obj) => ({
  dispute: {
    dispute_id: `${Date.now()}${Math.floor(Math.random() * 1000)}`,
    dispute_type: "CHARGEBACK",
    reason_description: "Fraudulent transaction",
    dispute_status: "CHARGEBACK_CREATED",
    respond_by: new Date(Date.now() + 3 * 86_400_000).toISOString(),
    ...dispute,
  },
  order_details: { order_id: oid, cf_payment_id: Number(cfp), ...order },
});

/** A pay-now order for an international card payer. */
const payNowInput = (currency: string, amountMinor: bigint) =>
  ({
    purpose: "payment",
    amountMinor,
    currency,
    customer: { providerKey: "cashfree", providerCustomerId: "cus_XXXXXXXXXXXX01" },
    idempotencyKey: `conf_${randomUUID()}`,
    contact: { email: "payer@example.com", phone: "+14155550100", name: "Conformance Payer" },
  }) as Parameters<CashfreeProvider["createIntent"]>[0];

/** The normalized events the route recorded for a delivery. */
const normalizedOf = async (w: World, b: Body) =>
  (await w.eventRows(b.eventIds)).map((r) => (r.normalized ?? {}) as Record<string, unknown>);

const sub = (s: string, expect: DocumentedStatus["expect"]) =>
  st("event:subscription", s, "subscription-events", expect);
const opened = ["dispute.created", "dispute.funds_withdrawn"] as DocumentedStatus["expect"];
const DISPUTE_STAGES = ["DISPUTE", "CHARGEBACK", "RETRIEVAL", "PRE_ARBITRATION", "ARBITRATION"];
const disputeStatuses: DocumentedStatus[] = DISPUTE_STAGES.flatMap((stage) => {
  const open = stage === "RETRIEVAL" ? (["dispute.created"] as DocumentedStatus["expect"]) : opened;
  return [
    ["CREATED", open],
    ["DOCS_RECEIVED", open],
    ...(stage === "ARBITRATION" ? [["CONTEST_REQUESTED", open] as const] : []),
    ["UNDER_REVIEW", open],
    ["MERCHANT_WON", ["dispute.won"]],
    ["MERCHANT_LOST", ["dispute.lost"]],
    ["MERCHANT_ACCEPTED", ["dispute.lost"]],
    // On DISPUTE_UPDATED Cashfree asks for documents again: still open.
    ["INSUFFICIENT_EVIDENCE", open],
  ].map(([outcome, expect]) =>
    st("dispute", `${stage}_${outcome}`, "spec", expect as DocumentedStatus["expect"]),
  );
});

export const cashfreeFixture: GatewayFixture = {
  key: "cashfree",
  currency: "INR",
  docs: [
    { id: "subscription-events", url: DOC.subEvents, read: READ, check: { kind: "page" } },
    { id: "spec", url: DOC.spec, read: READ, check: { kind: "page" } },
    { id: "payment-events", url: DOC.payEvents, read: READ, check: { kind: "page" } },
    { id: "refund-events", url: DOC.refundEvents, read: READ, check: { kind: "page" } },
  ],
  statuses: [
    // Subscription webhooks (Subscriptions tab, version 2026-01-01).
    sub("SUBSCRIPTION_PAYMENT_SUCCESS", ["charge.succeeded"]),
    sub("SUBSCRIPTION_PAYMENT_FAILED", ["charge.failed"]),
    sub("SUBSCRIPTION_PAYMENT_CANCELLED", ["charge.failed"]),
    sub("SUBSCRIPTION_PAYMENT_NOTIFICATION_INITIATED", {
      none: "Cashfree's own pre-debit notice; the payment's events carry its money.",
    }),
    sub("SUBSCRIPTION_REFUND_STATUS", ["charge.refunded"]),
    sub("SUBSCRIPTION_STATUS_CHANGED", ["payment_method.mandate_updated"]),
    sub("SUBSCRIPTION_AUTH_STATUS", ["intent.setup_succeeded"]),
    sub("SUBSCRIPTION_CARD_EXPIRY_REMINDER", {
      none: "A reminder; the mandate's own status change follows when the card expires.",
    }),
    sub("SUBSCRIPTION_CONTROLLED_NOTIFICATION_STATUS", ["pre_debit_notice.updated"]),
    sub("SUBSCRIPTION_CONTROLLED_EXECUTION_STATUS", ["charge.succeeded"]),
    // SUBSCRIPTION_STATUS_CHANGED statuses (the page's list).
    ...[
      "ACTIVE",
      "ON_HOLD",
      "COMPLETED",
      "CUSTOMER_CANCELLED",
      "CUSTOMER_PAUSED",
      "EXPIRED",
      "LINK_EXPIRED",
      "BANK_APPROVAL_PENDING",
      "CANCELLED",
      "CARD_EXPIRED",
    ].map((s) =>
      st("subscription-status", s, "subscription-events", ["payment_method.mandate_updated"]),
    ),
    // Subscription refund status (spec: "INITIALIZED, SUCCESS, CANCEL, PENDING or FAILED").
    st("subscription-refund", "INITIALIZED", "spec", ["refund.pending"]),
    st("subscription-refund", "PENDING", "spec", ["refund.pending"]),
    st("subscription-refund", "SUCCESS", "spec", ["charge.refunded"]),
    st("subscription-refund", "CANCEL", "spec", ["refund.failed"]),
    st("subscription-refund", "FAILED", "spec", ["refund.failed"]),
    // Pay-now orders (Payments tab, version 2025-01-01).
    // A paid order is the intent's capture, booked through the intent.
    st("event:order", "PAYMENT_SUCCESS_WEBHOOK", "payment-events", ["intent.authorized"]),
    st("event:order", "PAYMENT_FAILED_WEBHOOK", "payment-events", ["charge.failed"]),
    st("event:order", "PAYMENT_USER_DROPPED_WEBHOOK", "payment-events", {
      none: "The buyer left the checkout; the order stays payable.",
    }),
    st("event:order", "PAYMENT_CHARGES_WEBHOOK", "payment-events", {
      none: "A fee breakdown; it moves no money of the payer's.",
    }),
    // Order refund status (spec RefundEntity.refund_status enum).
    st("order-refund", "SUCCESS", "spec", ["charge.refunded"]),
    st("order-refund", "PENDING", "spec", ["refund.pending"]),
    st("order-refund", "PENDING_APPROVAL", "spec", ["refund.pending"]),
    st("order-refund", "ONHOLD", "spec", ["refund.pending"]),
    st("order-refund", "CANCELLED", "spec", ["refund.failed"]),
    st("order-refund", "REJECTED", "spec", ["refund.failed"]),
    st("event:auto-refund", "AUTO_REFUND_STATUS_WEBHOOK", "refund-events", ["charge.refunded"]),
    // Dispute status (spec DisputesEntity.dispute_status enum).
    ...disputeStatuses,
  ],
  na: {
    S5: `Dispute events name a pay-now order (\`order_details.order_id\`, \`cf_payment_id\`): ${DOC.disputeEvents} (read ${READ}). No documented dispute names a subscription debit, the only charge the scenarios make. The mapping is S1's dispute rows.`,
    S9: `No documented event takes back a SUBSCRIPTION_PAYMENT_SUCCESS; a failed debit is retried, never reversed: ${DOC.faq} (read ${READ}).`,
  },
  limits: [
    {
      op: "charge",
      field: "header:x-idempotency-key",
      max: 36,
      source: `${DOC.spec} (x-idempotency-key, format UUID)`,
    },
    {
      op: "refund",
      field: "header:x-idempotency-key",
      max: 36,
      source: `${DOC.spec} (x-idempotency-key, format UUID)`,
    },
  ],
  driver: () => new CashfreeDriver(),
  extraRows: [
    {
      scenario: "S12",
      id: "S12.stale-signed-refused",
      title: "a delivery signed with the right key but a timestamp past the window is refused",
      async run({ world }) {
        const w = await world("s12stale");
        const d = w.driver as CashfreeDriver;
        const b = await w.collected();
        const r = d.dashboardRefund(w, b.chargeId, 1000n);
        const body = r.events[0]!.body;
        const ts = String(Date.now() - CASHFREE_WEBHOOK_MAX_AGE_MS - 60_000);
        const res = await w.app.inject({
          method: "POST",
          url: `/v1/gateway_webhooks/cashfree?id=${w.account.publicId}`,
          headers: {
            "content-type": "application/json",
            host: new URL(w.notificationUrl).host,
            ...d.sign(w, body, w.secret),
            "x-webhook-timestamp": ts,
            "x-webhook-signature": createHmac("sha256", w.secret)
              .update(ts + body)
              .digest("base64"),
          },
          payload: body,
        });
        const rows = await w.eventRows(r.events[0]!.eventIds);
        return {
          pass: res.statusCode === 400 && rows.length === 0,
          detail: `status ${res.statusCode} rows ${rows.length}`,
        };
      },
    },
    {
      scenario: "S1",
      id: "S1.notice-lead-from-delivery",
      title: "a delivered UPI notice allows the debit 25 h after delivery, outside NPCI peak hours",
      async run({ world }) {
        const w = await world("s1lead");
        const d = w.driver as CashfreeDriver;
        const b = await w.bill("pays");
        const pid = pidOf(b.chargeId);
        // 02:00 IST: 25 h later is 03:00 IST, outside both peak windows.
        const delivered = "2026-10-20T02:00:00+05:30";
        const ev = d.event("SUBSCRIPTION_CONTROLLED_NOTIFICATION_STATUS", {
          notification_id: `${pid}-n`,
          notification_status: "SUCCESS",
          notification_attempted_time: "2026-10-20T01:59:00+05:30",
          notification_completed_time: delivered,
          payment_id: pid,
          payment_amount: 100,
        });
        await w.deliver(ev);
        const [n] = await normalizedOf(w, ev);
        const at = (n?.preDebitNotice as { executableAfter?: string } | undefined)?.executableAfter;
        const want = new Date(new Date(delivered).getTime() + 25 * 3_600_000).toISOString();
        return {
          pass: !!at && new Date(at).toISOString() === want,
          detail: `executableAfter ${at ?? "absent"} (want ${want})`,
        };
      },
    },
    {
      scenario: "S1",
      id: "S1.dispute-insufficient-evidence-closed",
      title: "INSUFFICIENT_EVIDENCE on DISPUTE_CLOSED is a loss",
      async run({ world }) {
        const w = await world("s1ie");
        const d = w.driver as CashfreeDriver;
        const b = await w.collected();
        const ev = d.disputeEvent("CHARGEBACK_INSUFFICIENT_EVIDENCE", b.chargeId, "DISPUTE_CLOSED");
        await w.deliver(ev);
        const got = await w.recordedTypes(ev.eventIds);
        return {
          pass: got.join() === "dispute.lost",
          detail: `recorded ${got.join(",") || "nothing"}`,
        };
      },
    },
    {
      scenario: "S1",
      id: "S1.pre-arbitration-own-case",
      title: "a pre-arbitration opens its own case, so it can take the money again after a win",
      async run({ world }) {
        const w = await world("s1pa");
        const d = w.driver as CashfreeDriver;
        const b = await w.collected();
        const ev = d.disputeEvent("PRE_ARBITRATION_CREATED", b.chargeId);
        await w.deliver(ev);
        const ids = (await normalizedOf(w, ev)).map((n) => String(n.providerDisputeId ?? ""));
        return {
          pass: ids.length > 0 && ids.every((i) => i.endsWith(":pre_arbitration")),
          detail: `dispute ids ${ids.join(",") || "none"}`,
        };
      },
    },
    {
      scenario: "S1",
      id: "S1.rejected-enach-mandate",
      title: "a failed eNACH authorization fails the setup and marks the mandate rejected",
      async run({ world }) {
        const w = await world("s1rej");
        const d = w.driver as CashfreeDriver;
        const sid = d.fake.subscription("enach", "INITIALIZED");
        const s = d.fake.subs.get(sid)!;
        const ev = d.event("SUBSCRIPTION_AUTH_STATUS", {
          payment_id: `${sid}-auth`,
          cf_payment_id: d.fake.digits(),
          subscription_id: sid,
          payment_type: "AUTH",
          payment_status: "FAILED",
          subscription_details: d.fake.subDetails(s),
          authorization_details: { ...d.fake.authorization(s), authorization_status: "FAILED" },
          failure_details: { failure_reason: "Mandate rejected by the bank" },
        });
        await w.deliver(ev);
        const ns = await normalizedOf(w, ev);
        const types = ns.map((n) => n.type).sort();
        const mandate = ns.find((n) => n.type === "payment_method.mandate_updated")?.mandate as
          | { status?: string }
          | undefined;
        return {
          pass:
            types.join() === "intent.setup_failed,payment_method.mandate_updated" &&
            mandate?.status === "rejected",
          detail: `recorded ${types.join(",") || "nothing"} mandate ${mandate?.status ?? "absent"}`,
        };
      },
    },
    {
      scenario: "S2",
      id: "S2.enach-refund-instant",
      title: "an eNACH debit's refund goes INSTANT (Cashfree takes no STANDARD eNACH refund)",
      async run({ world }) {
        const w = await world("s2en");
        const d = w.driver as CashfreeDriver;
        const b = await w.bill("bank_debit");
        await w.deliver(d.collect(w, b.chargeId));
        const after = await w.reload(b);
        const adapter = await adapterOf(w);
        await adapter
          .refund({
            providerChargeId: after.chargeId,
            amountMinor: 1000n,
            currency: "INR",
            idempotencyKey: `re_${randomUUID()}`,
          })
          .catch((e: Error) => e);
        const speed = d.fake.callsOf("refund").at(-1)?.body.refund_speed;
        return { pass: speed === "INSTANT", detail: `refund_speed ${String(speed)}` };
      },
    },
    {
      scenario: "S8",
      id: "S8.execute-not-due",
      title: "a controlled execution refused only as too early defers the debit, never declines it",
      async run({ world }) {
        const w = await world("s8nd");
        const d = w.driver as CashfreeDriver;
        const sid = d.fake.subscription("card");
        const adapter = await adapterOf(w);
        const r = await adapter
          .charge({
            amountMinor: 10_000n,
            currency: "INR",
            customer: { providerKey: "cashfree", providerCustomerId: "cus_XXXXXXXXXXXX01" },
            paymentMethod: {
              providerKey: "cashfree",
              providerPaymentMethodId: sid,
              providerCustomerId: "cus_XXXXXXXXXXXX01",
              display: { type: "upi" },
            },
            idempotencyKey: `conf_${sid}`,
            preDebitNotice: {
              notificationRef: `${sid}-0123456789ab-n`,
              amountMinor: 10_000n,
              debitNumber: 1,
            },
          })
          .catch((e: Error) => e);
        const f = r instanceof Error ? null : r.failure;
        return {
          pass:
            !(r instanceof Error) &&
            f?.code === "pre_debit_not_due" &&
            f.retriable === true &&
            (f.retryAfterMs ?? 0) > 0,
          detail:
            r instanceof Error
              ? `threw: ${r.message}`
              : `${r.status} ${f?.code ?? ""} retriable=${f?.retriable} wait=${f?.retryAfterMs}`,
        };
      },
    },
    {
      scenario: "S13",
      id: "S13.v2025-payment-books",
      title:
        "a SUBSCRIPTION_PAYMENT_SUCCESS on version 2025-01-01 (no subscription_details) is booked",
      async run({ world }) {
        const w = await world("s13v25");
        const d = w.driver as CashfreeDriver;
        const b = await w.bill("pays");
        const cash0 = await w.cash();
        const p = d.pay(b.chargeId);
        p.payment_status = "SUCCESS";
        const { subscription_details: _s, ...data } = d.payData(p);
        await w.deliver(d.event("SUBSCRIPTION_PAYMENT_SUCCESS", data, "2025-01-01"));
        const after = await w.reload(b);
        return {
          pass: after.txnStatus === "succeeded" && (await w.cash()) === cash0 + b.amountMinor,
          detail: `txn ${after.txnStatus} cash ${(await w.cash()) - cash0}`,
        };
      },
    },
    {
      scenario: "S13",
      id: "S13.v2023-failure-reason",
      title:
        "a SUBSCRIPTION_PAYMENT_FAILED on version 2023-08-01 keeps Cashfree's reason (`failureDetails.failureReason`)",
      async run({ world }) {
        const w = await world("s13v23");
        const d = w.driver as CashfreeDriver;
        const b = await w.bill("pays");
        const p = d.pay(b.chargeId);
        p.payment_status = "FAILED";
        const ev = d.event(
          "SUBSCRIPTION_PAYMENT_FAILED",
          {
            payment_id: p.payment_id,
            cf_payment_id: p.cf_payment_id,
            subscription_id: p.subscription_id,
            payment_type: "DEBIT_CARD",
            payment_amount: p.payment_amount,
            retry_attempts: 0,
            failureDetails: { failureReason: "Insufficient balance" },
            payment_status: "FAILED",
          },
          "2023-08-01",
        );
        await w.deliver(ev);
        const after = await w.reload(b);
        const [txn] = await txnsOf(w, b.invoiceId);
        const msg = txn?.errorText ?? "";
        return {
          pass: after.txnStatus === "failed" && /insufficient balance/i.test(msg),
          detail: `txn ${after.txnStatus} message "${msg}"`,
        };
      },
    },
    {
      scenario: "S13",
      id: "S13.unknown-version-not-booked",
      title:
        "a delivery on a webhook version Cashfree does not document is not guess-parsed into money",
      async run({ world }) {
        const w = await world("s13vx");
        const d = w.driver as CashfreeDriver;
        const b = await w.bill("pays");
        const cash0 = await w.cash();
        const p = d.pay(b.chargeId);
        p.payment_status = "SUCCESS";
        await w.deliver(d.event("SUBSCRIPTION_PAYMENT_SUCCESS", d.payData(p), "2099-01-01"));
        const after = await w.reload(b);
        return {
          pass: after.txnStatus !== "succeeded" && (await w.cash()) === cash0,
          detail: `txn ${after.txnStatus} cash ${(await w.cash()) - cash0}`,
        };
      },
    },
    {
      scenario: "S13",
      id: "S13.catalog-subscription-version",
      title: "setup steps ask for subscription webhooks on version 2026-01-01",
      async run() {
        const lines =
          GATEWAYS.cashfree.webhook?.instructions(
            "https://hooks.example.com/x",
            "paste_required",
          ) ?? [];
        const tab = lines.find((l) => /Subscriptions tab/.test(l)) ?? "";
        return { pass: tab.includes("2026-01-01"), detail: tab || "no Subscriptions tab step" };
      },
    },
    {
      scenario: "S14",
      id: "S14.card-upi-ceiling",
      title: "a card or UPI mandate asks for at most ₹15,000, and the phone is sent as 10 digits",
      async run({ world }) {
        const w = await world("s14cap");
        const d = w.driver as CashfreeDriver;
        const adapter = await adapterOf(w);
        await adapter
          .initiateVaultSetup({
            customer: { providerKey: "cashfree", providerCustomerId: "cus_XXXXXXXXXXXX01" },
            returnUrl: "https://app.example.com/return",
            currency: "INR",
            maxAmountMinor: 5_000_000n,
            methodTypes: ["card", "upi"],
            contact: {
              email: "payer@example.com",
              phone: "+91 90000 00000",
              name: "Conformance Payer",
            },
          } as Parameters<CashfreeProvider["initiateVaultSetup"]>[0])
          .catch((e: Error) => e);
        const body = d.fake.callsOf("vault_setup").at(-1)?.body as
          | {
              plan_details?: { plan_max_amount?: number };
              customer_details?: { customer_phone?: string };
            }
          | undefined;
        const max = body?.plan_details?.plan_max_amount;
        const phone = body?.customer_details?.customer_phone;
        return {
          pass: max === 15000 && phone === "9000000000",
          detail: `plan_max_amount ${String(max)} phone ${String(phone)}`,
        };
      },
    },
    {
      scenario: "S14",
      id: "S14.non-inr-mandate-card-only",
      title:
        "a USD mandate is a card mandate in USD with a + phone (sandbox 2026-11-01); UPI in USD is refused before any call",
      async run({ world }) {
        const w = await world("s14usd");
        const d = w.driver as CashfreeDriver;
        const adapter = await adapterOf(w);
        const setup = (methodTypes: string[]) =>
          adapter
            .initiateVaultSetup({
              customer: { providerKey: "cashfree", providerCustomerId: "cus_XXXXXXXXXXXX01" },
              returnUrl: "https://app.example.com/return",
              currency: "USD",
              maxAmountMinor: 260n,
              methodTypes,
              contact: {
                email: "payer@example.com",
                phone: "+1 415 555 0100",
                name: "Conformance Payer",
              },
            } as Parameters<CashfreeProvider["initiateVaultSetup"]>[0])
            .catch((e: Error) => e);
        const before = d.fake.callsOf("vault_setup").length;
        const upi = await setup(["upi"]);
        const afterUpi = d.fake.callsOf("vault_setup").length;
        await setup(["card"]);
        const body = d.fake.callsOf("vault_setup").at(-1)?.body as
          | {
              plan_details?: { plan_currency?: string; plan_max_amount?: number };
              customer_details?: { customer_phone?: string };
              authorization_details?: { payment_methods?: string[] };
            }
          | undefined;
        return {
          pass:
            upi instanceof Error &&
            afterUpi === before &&
            body?.plan_details?.plan_currency === "USD" &&
            body.plan_details.plan_max_amount === 2.6 &&
            body.customer_details?.customer_phone === "+14155550100" &&
            body.authorization_details?.payment_methods?.join() === "card",
          detail: `upi ${upi instanceof Error ? upi.message : "accepted"}; ${JSON.stringify(body?.plan_details)} ${body?.customer_details?.customer_phone}`,
        };
      },
    },
    {
      scenario: "S14",
      id: "S14.mandate-currency-and-minimum",
      title:
        "audit C1/L1: a debit in another currency than the mandate (none on record = INR), or under 1 USD, is refused before any call",
      async run({ world }) {
        const w = await world("s14cur");
        const d = w.driver as CashfreeDriver;
        const adapter = await adapterOf(w);
        const charge = (currency: string, amountMinor: bigint, mandateCurrency?: string) =>
          adapter.charge({
            amountMinor,
            currency,
            customer: { providerKey: "cashfree", providerCustomerId: "cus_XXXXXXXXXXXX01" },
            paymentMethod: {
              providerKey: "cashfree",
              providerPaymentMethodId: "tms_00000000000000c1",
              display: { type: "card" },
              ...(mandateCurrency ? { mandate: { currency: mandateCurrency } } : {}),
            },
            idempotencyKey: `s14cur_${currency}_${amountMinor}_${mandateCurrency ?? "none"}`,
          });
        const before = d.fake.callsOf("charge").length;
        const noRecord = await charge("USD", 5000n);
        const onInr = await charge("USD", 5000n, "INR");
        const small = await charge("USD", 50n, "USD");
        return {
          pass:
            [noRecord, onInr, small].every(
              (r) => r.status === "failed" && r.failure?.retriable === false,
            ) && d.fake.callsOf("charge").length === before,
          detail: [noRecord, onInr, small].map((r) => r.failure?.message).join(" | "),
        };
      },
    },
    {
      scenario: "S14",
      id: "S14.non-inr-mandate-phone-country",
      title:
        "audit L2: a USD mandate phone without + is never sent as an Indian number; with no country it is refused before any call",
      async run({ world }) {
        const w = await world("s14ph");
        const d = w.driver as CashfreeDriver;
        const adapter = await adapterOf(w);
        const before = d.fake.callsOf("vault_setup").length;
        const refused = await adapter
          .initiateVaultSetup({
            customer: { providerKey: "cashfree", providerCustomerId: "cus_XXXXXXXXXXXX01" },
            returnUrl: "https://app.example.com/return",
            currency: "USD",
            maxAmountMinor: 260n,
            methodTypes: ["card"],
            contact: { email: "payer@example.com", phone: "4155550100", name: "Conformance Payer" },
          } as Parameters<CashfreeProvider["initiateVaultSetup"]>[0])
          .catch((e: Error) => e);
        return {
          pass:
            refused instanceof ProviderRefusalError &&
            /country code/.test(refused.message) &&
            d.fake.callsOf("vault_setup").length === before,
          detail: refused instanceof Error ? refused.message : "accepted",
        };
      },
    },
    {
      scenario: "S14",
      id: "S14.order-expiry",
      title: "a pay-now order closes when our intent expires (`order_expiry_time`)",
      async run({ world }) {
        const w = await world("s14oe");
        const d = w.driver as CashfreeDriver;
        const adapter = await adapterOf(w);
        const expiresAt = new Date(Date.now() + 3_600_000);
        await adapter
          .createIntent({
            purpose: "payment",
            amountMinor: 10_000n,
            currency: "INR",
            customer: { providerKey: "cashfree", providerCustomerId: "cus_XXXXXXXXXXXX01" },
            idempotencyKey: `conf_${randomUUID()}`,
            contact: { email: "payer@example.com", phone: "9000000000", name: "Conformance Payer" },
            expiresAt,
          } as Parameters<CashfreeProvider["createIntent"]>[0])
          .catch((e: Error) => e);
        const sent = d.fake.callsOf("intent").at(-1)?.body.order_expiry_time;
        return {
          pass: sent === expiresAt.toISOString(),
          detail: `order_expiry_time ${String(sent)} (want ${expiresAt.toISOString()})`,
        };
      },
    },
    {
      scenario: "S14",
      id: "S14.refund-note-min-3",
      title:
        "a refund note under 3 characters is replaced (Cashfree refuses it), and every call carries x-request-id",
      async run({ world }) {
        const w = await world("s14rn");
        const d = w.driver as CashfreeDriver;
        const b = await w.collected();
        const adapter = await adapterOf(w);
        await adapter
          .refund({
            providerChargeId: b.chargeId,
            amountMinor: 100n,
            currency: "INR",
            idempotencyKey: `re_${randomUUID()}`,
            reason: "ab",
          })
          .catch((e: Error) => e);
        const call = d.fake.callsOf("refund").at(-1);
        const note = call?.body.refund_note;
        const rid = call?.headers["x-request-id"];
        return {
          pass: note === "Refund" && !!rid,
          detail: `refund_note ${String(note)} x-request-id ${rid ?? "absent"}`,
        };
      },
    },
    {
      scenario: "S14",
      id: "S14.order-currency-decimals",
      title:
        "pay now sends the order in its own currency and decimals (USD 1.00, JPY 1000, EUR 19.99)",
      async run({ world }) {
        const w = await world("s14fx");
        const d = w.driver as CashfreeDriver;
        const adapter = await adapterOf(w);
        for (const [currency, amountMinor] of [
          ["USD", 100n],
          ["JPY", 1000n],
          ["EUR", 1999n],
        ] as const)
          await adapter.createIntent(payNowInput(currency, amountMinor)).catch((e: Error) => e);
        const sent = d.fake
          .callsOf("intent")
          .slice(-3)
          .map((c) => `${String(c.body.order_amount)} ${String(c.body.order_currency)}`);
        return {
          pass: sent.join() === "1 USD,1000 JPY,19.99 EUR",
          detail: sent.join(", "),
        };
      },
    },
    {
      scenario: "S14",
      id: "S14.order-minimum-and-currencies",
      title:
        "under 1 whole unit, KWD and BHD (not enabled at Cashfree) are refused before any call",
      async run({ world }) {
        const w = await world("s14fxmin");
        const d = w.driver as CashfreeDriver;
        const adapter = await adapterOf(w);
        const before = d.fake.callsOf("intent").length;
        const got = await Promise.all(
          (
            [
              ["USD", 99n],
              ["JPY", 0n],
              ["KWD", 10_000n],
              ["BHD", 10_000n],
            ] as const
          ).map(([c, a]) =>
            adapter.createIntent(payNowInput(c, a)).then(
              () => "accepted",
              (e: Error) => e.name,
            ),
          ),
        );
        const calls = d.fake.callsOf("intent").length - before;
        return {
          pass: got.every((g) => g !== "accepted") && calls === 0,
          detail: `${got.join(",")} calls ${calls}`,
        };
      },
    },
    {
      scenario: "S13",
      id: "S13.indian-card-on-usd-order-books-the-order",
      title:
        "an Indian card on a 1 USD order (payment 95.16 INR) captures 100 USD cents, never 9516",
      async run({ world }) {
        const w = await world("s13fx");
        const d = w.driver as CashfreeDriver;
        const adapter = await adapterOf(w);
        const body = d.event(
          "PAYMENT_SUCCESS_WEBHOOK",
          {
            order: {
              order_id: d.fake.id("order_", 10),
              order_amount: 1,
              order_currency: "USD",
              order_tags: null,
            },
            payment: {
              cf_payment_id: Number(d.fake.digits()),
              payment_status: "SUCCESS",
              payment_amount: 95.16,
              payment_currency: "INR",
              international_payment: { international: false },
            },
          },
          "2025-01-01",
        ).body;
        const [ev] = await adapter.normalizeWebhook({
          payload: body,
          headers: d.sign(w, body, w.secret),
        });
        return {
          pass: ev?.type === "intent.authorized" && ev.capturedAmountMinor === 100n,
          detail: `${ev?.type} captured ${String(ev?.capturedAmountMinor)}`,
        };
      },
    },
    {
      scenario: "S2",
      id: "S2.order-refund-in-order-currency",
      title:
        "a pay-now refund is taken in the order's currency: 0.50 USD partial, then the 0.50 left by default",
      async run({ world }) {
        const w = await world("s2fx");
        const d = w.driver as CashfreeDriver;
        const adapter = await adapterOf(w);
        const oid = d.fake.id("order_", 10);
        const cfp = d.fake.digits();
        d.fake.orders.set(oid, { amountMinor: 100, currency: "USD", cfPaymentId: cfp });
        const charge = `ord:${encodeURIComponent(oid)}:${cfp}`;
        const part = await adapter
          .refund({
            providerChargeId: charge,
            amountMinor: 50n,
            currency: "USD",
            idempotencyKey: `re_${randomUUID()}`,
          })
          .catch((e: Error) => e);
        const rest = await adapter
          .refund({ providerChargeId: charge, idempotencyKey: `re_${randomUUID()}` })
          .catch((e: Error) => e);
        const sent = d.fake.callsOf("order_refund").map((c) => c.body.refund_amount);
        const wrong = await adapter
          .refund({
            providerChargeId: charge,
            amountMinor: 10n,
            currency: "INR",
            idempotencyKey: `re_${randomUUID()}`,
          })
          .then(
            () => "accepted",
            (e: Error) => e.name,
          );
        return {
          pass:
            !(part instanceof Error) &&
            !(rest instanceof Error) &&
            sent.join() === "0.5,0.5" &&
            wrong === "ProviderRefusalError" &&
            d.fake.callsOf("order_refund").length === 2,
          detail: `sent ${sent.join(",")} wrong-currency ${wrong} ${part instanceof Error ? part.message : ""} ${rest instanceof Error ? rest.message : ""}`,
        };
      },
    },
    {
      scenario: "S2",
      id: "S2.jpy-refund-whole-yen",
      title:
        "a JPY refund goes in whole yen (Cashfree accepts 10.5 JPY, so we never send decimals)",
      async run({ world }) {
        const w = await world("s2jpy");
        const d = w.driver as CashfreeDriver;
        const adapter = await adapterOf(w);
        const oid = d.fake.id("order_", 10);
        const cfp = d.fake.digits();
        d.fake.orders.set(oid, { amountMinor: 1000, currency: "JPY", cfPaymentId: cfp });
        await adapter
          .refund({
            providerChargeId: `ord:${encodeURIComponent(oid)}:${cfp}`,
            amountMinor: 400n,
            currency: "JPY",
            idempotencyKey: `re_${randomUUID()}`,
          })
          .catch((e: Error) => e);
        const amount = d.fake.callsOf("order_refund").at(-1)?.body.refund_amount;
        return { pass: amount === 400, detail: `refund_amount ${String(amount)}` };
      },
    },
    {
      scenario: "S5",
      id: "S5.dispute-non-inr-order-currency",
      title:
        "a dispute in the payment's INR on a USD order is booked in USD (95.16 INR on 1 USD → 100 cents); another currency is unresolved",
      async run({ world }) {
        const w = await world("s15fx");
        const d = w.driver as CashfreeDriver;
        const { oid, cfp } = paidOrder(d, 100, "USD");
        const order = {
          order_amount: 1,
          order_currency: "USD",
          payment_amount: 95.16,
          payment_currency: "INR",
        };
        const [inr] = await adapterRead(
          w,
          "DISPUTE_CREATED",
          disputeData(oid, cfp, { dispute_amount: 95.16, dispute_amount_currency: "INR" }, order),
        );
        const [eur] = await adapterRead(
          w,
          "DISPUTE_CREATED",
          disputeData(oid, cfp, { dispute_amount: 1, dispute_amount_currency: "EUR" }, order),
        );
        return {
          pass:
            inr?.disputeAmountMinor === 100n &&
            inr.disputeCurrency === "USD" &&
            !inr.unresolved &&
            !!eur?.unresolved &&
            eur.disputeAmountMinor === undefined,
          detail: `INR→ ${String(inr?.disputeAmountMinor)} ${inr?.disputeCurrency}; EUR→ ${eur?.unresolved ?? `${String(eur?.disputeAmountMinor)} ${eur?.disputeCurrency}`}`,
        };
      },
    },
    {
      scenario: "S5",
      id: "S5.dispute-currency-blank",
      title:
        'a dispute with a blank currency takes the order\'s (1000 JPY stays 1000, never "" or the INR exponent)',
      async run({ world }) {
        const w = await world("s15blank");
        const d = w.driver as CashfreeDriver;
        const { oid, cfp } = paidOrder(d, 1000, "JPY");
        const order = {
          order_amount: 1000,
          order_currency: "JPY",
          payment_amount: 1000,
          payment_currency: "JPY",
        };
        const [blank] = await adapterRead(
          w,
          "DISPUTE_CREATED",
          disputeData(oid, cfp, { dispute_amount: 1000, dispute_amount_currency: "" }, order),
        );
        const [missing] = await adapterRead(
          w,
          "DISPUTE_CREATED",
          disputeData(oid, cfp, { dispute_amount: 1000 }, order),
        );
        return {
          pass:
            blank?.disputeAmountMinor === 1000n &&
            blank.disputeCurrency === "JPY" &&
            missing?.disputeAmountMinor === 1000n &&
            missing.disputeCurrency === "JPY",
          detail: `blank ${String(blank?.disputeAmountMinor)} "${blank?.disputeCurrency}", missing ${String(missing?.disputeAmountMinor)} "${missing?.disputeCurrency}"`,
        };
      },
    },
    {
      scenario: "S2",
      id: "S2.oob-refund-unknown-total-never-full",
      title:
        "an order refund whose total cannot be known (10.5 JPY, order unreadable, list unreadable) is unresolved, never a full refund",
      async run({ world }) {
        const w = await world("s2unk");
        const d = w.driver as CashfreeDriver;
        const refundOf = (oid: string, cfp: string, extra: Obj) => ({
          refund: {
            order_id: oid,
            cf_payment_id: Number(cfp),
            refund_id: d.fake.id("refund_", 10),
            cf_refund_id: Number(d.fake.digits()),
            refund_status: "SUCCESS",
            refund_type: "MERCHANT_INITIATED",
            ...extra,
          },
        });
        const jpy = paidOrder(d, 1000, "JPY");
        const [decimals] = await adapterRead(
          w,
          "REFUND_STATUS_WEBHOOK",
          refundOf(jpy.oid, jpy.cfp, { refund_amount: 10.5, refund_currency: "JPY" }),
        );
        const usd = paidOrder(d, 100, "USD");
        d.fake.inject("order_read", { kind: "http", status: 500, body: { message: "down" } });
        const [noOrder] = await adapterRead(
          w,
          "REFUND_STATUS_WEBHOOK",
          refundOf(usd.oid, usd.cfp, { refund_amount: 0.5 }),
        );
        d.fake.inject("order_refunds_list", {
          kind: "http",
          status: 500,
          body: { message: "down" },
        });
        const [noList] = await adapterRead(
          w,
          "REFUND_STATUS_WEBHOOK",
          refundOf(usd.oid, usd.cfp, { refund_amount: 0.5, refund_currency: "USD" }),
        );
        d.fake.clearFaults();
        const safe = (e: NormalizedProviderEvent | undefined) =>
          !!e && (e.type !== "charge.refunded" || e.amountRefundedMinor != null || !!e.unresolved);
        const all = [decimals, noOrder, noList];
        return {
          pass: all.every((e) => safe(e) && !!e?.unresolved),
          detail: all
            .map(
              (e) =>
                `${e?.type} total=${String(e?.amountRefundedMinor)} unresolved=${!!e?.unresolved}`,
            )
            .join(" | "),
        };
      },
    },
    {
      scenario: "S2",
      id: "S2.refund-currency-mismatch-unresolved",
      title:
        "a refund reported in INR on a USD order (47.58 INR) is unresolved, never read as USD cents",
      async run({ world }) {
        const w = await world("s2mis");
        const d = w.driver as CashfreeDriver;
        const { oid, cfp } = paidOrder(d, 100, "USD");
        const [inEvent] = await adapterRead(w, "REFUND_STATUS_WEBHOOK", {
          refund: {
            order_id: oid,
            cf_payment_id: Number(cfp),
            refund_id: d.fake.id("refund_", 10),
            refund_amount: 47.58,
            refund_currency: "INR",
            refund_status: "SUCCESS",
          },
        });
        d.fake.orderRefunds.push({
          order_id: oid,
          cf_payment_id: cfp,
          refund_id: d.fake.id("refund_", 10),
          refund_amount: 47.58,
          refund_currency: "INR",
          refund_status: "SUCCESS",
        });
        const [inList] = await adapterRead(w, "REFUND_STATUS_WEBHOOK", {
          refund: {
            order_id: oid,
            cf_payment_id: Number(cfp),
            refund_id: d.fake.id("refund_", 10),
            refund_amount: 0.1,
            refund_currency: "USD",
            refund_status: "SUCCESS",
          },
        });
        return {
          pass:
            !!inEvent?.unresolved &&
            inEvent.amountRefundedMinor === undefined &&
            !!inList?.unresolved &&
            inList.amountRefundedMinor === undefined,
          detail: `event: ${inEvent?.unresolved ?? String(inEvent?.amountRefundedMinor)} | list: ${inList?.unresolved ?? String(inList?.amountRefundedMinor)}`,
        };
      },
    },
    {
      scenario: "S2",
      id: "S2.auto-refund-non-inr-order",
      title: "an auto refund on a 1000 JPY order is booked as 1000 JPY",
      async run({ world }) {
        const w = await world("s2auto");
        const d = w.driver as CashfreeDriver;
        const { oid, cfp } = paidOrder(d, 1000, "JPY");
        const [ev] = await adapterRead(w, "AUTO_REFUND_STATUS_WEBHOOK", {
          auto_refund: {
            order_id: oid,
            cf_payment_id: cfp,
            cf_refund_id: Number(d.fake.digits()),
            refund_amount: 1000,
            refund_currency: "JPY",
            refund_status: "SUCCESS",
            refund_type: "PAYMENT_AUTO_REFUND",
          },
        });
        return {
          pass:
            ev?.type === "charge.refunded" && ev.amountRefundedMinor === 1000n && !ev.unresolved,
          detail: `${ev?.type} total ${String(ev?.amountRefundedMinor)} ${ev?.unresolved ?? ""}`,
        };
      },
    },
    {
      scenario: "S13",
      id: "S13.dcc-inr-order-books-order",
      title: "a foreign card paying an INR order in USD (DCC) is booked as the INR order amount",
      async run({ world }) {
        const w = await world("s13dcc");
        const d = w.driver as CashfreeDriver;
        const [ev] = await adapterRead(w, "PAYMENT_SUCCESS_WEBHOOK", {
          order: {
            order_id: d.fake.id("order_", 10),
            order_amount: 100,
            order_currency: "INR",
            order_tags: null,
          },
          payment: {
            cf_payment_id: Number(d.fake.digits()),
            payment_status: "SUCCESS",
            payment_amount: 1.2,
            payment_currency: "USD",
          },
        });
        return {
          pass: ev?.type === "intent.authorized" && ev.capturedAmountMinor === 10_000n,
          detail: `${ev?.type} captured ${String(ev?.capturedAmountMinor)}`,
        };
      },
    },
    {
      scenario: "S14",
      id: "S14.phone-plus-prefix-kept",
      title:
        "a + number outside India keeps its country code on any order (+65 9123 4567 is not an Indian number)",
      async run({ world }) {
        const w = await world("s14ph");
        const d = w.driver as CashfreeDriver;
        const adapter = await adapterOf(w);
        const cases = [
          ["USD", "+65 9123 4567"],
          ["INR", "+1 415 555 0100"],
          ["INR", "+91 90000 00000"],
        ] as const;
        for (const [currency, phone] of cases)
          await adapter
            .createIntent({
              ...payNowInput(currency, 10_000n),
              contact: { email: "payer@example.com", phone, name: "Conformance Payer" },
            })
            .catch((e: Error) => e);
        const sent = d.fake
          .callsOf("intent")
          .slice(-3)
          .map((c) => String((c.body.customer_details as Obj | undefined)?.customer_phone));
        return {
          pass: sent.join() === "+6591234567,+14155550100,9000000000",
          detail: sent.join(", "),
        };
      },
    },
    {
      scenario: "S13",
      id: "S13.big-cf-payment-id-exact",
      title:
        "a cf_payment_id sent as a JSON number above 2^53 keeps every digit, so the webhook names the stored charge",
      async run({ world }) {
        const w = await world("s13big");
        const d = w.driver as CashfreeDriver;
        const adapter = await adapterOf(w);
        const oid = d.fake.id("order_", 10);
        // Real shape: the number is written into the body as-is, never through a double.
        const body =
          `{"data":{"order":{"order_id":"${oid}","order_amount":1,"order_currency":"USD","order_tags":null},` +
          `"payment":{"cf_payment_id":1469749760381710336,"payment_status":"SUCCESS","payment_amount":1,"payment_currency":"USD","payment_group":"credit_card"}},` +
          `"event_time":"${new Date().toISOString()}","type":"PAYMENT_SUCCESS_WEBHOOK"}`;
        d.versions.set(body, "2025-01-01");
        const [ev] = await adapter.normalizeWebhook({
          payload: body,
          headers: d.sign(w, body, w.secret),
        });
        const want = `ord:${encodeURIComponent(oid)}:1469749760381710336`;
        return {
          pass: ev?.providerChargeId === want,
          detail: `providerChargeId ${String(ev?.providerChargeId)} (want ${want})`,
        };
      },
    },
    {
      scenario: "S10",
      id: "S10.mandate-cancel-cancels-queued-debits",
      title:
        "removing a Cashfree mandate also cancels its raised payments (the subscription cancel alone leaves them scheduled)",
      async run({ world }) {
        const w = await world("s10mc");
        const d = w.driver as CashfreeDriver;
        const b = await w.bill("pays");
        const p = d.pay(b.chargeId);
        const [pm] = await systemDb
          .select({
            publicId: paymentMethods.publicId,
            token: paymentMethods.providerPaymentMethodId,
          })
          .from(paymentMethods)
          .where(eq(paymentMethods.id, b.paymentMethodId));
        const queued = p.payment_status;
        await detachPaymentMethod(w.org.id, b.customerId, pm!.publicId);
        const sub = d.fake.subs.get(pm!.token)!;
        return {
          pass:
            (queued === "PENDING" || queued === "INITIALIZED") &&
            p.payment_status === "CANCELLED" &&
            sub.subscription_status === "CANCELLED",
          detail: `payment ${queued} → ${p.payment_status}, subscription ${sub.subscription_status}`,
        };
      },
    },
    {
      scenario: "S10",
      id: "S10.mandate-cancel-uncancellable-debit-is-recorded",
      title:
        "an eNACH payment Cashfree will not cancel leaves the mandate recorded as still chargeable, never dropped",
      async run({ world }) {
        const w = await world("s10mx");
        const d = w.driver as CashfreeDriver;
        const b = await w.bill("bank_debit");
        const [pm] = await systemDb
          .select({ publicId: paymentMethods.publicId })
          .from(paymentMethods)
          .where(eq(paymentMethods.id, b.paymentMethodId));
        d.fake.inject("cancel_charge", { kind: "http", status: 500, body: { message: "down" } }, 4);
        await detachPaymentMethod(w.org.id, b.customerId, pm!.publicId);
        d.fake.clearFaults();
        const orphaned = await systemDb
          .select({ id: auditLogs.id })
          .from(auditLogs)
          .where(
            and(
              eq(auditLogs.action, "customer.payment_method_orphaned_at_gateway"),
              eq(auditLogs.resourceId, b.customerId),
            ),
          );
        return {
          pass: orphaned.length === 1 && d.pay(b.chargeId).payment_status !== "CANCELLED",
          detail: `orphan records ${orphaned.length}, payment ${d.pay(b.chargeId).payment_status}`,
        };
      },
    },
    {
      scenario: "S10",
      id: "S10.mandate-cancel-card-pending-not-chargeable",
      title:
        "a card PENDING payment left on a CANCELLED mandate is not recorded as chargeable (Cashfree support 2026-11-02: never debited, moves to FAILED)",
      async run({ world }) {
        const w = await world("s10cp");
        const d = w.driver as CashfreeDriver;
        const b = await w.bill("pays");
        const [pm] = await systemDb
          .select({ publicId: paymentMethods.publicId })
          .from(paymentMethods)
          .where(eq(paymentMethods.id, b.paymentMethodId));
        d.fake.inject("cancel_charge", { kind: "http", status: 500, body: { message: "down" } }, 4);
        await detachPaymentMethod(w.org.id, b.customerId, pm!.publicId);
        d.fake.clearFaults();
        const orphaned = await systemDb
          .select({ id: auditLogs.id })
          .from(auditLogs)
          .where(
            and(
              eq(auditLogs.action, "customer.payment_method_orphaned_at_gateway"),
              eq(auditLogs.resourceId, b.customerId),
            ),
          );
        return {
          pass: orphaned.length === 0 && d.pay(b.chargeId).payment_status === "PENDING",
          detail: `orphan records ${orphaned.length}, payment ${d.pay(b.chargeId).payment_status}`,
        };
      },
    },
    {
      scenario: "S14",
      id: "S14.engine-mandate-currency",
      title:
        "through the engine, a USD invoice on an INR mandate is refused as mandate_currency_mismatch with no gateway call",
      async run({ world }) {
        const w = await world("s14eng", "USD");
        const d = w.driver as CashfreeDriver;
        const before = d.fake.callsOf("charge").length;
        const b = await w.bill("pays", {
          onVaulted: async (id) => {
            await systemDb
              .update(paymentMethods)
              .set({ mandateCurrency: "INR" })
              .where(eq(paymentMethods.id, id));
          },
        });
        const sent = d.fake.callsOf("charge").length - before;
        return {
          pass: sent === 0 && b.failureCode === "mandate_currency_mismatch",
          detail: `${sent} charge call(s), ${b.txnStatus ?? b.paymentStatus} ${b.failureCode ?? ""}`,
        };
      },
    },
    {
      scenario: "S14",
      id: "S14.inr-order-indian-phone",
      title:
        "an INR pay-now order sends a phone without + as an Indian number, whatever the customer's country",
      async run({ world }) {
        const w = await world("s14inph");
        const d = w.driver as CashfreeDriver;
        const adapter = await adapterOf(w);
        await adapter
          .createIntent({
            purpose: "payment",
            amountMinor: 10_000n,
            currency: "INR",
            customer: { providerKey: "cashfree", providerCustomerId: "cus_XXXXXXXXXXXX01" },
            idempotencyKey: `conf_${randomUUID()}`,
            contact: {
              email: "payer@example.com",
              phone: "9000000000",
              name: "Conformance Payer",
              country: "US",
            },
          } as Parameters<CashfreeProvider["createIntent"]>[0])
          .catch((e: Error) => e);
        const details = d.fake.callsOf("intent").at(-1)?.body.customer_details as
          | { customer_phone?: string }
          | undefined;
        const sent = details?.customer_phone;
        return { pass: sent === "9000000000", detail: `customer_phone ${String(sent)}` };
      },
    },
  ],
};
