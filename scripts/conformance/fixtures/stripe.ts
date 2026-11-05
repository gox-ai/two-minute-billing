/**
 * Stripe conformance fixtures. Objects follow the API version the SDK is pinned to
 * (`STRIPE_API_VERSION`); S13 reuses the recorded 2020-03-02 payloads in
 * `test/unit/fixtures/stripe-webhook-versions.json`. Every id is a same-shape fake.
 */
import { createHmac } from "node:crypto";
import {
  STRIPE_API_VERSION,
  STRIPE_OWNERSHIP_KEY,
  STRIPE_WEBHOOK_TOLERANCE_S,
} from "@/providers/stripe";
import versions from "../../../test/unit/fixtures/stripe-webhook-versions.json";
import { runWithClockScope } from "@/platform/clock";
import { sweepStalePendingCharges } from "@/modules/payments/stale-pending";
import { FakeGateway, json, type FakeRequest } from "../fake-http";
import { AMOUNT, type World } from "../harness";
import type {
  Billed,
  Body,
  DisputeStep,
  DocumentedStatus,
  GatewayDriver,
  GatewayFixture,
  RefundState,
  TokenKind,
} from "../types";

const HOST = "https://api.stripe.com";
const READ = "2026-10-27";
const SPEC = "https://raw.githubusercontent.com/stripe/openapi/master/openapi/spec3.json";
const DOC = {
  errors: "https://docs.stripe.com/api/errors",
  idempotency: "https://docs.stripe.com/api/idempotent_requests",
  metadata: "https://docs.stripe.com/api/metadata",
  currencies: "https://docs.stripe.com/currencies",
  achDisputes: "https://docs.stripe.com/payments/ach-direct-debit",
  lifecycle: "https://docs.stripe.com/payments/paymentintents/lifecycle",
  search: "https://docs.stripe.com/search",
};

type Obj = Record<string, unknown> & { id: string };
const now = () => Math.floor(Date.now() / 1000);

class FakeStripe extends FakeGateway {
  readonly host = HOST;
  readonly pms = new Map<string, Obj & { decline?: boolean }>();
  readonly pis = new Map<string, Obj>();
  readonly charges = new Map<string, Obj>();
  readonly refunds = new Map<string, Obj>();
  readonly disputes = new Map<string, Obj>();
  /** Idempotency-Key → the first answer, replayed as Stripe does. */
  private readonly replay = new Map<string, { status: number; body: unknown }>();

  pm(kind: TokenKind): string {
    const id = this.id("pm_conf");
    const bank = kind === "bank_debit";
    this.pms.set(id, {
      id,
      object: "payment_method",
      type: bank ? "us_bank_account" : "card",
      customer: null,
      created: now(),
      ...(bank
        ? { us_bank_account: { bank_name: "TEST BANK", last4: "6789", account_type: "checking" } }
        : {
            card: {
              brand: "visa",
              last4: kind === "declines" ? "0002" : "4242",
              exp_month: 12,
              exp_year: 2034,
              funding: "credit",
              country: "US",
            },
          }),
      decline: kind === "declines",
    });
    return id;
  }

  /** PaymentIntents as Stripe lists them: newest first. */
  private newestFirst(): Obj[] {
    return [...this.pis.values()].reverse();
  }

  /** The PaymentIntent's charge, expanded or by id. */
  private view(pi: Obj, expandCharge: boolean): Obj {
    const ch = pi.latest_charge ? this.charges.get(String(pi.latest_charge)) : undefined;
    return { ...pi, latest_charge: expandCharge ? (ch ?? null) : (pi.latest_charge ?? null) };
  }

