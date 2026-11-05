/**
 * PayPal conformance fixtures. Shapes follow PayPal's OpenAPI specs (read 2026-10-27) and the
 * offline suite (`verify:paypal`). Every id is a same-shape fake.
 */
import { createSign, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { desc, eq, like } from "drizzle-orm";
import { systemDb, withTenant } from "@/platform/db";
import { resolveAdapter } from "@/providers/registry";
import type { PayPalProvider } from "@/providers/paypal";
import { businesses, customers, gatewayAccounts, paymentMethods, payments } from "@db/schema";
import { FakeGateway, installFake, json, type FakeRequest } from "../fake-http";
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

const HOST = "https://paypal.conformance.invalid";
/** The adapter only trusts a cert on a paypal.com host; this fake owns that one path. */
const CERT_BASE = "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-CONF-";
const READ = "2026-10-27";
const SPECS =
  "https://raw.githubusercontent.com/paypal/paypal-rest-api-specifications/main/openapi";
const DOC = {
  events: "https://developer.paypal.com/api/rest/webhooks/event-names/",
  orders: `${SPECS}/checkout_orders_v2.json`,
  payments: `${SPECS}/payments_payment_v2.json`,
  disputes: `${SPECS}/customer_disputes_v1.json`,
  vault: `${SPECS}/vault_payment_tokens_v3.json`,
  currencies: "https://developer.paypal.com/reference/currency-codes/",
  rateLimit: "https://developer.paypal.com/api/rest/reference/rate-limiting/",
};

type Money = { value: string; currency_code: string };
type Obj = Record<string, unknown> & { id: string };

const CRC = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();
function crc32(s: string): number {
  let c = -1;
  for (const b of Buffer.from(s, "utf8")) c = (c >>> 8) ^ CRC[(c ^ b) & 0xff]!;
  return (c ^ -1) >>> 0;
}

/** A throwaway RSA key and self-signed leaf, as the unit test makes one. */
function selfSigned(): { key: string; cert: string } {
  const dir = mkdtempSync(join(tmpdir(), "paypal-conf-"));
  try {
    const [key, cert] = [join(dir, "k.pem"), join(dir, "c.pem")];
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-keyout",
        key,
        "-out",
        cert,
        "-days",
        "2",
        "-nodes",
        "-subj",
        "/CN=api.sandbox.paypal.com",
      ],
      { stdio: "pipe" },
    );
    return { key: readFileSync(key, "utf8"), cert: readFileSync(cert, "utf8") };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const money = (minor: number, currency: string): Money => ({
  value: (minor / 100).toFixed(2),
  currency_code: currency,
});
const minorOf = (m: Money) => Math.round(Number(m.value) * 100);
const err = (status: number, name: string, issue?: string, extra: Record<string, unknown> = {}) =>
  json(status, {
    name,
    message: `${name.toLowerCase().replace(/_/g, " ")}`,
    debug_id: "f0c0nf0000001",
    ...(issue
      ? { details: [{ issue, description: `${issue.toLowerCase().replace(/_/g, " ")}` }] }
      : {}),
    ...extra,
  });

class FakePayPalCerts extends FakeGateway {
  readonly host = CERT_BASE;
  constructor(private readonly pem: string) {
    super();
  }
  async route(req: FakeRequest): Promise<Response | null> {
    return req.method === "GET" ? new Response(this.pem, { status: 200 }) : null;
  }
}

class FakePayPal extends FakeGateway {
  readonly host = HOST;
  /** Setup token → the customer id it was minted for (bound on first read). */
  readonly setupTokens = new Map<string, string | null>();
  readonly vault = new Map<string, Obj>();
  readonly orders = new Map<string, Obj>();
  readonly captures = new Map<string, Obj & { vault: string; refunded: number }>();
  readonly refunds = new Map<string, Obj>();
  readonly agreements = new Map<string, Obj>();
  /** `<op>:<PayPal-Request-Id>` → the first answer, read again with its object's latest state. */
  private readonly keys = new Map<string, () => Response>();
  /** The next vault exchange mints a v1 billing agreement id instead of a v3 token. */
  nextVaultIsAgreement = false;
  /** The next `charge` answers with a non-JSON body (after creating the order when `afterCreate`). */
  rawNext: { status: number; afterCreate: boolean } | null = null;

  newCapture(order: Obj, amount: Money, vault: string, customId: unknown, status = "COMPLETED") {
    const c = {
      id: this.id("CAPCONF", 10),
      status,
      amount,
      custom_id: customId,
      final_capture: true,
      create_time: new Date().toISOString(),
      supplementary_data: { related_ids: { order_id: order.id } },
      links: [
        { rel: "self", href: `${HOST}/v2/payments/captures/` },
        { rel: "up", href: `${HOST}/v2/checkout/orders/${order.id}` },
      ],
      vault,
      refunded: 0,
    };
    c.links[0]!.href += c.id;
    this.captures.set(c.id, c);
    return c;
  }

  newRefund(capId: string, minor: number, status = "COMPLETED", customId?: string): Obj {
    const c = this.captures.get(capId)!;
    const cur = (c.amount as Money).currency_code;
    c.refunded += minor;
    c.status = c.refunded >= minorOf(c.amount as Money) ? "REFUNDED" : "PARTIALLY_REFUNDED";
    const r: Obj = {
      id: this.id("REFCONF", 10),
      status,
      amount: money(minor, cur),
      // PayPal: "the total amount refunded from the original capture to date".
      seller_payable_breakdown: { total_refunded_amount: money(c.refunded, cur) },
      ...(customId ? { custom_id: customId } : {}),
      create_time: new Date().toISOString(),
      links: [{ rel: "up", href: `${HOST}/v2/payments/captures/${capId}` }],
    };
    this.refunds.set(r.id, r);
    return r;
  }

  /** PayPal-Request-Id rule: a repeat returns the latest state of the first request's object. */
  private replay(op: string, req: FakeRequest): Response | null {
    const id = req.headers["paypal-request-id"];
    return (id && this.keys.get(`${op}:${id}`)?.()) || null;
  }
  private remember(op: string, req: FakeRequest, answer: () => Response) {
    const id = req.headers["paypal-request-id"];
    if (id) this.keys.set(`${op}:${id}`, answer);
    return answer();
  }

  /** The customer a setup token belongs to: the newest one billed in a PayPal world. */
  private async bindSetupToken(id: string): Promise<string | null> {
    const bound = this.setupTokens.get(id);
    if (bound) return bound;
    const [row] = await systemDb
      .select({ publicId: customers.publicId })
      .from(customers)
      .innerJoin(businesses, eq(businesses.id, customers.businessId))
      .where(like(businesses.name, "GC paypal %"))
      .orderBy(desc(customers.createdAt))
      .limit(1);
    this.setupTokens.set(id, row?.publicId ?? null);
    return row?.publicId ?? null;
  }

  async route(req: FakeRequest): Promise<Response | null> {
    const { method, path, body } = req;
    if (method === "POST" && path === "/v1/oauth2/token")
      return json(200, {
        access_token: "A21CONF.access.token",
        token_type: "Bearer",
        expires_in: 32_400,
      });

    const setup = path.match(/^\/v3\/vault\/setup-tokens\/([^/]+)$/);
    if (method === "GET" && setup) {
      if (!this.setupTokens.has(setup[1]!))
        return err(404, "RESOURCE_NOT_FOUND", "INVALID_RESOURCE_ID");
      const cus = await this.bindSetupToken(setup[1]!);
      return json(200, {
        id: setup[1],
        status: "APPROVED",
        customer: { id: "CUSCONF001", merchant_customer_id: cus },
      });
    }
    if (method === "POST" && path === "/v3/vault/payment-tokens")
      return this.guarded("vault", req, () => {
        const tok = String(((body.payment_source as Obj)?.token as Obj)?.id ?? "");
        if (!this.setupTokens.has(tok))
          return err(404, "RESOURCE_NOT_FOUND", "INVALID_RESOURCE_ID");
        const agreement = this.nextVaultIsAgreement;
        this.nextVaultIsAgreement = false;
        const v: Obj = {
          id: agreement ? this.id("B-CONF", 10) : this.id("VTCONF", 6),
          customer: { id: "CUSCONF001" },
          payment_source: {
            paypal: { email_address: "payer@example.com", payer_id: "PAYERCONF0001" },
          },
        };
        this.vault.set(v.id, v);
        if (agreement) this.agreements.set(v.id, { id: v.id, state: "Active" });
        return json(200, v);
      });
    const tokenDel = path.match(/^\/v3\/vault\/payment-tokens\/([^/]+)$/);
    if (method === "DELETE" && tokenDel) {
      this.vault.delete(tokenDel[1]!);
      return new Response(null, { status: 204 });
    }

    if (method === "POST" && path === "/v2/checkout/orders")
      return this.guarded("charge", req, () => {
        const again = this.replay("charge", req);
        if (again) return again;
        const raw = this.rawNext;
        const html = (status: number) => () =>
          new Response("<html><body>error</body></html>", {
            status,
            headers: { "content-type": "text/html" },
          });
        if (raw && !raw.afterCreate) {
          this.rawNext = null;
          return this.remember("charge", req, html(raw.status));
        }
        const pu = (body.purchase_units as Obj[])[0]!;
        const src = body.payment_source as {
          paypal?: { vault_id: string };
          token?: { id: string };
        };
        const vault = src.paypal?.vault_id ?? src.token?.id ?? "";
        if (!this.vault.has(vault))
          return this.remember("charge", req, () =>
            err(
              422,
              "UNPROCESSABLE_ENTITY",
              src.token ? "BILLING_AGREEMENT_NOT_FOUND" : "INVALID_VAULT_ID",
            ),
          );
        const order: Obj = {
          id: this.id("ORDCONF", 10),
          intent: body.intent,
          status: "COMPLETED",
          purchase_units: [],
        };
        const cap = this.newCapture(order, pu.amount as Money, vault, pu.custom_id);
        order.purchase_units = [
          {
            reference_id: "default",
            custom_id: pu.custom_id,
            amount: pu.amount,
            payments: { captures: [cap] },
          },
        ];
        this.orders.set(order.id, order);
        const res = this.remember("charge", req, () => json(201, this.orders.get(order.id)));
        if (raw) {
          // The order exists; only this answer arrives unreadable.
          this.rawNext = null;
          return html(raw.status)();
        }
        return res;
      });
    const order = path.match(/^\/v2\/checkout\/orders\/([^/]+)$/);
    if (method === "GET" && order) {
      const o = this.orders.get(order[1]!);
      return o ? json(200, o) : err(404, "RESOURCE_NOT_FOUND", "INVALID_RESOURCE_ID");
    }
    const capture = path.match(/^\/v2\/payments\/captures\/([^/]+)$/);
    if (method === "GET" && capture) {
      const c = this.captures.get(capture[1]!);
      return c ? json(200, c) : err(404, "RESOURCE_NOT_FOUND", "INVALID_RESOURCE_ID");
    }
    const refund = path.match(/^\/v2\/payments\/captures\/([^/]+)\/refund$/);
    if (method === "POST" && refund)
      return this.guarded("refund", req, () => {
        const again = this.replay("refund", req);
        if (again) return again;
        const c = this.captures.get(decodeURIComponent(refund[1]!));
        if (!c) return err(404, "RESOURCE_NOT_FOUND", "INVALID_RESOURCE_ID");
        const left = minorOf(c.amount as Money) - c.refunded;
        const want = body.amount ? minorOf(body.amount as Money) : left;
        if (want > left) return err(422, "UNPROCESSABLE_ENTITY", "REFUND_AMOUNT_EXCEEDED");
        const r = this.newRefund(c.id, want, "COMPLETED", body.custom_id as string | undefined);
        return this.remember("refund", req, () => json(201, this.refunds.get(r.id)));
      });
    const refundGet = path.match(/^\/v2\/payments\/refunds\/([^/]+)$/);
    if (method === "GET" && refundGet) {
      const r = this.refunds.get(refundGet[1]!);
      return r ? json(200, r) : err(404, "RESOURCE_NOT_FOUND", "INVALID_RESOURCE_ID");
    }
    // Transaction Search (reporting_transactions_v1.json): a capture is listed with its
    // `custom_id` as `custom_field`. Assumed, not measured: our sandbox app lacks the
    // permission (403, 2026-10-27).
    if (method === "GET" && path === "/v1/reporting/transactions")
      return this.guarded("search", req, () => {
        const q = req.url.searchParams;
        const from = Date.parse(q.get("start_date") ?? "");
        const to = Date.parse(q.get("end_date") ?? "");
        if (Number.isNaN(from) || Number.isNaN(to) || to - from > 31 * 86_400_000)
          return err(400, "INVALID_REQUEST", "INVALID_DATE_RANGE");
        const cur = q.get("transaction_currency");
        const size = Number(q.get("page_size") ?? 100);
        const rows = [...this.captures.values()]
          .filter((c) => {
            const at = Date.parse(String(c.create_time));
            return at >= from && at <= to && (!cur || (c.amount as Money).currency_code === cur);
          })
          .map((c) => ({
            transaction_info: {
              transaction_id: c.id,
              transaction_event_code: "T0006",
              transaction_initiation_date: c.create_time,
              transaction_amount: c.amount,
              transaction_status:
                c.status === "DECLINED" ? "D" : c.status === "PENDING" ? "P" : "S",
              ...(typeof c.custom_id === "string" ? { custom_field: c.custom_id } : {}),
            },
          }));
        const page = Number(q.get("page") ?? 1);
        return json(200, {
          transaction_details: rows.slice((page - 1) * size, page * size),
          page,
          total_items: rows.length,
          total_pages: Math.max(1, Math.ceil(rows.length / size)),
          // The fake's report is current through the window asked for.
          last_refreshed_datetime: new Date(to).toISOString(),
        });
      });

    const authCapture = path.match(/^\/v2\/payments\/authorizations\/([^/]+)\/capture$/);
    if (method === "POST" && authCapture)
      return this.guarded("intent_capture", req, () => {
        const o = [...this.orders.values()].find((x) =>
          JSON.stringify(x.purchase_units).includes(authCapture[1]!),
        );
        if (!o) return err(404, "RESOURCE_NOT_FOUND", "INVALID_RESOURCE_ID");
        const pu = (o.purchase_units as Obj[])[0]!;
        const c = this.newCapture(
          o,
          (body.amount as Money) ?? (pu.amount as Money),
          "",
          pu.custom_id,
        );
        return json(201, c);
      });

    const agreement = path.match(/^\/v1\/billing-agreements\/agreements\/([^/]+?)(\/cancel)?$/);
    if (agreement) {
      const a = this.agreements.get(decodeURIComponent(agreement[1]!));
      if (!a) return err(404, "RESOURCE_NOT_FOUND", "INVALID_RESOURCE_ID");
      if (method === "POST" && agreement[2]) {
        a.state = "Cancelled";
        return new Response(null, { status: 204 });
      }
      return json(200, a);
    }
    if (path === "/v1/notifications/webhooks")
      return method === "GET"
        ? json(200, { webhooks: [] })
        : json(201, { id: this.id("WHCONF", 8) });
    return null;
  }
}

class PayPalDriver implements GatewayDriver {
  readonly fake = new FakePayPal();
  readonly forgedStatus = 400;
  readonly chargeOp = "charge";
  readonly refundOp = "refund";
  readonly errors = {
    // The documented 409 on a create: a request with this id is still in progress.
    conflict: {
      status: 409,
      body: {
        name: "RESOURCE_CONFLICT",
        details: [{ issue: "PREVIOUS_REQUEST_IN_PROGRESS" }],
        debug_id: "f0c0nf0000002",
      },
    },
    rateLimited: {
      status: 429,
      body: { name: "RATE_LIMIT_REACHED", message: "Too many requests." },
    },
    server: {
      status: 500,
      body: { name: "INTERNAL_SERVER_ERROR", message: "An internal server error has occurred." },
    },
    internal: {
      status: 503,
      body: { name: "SERVICE_UNAVAILABLE", message: "Service Unavailable." },
    },
    refundRefused: {
      status: 422,
      body: {
        name: "UNPROCESSABLE_ENTITY",
        details: [{ issue: "REFUND_AMOUNT_EXCEEDED" }],
        debug_id: "f0c0nf0000003",
      },
    },
  };
  private readonly signer = selfSigned();
  readonly certUrl = `${CERT_BASE}${randomUUID().slice(0, 8)}`;

  constructor() {
    installFake(new FakePayPalCerts(this.signer.cert));
  }

  credentials(webhookSecret: string) {
    return {
      client_id: "AConformanceClientId000000000001",
      client_secret: "EConformanceClientSecret0000001",
      api_base: HOST,
      // PayPal signs over its webhook id; here the world's secret plays that part.
      webhook_id: webhookSecret,
    };
  }
  token(kind: TokenKind) {
    if (kind !== "pays") return null;
    const id = this.fake.id("STCONF", 10);
    this.fake.setupTokens.set(id, null);
    return id;
  }
  sign(_w: World, body: string, secret: string, certUrl = this.certUrl) {
    const id = randomUUID();
    const time = new Date().toISOString();
    const s = createSign("sha256");
    s.update(`${id}|${time}|${secret}|${crc32(body)}`, "utf8");
    s.end();
    return {
      "paypal-auth-algo": "SHA256withRSA",
      "paypal-cert-url": certUrl,
      "paypal-transmission-id": id,
      "paypal-transmission-time": time,
      "paypal-transmission-sig": s.sign(this.signer.key, "base64"),
    };
  }

  event(type: string, resource: Obj, resourceType: string): Body {
    const id = `WH-${this.fake.id("CONF", 10)}-${this.fake.id("EV", 8)}`;
    return {
      body: JSON.stringify({
        id,
        event_version: "1.0",
        create_time: new Date().toISOString(),
        resource_type: resourceType,
        resource_version: "2.0",
        event_type: type,
        summary: type.toLowerCase(),
        resource,
      }),
      eventIds: [id],
    };
  }
  capture(id: string) {
    const c = this.fake.captures.get(id);
    if (!c) throw new Error(`fake PayPal has no capture ${id}`);
    return c;
  }
  /** The capture as PayPal publishes it (without the fake's own bookkeeping). */
  view(id: string, over: Record<string, unknown> = {}): Obj {
    const { vault: _v, refunded: _r, ...c } = this.capture(id);
    return { ...c, ...over };
  }
  captureEvent(type: string, id: string, status: string) {
    return this.event(type, this.view(id, { status }), "capture");
  }
  reversal(id: string): Obj {
    const c = this.capture(id);
    return {
      id: this.fake.id("REVCONF", 10),
      status: "COMPLETED",
      amount: c.amount,
      create_time: new Date().toISOString(),
      links: [{ rel: "up", href: `${HOST}/v2/payments/captures/${id}` }],
    };
  }
  dispute(id: string, status: string, outcome?: string): Obj {
    const c = this.capture(id);
    return {
      dispute_id: "",
      id: "",
      status,
      reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
      dispute_amount: c.amount,
      disputed_transactions: [{ seller_transaction_id: id }],
      seller_response_due_date: new Date(Date.now() + 10 * 86_400_000).toISOString(),
      ...(outcome ? { dispute_outcome: { outcome_code: outcome } } : {}),
    };
  }
  newDispute(id: string, status: string, outcome?: string): Obj {
    const d = this.dispute(id, status, outcome);
    d.dispute_id = d.id = this.fake.id("PP-D-", 6);
    return d;
  }

  collect() {
    return [];
  }
  paymentSucceeded(_w: World, id: string) {
    this.capture(id).status = "COMPLETED";
    return [this.captureEvent("PAYMENT.CAPTURE.COMPLETED", id, "COMPLETED")];
  }
  paymentFailed(_w: World, id: string, late: boolean) {
    if (late) return [this.event("PAYMENT.CAPTURE.REVERSED", this.reversal(id), "refund")];
    this.capture(id).status = "DECLINED";
    return [this.captureEvent("PAYMENT.CAPTURE.DENIED", id, "DECLINED")];
  }
  refundEvent(_w: World, _id: string, refundId: string, state: RefundState) {
    const r = this.fake.refunds.get(refundId);
    if (!r) throw new Error(`fake PayPal has no refund ${refundId}`);
    r.status = { pending: "PENDING", succeeded: "COMPLETED", failed: "FAILED" }[state];
    const type = {
      pending: "PAYMENT.REFUND.PENDING",
      succeeded: "PAYMENT.CAPTURE.REFUNDED",
      failed: "PAYMENT.REFUND.FAILED",
    }[state];
    return [this.event(type, { ...r }, "refund")];
  }
  dashboardRefund(_w: World, id: string, amountMinor: bigint) {
    const r = this.fake.newRefund(id, Number(amountMinor));
    return { refundId: r.id, events: [this.event("PAYMENT.CAPTURE.REFUNDED", { ...r }, "refund")] };
  }
  disputeSteps(_w: World, id: string, flow: "won" | "lost" | "win_after_loss"): DisputeStep[] {
    const d = this.newDispute(id, "WAITING_FOR_SELLER_RESPONSE");
    const at = (type: string, status: string, outcome?: string) =>
      this.event(
        type,
        { ...d, status, ...(outcome ? { dispute_outcome: { outcome_code: outcome } } : {}) },
        "dispute",
      );
    // A dispute opens with no money moved; PayPal takes it back as a capture reversal.
    const steps: DisputeStep[] = [
      { after: "opened", bodies: [at("CUSTOMER.DISPUTE.CREATED", "WAITING_FOR_SELLER_RESPONSE")] },
      {
        after: "withdrawn",
        bodies: [this.event("PAYMENT.CAPTURE.REVERSED", this.reversal(id), "refund")],
      },
    ];
    const won: DisputeStep = {
      after: "won",
      bodies: [at("CUSTOMER.DISPUTE.RESOLVED", "RESOLVED", "RESOLVED_SELLER_FAVOUR")],
    };
    const lost: DisputeStep = {
      after: "lost",
      bodies: [at("CUSTOMER.DISPUTE.RESOLVED", "RESOLVED", "RESOLVED_BUYER_FAVOUR")],
    };
    return flow === "won"
      ? [...steps, won]
      : flow === "lost"
        ? [...steps, lost]
        : [...steps, lost, won];
  }
  chargesOn(vault: string) {
    return [...this.fake.captures.values()].filter((c) => c.vault === vault).map((c) => c.id);
  }

  statusEvent(_w: World, st: DocumentedStatus, id: string): Body[] {
    if (st.object === "dispute.status")
      return [this.event("CUSTOMER.DISPUTE.UPDATED", this.newDispute(id, st.status), "dispute")];
    if (st.object === "dispute.outcome")
      return [
        this.event(
          "CUSTOMER.DISPUTE.RESOLVED",
          this.newDispute(id, "RESOLVED", st.status),
          "dispute",
        ),
      ];
    const c = this.capture(id);
    const orderId = (c.supplementary_data as { related_ids: { order_id: string } }).related_ids
      .order_id;
    const order = () => ({ ...this.fake.orders.get(orderId)! });
    const sale = (state: string): Obj => ({
      id: this.fake.id("SALECONF", 9),
      state,
      amount: { total: "100.00", currency: "USD" },
    });
    const t = st.status;
    switch (t) {
      case "PAYMENT.CAPTURE.COMPLETED":
        return [this.captureEvent(t, id, "COMPLETED")];
      case "PAYMENT.CAPTURE.PENDING":
        return [this.captureEvent(t, id, "PENDING")];
      case "PAYMENT.CAPTURE.DECLINED":
      case "PAYMENT.CAPTURE.DENIED":
        return [this.captureEvent(t, id, "DECLINED")];
      case "PAYMENT.CAPTURE.REFUNDED":
        return [this.event(t, { ...this.fake.newRefund(id, 500) }, "refund")];
      case "PAYMENT.CAPTURE.REVERSED":
        return [this.event(t, this.reversal(id), "refund")];
      case "PAYMENT.REFUND.PENDING":
      case "PAYMENT.REFUND.FAILED":
        return [
          this.event(
            t,
            { ...this.fake.newRefund(id, 500, t.endsWith("PENDING") ? "PENDING" : "FAILED") },
            "refund",
          ),
        ];
      case "PAYMENT.AUTHORIZATION.CREATED":
      case "PAYMENT.AUTHORIZATION.VOIDED":
        return [
          this.event(
            t,
            {
              id: this.fake.id("AUTHCONF", 9),
              status: t.endsWith("CREATED") ? "CREATED" : "VOIDED",
              amount: c.amount,
              supplementary_data: { related_ids: { order_id: orderId } },
            },
            "authorization",
          ),
        ];
      case "CHECKOUT.ORDER.APPROVED":
      case "CHECKOUT.ORDER.COMPLETED":
      case "CHECKOUT.ORDER.PROCESSED":
      case "CHECKOUT.PAYMENT-APPROVAL.REVERSED":
        return [this.event(t, order(), "checkout-order")];
      case "PAYMENT.SALE.COMPLETED":
        return [this.event(t, sale("completed"), "sale")];
      case "PAYMENT.SALE.PENDING":
        return [this.event(t, sale("pending"), "sale")];
      case "PAYMENT.SALE.DENIED":
        return [this.event(t, sale("denied"), "sale")];
      case "PAYMENT.SALE.REFUNDED":
      case "PAYMENT.SALE.REVERSED":
        return [
          this.event(
            t,
            {
              id: this.fake.id("SRCONF", 11),
              state: "completed",
              sale_id: id,
              amount: { total: "-5.00", currency: "USD" },
            },
            "refund",
          ),
        ];
      case "CUSTOMER.DISPUTE.CREATED":
        return [this.event(t, this.newDispute(id, "WAITING_FOR_SELLER_RESPONSE"), "dispute")];
      case "CUSTOMER.DISPUTE.UPDATED":
        return [this.event(t, this.newDispute(id, "UNDER_REVIEW"), "dispute")];
      case "CUSTOMER.DISPUTE.RESOLVED":
        return [
          this.event(t, this.newDispute(id, "RESOLVED", "RESOLVED_SELLER_FAVOUR"), "dispute"),
        ];
      case "RISK.DISPUTE.CREATED":
        return [this.event(t, this.newDispute(id, "OPEN"), "dispute")];
      case "VAULT.PAYMENT-TOKEN.CREATED":
      case "VAULT.PAYMENT-TOKEN.DELETED":
      case "VAULT.PAYMENT-TOKEN.DELETION-INITIATED":
        return [
          this.event(
            t,
            {
              id: this.fake.id("VTCONF", 6),
              customer: { id: "CUSCONF001" },
              payment_source: { paypal: {} },
            },
            "payment_token",
          ),
        ];
      case "BILLING.SUBSCRIPTION.CANCELLED":
        return [this.event(t, { id: this.fake.id("B-CONF", 10), state: "Cancelled" }, "Agreement")];
      default:
        throw new Error(`no PayPal event for ${st.object}.${t}`);
    }
  }
}

const ev = (status: string, expect: DocumentedStatus["expect"]): DocumentedStatus => ({
  object: "event",
  status,
  doc: "event-names",
  expect,
});
const dStatus = (status: string, expect: DocumentedStatus["expect"]): DocumentedStatus => ({
  object: "dispute.status",
  status,
  doc: "dispute-status",
  expect,
});
const outcome = (status: string, expect: DocumentedStatus["expect"]): DocumentedStatus => ({
  object: "dispute.outcome",
  status,
  doc: "dispute-outcome",
  expect,
});

const adapterOf = async (w: World) => {
  const [acc] = await systemDb
    .select()
    .from(gatewayAccounts)
    .where(eq(gatewayAccounts.id, w.account.id));
  return resolveAdapter(acc!) as unknown as PayPalProvider;
};
const pmOf = async (w: World, id: string) =>
  (
    await withTenant(w.org.id, (tx) =>
      tx.select().from(paymentMethods).where(eq(paymentMethods.id, id)),
    )
  )[0]!;
const lastCall = (d: PayPalDriver, op: string) => d.fake.callsOf(op).at(-1);

/** A direct adapter charge in `currency`, on a method vaulted in this world. */
async function chargeIn(w: World, currency: string, minor: bigint) {
  const d = w.driver as PayPalDriver;
  const b = await w.bill();
  const pm = await pmOf(w, b.paymentMethodId);
  const adapter = await adapterOf(w);
  await adapter
    .charge({
      amountMinor: minor,
      currency,
      customer: { providerKey: "paypal", providerCustomerId: pm.providerCustomerId },
      paymentMethod: {
        providerKey: "paypal",
        providerPaymentMethodId: pm.providerPaymentMethodId,
        providerCustomerId: pm.providerCustomerId,
        display: { type: "paypal" },
      },
      idempotencyKey: `conf_${currency}_${randomUUID()}`,
      ownershipRef: `inv_conf_${currency}`,
    })
    .catch((e: Error) => e);
  const pu = (lastCall(d, "charge")?.body.purchase_units as Obj[] | undefined)?.[0];
  return String((pu?.amount as Money | undefined)?.value);
}

/** One charge whose create meets a decline `issue`; the attempt as booked. */
async function declinedWith(w: World, issue: string) {
  const d = w.driver as PayPalDriver;
  d.fake.inject("charge", {
    kind: "http",
    status: 422,
    body: {
      name: "UNPROCESSABLE_ENTITY",
      message: "The requested action could not be performed.",
      debug_id: "f0c0nf00000dbg",
      details: [{ issue, description: "PayPal internal wording for the decline." }],
    },
  });
  try {
    return await w.bill();
  } finally {
    d.fake.clearFaults();
  }
}

export const paypalFixture: GatewayFixture = {
  key: "paypal",
  currency: "USD",
  docs: [
    { id: "event-names", url: DOC.events, read: READ, check: { kind: "page" } },
    {
      id: "dispute-status",
      url: DOC.disputes,
      read: READ,
      check: { kind: "openapi-enum", path: ["components", "schemas", "status", "enum"] },
    },
    {
      id: "dispute-outcome",
      url: DOC.disputes,
      read: READ,
      check: {
        kind: "openapi-enum",
        path: ["components", "schemas", "dispute_outcome", "properties", "outcome_code", "enum"],
      },
    },
  ],
  // Every payment, refund, dispute and saved-method event on the event-names page.
  statuses: [
    ev("PAYMENT.CAPTURE.COMPLETED", ["charge.succeeded"]),
    ev("PAYMENT.CAPTURE.PENDING", ["charge.pending"]),
    ev("PAYMENT.CAPTURE.DECLINED", ["charge.failed"]),
    ev("PAYMENT.CAPTURE.DENIED", ["charge.failed"]),
    ev("PAYMENT.CAPTURE.REFUNDED", ["charge.refunded"]),
    ev("PAYMENT.CAPTURE.REVERSED", ["charge.reversed"]),
    ev("PAYMENT.REFUND.PENDING", ["refund.pending"]),
    ev("PAYMENT.REFUND.FAILED", ["refund.failed"]),
    ev("PAYMENT.AUTHORIZATION.CREATED", ["intent.authorized"]),
    ev("PAYMENT.AUTHORIZATION.VOIDED", ["intent.voided"]),
    ev("CHECKOUT.ORDER.APPROVED", ["intent.authorized"]),
    ev("CHECKOUT.ORDER.COMPLETED", ["charge.succeeded"]),
    ev("CHECKOUT.ORDER.PROCESSED", {
      none: "Listed only as a cross-reference for platforms; our orders capture in the create call and the capture events carry the money.",
    }),
    ev("CHECKOUT.PAYMENT-APPROVAL.REVERSED", ["intent.voided"]),
    ev("PAYMENT.SALE.COMPLETED", ["charge.succeeded"]),
    ev("PAYMENT.SALE.PENDING", ["charge.pending"]),
    ev("PAYMENT.SALE.DENIED", ["charge.failed"]),
    ev("PAYMENT.SALE.REFUNDED", ["charge.refunded"]),
    ev("PAYMENT.SALE.REVERSED", ["charge.reversed"]),
    ev("CUSTOMER.DISPUTE.CREATED", ["dispute.created"]),
    ev("CUSTOMER.DISPUTE.UPDATED", ["dispute.updated"]),
    ev("CUSTOMER.DISPUTE.RESOLVED", ["dispute.won"]),
    ev("RISK.DISPUTE.CREATED", {
      none: "Deprecated: superseded by CUSTOMER.DISPUTE.CREATED, which books the dispute.",
    }),
    ev("VAULT.PAYMENT-TOKEN.CREATED", ["payment_method.updated"]),
    ev("VAULT.PAYMENT-TOKEN.DELETED", ["payment_method.detached"]),
    ev("VAULT.PAYMENT-TOKEN.DELETION-INITIATED", {
      none: "A deletion request, not an outcome; VAULT.PAYMENT-TOKEN.DELETED detaches the method.",
    }),
    ev("BILLING.SUBSCRIPTION.CANCELLED", ["payment_method.detached"]),
    dStatus("OPEN", ["dispute.updated"]),
    dStatus("WAITING_FOR_BUYER_RESPONSE", ["dispute.updated"]),
    dStatus("WAITING_FOR_SELLER_RESPONSE", ["dispute.updated"]),
    dStatus("UNDER_REVIEW", ["dispute.updated"]),
    dStatus("RESOLVED", ["dispute.closed"]),
    dStatus("OTHER", ["dispute.updated"]),
    outcome("RESOLVED_BUYER_FAVOUR", ["dispute.lost"]),
    outcome("RESOLVED_SELLER_FAVOUR", ["dispute.won"]),
    outcome("RESOLVED_WITH_PAYOUT", ["dispute.won"]),
    outcome("CANCELED_BY_BUYER", ["dispute.won"]),
    outcome("ACCEPTED", ["dispute.lost"]),
    outcome("DENIED", ["dispute.won"]),
    outcome("NONE", ["dispute.closed"]),
  ],
  na: {
    "S6.after-failure": `A DECLINED capture is final; a retry is a new order with a new capture id (capture_status, ${DOC.payments}).`,
    S10: `PayPal has no call that cancels a capture in flight; a PENDING capture ends COMPLETED or DECLINED (${DOC.payments}).`,
  },
  limits: [
    { op: "charge", field: "header:paypal-request-id", max: 108, source: DOC.orders },
    { op: "charge", field: "purchase_units.0.custom_id", max: 255, source: DOC.orders },
    { op: "charge", field: "purchase_units.0.description", max: 3000, source: DOC.orders },
    { op: "refund", field: "custom_id", max: 127, source: DOC.payments },
  ],
  driver: () => new PayPalDriver(),
  extraRows: [
    {
      scenario: "S5",
      id: "S5.updated-keeps-open",
      title: "CUSTOMER.DISPUTE.UPDATED refreshes an open dispute and does not close it",
      async run({ world }) {
        const w = await world("s5up");
        const d = w.driver as PayPalDriver;
        const b = await w.collected();
        const disp = d.newDispute(b.chargeId, "WAITING_FOR_SELLER_RESPONSE");
        await w.deliver(d.event("CUSTOMER.DISPUTE.CREATED", disp, "dispute"));
        await w.deliver(
          d.event("CUSTOMER.DISPUTE.UPDATED", { ...disp, status: "UNDER_REVIEW" }, "dispute"),
        );
        const row = await w.dispute(disp.id);
        return {
          pass: !!row && !/closed|won|lost/.test(row.status),
          detail: `dispute ${row?.status ?? "missing"}`,
        };
      },
    },
    {
      scenario: "S6",
      id: "S6.partial-capture-final",
      title:
        "capturing less than the authorization sends final_capture, so the remainder is released",
      async run({ world }) {
        const w = await world("s6pc");
        const d = w.driver as PayPalDriver;
        const id = d.fake.id("ORDCONF", 10);
        const authId = d.fake.id("AUTHCONF", 9);
        d.fake.orders.set(id, {
          id,
          status: "COMPLETED",
          purchase_units: [
            {
              amount: money(10_000, "USD"),
              payments: { authorizations: [{ id: authId, status: "CREATED" }] },
            },
          ],
        });
        const r = await (
          await adapterOf(w)
        )
          .consumeIntent({
            purpose: "payment",
            intentId: id,
            idempotencyKey: `conf_${id}`,
            amountMinor: 6000n,
            currency: "USD",
          })
          .catch((e: Error) => e);
        const body = lastCall(d, "intent_capture")?.body;
        return {
          pass: body?.final_capture === true,
          detail:
            r instanceof Error ? `threw: ${r.message}` : `capture body ${JSON.stringify(body)}`,
        };
      },
    },
    {
      scenario: "S7",
      id: "S7.non-json-2xx-replays",
      title:
        "an order create answered 201 with a non-JSON body is replayed under the same id and booked once",
      async run({ world }) {
        const w = await world("s7nj");
        const d = w.driver as PayPalDriver;
        d.fake.rawNext = { status: 201, afterCreate: true };
        const b = await w.bill();
        const pm = await pmOf(w, b.paymentMethodId);
        const made = d.chargesOn(pm.providerPaymentMethodId);
        return {
          pass: made.length === 1 && b.txnStatus === "succeeded" && b.chargeId === made[0],
          detail: `charges ${made.length} attempt ${b.txnStatus ?? b.paymentStatus} id ${b.chargeId || "none"}`,
        };
      },
    },
    {
      scenario: "S7",
      id: "S7.vault-request-id",
      title: "the vault exchange sends a PayPal-Request-Id, so a lost answer can be replayed",
      async run({ world }) {
        const w = await world("s7vr");
        const d = w.driver as PayPalDriver;
        await w.bill();
        const h = lastCall(d, "vault")?.headers ?? {};
        return {
          pass: !!h["paypal-request-id"],
          detail: `vault headers ${Object.keys(h).join(",")}`,
        };
      },
    },
    {
      scenario: "S8",
      id: "S8.non-json-4xx-definite",
      title: "a charge refused 400 with a non-JSON body is a definite failure, not a lost answer",
      async run({ world }) {
        const w = await world("s8nj");
        const d = w.driver as PayPalDriver;
        d.fake.rawNext = { status: 400, afterCreate: false };
        const b = await w.bill();
        const tries = d.fake.callsOf("charge").filter((c) => c.status === 400).length;
        return {
          pass: (b.txnStatus ?? b.paymentStatus) === "failed",
          detail: `attempt ${b.txnStatus ?? b.paymentStatus} ${b.failureCode ?? ""} after ${tries} answer(s)`,
        };
      },
    },
    {
      scenario: "S8",
      id: "S8.dead-agreement",
      title: "BILLING_AGREEMENT_NOT_FOUND marks the method unusable, not a retriable decline",
      async run({ world }) {
        const b = await declinedWith(await world("s8da"), "BILLING_AGREEMENT_NOT_FOUND");
        return {
          pass: b.failureCode === "payment_method_not_found",
          detail: `failure ${b.failureCode}`,
        };
      },
    },
    {
      scenario: "S8",
      id: "S8.merchant-side",
      title: "PAYEE_ACCOUNT_RESTRICTED is the merchant's problem, not the customer's",
      async run({ world }) {
        const b = await declinedWith(await world("s8ms"), "PAYEE_ACCOUNT_RESTRICTED");
        return {
          pass: b.failureCode === "gateway_account_unavailable",
          detail: `failure ${b.failureCode}`,
        };
      },
    },
    {
      scenario: "S8",
      id: "S8.failure-text",
      title: "failure text keeps PayPal's issue code but not its description or debug_id",
      async run({ world }) {
        const w = await world("s8ft");
        const b = await declinedWith(w, "SOME_FUTURE_ISSUE");
        const [p] = await withTenant(w.org.id, (tx) =>
          tx.select().from(payments).where(eq(payments.id, b.paymentId!)),
        );
        const m = p?.failureMessage ?? "";
        return {
          pass:
            m.includes("SOME_FUTURE_ISSUE") &&
            !m.includes("internal wording") &&
            !m.includes("f0c0nf00000dbg"),
          detail: `message "${m}"`,
        };
      },
    },
    {
      scenario: "S9",
      id: "S9.denied-after-completed",
      title: "PAYMENT.CAPTURE.DENIED on a booked capture reverses it once",
      async run({ world }) {
        const w = await world("s9dn");
        const d = w.driver as PayPalDriver;
        const b = await w.collected();
        const cash0 = await w.cash();
        const denied = d.paymentFailed(w, b.chargeId, false);
        await w.deliver(denied);
        await w.deliver(denied);
        return {
          pass:
            (await w.cash()) === cash0 - b.amountMinor &&
            (await w.invoiceStatus(b.invoiceId)) !== "paid",
          detail: `cash ${(await w.cash()) - cash0} invoice ${await w.invoiceStatus(b.invoiceId)}`,
        };
      },
    },
    {
      scenario: "S12",
      id: "S12.cert-host-pinned",
      title: "a delivery signed with a certificate off paypal.com is refused",
      async run({ world }) {
        const w = await world("s12cert");
        const d = w.driver as PayPalDriver;
        const b = await w.collected();
        const r = d.dashboardRefund(w, b.chargeId, 1000n);
        const body = r.events[0]!.body;
        const res = await w.app.inject({
          method: "POST",
          url: `/v1/gateway_webhooks/paypal?id=${w.account.publicId}`,
          headers: {
            "content-type": "application/json",
            host: new URL(w.notificationUrl).host,
            ...d.sign(w, body, w.secret, "https://certs.example.com/paypal-lookalike.pem"),
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
      scenario: "S13",
      id: "S13.v1-sale-refund-sized",
      title: "a v1 PAYMENT.SALE.REFUNDED is booked at its amount.total, never as a full refund",
      async run({ world }) {
        const w = await world("s13sr");
        const d = w.driver as PayPalDriver;
        const b = await w.collected();
        const cash0 = await w.cash();
        const refund = {
          id: d.fake.id("SRCONF", 11),
          state: "completed",
          sale_id: b.chargeId,
          amount: { total: "-30.00", currency: "USD" },
        };
        await w.deliver(d.event("PAYMENT.SALE.REFUNDED", refund, "refund"));
        return {
          pass: (await w.cash()) === cash0 - 3000n,
          detail: `cash ${(await w.cash()) - cash0} (want -3000)`,
        };
      },
    },
    {
      scenario: "S13",
      id: "S13.v1-agreement-charge",
      title: "a v1 billing agreement (B-…) is charged as payment_source.token BILLING_AGREEMENT",
      async run({ world }) {
        const w = await world("s13ag");
        const d = w.driver as PayPalDriver;
        d.fake.nextVaultIsAgreement = true;
        const b = await w.bill();
        const src = lastCall(d, "charge")?.body.payment_source as Record<string, Obj> | undefined;
        return {
          pass: src?.token?.type === "BILLING_AGREEMENT" && b.txnStatus === "succeeded",
          detail: `payment_source ${JSON.stringify(src)} attempt ${b.txnStatus}`,
        };
      },
    },
    {
      scenario: "S13",
      id: "S13.v1-agreement-delete-cancels",
      title: "deleting a B-… method cancels the billing agreement at PayPal",
      async run({ world }) {
        const w = await world("s13del");
        const d = w.driver as PayPalDriver;
        d.fake.nextVaultIsAgreement = true;
        const b = await w.bill();
        const pm = await pmOf(w, b.paymentMethodId);
        const r = await (
          await adapterOf(w)
        )
          .deletePaymentMethod({
            customer: { providerKey: "paypal", providerCustomerId: pm.providerCustomerId },
            paymentMethod: {
              providerKey: "paypal",
              providerPaymentMethodId: pm.providerPaymentMethodId,
              providerCustomerId: pm.providerCustomerId,
              display: { type: "paypal" },
            },
          })
          .catch((e: Error) => e);
        const state = d.fake.agreements.get(pm.providerPaymentMethodId)?.state;
        return {
          pass: state === "Cancelled",
          detail: r instanceof Error ? `threw: ${r.message}` : `agreement ${String(state)}`,
        };
      },
    },
    {
      scenario: "S13",
      id: "S13.v1-agreement-cancelled-detaches",
      title: "BILLING.SUBSCRIPTION.CANCELLED on our agreement stops it being charged",
      async run({ world }) {
        const w = await world("s13ac");
        const d = w.driver as PayPalDriver;
        d.fake.nextVaultIsAgreement = true;
        const b = await w.bill();
        const pm = await pmOf(w, b.paymentMethodId);
        await w.deliver(
          d.event(
            "BILLING.SUBSCRIPTION.CANCELLED",
            { id: pm.providerPaymentMethodId, state: "Cancelled" },
            "Agreement",
          ),
        );
        const after = await pmOf(w, b.paymentMethodId);
        return { pass: after.status !== "valid", detail: `method ${after.status}` };
      },
    },
    {
      scenario: "S13",
      id: "S13.subscription-cancel-not-agreement",
      title: "BILLING.SUBSCRIPTION.CANCELLED for a Subscriptions-API id is not a method detach",
      async run({ world }) {
        const w = await world("s13sc");
        const d = w.driver as PayPalDriver;
        const e = d.event(
          "BILLING.SUBSCRIPTION.CANCELLED",
          { id: "I-CONF0000000001", status: "CANCELLED" },
          "subscription",
        );
        await w.deliver(e);
        const types = await w.recordedTypes(e.eventIds);
        return {
          pass: types.join() === "unknown",
          detail: `recorded ${types.join() || "nothing"}`,
        };
      },
    },
    ...(["HUF", "TWD", "JPY"] as const).map((cur) => ({
      scenario: "S14" as const,
      id: `S14.amount.${cur}`,
      title: `${cur} is a zero-digit currency at PayPal: the value carries no decimals`,
      async run({ world }: { world: (l: string) => Promise<World> }) {
        // 2500 minor units: 25.00 HUF/TWD (ISO exponent 2), 2500 JPY (exponent 0).
        const sent = await chargeIn(await world(`s14${cur}`), cur, 2500n);
        const want = cur === "JPY" ? "2500" : "25";
        return {
          pass: sent === want,
          detail: `sent "${sent}" (want "${want}", ${DOC.currencies})`,
        };
      },
    })),
  ],
};
