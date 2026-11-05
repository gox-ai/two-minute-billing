/**
 * Mollie conformance fixtures. Renewals are SEPA Direct Debit `recurring` payments, which answer
 * `pending` (measured, `verify:mollie-live`); test-mode refunds also stay `pending` until moved.
 * Payment state arrives as classic webhooks (`id=tr_…`, unsigned, fetched back); refunds and
 * chargebacks as signed next-gen events. Every id is a same-shape fake.
 */
import { createHmac, randomUUID } from "node:crypto";
import { refundPayment, RefundError } from "@/modules/refunds/service";
import { sweepStalePendingCharges } from "@/modules/payments/stale-pending";
import { pollGatewaySettlementReports } from "@/modules/gateway/settlement-report";
import { runWithClockScope } from "@/platform/clock";
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

const HOST = "https://mollie.conformance.invalid";
const READ = "2026-10-27";
const DOC = {
  payment: "https://docs.mollie.com/reference/get-payment.md",
  refund: "https://docs.mollie.com/reference/get-refund.md",
  chargeback: "https://docs.mollie.com/reference/get-chargeback.md",
  events: "https://docs.mollie.com/reference/webhooks-new.md",
  createPayment: "https://docs.mollie.com/reference/create-payment.md",
  createRefund: "https://docs.mollie.com/reference/create-refund.md",
};

type Money = { value: string; currency: string };
const money = (minor: number, currency = "EUR"): Money => ({
  value: (minor / 100).toFixed(2),
  currency,
});
const minorOf = (m: Money) => Math.round(Number(m.value) * 100);

interface Payment {
  id: string;
  status: string;
  sequenceType: string;
  method: string;
  amount: Money;
  customerId: string | null;
  mandateId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  paidAt?: string;
  failedAt?: string;
  authorizedAt?: string;
  details?: Record<string, string>;
}
interface Refund {
  id: string;
  paymentId: string;
  status: string;
  amount: Money;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}
interface Chargeback {
  id: string;
  paymentId: string;
  amount: Money;
  reason: { code: string; description: string };
  createdAt: string;
  reversedAt: string | null;
}

class FakeMollie extends FakeGateway {
  readonly host = HOST;
  readonly payments = new Map<string, Payment>();
  readonly refunds = new Map<string, Refund>();
  readonly chargebacks = new Map<string, Chargeback>();
  /** mdt_ → its customer ("" until a customer first reads it). */
  readonly mandates = new Map<string, string>();
  /** When each charge create reached us (S8 Retry-After row). */
  readonly chargeTimes: number[] = [];
  /** Idempotency-Key → [endpoint + parameters, status, body]. Kept one hour. */
  private readonly keys = new Map<string, [string, number, unknown]>();

  /** "Possibly higher than the payment amount"; counts every refund not failed or canceled. */
  refunded(p: Payment) {
    return [...this.refunds.values()]
      .filter((r) => r.paymentId === p.id && r.status !== "failed" && r.status !== "canceled")
      .reduce((t, r) => t + minorOf(r.amount), 0);
  }
  view(p: Payment) {
    const refunded = this.refunded(p);
    const cb = [...this.chargebacks.values()].filter((c) => c.paymentId === p.id);
    return {
      resource: "payment",
      mode: "test",
      ...p,
      amountRefunded: money(refunded, p.amount.currency),
      amountRemaining: money(minorOf(p.amount) - refunded, p.amount.currency),
      ...(cb.length
        ? { amountChargedBack: money(cb.reduce((t, c) => t + minorOf(c.amount), 0)) }
        : {}),
      _links: refunded ? { refunds: { href: `${HOST}/v2/payments/${p.id}/refunds` } } : {},
    };
  }
  newPayment(over: Partial<Payment> & Pick<Payment, "amount" | "metadata">): Payment {
    const p: Payment = {
      id: this.id("tr_C", 6),
      status: "pending",
      sequenceType: "recurring",
      method: "directdebit",
      customerId: null,
      mandateId: null,
      createdAt: new Date().toISOString(),
      ...over,
    };
    this.payments.set(p.id, p);
    return p;
  }
  newRefund(
    p: Payment,
    minor: number,
    status: string,
    metadata: Record<string, unknown> | null = null,
  ): Refund {
    const r: Refund = {
      id: this.id("re_C", 6),
      paymentId: p.id,
      status,
      amount: money(minor, p.amount.currency),
      metadata,
      createdAt: new Date().toISOString(),
    };
    this.refunds.set(r.id, r);
    return r;
  }
  newChargeback(p: Payment): Chargeback {
    const c: Chargeback = {
      id: this.id("chb_C", 6),
      paymentId: p.id,
      amount: { ...p.amount },
      reason: { code: "MD06", description: "Disputed authorisation" },
      createdAt: new Date().toISOString(),
      reversedAt: null,
    };
    this.chargebacks.set(c.id, c);
    return c;
  }