  private metadata(body: Record<string, unknown>) {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(body)) {
      const m = k.match(/^metadata\[(.+)\]$/);
      if (m) out[m[1]!] = String(v);
    }
    return out;
  }

  /** Create once per Idempotency-Key; a repeat replays the first answer. */
  private idempotent(req: FakeRequest, make: () => { status: number; body: unknown }) {
    const key = req.headers["idempotency-key"];
    const hit = key ? this.replay.get(`${req.path}:${key}`) : undefined;
    const r = hit ?? make();
    if (key && !hit) this.replay.set(`${req.path}:${key}`, r);
    return json(r.status, r.body);
  }

  newCharge(pi: Obj, status: string): Obj {
    const ch: Obj = {
      id: this.id("ch_conf"),
      object: "charge",
      amount: pi.amount,
      amount_captured: status === "succeeded" ? pi.amount : 0,
      amount_refunded: 0,
      captured: status === "succeeded",
      currency: pi.currency,
      payment_intent: pi.id,
      payment_method: pi.payment_method,
      metadata: pi.metadata,
      status,
      paid: status === "succeeded",
      refunded: false,
      created: now(),
      disputed: false,
    };
    this.charges.set(ch.id, ch);
    pi.latest_charge = ch.id;
    return ch;
  }

  newRefund(pi: Obj, amount: number, status: string, metadata: Record<string, string>): Obj {
    const ch = this.charges.get(String(pi.latest_charge))!;
    const r: Obj = {
      id: this.id("re_conf"),
      object: "refund",
      amount,
      currency: pi.currency,
      status,
      payment_intent: pi.id,
      charge: ch.id,
      metadata,
      created: now(),
    };
    this.refunds.set(r.id, r);
    ch.amount_refunded = Number(ch.amount_refunded) + amount;
    ch.refunded = ch.amount_refunded === ch.amount;
    return r;
  }

  async route(req: FakeRequest): Promise<Response | null> {
    const { method, path, body } = req;
    const seg = path.split("/").filter(Boolean);
    if (method === "POST" && path === "/v1/customers")
      return this.guarded("customer", req, () =>
        this.idempotent(req, () => ({
          status: 200,
          body: {
            id: this.id("cus_conf"),
            object: "customer",
            metadata: this.metadata(body),
            created: now(),
          },
        })),
      );
    if (method === "GET" && seg[1] === "customers" && seg[2])
      return json(200, { id: seg[2], object: "customer", metadata: {}, deleted: false });
    if (seg[1] === "payment_methods" && seg[2]) {
      const pm = this.pms.get(seg[2]);
      if (!pm)
        return json(404, { error: { type: "invalid_request_error", code: "resource_missing" } });
      if (method === "POST" && seg[3] === "attach") pm.customer = body.customer;
      const { decline: _d, ...out } = pm;
      return json(200, out);
    }
    if (method === "GET" && path === "/v1/account")
      return json(200, { id: "acct_conf0000000001", object: "account", country: "US" });
    if (method === "POST" && path === "/v1/payment_intents")
      return this.guarded("charge", req, () =>
        this.idempotent(req, () => {
          const pm = this.pms.get(String(body.payment_method));
          const pi: Obj = {
            id: this.id("pi_conf"),
            object: "payment_intent",
            amount: Number(body.amount),
            amount_received: 0,
            currency: String(body.currency),
            customer: body.customer,
            payment_method: body.payment_method,
            description: body.description ?? null,
            metadata: this.metadata(body),
            created: now(),
            status: "requires_confirmation",
            last_payment_error: null,
            cancellation_reason: null,
          };
          this.pis.set(pi.id, pi);
          const expand = Object.entries(body).some(
            ([k, v]) => k.startsWith("expand") && v === "latest_charge",
          );
          if (pm?.decline) {
            const ch = this.newCharge(pi, "failed");
            const err = {
              type: "card_error",
              code: "card_declined",
              decline_code: "insufficient_funds",
              message: "Your card has insufficient funds.",
            };
            Object.assign(ch, {
              failure_code: "card_declined",
              outcome: { reason: "insufficient_funds", type: "issuer_declined" },
            });
            Object.assign(pi, { status: "requires_payment_method", last_payment_error: err });
            return {
              status: 402,
              body: { error: { ...err, charge: ch.id, payment_intent: this.view(pi, false) } },
            };
          }
          const processing = pm?.type === "us_bank_account";
          this.newCharge(pi, processing ? "pending" : "succeeded");
          Object.assign(
            pi,
            processing
              ? { status: "processing" }
              : { status: "succeeded", amount_received: pi.amount },
          );
          return { status: 200, body: this.view(pi, expand) };
        }),
      );
    if (method === "GET" && path === "/v1/payment_intents/search")
      return this.guarded("search", req, () => {
        const match = searchFilter(req.url.searchParams.get("query") ?? "");
        if (!match)
          return json(400, {
            error: { type: "invalid_request_error", message: "Invalid search query." },
          });
        const data = this.newestFirst().filter(match);
        return json(200, {
          object: "search_result",
          data: data.map((pi) => this.view(pi, false)),
          has_more: false,
          next_page: null,
          url: "/v1/payment_intents/search",
        });
      });
    if (method === "GET" && path === "/v1/payment_intents")
      return this.guarded("list_charges", req, () => {
        const q = req.url.searchParams;
        const num = (k: string) => (q.get(k) != null ? Number(q.get(k)) : undefined);
        const gte = num("created[gte]");
        const lte = num("created[lte]");
        const limit = num("limit") ?? 10;
        let rows = this.newestFirst().filter(
          (pi) =>
            (gte == null || Number(pi.created) >= gte) &&
            (lte == null || Number(pi.created) <= lte),
        );
        const after = q.get("starting_after");
        if (after) rows = rows.slice(rows.findIndex((pi) => pi.id === after) + 1);
        return json(200, {
          object: "list",
          data: rows.slice(0, limit).map((pi) => this.view(pi, false)),
          has_more: rows.length > limit,
          url: "/v1/payment_intents",
        });
      });
    if (seg[1] === "payment_intents" && seg[2]) {
      const pi = this.pis.get(seg[2]);
      if (!pi)
        return json(404, { error: { type: "invalid_request_error", code: "resource_missing" } });
      if (method === "POST" && seg[3] === "cancel")
        return this.guarded("cancel_charge", req, () => {
          if (pi.status === "processing" || String(pi.status).startsWith("requires_"))
            Object.assign(pi, { status: "canceled", cancellation_reason: "requested_by_customer" });
          return json(200, this.view(pi, false));
        });
      const expandPm = [...req.url.searchParams].some(
        ([k, v]) => k.startsWith("expand") && v === "payment_method",
      );
      const out = this.view(pi, false);
      if (expandPm) {
        const { decline: _d, ...pm } = this.pms.get(String(pi.payment_method)) ?? ({} as Obj);
        out.payment_method = pm;
      }
      return this.guarded("read_charge", req, () => json(200, out));
    }
    if (method === "POST" && path === "/v1/refunds")
      return this.guarded("refund", req, () =>
        this.idempotent(req, () => {
          const pi = this.pis.get(String(body.payment_intent));
          if (!pi)
            return {
              status: 404,
              body: { error: { type: "invalid_request_error", code: "resource_missing" } },
            };
          const ch = this.charges.get(String(pi.latest_charge))!;
          const amount =
            body.amount != null
              ? Number(body.amount)
              : Number(ch.amount) - Number(ch.amount_refunded);
          const bank = this.pms.get(String(pi.payment_method))?.type === "us_bank_account";
          return {
            status: 200,
            body: this.newRefund(pi, amount, bank ? "pending" : "succeeded", this.metadata(body)),
          };
        }),
      );
    if (method === "GET" && path === "/v1/refunds") {
      const charge = req.url.searchParams.get("charge");
      const data = [...this.refunds.values()].filter((r) => r.charge === charge).reverse();
      return json(200, { object: "list", data, has_more: false, url: "/v1/refunds" });
    }
    const read = (m: Map<string, Obj>, op: string) => {
      const o = seg[2] ? m.get(seg[2]) : undefined;
      return this.guarded(op, req, () =>
        o
          ? json(200, o)
          : json(404, { error: { type: "invalid_request_error", code: "resource_missing" } }),
      );
    };
    if (method === "GET" && seg[1] === "refunds") return read(this.refunds, "read_refund");
    if (method === "GET" && seg[1] === "charges") return read(this.charges, "read_object");
    if (method === "GET" && seg[1] === "disputes") return read(this.disputes, "read_object");
    return null;
  }
}