  /** "the same idempotency key … with different parameters … returns a 400 Bad Request". */
  private once(req: FakeRequest, make: () => [number, unknown]): Response {
    const key = req.headers["idempotency-key"];
    const shape = `${req.path}:${req.text}`;
    const seen = key ? this.keys.get(key) : undefined;
    if (seen && seen[0] !== shape)
      return json(400, {
        status: 400,
        title: "Bad Request",
        detail: "The idempotency key was used with different parameters",
      });
    if (seen) return json(seen[1], seen[2], { "idempotent-replayed": "true" });
    const [status, body] = make();
    if (key && status < 300) this.keys.set(key, [shape, status, body]);
    return json(status, body);
  }

  async route(req: FakeRequest): Promise<Response | null> {
    if (!req.path.startsWith("/v2/")) return null;
    const path = req.path.slice(3);
    const { method, body } = req;
    const notFound = () =>
      json(404, { status: 404, title: "Not Found", detail: "No resource found" });
    if (method === "POST" && path === "/customers")
      return this.once(req, () => [
        201,
        { resource: "customer", id: this.id("cst_C", 6), metadata: body.metadata },
      ]);
    const mdt = path.match(/^\/customers\/([^/]+)\/mandates\/([^/]+)$/);
    if (mdt && method === "GET") {
      const [c, m] = [mdt[1]!, mdt[2]!];
      const owner = this.mandates.get(m);
      if (owner === undefined || (owner && owner !== c)) return notFound();
      this.mandates.set(m, c);
      return json(200, {
        resource: "mandate",
        id: m,
        status: "valid",
        method: "directdebit",
        mandateReference: `CONF-${m.slice(-6)}`,
        customerId: c,
        details: {
          consumerName: "Conformance Payer",
          consumerAccount: "NL55INGB0000000000",
          consumerBic: "INGBNL2A",
        },
      });
    }
    if (method === "POST" && path === "/payments") {
      const meta = (body.metadata ?? {}) as Record<string, unknown>;
      const op = meta.tmbilling_kind === "charge" ? "charge" : "intent";
      if (op === "charge") this.chargeTimes.push(Date.now());
      return this.guarded(op, req, () =>
        this.once(req, () => {
          const p = this.newPayment({
            amount: body.amount as Money,
            metadata: meta,
            sequenceType: String(body.sequenceType ?? "oneoff"),
            customerId: (body.customerId as string) ?? null,
            mandateId: (body.mandateId as string) ?? null,
          });
          return [201, this.view(p)];
        }),
      );
    }
    if (method === "GET" && path === "/payments")
      return this.guarded("lookup", req, () =>
        json(200, {
          count: this.payments.size,
          _embedded: { payments: [...this.payments.values()].reverse().map((p) => this.view(p)) },
        }),
      );
    // List all refunds / chargebacks: newest first; `embed=payment` nests each one's payment.
    const all = path.match(/^\/(refunds|chargebacks)$/);
    if (all && method === "GET") {
      const embed = req.url.searchParams.get("embed") === "payment";
      const items = [...(all[1] === "refunds" ? this.refunds : this.chargebacks).values()]
        .reverse()
        .map((x) => ({
          resource: all[1] === "refunds" ? "refund" : "chargeback",
          ...x,
          ...(embed ? { _embedded: { payment: this.view(this.payments.get(x.paymentId)!) } } : {}),
        }));
      return json(200, { count: items.length, _embedded: { [all[1]!]: items } });
    }
    const pay = path.match(
      /^\/payments\/([^/]+)(?:\/(refunds|chargebacks|captures)(?:\/([^/]+))?)?$/,
    );
    if (pay) {
      const p = this.payments.get(pay[1]!);
      if (!p) return notFound();
      if (!pay[2] && method === "GET") return json(200, this.view(p));
      if (!pay[2] && method === "DELETE") {
        if (p.status !== "open" && p.status !== "pending")
          return json(422, {
            status: 422,
            title: "Unprocessable Entity",
            detail: "The payment cannot be canceled",
          });
        p.status = "canceled";
        return json(200, this.view(p));
      }
      if (pay[2] === "refunds" && method === "POST")
        return this.guarded("refund", req, () =>
          this.once(req, () => {
            const minor = minorOf(body.amount as Money);
            if (minor > minorOf(p.amount) - this.refunded(p))
              return [
                422,
                {
                  status: 422,
                  title: "Unprocessable Entity",
                  detail: "The amount is higher than the amount that is refundable",
                  field: "amount",
                },
              ];
            return [
              201,
              {
                resource: "refund",
                ...this.newRefund(
                  p,
                  minor,
                  "pending",
                  (body.metadata as Record<string, unknown>) ?? null,
                ),
              },
            ];
          }),
        );
      if (pay[2] === "refunds" && method === "GET") {
        if (pay[3]) {
          const r = this.refunds.get(pay[3]);
          return r ? json(200, { resource: "refund", ...r }) : notFound();
        }
        const list = [...this.refunds.values()].filter((r) => r.paymentId === p.id);
        return json(200, {
          count: list.length,
          _embedded: { refunds: list.map((r) => ({ resource: "refund", ...r })) },
        });
      }
      if (pay[2] === "captures" && method === "POST")
        return this.once(req, () => {
          if (p.status !== "authorized")
            return [
              422,
              { status: 422, title: "Unprocessable Entity", detail: "Nothing to capture" },
            ];
          p.status = "paid";
          p.paidAt = new Date().toISOString();
          return [201, { resource: "capture", id: this.id("cpt_C", 6), status: "succeeded" }];
        });
      if (pay[2] === "chargebacks" && method === "GET") {
        const list = [...this.chargebacks.values()].filter((c) => c.paymentId === p.id);
        return json(200, {
          count: list.length,
          _embedded: { chargebacks: list.map((c) => ({ resource: "chargeback", ...c })) },
        });
      }
    }
    return null;
  }
}

class MollieDriver implements GatewayDriver {
  readonly fake = new FakeMollie();
  readonly forgedStatus = 400;
  readonly chargeOp = "charge";
  readonly refundOp = "refund";
  readonly lookupOp = "lookup";
  readonly errors = {
    // "the API will respond to the second request with a 409 Conflict" (first still in progress).
    conflict: {
      status: 409,
      body: {
        status: 409,
        title: "Conflict",
        detail: "A request with this idempotency key is still being processed",
      },
    },
    rateLimited: {
      status: 429,
      body: { status: 429, title: "Too Many Requests", detail: "Rate limit exceeded" },
      headers: { "retry-after": "1" },
    },
    server: {
      status: 503,
      body: {
        status: 503,
        title: "Service Unavailable",
        detail: "The service is temporarily unavailable",
      },
    },
    refundRefused: {
      status: 422,
      body: {
        status: 422,
        title: "Unprocessable Entity",
        detail: "The amount is higher than the amount that is refundable",
        field: "amount",
      },
    },
  };

  credentials(webhookSecret: string) {
    return {
      api_key: "test_conformance00000000000000000001",
      webhook_secret: webhookSecret,
      api_base: `${HOST}/v2`,
    };
  }
  token(kind: TokenKind) {
    if (kind === "declines") return null;
    const m = this.fake.id("mdt_C", 6);
    this.fake.mandates.set(m, "");
    return m;
  }
  /** Classic calls are form posts with no signature; next-gen events are JSON, HMAC-signed. */
  sign(_w: World, body: string, secret: string): Record<string, string> {
    if (!body.startsWith("{")) return { "content-type": "application/x-www-form-urlencoded" };
    return {
      "x-mollie-signature": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
    };
  }

  /**
   * Mollie posts only an id and the adapter reads the state back, so a step's state change
   * must happen when that step is delivered: body → the change, run once on delivery.
   */
  private readonly onDelivery = new Map<string, () => void>();
  signBody(_w: World, body: string) {
    this.onDelivery.get(body)?.();
    this.onDelivery.delete(body);
    return body;
  }