/**
 * The subset of Stripe's search language the adapter sends: `AND`-joined
 * `metadata["k"]:"v"` (exact, case-insensitive) and numeric `created` comparisons.
 * Anything else is a 400, as Stripe answers an unsupported clause.
 * https://docs.stripe.com/search#search-query-language
 */
function searchFilter(query: string): ((pi: Obj) => boolean) | null {
  const tests: Array<(pi: Obj) => boolean> = [];
  for (const clause of query.split(/\s+AND\s+/i)) {
    const meta = clause.match(/^metadata\["([^"]+)"\]:"((?:[^"\\]|\\.)*)"$/);
    if (meta) {
      const want = meta[2]!.replace(/\\(.)/g, "$1").toLowerCase();
      tests.push(
        (pi) =>
          String((pi.metadata as Record<string, string>)[meta[1]!] ?? "").toLowerCase() === want,
      );
      continue;
    }
    const created = clause.match(/^created(>=|<=|>|<|:)(\d+)$/);
    if (!created) return null;
    const n = Number(created[2]);
    const c = (pi: Obj) => Number(pi.created);
    tests.push(
      {
        ">=": (pi: Obj) => c(pi) >= n,
        "<=": (pi: Obj) => c(pi) <= n,
        ">": (pi: Obj) => c(pi) > n,
        "<": (pi: Obj) => c(pi) < n,
        ":": (pi: Obj) => c(pi) === n,
      }[created[1]!]!,
    );
  }
  return (pi) => tests.every((t) => t(pi));
}

class StripeDriver implements GatewayDriver {
  readonly fake = new FakeStripe();
  readonly forgedStatus = 400;
  readonly chargeOp = "charge";
  readonly refundOp = "refund";
  readonly lookupOp = "search";
  readonly errors = {
    conflict: {
      status: 409,
      body: {
        error: {
          type: "invalid_request_error",
          code: "idempotency_key_in_use",
          message: "There is currently another in-progress request using this Idempotent Key.",
        },
      },
    },
    rateLimited: {
      status: 429,
      body: {
        error: {
          type: "invalid_request_error",
          code: "rate_limit",
          message: "Too many requests hit the API too quickly.",
        },
      },
    },
    server: {
      status: 500,
      body: { error: { type: "api_error", message: "An unknown error occurred" } },
    },
    refundRefused: {
      status: 400,
      body: {
        error: {
          type: "invalid_request_error",
          code: "charge_already_refunded",
          message: "Charge has already been refunded.",
        },
      },
    },
  };
  private seq = 0;

  credentials(webhookSecret: string) {
    return {
      secret_key: "sk_test_conformance",
      webhook_secret: webhookSecret,
      publishable_key: "pk_test_conformance",
    };
  }
  token(kind: TokenKind) {
    return this.fake.pm(kind);
  }
  sign(_w: World, body: string, secret: string) {
    const t = now();
    return {
      "stripe-signature": `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`,
    };
  }

  event(type: string, object: unknown, apiVersion: string = STRIPE_API_VERSION): Body {
    const id = `evt_conf${String(++this.seq).padStart(10, "0")}${Date.now().toString(36)}`;
    return {
      body: JSON.stringify({
        id,
        object: "event",
        api_version: apiVersion,
        created: now(),
        type,
        data: { object },
        livemode: false,
        pending_webhooks: 1,
        request: { id: null, idempotency_key: null },
      }),
      eventIds: [id],
    };
  }
  pi(id: string) {
    const pi = this.fake.pis.get(id);
    if (!pi) throw new Error(`fake Stripe has no PaymentIntent ${id}`);
    return pi;
  }
  charge(piId: string) {
    return this.fake.charges.get(String(this.pi(piId).latest_charge))!;
  }

  collect() {
    return [];
  }
  paymentSucceeded(_w: World, piId: string) {
    const pi = this.pi(piId);
    Object.assign(pi, {
      status: "succeeded",
      amount_received: pi.amount,
      last_payment_error: null,
    });
    Object.assign(this.charge(piId), {
      status: "succeeded",
      paid: true,
      captured: true,
      amount_captured: pi.amount,
    });
    return [this.event("payment_intent.succeeded", { ...pi })];
  }
  paymentFailed(_w: World, piId: string) {
    const pi = this.pi(piId);
    const err = { type: "card_error", code: "card_declined", decline_code: "insufficient_funds" };
    Object.assign(pi, { status: "requires_payment_method", last_payment_error: err });
    Object.assign(this.charge(piId), { status: "failed", failure_code: "card_declined" });
    return [this.event("payment_intent.payment_failed", { ...pi })];
  }
  refundEvent(_w: World, _piId: string, refundId: string, state: RefundState) {
    const r = this.fake.refunds.get(refundId);
    if (!r) throw new Error(`fake Stripe has no refund ${refundId}`);
    if (state === "pending") return [this.event("refund.created", { ...r, status: "pending" })];
    r.status = state;
    if (state === "failed") {
      const ch = this.fake.charges.get(String(r.charge))!;
      ch.amount_refunded = Number(ch.amount_refunded) - Number(r.amount);
      Object.assign(r, { failure_reason: "lost_or_stolen_card" });
      return [this.event("refund.failed", { ...r })];
    }
    return [this.event("refund.updated", { ...r })];
  }
  dashboardRefund(_w: World, piId: string, amountMinor: bigint) {
    const r = this.fake.newRefund(this.pi(piId), Number(amountMinor), "succeeded", {});
    return {
      refundId: r.id,
      events: [
        this.event("refund.created", { ...r }),
        this.event("charge.refunded", { ...this.charge(piId) }),
      ],
    };
  }
  private dispute(piId: string): Obj {
    const ch = this.charge(piId);
    const d: Obj = {
      id: this.fake.id("dp_conf"),
      object: "dispute",
      amount: ch.amount,
      currency: ch.currency,
      charge: ch.id,
      payment_intent: piId,
      reason: "fraudulent",
      status: "needs_response",
      evidence_details: { due_by: now() + 7 * 86_400 },
      created: now(),
    };
    this.fake.disputes.set(d.id, d);
    return d;
  }
  private disputeEvent(d: Obj, type: string, status: string) {
    d.status = status;
    return this.event(type, { ...d });
  }
  disputeSteps(_w: World, piId: string, flow: "won" | "lost" | "win_after_loss"): DisputeStep[] {
    const d = this.dispute(piId);
    const won = (): DisputeStep => ({
      after: "won",
      bodies: [
        this.disputeEvent(d, "charge.dispute.closed", "won"),
        this.disputeEvent(d, "charge.dispute.funds_reinstated", "won"),
      ],
    });
    const lost = (): DisputeStep => ({
      after: "lost",
      bodies: [this.disputeEvent(d, "charge.dispute.closed", "lost")],
    });
    const steps: DisputeStep[] = [
      {
        after: "opened",
        bodies: [this.disputeEvent(d, "charge.dispute.created", "needs_response")],
      },
      {
        after: "withdrawn",
        bodies: [this.disputeEvent(d, "charge.dispute.funds_withdrawn", "needs_response")],
      },
    ];
    if (flow === "won") return [...steps, won()];
    if (flow === "lost") return [...steps, lost()];
    return [...steps, lost(), won()];
  }
  chargesOn(pmId: string) {
    return [...this.fake.pis.values()].filter((p) => p.payment_method === pmId).map((p) => p.id);
  }

  statusEvent(_w: World, st: DocumentedStatus, piId: string): Body[] {
    const pi = this.pi(piId);
    const ch = this.charge(piId);
    if (st.object === "payment_intent") {
      const type: Record<string, string> = {
        canceled: "payment_intent.canceled",
        processing: "payment_intent.processing",
        requires_action: "payment_intent.requires_action",
        requires_capture: "payment_intent.amount_capturable_updated",
        requires_confirmation: "payment_intent.created",
        requires_payment_method: "payment_intent.payment_failed",
        succeeded: "payment_intent.succeeded",
      };
      const extra =
        st.status === "requires_payment_method"
          ? {
              last_payment_error: {
                type: "card_error",
                code: "card_declined",
                decline_code: "generic_decline",
              },
            }
          : st.status === "requires_action"
            ? { next_action: { type: "use_stripe_sdk" } }
            : {};
      return [this.event(type[st.status]!, { ...pi, status: st.status, ...extra })];
    }
    if (st.object === "charge") {
      const type = {
        failed: "charge.failed",
        pending: "charge.pending",
        succeeded: "charge.succeeded",
      }[st.status]!;
      return [
        this.event(type, {
          ...ch,
          status: st.status,
          ...(st.status === "failed" ? { failure_code: "card_declined" } : {}),
        }),
      ];
    }
    if (st.object === "refund") {
      const r = this.fake.newRefund(pi, 500, st.status, {});
      const type =
        st.status === "pending"
          ? "refund.created"
          : st.status === "failed"
            ? "refund.failed"
            : "refund.updated";
      return [this.event(type, { ...r })];
    }
    const d = this.dispute(piId);
    const type = ["won", "lost", "warning_closed", "prevented"].includes(st.status)
      ? "charge.dispute.closed"
      : st.status === "under_review" || st.status === "warning_under_review"
        ? "charge.dispute.updated"
        : "charge.dispute.created";
    return [this.disputeEvent(d, type, st.status)];
  }
}

const status = (
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

/** A recorded 2020-03-02 event, re-pointed at this run's objects. */
function oldVersion(
  d: StripeDriver,
  key: keyof typeof versions.v2020,
  object: Record<string, unknown>,
): Body {
  const rec = structuredClone(versions.v2020[key]) as {
    type: string;
    data: { object: Record<string, unknown> };
  };
  return d.event(rec.type, { ...rec.data.object, ...object }, "2020-03-02");
}

export const stripeFixture: GatewayFixture = {
  key: "stripe",
  currency: "USD",
  docs: [
    {
      id: "pi-status",
      url: SPEC,
      read: READ,
      check: {
        kind: "openapi-enum",
        path: ["components", "schemas", "payment_intent", "properties", "status", "enum"],
      },
    },
    {
      id: "charge-status",
      url: SPEC,
      read: READ,
      check: {
        kind: "openapi-enum",
        path: ["components", "schemas", "charge", "properties", "status", "enum"],
      },
    },
    {
      id: "refund-status",
      url: SPEC,
      read: READ,
      check: {
        kind: "openapi-text",
        path: ["components", "schemas", "refund", "properties", "status", "description"],
      },
    },
    {
      id: "dispute-status",
      url: SPEC,
      read: READ,
      check: {
        kind: "openapi-enum",
        path: ["components", "schemas", "dispute", "properties", "status", "enum"],
      },
    },
  ],
  statuses: [
    status("payment_intent", "canceled", "pi-status", ["intent.voided"]),
    status("payment_intent", "processing", "pi-status", {
      none: "A debit in flight; its verdict arrives as succeeded or payment_failed.",
    }),
    status("payment_intent", "requires_action", "pi-status", ["intent.requires_action"]),
    status("payment_intent", "requires_capture", "pi-status", ["intent.authorized"]),
    status("payment_intent", "requires_confirmation", "pi-status", ["intent.created"]),
    status("payment_intent", "requires_payment_method", "pi-status", ["charge.failed"]),
    status("payment_intent", "succeeded", "pi-status", ["charge.succeeded"]),
    status("charge", "failed", "charge-status", ["charge.failed"]),
    status("charge", "pending", "charge-status", ["charge.pending"]),
    status("charge", "succeeded", "charge-status", ["charge.succeeded"]),
    status("refund", "pending", "refund-status", ["refund.pending"]),
    status("refund", "requires_action", "refund-status", {
      none: "The refund waits on the customer; it lands or fails later.",
    }),
    status("refund", "succeeded", "refund-status", ["charge.refunded"]),
    status("refund", "failed", "refund-status", ["refund.failed"]),
    status("refund", "canceled", "refund-status", ["refund.failed"]),
    status("dispute", "warning_needs_response", "dispute-status", ["dispute.created"]),
    status("dispute", "warning_under_review", "dispute-status", ["dispute.created"]),
    status("dispute", "warning_closed", "dispute-status", ["dispute.closed"]),
    status("dispute", "needs_response", "dispute-status", ["dispute.created"]),
    status("dispute", "under_review", "dispute-status", ["dispute.created"]),
    status("dispute", "won", "dispute-status", ["dispute.won"]),
    status("dispute", "lost", "dispute-status", ["dispute.lost"]),
    status("dispute", "prevented", "dispute-status", ["dispute.closed"]),
  ],
  na: {
    "S6.after-failure": `A declined PaymentIntent "returns to requires_payment_method so that the payment can be retried", and only our engine confirms it again; the engine makes a new attempt instead: ${DOC.lifecycle} (read ${READ}).`,
    S9: `Stripe reports a debit returned after success as a dispute (charge.dispute.*), covered by S5: ${DOC.achDisputes} (read ${READ}).`,
  },
  limits: [
    { op: "charge", field: "header:idempotency-key", max: 255, source: DOC.idempotency },
    { op: "charge", field: `metadata[${STRIPE_OWNERSHIP_KEY}]`, max: 500, source: DOC.metadata },
    { op: "refund", field: "header:idempotency-key", max: 255, source: DOC.idempotency },
    { op: "refund", field: `metadata[${STRIPE_OWNERSHIP_KEY}]`, max: 500, source: DOC.metadata },
  ],
  currencyAmounts: [
    { currency: "JPY", minor: 500n, sent: 500, source: DOC.currencies },
    // "to charge 5 ISK, provide an amount value of 500"; ISK is zero-decimal in our table.
    { currency: "ISK", minor: 5n, sent: 500, source: DOC.currencies },
    // The same special case: "to charge 5 UGX, provide an amount value of 500".
    { currency: "UGX", minor: 5n, sent: 500, source: DOC.currencies },
  ],
  driver: () => new StripeDriver(),
  extraRows: [
    {
      scenario: "S12",
      id: "S12.stale-signed-refused",
      title: "a delivery signed with the right secret but an expired timestamp is refused",
      async run({ world }) {
        // Stripe signs each attempt afresh: https://docs.stripe.com/webhooks#preventing-replay-attacks
        const w = await world("s12stale");
        const d = w.driver as StripeDriver;
        const b = await w.collected();
        const r = d.dashboardRefund(w, b.chargeId, 1000n);
        const body = r.events[0]!.body;
        const t = now() - STRIPE_WEBHOOK_TOLERANCE_S - 60;
        const v1 = createHmac("sha256", w.secret).update(`${t}.${body}`).digest("hex");
        const res = await w.app.inject({
          method: "POST",
          url: `/v1/gateway_webhooks/stripe?id=${w.account.publicId}`,
          headers: {
            "content-type": "application/json",
            host: new URL(w.notificationUrl).host,
            "stripe-signature": `t=${t},v1=${v1}`,
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
      scenario: "S7",
      id: "S7.locate-search-refused",
      title: "a lost charge is found through the list API where Stripe refuses search (India)",
      async run({ world }) {
        // Search "isn't available to businesses in India": ${DOC.search}. The refusal's
        // exact body is not measured; the adapter falls back on any 4xx refusal.
        const w = await world("s7s");
        const d = w.driver as StripeDriver;
        const cash0 = await w.cash();
        d.fake.inject("charge", { kind: "network", afterCreate: true }, 6);
        let b: Billed;
        try {
          b = await w.bill();
        } finally {
          d.fake.clearFaults();
        }
        d.fake.inject(
          "search",
          {
            kind: "http",
            status: 400,
            body: { error: { type: "invalid_request_error", message: "Search is not available." } },
          },
          6,
        );
        try {
          await runWithClockScope({ onlyBusinessId: w.biz.id }, () =>
            sweepStalePendingCharges(new Date(Date.now() + 15 * 60_000)),
          );
        } finally {
          d.fake.clearFaults();
        }
        const after = await w.reload(b);
        const listed = d.fake.callsOf("list_charges").length;
        return {
          pass:
            b.txnStatus === "timeout" &&
            after.txnStatus === "succeeded" &&
            !!after.chargeId &&
            listed > 0 &&
            (await w.cash()) === cash0 + AMOUNT,
          detail: `lost ${b.txnStatus}; after sweep ${after.txnStatus} id ${after.chargeId || "none"} list calls ${listed} cash ${(await w.cash()) - cash0}`,
        };
      },
    },
    {
      scenario: "S13",
      id: "S13.old-version-refund",
      title: "a 2020-03-02 charge.refunded books the refund once, read at our version",
      async run({ world }) {
        const w = await world("s13r");
        const d = w.driver as StripeDriver;
        const b = await w.collected();
        const cash0 = await w.cash();
        const r = d.fake.newRefund(d.pi(b.chargeId), 2500, "succeeded", {});
        const ch = d.charge(b.chargeId);
        await w.deliver(
          oldVersion(d, "charge.refunded#1", {
            id: ch.id,
            payment_intent: b.chargeId,
            amount: ch.amount,
            amount_refunded: 2500,
            refunds: { object: "list", data: [{ ...r }], has_more: false },
          }),
        );
        const n = await w.entries();
        await w.redeliver();
        return {
          pass: (await w.cash()) === cash0 - 2500n && (await w.entries()) === n,
          detail: `cash ${(await w.cash()) - cash0} (want -2500)`,
        };
      },
    },
    {
      scenario: "S13",
      id: "S13.old-version-unreadable",
      title:
        "an old-version event whose object cannot be read books nothing and asks for redelivery",
      async run({ world }) {
        const w = await world("s13u");
        const d = w.driver as StripeDriver;
        const b = await w.collected();
        const cash0 = await w.cash();
        d.fake.newRefund(d.pi(b.chargeId), 2000, "succeeded", {});
        const ch = d.charge(b.chargeId);
        const body = oldVersion(d, "charge.refunded#1", {
          id: ch.id,
          payment_intent: b.chargeId,
          amount: ch.amount,
          amount_refunded: 2000,
        });
        d.fake.inject(
          "read_object",
          { kind: "http", status: 500, body: { error: { type: "api_error" } } },
          6,
        );
        const first = await w.deliver(body);
        d.fake.clearFaults();
        const mid = await w.cash();
        const again = await w.redeliver();
        return {
          pass:
            first.status !== 200 &&
            mid === cash0 &&
            again.status === 200 &&
            (await w.cash()) === cash0 - 2000n,
          detail: `first ${first.status} cash ${mid - cash0}; redelivered ${again.status} cash ${(await w.cash()) - cash0}`,
        };
      },
    },
  ],
};