  payment(id: string) {
    const p = this.fake.payments.get(id);
    if (!p) throw new Error(`fake Mollie has no payment ${id}`);
    return p;
  }
  /** The ids the adapter derives from a payment's state. */
  static stateId(p: Pick<Payment, "id" | "status">) {
    return p.status === "paid"
      ? `${p.id}:paid`
      : p.status === "open" || p.status === "pending"
        ? `${p.id}:pending`
        : `${p.id}:${p.status}`;
  }
  static refundId(r: Pick<Refund, "id" | "status">) {
    return r.status === "refunded"
      ? `${r.id}:refunded`
      : r.status === "failed" || r.status === "canceled"
        ? `${r.id}:${r.status}`
        : `${r.id}:pending`;
  }
  classic(p: Payment): Body {
    return { body: `id=${p.id}`, eventIds: [MollieDriver.stateId(p)] };
  }
  nextGen(type: string, entity: { id: string; paymentId: string }, eventIds: string[]): Body {
    const body = JSON.stringify({
      resource: "event",
      id: `event_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
      type,
      entityId: entity.id,
      createdAt: new Date().toISOString(),
      _embedded: {
        entity: { resource: type.split(".")[0], id: entity.id, paymentId: entity.paymentId },
      },
    });
    return { body, eventIds };
  }
  refundNote(r: Refund) {
    return this.nextGen(`refund.${r.status}`, r, [MollieDriver.refundId(r)]);
  }

  collect(w: World, id: string) {
    return this.paymentSucceeded(w, id);
  }
  paymentSucceeded(_w: World, id: string) {
    const p = this.payment(id);
    p.status = "paid";
    p.paidAt = new Date().toISOString();
    return [this.classic(p)];
  }
  paymentFailed(_w: World, id: string) {
    const p = this.payment(id);
    p.status = "failed";
    p.failedAt = new Date().toISOString();
    p.details = { bankReasonCode: "AM04", bankReason: "Insufficient funds" };
    return [this.classic(p)];
  }
  refundEvent(_w: World, _id: string, refundId: string, state: RefundState) {
    const r = this.fake.refunds.get(refundId.split(":")[0]!);
    if (!r) throw new Error(`fake Mollie has no refund ${refundId}`);
    r.status = { pending: "pending", succeeded: "refunded", failed: "failed" }[state];
    return [this.refundNote(r)];
  }
  dashboardRefund(_w: World, id: string, amountMinor: bigint) {
    const r = this.fake.newRefund(this.payment(id), Number(amountMinor), "queued");
    const queued = this.refundNote({ ...r });
    r.status = "refunded";
    return { refundId: `${r.id}:${id}`, events: [queued, this.refundNote(r)] };
  }
  chargebackNote(c: Chargeback, type: "chargeback.received" | "chargeback.reversed") {
    const ids =
      type === "chargeback.received"
        ? [`${c.id}:created`, `${c.id}:funds_withdrawn`]
        : [`${c.id}:reversed`];
    return this.nextGen(type, c, ids);
  }
  disputeSteps(
    _w: World,
    id: string,
    flow: "won" | "lost" | "win_after_loss",
  ): DisputeStep[] | null {
    if (flow !== "won") return null;
    const c = this.fake.newChargeback(this.payment(id));
    const reversed = this.chargebackNote(c, "chargeback.reversed");
    this.onDelivery.set(reversed.body, () => (c.reversedAt = new Date().toISOString()));
    return [
      { after: "withdrawn", bodies: [this.chargebackNote(c, "chargeback.received")] },
      { after: "won", bodies: [reversed] },
    ];
  }
  chargesOn(mandateId: string) {
    return [...this.fake.payments.values()]
      .filter((p) => p.mandateId === mandateId && p.metadata.tmbilling_kind === "charge")
      .map((p) => p.id);
  }

  statusEvent(_w: World, st: DocumentedStatus, id: string): Body[] {
    const p = this.payment(id);
    if (st.object === "refund") return [this.refundNote(this.fake.newRefund(p, 500, st.status))];
    if (st.object === "event") {
      const c = this.fake.newChargeback(p);
      if (st.status === "chargeback.reversed") c.reversedAt = new Date().toISOString();
      return [this.chargebackNote(c, st.status as "chargeback.received" | "chargeback.reversed")];
    }
    if (st.status === "authorized") {
      // A pay-later method on a hosted one-off ("Pay now") stays authorized until captured.
      const one = this.fake.newPayment({
        amount: { ...p.amount },
        metadata: { tmbilling_kind: "payment", tmbilling_ref: `pr_${p.id}` },
        sequenceType: "oneoff",
        method: "klarna",
        status: "authorized",
        authorizedAt: new Date().toISOString(),
      });
      return [this.classic(one)];
    }
    p.status = st.status;
    if (st.status === "failed" || st.status === "canceled" || st.status === "expired")
      p.failedAt = new Date().toISOString();
    return [this.classic(p)];
  }
}

const pay = (status: string, expect: DocumentedStatus["expect"]): DocumentedStatus => ({
  object: "payment",
  status,
  doc: "payment-status",
  expect,
});
const ref = (status: string, expect: DocumentedStatus["expect"]): DocumentedStatus => ({
  object: "refund",
  status,
  doc: "refund-status",
  expect,
});
/** The clock's gateway passes `ms` from now: the stale-pending sweep, then the settlement poll. */
const later = (w: World, ms: number) =>
  runWithClockScope({ onlyBusinessId: w.biz.id }, async () => {
    const at = new Date(Date.now() + ms);
    await sweepStalePendingCharges(at);
    await pollGatewaySettlementReports(at);
  });

export const mollieFixture: GatewayFixture = {
  key: "mollie",
  currency: "EUR",
  docs: [
    { id: "payment-status", url: DOC.payment, read: READ, check: { kind: "page" } },
    { id: "refund-status", url: DOC.refund, read: READ, check: { kind: "page" } },
    { id: "chargeback-events", url: DOC.events, read: READ, check: { kind: "page" } },
  ],
  statuses: [
    pay("open", ["charge.pending"]),
    pay("pending", ["charge.pending"]),
    // Pay-later on a hosted one-off: "will have this status for as long as new captures can be created".
    pay("authorized", ["intent.authorized"]),
    pay("paid", ["charge.succeeded"]),
    pay("canceled", ["charge.failed"]),
    pay("expired", ["charge.failed"]),
    pay("failed", ["charge.failed"]),
    ref("queued", ["refund.pending"]),
    ref("pending", ["refund.pending"]),
    ref("processing", ["refund.pending"]),
    ref("refunded", ["charge.refunded"]),
    ref("failed", ["refund.failed"]),
    ref("canceled", ["refund.failed"]),
    // A chargeback has no status field; these two events are its whole life.
    {
      object: "event",
      status: "chargeback.received",
      doc: "chargeback-events",
      expect: ["dispute.created", "dispute.funds_withdrawn"],
    },
    {
      object: "event",
      status: "chargeback.reversed",
      doc: "chargeback-events",
      expect: ["dispute.funds_reinstated"],
    },
  ],
  na: {
    "S5.lost": `A Mollie chargeback has no status or verdict, only \`reversedAt\` (${DOC.chargeback}, read ${READ}); an operator records the outcome (\`disputeFinalState: false\`).`,
    "S5.win_after_loss": "No lost verdict to win after (see S5.lost).",
    "S6.after-failure": `\`payment.failed\`: "Payment has failed. Definitive status.": ${DOC.events} (read ${READ}).`,
  },
  limits: [
    { op: "charge", field: "description", max: 255, source: DOC.createPayment },
    { op: "refund", field: "description", max: 255, source: DOC.createRefund },
  ],
  driver: () => new MollieDriver(),
  extraRows: [
    {
      scenario: "S3",
      id: "S3.mixed-pending-dashboard",
      title:
        "a dashboard refund booked while another is pending, then that one fails: only the first stays booked",
      async run({ world }) {
        const w = await world("s3mix");
        const d = w.driver as MollieDriver;
        const b = await w.collected();
        const cash0 = await w.cash();
        const p = d.payment(b.chargeId);
        const done = d.fake.newRefund(p, 3000, "refunded");
        const waiting = d.fake.newRefund(p, 2000, "pending");
        await w.deliver(d.refundNote(done));
        waiting.status = "failed";
        await w.deliver(d.refundNote(waiting));
        return {
          pass: (await w.cash()) === cash0 - 3000n,
          detail: `cash ${(await w.cash()) - cash0} (want -3000)`,
        };
      },
    },
    {
      scenario: "S3",
      id: "S3.catch-up-after-retries",
      title:
        "a dashboard refund whose webhook Mollie gave up on (10 tries in 26 h) is still booked",
      async run({ world }) {
        const w = await world("s3late");
        const d = w.driver as MollieDriver;
        const b = await w.collected();
        const cash0 = await w.cash();
        d.fake.newRefund(d.payment(b.chargeId), 2500, "refunded");
        await later(w, 27 * 3_600_000);
        return {
          pass: (await w.cash()) === cash0 - 2500n,
          detail: `cash ${(await w.cash()) - cash0} after the sweeps (want -2500)`,
        };
      },
    },
    {
      scenario: "S5",
      id: "S5.reversal-without-webhook",
      title: "a chargeback reversal, which no classic webhook announces, is found and credited",
      async run({ world }) {
        const w = await world("s5rev");
        const d = w.driver as MollieDriver;
        const b = await w.collected();
        const cash0 = await w.cash();
        const c = d.fake.newChargeback(d.payment(b.chargeId));
        await w.deliver(d.chargebackNote(c, "chargeback.received"));
        c.reversedAt = new Date().toISOString();
        await later(w, 27 * 3_600_000);
        return {
          pass: (await w.cash()) === cash0,
          detail: `cash ${(await w.cash()) - cash0} (want 0)`,
        };
      },
    },
    {
      scenario: "S8",
      id: "S8.refund-409",
      title: "a refund answered 409 (the first request still in progress) is not reported refused",
      async run({ world }) {
        const w = await world("s8r409");
        const d = w.driver as MollieDriver;
        const b = await w.collected();
        d.fake.inject("refund", { kind: "http", ...d.errors.conflict, afterCreate: true }, 6);
        let refused = false;
        try {
          await refundPayment({
            organizationId: w.org.id,
            businessId: w.biz.id,
            paymentPublicId: b.paymentPublicId!,
            amountMinor: 4000,
          });
        } catch (e) {
          refused = e instanceof RefundError;
        } finally {
          d.fake.clearFaults();
        }
        const made = [...d.fake.refunds.values()].filter((r) => r.paymentId === b.chargeId).length;
        return { pass: !refused, detail: `refused=${refused}; refunds Mollie made ${made}` };
      },
    },
    {
      scenario: "S8",
      id: "S8.retry-after",
      title: "a 429 is retried only after the Retry-After it names",
      async run({ world }) {
        const w = await world("s8ra");
        const d = w.driver as MollieDriver;
        d.fake.chargeTimes.length = 0;
        d.fake.inject(
          "charge",
          {
            kind: "http",
            status: 429,
            body: d.errors.rateLimited.body,
            headers: { "retry-after": "1" },
          },
          1,
        );
        await w.bill().finally(() => d.fake.clearFaults());
        const [t1, t2] = d.fake.chargeTimes;
        const gap = t1 != null && t2 != null ? t2 - t1 : -1;
        return { pass: gap >= 1000, detail: `second attempt after ${gap} ms (Retry-After: 1)` };
      },
    },
    {
      scenario: "S9",
      id: "S9.return-and-chargeback",
      title:
        "a SEPA return that shows as both a failed payment and a chargeback takes the money once",
      async run({ world }) {
        const w = await world("s9ret");
        const d = w.driver as MollieDriver;
        const b = await w.collected();
        const cash0 = await w.cash();
        const p = d.payment(b.chargeId);
        const c = d.fake.newChargeback(p);
        await w.deliver(d.paymentFailed(w, p.id));
        await w.deliver(d.chargebackNote(c, "chargeback.received"));
        return {
          pass: (await w.cash()) === cash0 - b.amountMinor,
          detail: `cash ${(await w.cash()) - cash0} (want -${b.amountMinor})`,
        };
      },
    },
    {
      scenario: "S12",
      id: "S12.unknown-classic-id",
      title: "a classic call naming a payment Mollie does not know under our key records nothing",
      async run({ world }) {
        const w = await world("s12id");
        const id = "tr_CFORGED00001";
        const res = await w.deliver({ body: `id=${id}`, eventIds: [`${id}:paid`] });
        const rows = await w.eventRows([`${id}:paid`]);
        return {
          pass: res.status === 200 && rows.length === 0,
          detail: `status ${res.status} rows ${rows.length}`,
        };
      },
    },
    {
      scenario: "S13",
      id: "S13.next-gen-payment-event",
      title: "a signed next-gen payment.paid event books like the classic call",
      async run({ world }) {
        const w = await world("s13ng");
        const d = w.driver as MollieDriver;
        const b = await w.bill();
        const p = d.payment(b.chargeId);
        p.status = "paid";
        p.paidAt = new Date().toISOString();
        await w.deliver(d.nextGen("payment.paid", { id: p.id, paymentId: p.id }, [`${p.id}:paid`]));
        const after = await w.reload(b);
        return { pass: after.txnStatus === "succeeded", detail: `txn ${after.txnStatus}` };
      },
    },
  ],
};
