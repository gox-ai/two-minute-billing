/**
 * Checkout.com conformance fixtures. Payment and event shapes follow the offline suite
 * (`verify:checkoutcom`) and the API spec; every id is a same-shape fake. The fake owns the
 * account host the adapter builds from `api_prefix`, which is never reached.
 */
import { createHmac, randomUUID } from "node:crypto";
import { refundPayment, RefundError } from "@/modules/refunds/service";
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

const PREFIX = "conf0001";
const HOST = `https://${PREFIX}.api.sandbox.checkout.com`;
const READ = "2026-10-27";
const SPEC = "https://api-reference.checkout.com/v1/swagger.json";
const DOC = {
  events: "https://www.checkout.com/docs/developer-resources/webhooks/webhook-event-types",
  // Flow's `googlepay`; the payment's source is `card` with `card_wallet_type` (read 2026-10-28).
  googlePay: "https://www.checkout.com/docs/payments/add-payment-methods/google-pay/web",
  idempotency: "https://www.checkout.com/docs/developer-resources/api/idempotency",
  amount: "https://www.checkout.com/docs/resources/calculating-the-amount",
};

type Obj = Record<string, unknown> & { id: string };
interface Action {
  id: string;
  type: "Authorization" | "Card Verification" | "Capture" | "Refund" | "Void";
  amount: number;
  approved?: boolean;
  response_code?: string;
  processed_on: string;
}
interface Payment extends Obj {
  status: string;
  approved: boolean;
  amount: number;
  currency: string;
  source: Obj;
  metadata: Record<string, unknown>;
  actions: Action[];
}

class FakeCheckoutcom extends FakeGateway {
  readonly host = HOST;
  readonly customers = new Map<string, Obj>();
  readonly instruments = new Map<string, Obj>();
  readonly payments = new Map<string, Payment>();
  /** Hosted Payments Page sessions by `reference`. */
  readonly pages = new Map<string, Obj>();
  /** Cko-Idempotency-Key → the first 2xx answer (status, body). Only 2xx answers are kept. */
  private readonly keys = new Map<string, [number, unknown]>();

  action(p: Payment, type: Action["type"], amount: number, approved?: boolean): Action {
    const a: Action = {
      id: this.id("act_conf", 16),
      type,
      amount,
      ...(approved !== undefined ? { approved } : {}),
      processed_on: new Date().toISOString(),
    };
    p.actions.push(a);
    return a;
  }

  totalRefunded(p: Payment) {
    return p.actions
      .filter((a) => a.type === "Refund" && a.approved === true)
      .reduce((t, a) => t + a.amount, 0);
  }

  private view(p: Payment) {
    const { actions: _a, ...rest } = p;
    return { ...rest, balances: { total_refunded: this.totalRefunded(p) } };
  }

  private replayed(req: FakeRequest, make: () => [number, unknown]): Response {
    const key = req.headers["cko-idempotency-key"];
    const seen = key ? this.keys.get(`${req.path}:${key}`) : undefined;
    if (seen) return json(seen[0], seen[1], { "cko-idempotency-replayed": "true" });
    const [status, body] = make();
    if (key && status < 300) this.keys.set(`${req.path}:${key}`, [status, body]);
    return json(status, body);
  }

  newPayment(over: {
    amount: number;
    currency: string;
    source: Obj;
    metadata: Record<string, unknown>;
    status: string;
    customer?: string;
    reference?: string;
  }): Payment {
    const p: Payment = {
      id: this.id("pay_conf", 16),
      status: over.status,
      approved: over.status !== "Declined",
      amount: over.amount,
      currency: over.currency,
      reference: over.reference,
      source: over.source,
      customer: over.customer ? { id: over.customer } : undefined,
      metadata: over.metadata,
      requested_on: new Date().toISOString(),
      actions: [],
    };
    this.payments.set(p.id, p);
    return p;
  }

  async route(req: FakeRequest): Promise<Response | null> {
    const { method, path, body } = req;
    if (method === "POST" && path === "/customers") {
      const c: Obj = { id: this.id("cus_conf", 16), email: body.email, metadata: body.metadata };
      this.customers.set(c.id, c);
      return json(201, { id: c.id });
    }
    const cus = path.match(/^\/customers\/([^/]+)$/);
    if (cus && method === "GET") {
      const c = this.customers.get(decodeURIComponent(cus[1]!));
      return c ? json(200, c) : json(404, {});
    }
    if (cus && method === "PATCH") return json(204, {});
    if (method === "POST" && path === "/payments") {
      const meta = (body.metadata ?? {}) as Record<string, unknown>;
      const op =
        meta.tmbilling_kind === "setup"
          ? "verify"
          : meta.tmbilling_kind === "intent"
            ? "authorize"
            : "charge";
      return this.guarded(op, req, () => this.replayed(req, () => this.createPayment(body, meta)));
    }
    // A Hosted Payments Page: `id` and `_links.redirect.href` (HostedPaymentsResponse).
    if (method === "POST" && path === "/hosted-payments")
      return this.guarded("hosted_page", req, () => {
        const page: Obj = { ...body, id: this.id("hpp_conf", 12) };
        this.pages.set(String(body.reference), page);
        return json(201, {
          id: page.id,
          reference: body.reference,
          _links: { redirect: { href: `https://pay.sandbox.checkout.com/page/${page.id}` } },
        });
      });
    // "Get payment lists": search by reference; 404 "Payment not found" when nothing matches.
    if (method === "GET" && path === "/payments")
      return this.guarded("lookup", req, () => {
        const ref = req.url.searchParams.get("reference");
        const all = [...this.payments.values()].filter((p) => p.reference === ref).reverse();
        const skip = Number(req.url.searchParams.get("skip") ?? 0);
        const limit = Number(req.url.searchParams.get("limit") ?? 10);
        if (!all.length) return json(404, {});
        return json(200, {
          limit,
          skip,
          total_count: all.length,
          data: all.slice(skip, skip + limit).map((p) => this.view(p)),
        });
      });
    const sub = path.match(/^\/payments\/([^/]+)(?:\/(actions|refunds|captures|voids))?$/);
    if (sub) {
      const p = this.payments.get(decodeURIComponent(sub[1]!));
      if (!p) return json(404, {});
      if (method === "GET" && !sub[2]) return json(200, this.view(p));
      if (method === "GET" && sub[2] === "actions") return json(200, [...p.actions].reverse());
      if (method === "POST" && sub[2] === "refunds")
        return this.guarded("refund", req, () =>
          this.replayed(req, () => {
            const amount =
              body.amount == null ? p.amount - this.totalRefunded(p) : Number(body.amount);
            const a = this.action(p, "Refund", amount);
            return [202, { action_id: a.id, reference: body.reference }];
          }),
        );
      if (method === "POST" && sub[2] === "captures")
        return this.replayed(req, () => [
          202,
          { action_id: this.action(p, "Capture", Number(body.amount ?? p.amount), true).id },
        ]);
      if (method === "POST" && sub[2] === "voids")
        return this.replayed(req, () => {
          p.status = "Voided";
          return [202, { action_id: this.action(p, "Void", p.amount, true).id }];
        });
    }
    const ins = path.match(/^\/instruments\/([^/]+)$/);
    if (ins) {
      const i = this.instruments.get(decodeURIComponent(ins[1]!));
      if (!i) return json(404, {});
      if (method === "DELETE") {
        this.instruments.delete(i.id);
        return new Response(null, { status: 204 });
      }
      return json(200, i);
    }
    return null;
  }

  private createPayment(
    body: Record<string, unknown>,
    meta: Record<string, unknown>,
  ): [number, unknown] {
    const src = body.source as Obj & { type?: string; token?: string };
    const customer = (body.customer as { id?: string } | undefined)?.id;
    let instrument: Obj | undefined;
    if (src.type === "token") {
      instrument = {
        id: this.id("src_conf", 16),
        type: "card",
        scheme: "Visa",
        last4: "4242",
        expiry_month: 12,
        expiry_year: 2034,
        fingerprint: `fp${String(src.token).slice(-12)}`,
        card_type: "CREDIT",
        customer: { id: customer },
      };
      this.instruments.set(instrument.id, instrument);
    } else instrument = this.instruments.get(String(src.id));
    if (!instrument)
      return [
        422,
        {
          request_id: "0HLCONF00001",
          error_type: "request_invalid",
          error_codes: ["source_id_invalid"],
        },
      ];
    const verify = Number(body.amount ?? 0) === 0;
    const p = this.newPayment({
      amount: Number(body.amount ?? 0),
      currency: String(body.currency),
      source: { id: instrument.id, type: "card", scheme: "Visa", last4: "4242" },
      metadata: meta,
      customer,
      reference: String(body.reference ?? ""),
      status: verify ? "Card Verified" : "Authorized",
    });
    this.action(p, verify ? "Card Verification" : "Authorization", p.amount, true);
    return [
      201,
      {
        id: p.id,
        action_id: p.actions[0]!.id,
        amount: p.amount,
        currency: p.currency,
        approved: true,
        status: p.status,
        response_code: "10000",
        response_summary: "Approved",
        reference: p.reference,
        customer: p.customer,
        source: { ...instrument },
        processed_on: new Date().toISOString(),
      },
    ];
  }
}

class CheckoutcomDriver implements GatewayDriver {
  readonly fake = new FakeCheckoutcom();
  readonly forgedStatus = 400;
  readonly chargeOp = "charge";
  readonly refundOp = "refund";
  readonly lookupOp = "lookup";
  readonly errors = {
    // "The other requests return a 409 Conflict with another request being processed response."
    conflict: { status: 409, body: { request_id: "0HLCONF00409" } },
    rateLimited: { status: 429, body: { request_id: "0HLCONF00429" } },
    // Documented on the refund path as "Bad gateway".
    server: { status: 502, body: {} },
    // The documented ValidationError shape; the code is illustrative.
    refundRefused: {
      status: 422,
      body: {
        request_id: "0HLCONF00422",
        error_type: "request_invalid",
        error_codes: ["amount_invalid"],
      },
    },
  };

  credentials(webhookSecret: string) {
    return {
      secret_key: "sk_sbox_conformance00000000000000000001",
      public_key: "pk_sbox_conformance00000000000000000001",
      processing_channel_id: "pc_conformance000000000000001",
      api_prefix: PREFIX,
      default_country: "US",
      entity_id: "ent_conformance000000000000000",
      webhook_secret: webhookSecret,
    };
  }
  token(kind: TokenKind) {
    return kind === "pays" ? `tok_conf${randomUUID().replace(/-/g, "").slice(0, 22)}` : null;
  }
  sign(_w: World, body: string, secret: string) {
    return { "cko-signature": createHmac("sha256", secret).update(body).digest("hex") };
  }

  payment(id: string) {
    const p = this.fake.payments.get(id);
    if (!p) throw new Error(`fake Checkout.com has no payment ${id}`);
    return p;
  }
  event(type: string, data: Record<string, unknown>): Body {
    const id = `evt_${randomUUID().replace(/-/g, "").slice(0, 26)}`;
    return {
      body: JSON.stringify({
        id,
        type,
        version: "1.0.36",
        created_on: new Date().toISOString(),
        data,
        _links: {},
      }),
      eventIds: [id],
    };
  }
  payData(p: Payment, extra: Record<string, unknown> = {}) {
    return {
      id: p.id,
      action_id: p.actions.at(-1)?.id,
      amount: p.amount,
      currency: p.currency,
      reference: p.reference,
      metadata: p.metadata,
      response_code: "10000",
      response_summary: "Approved",
      balances: { total_refunded: this.fake.totalRefunded(p) },
      ...extra,
    };
  }

  collect() {
    return [];
  }
  paymentSucceeded(_w: World, id: string) {
    const p = this.payment(id);
    p.status = "Captured";
    const a = this.fake.action(p, "Capture", p.amount, true);
    return [this.event("payment_captured", this.payData(p, { action_id: a.id }))];
  }
  paymentFailed(_w: World, id: string, late: boolean) {
    const p = this.payment(id);
    const decline = { response_code: "20005", response_summary: "Declined - Do Not Honour" };
    if (!late) {
      p.status = "Declined";
      p.approved = false;
      return [this.event("payment_declined", this.payData(p, decline))];
    }
    // An auto-capture the scheme refused after the authorization was booked.
    const a = this.fake.action(p, "Capture", p.amount, false);
    return [
      this.event("payment_capture_declined", this.payData(p, { action_id: a.id, ...decline })),
    ];
  }
  refundEvent(_w: World, id: string, refundId: string, state: RefundState) {
    const p = this.payment(id);
    const a = p.actions.find((x) => x.id === refundId);
    if (!a) throw new Error(`fake Checkout.com has no refund ${refundId}`);
    if (state === "succeeded") a.approved = true;
    if (state === "failed") a.approved = false;
    const type = {
      pending: "payment_refund_pending",
      succeeded: "payment_refunded",
      failed: "payment_refund_declined",
    }[state];
    return [this.event(type, this.payData(p, { action_id: a.id, amount: a.amount }))];
  }
  dashboardRefund(_w: World, id: string, amountMinor: bigint) {
    const p = this.payment(id);
    const a = this.fake.action(p, "Refund", Number(amountMinor));
    // Made in the dashboard: no metadata of ours on the action.
    const pending = this.event(
      "payment_refund_pending",
      this.payData(p, { action_id: a.id, amount: a.amount }),
    );
    a.approved = true;
    const done = this.event(
      "payment_refunded",
      this.payData(p, { action_id: a.id, amount: a.amount }),
    );
    return { refundId: a.id, events: [pending, done] };
  }
  disputeData(p: Payment, id: string) {
    return {
      id,
      payment_id: p.id,
      amount: p.amount,
      currency: p.currency,
      category: "fraudulent",
      reason_code: "10.4",
      evidence_required_by: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    };
  }
  disputeSteps(_w: World, id: string, flow: "won" | "lost" | "win_after_loss"): DisputeStep[] {
    const p = this.payment(id);
    const d = this.fake.id("dsp_conf", 16);
    const ev = (type: string) => this.event(type, this.disputeData(p, d));
    const steps: DisputeStep[] = [
      { after: "withdrawn", bodies: [ev("dispute_received"), ev("dispute_evidence_required")] },
    ];
    const won: DisputeStep = {
      after: "won",
      bodies: [ev("dispute_evidence_submitted"), ev("dispute_won")],
    };
    const lost: DisputeStep = { after: "lost", bodies: [ev("dispute_lost")] };
    if (flow === "won") return [...steps, won];
    if (flow === "lost") return [...steps, lost];
    return [
      ...steps,
      lost,
      {
        after: "won",
        bodies: [ev("dispute_arbitration_sent_to_scheme"), ev("dispute_arbitration_won")],
      },
    ];
  }
  chargesOn(sourceId: string) {
    return [...this.fake.payments.values()]
      .filter((p) => p.source.id === sourceId && p.metadata.tmbilling_kind === "charge")
      .map((p) => p.id);
  }

  statusEvent(_w: World, st: DocumentedStatus, id: string): Body[] {
    const p = this.payment(id);
    if (st.object === "event:dispute")
      return [this.event(st.status, this.disputeData(p, this.fake.id("dsp_conf", 16)))];
    if (
      st.status === "payment_refunded" ||
      st.status === "payment_refund_pending" ||
      st.status === "payment_refund_declined"
    ) {
      const a = this.fake.action(
        p,
        "Refund",
        500,
        st.status === "payment_refunded"
          ? true
          : st.status === "payment_refund_declined"
            ? false
            : undefined,
      );
      return [this.event(st.status, this.payData(p, { action_id: a.id, amount: 500 }))];
    }
    const declined = /declined/.test(st.status)
      ? { response_code: "20005", response_summary: "Declined - Do Not Honour" }
      : {};
    return [this.event(st.status, this.payData(p, declined))];
  }
}

const gw = (status: string, expect: DocumentedStatus["expect"]): DocumentedStatus => ({
  object: "event:gateway",
  status,
  doc: "events",
  expect,
});
const dsp = (status: string, expect: DocumentedStatus["expect"]): DocumentedStatus => ({
  object: "event:dispute",
  status,
  doc: "events",
  expect,
});
const APM_ONLY = "An alternative-payment-method event; this account takes cards only.";

/** The buyer pays the hosted page with Apple Pay: a held card payment carrying its reference. */
function payHostedPage(w: World, intentAtGateway: string) {
  const d = w.driver as CheckoutcomDriver;
  const reference = intentAtGateway.slice("ckoh_".length);
  const page = d.fake.pages.get(reference);
  if (!page) throw new Error(`fake Checkout.com has no hosted page ${reference}`);
  const source = {
    id: d.fake.id("src_conf", 16),
    type: "card",
    card_wallet_type: "applepay",
    scheme: "Visa",
    last4: "4242",
  };
  const p = d.fake.newPayment({
    amount: Number(page.amount),
    currency: String(page.currency),
    source,
    metadata: (page.metadata as Record<string, unknown>) ?? {},
    reference,
    status: "Authorized",
  });
  d.fake.action(p, "Authorization", p.amount, true);
  return { chargeId: p.id, bodies: [d.event("payment_approved", d.payData(p, { source }))] };
}

export const checkoutcomFixture: GatewayFixture = {
  key: "checkoutcom",
  currency: "USD",
  docs: [{ id: "events", url: DOC.events, read: READ, check: { kind: "page" } }],
  // Checkout.com reports state as webhook event types; every payment and dispute type on the page.
  statuses: [
    gw("payment_approved", ["charge.succeeded"]),
    gw("payment_authorization_increment_declined", {
      none: "We never increment an authorization.",
    }),
    gw("payment_authorization_incremented", { none: "We never increment an authorization." }),
    gw("payment_canceled", { none: APM_ONLY }),
    gw("payment_capture_declined", ["charge.failed"]),
    gw("payment_capture_pending", ["charge.pending"]),
    gw("payment_captured", ["charge.succeeded"]),
    gw("payment_compliance_review", {
      none: "A review notice; the payment's approved or declined event carries the verdict.",
    }),
    gw("payment_declined", ["charge.failed"]),
    gw("payment_expired", { none: APM_ONLY }),
    gw("payment_optimized", { none: "An Intelligent Acceptance report; no money moves." }),
    gw("payment_paid", { none: "A bank payout event; we make no payouts." }),
    gw("payment_pending", ["charge.pending"]),
    gw("payment_refund_declined", ["refund.failed"]),
    gw("payment_refund_pending", ["refund.pending"]),
    gw("payment_refunded", ["charge.refunded"]),
    gw("payment_retry_scheduled", {
      none: "We never request Checkout.com payment retries; the engine owns dunning.",
    }),
    gw("payment_returned", ["charge.reversed"]),
    gw("payment_void_declined", {
      none: "The hold stays authorized and lapses; nothing was booked for it.",
    }),
    // On a charge (booked paid at authorization) a void takes the payment back; on a hold
    // it is `intent.voided`. The status check delivers it on a charge.
    gw("payment_voided", ["charge.failed"]),
    gw("payment_instrument_verification_failed", {
      none: "An Instruments API check; we verify cards with a 0-amount payment.",
    }),
    gw("payment_instrument_verification_passed", {
      none: "An Instruments API check; we verify cards with a 0-amount payment.",
    }),
    dsp("dispute_received", ["dispute.created", "dispute.funds_withdrawn"]),
    dsp("dispute_evidence_required", ["dispute.created"]),
    dsp("dispute_evidence_submitted", ["dispute.created"]),
    dsp("dispute_evidence_acknowledged_by_scheme", ["dispute.created"]),
    dsp("dispute_arbitration_sent_to_scheme", ["dispute.created"]),
    dsp("dispute_arbitration_evidence_submitted", ["dispute.created"]),
    dsp("dispute_won", ["dispute.won"]),
    dsp("dispute_arbitration_won", ["dispute.won"]),
    dsp("dispute_lost", ["dispute.lost"]),
    dsp("dispute_arbitration_lost", ["dispute.lost"]),
    dsp("dispute_accepted", ["dispute.lost"]),
    dsp("dispute_expired", ["dispute.lost"]),
    // "If previously debited, the disputed amount is credited back to you."
    dsp("dispute_canceled", ["dispute.won"]),
    dsp("dispute_resolved", ["dispute.closed"]),
  ],
  na: {
    "S6.after-failure": `A declined Checkout.com authorization is final ("a rejection during authorization"); a retry is a new payment with a new id: ${DOC.events} (read ${READ}).`,
    S10: "Cards only: a card payment answers at once, so there is no pending debit to cancel.",
    S13: `One event shape: a workflow selects no payload version (add-workflow-request has name, active, conditions, actions only): ${SPEC} (read ${READ}).`,
  },
  limits: [
    { op: "charge", field: "reference", max: 80, source: SPEC },
    { op: "charge", field: "description", max: 100, source: SPEC },
    { op: "refund", field: "reference", max: 80, source: SPEC },
  ],
  // "For payment requests in which the currency is CLP … the last two digits of the amount must be 00":
  // CLP is not on the full-amount list, so it is sent ×100.
  currencyAmounts: [{ currency: "CLP", minor: 1000n, sent: 100_000, source: DOC.amount }],
  driver: () => new CheckoutcomDriver(),
  extraRows: [
    // https://www.checkout.com/docs/payments/accept-payments/accept-a-payment-on-a-hosted-page
    ...hostedApplePayRows({
      createOp: "hosted_page",
      intentPrefix: "ckoh_",
      methodUsed: "apple_pay",
      checkCreate(call, ref) {
        const b = call.body as Record<string, unknown>;
        const methods = JSON.stringify(b.allow_payment_methods);
        if (methods !== '["applepay"]') return `allow_payment_methods ${methods}`;
        if (b.reference !== `th-${ref}`) return `reference ${String(b.reference)}`;
        if ((b.metadata as Record<string, unknown>)?.tmbilling_ref !== ref)
          return "no ownership ref";
        if (b.amount !== Number(AMOUNT) || b.capture !== false) return "not a hold for the amount";
        if (String(b.reference).length > 30) return "reference over 30 characters (Amex)";
        return null;
      },
      pay: payHostedPage,
    }),
    {
      scenario: "S5",
      id: "S5.canceled-credits-back",
      title: "a dispute the issuer cancels after the debit credits the money back",
      async run({ world }) {
        const w = await world("s5cc");
        const d = w.driver as CheckoutcomDriver;
        const b = await w.collected();
        const cash0 = await w.cash();
        const p = d.payment(b.chargeId);
        const id = d.fake.id("dsp_conf", 16);
        await w.deliver(d.event("dispute_received", d.disputeData(p, id)));
        await w.deliver(d.event("dispute_canceled", d.disputeData(p, id)));
        const [cash, losses] = [await w.cash(), await w.bal("dispute_losses")];
        return {
          pass: cash === cash0 && losses === 0n,
          detail: `cash ${cash - cash0} losses ${losses} dispute ${(await w.dispute(id))?.status}`,
        };
      },
    },
    {
      scenario: "S8",
      id: "S8.refund-403-refused",
      title:
        'a refund answered 403 "Refund not allowed" is a refusal that releases the reservation',
      async run({ world }) {
        const w = await world("s8403");
        const d = w.driver as CheckoutcomDriver;
        const b = await w.collected();
        d.fake.inject(
          "refund",
          { kind: "http", status: 403, body: { request_id: "0HLCONF00403" } },
          6,
        );
        let err: unknown;
        try {
          await refundPayment({
            organizationId: w.org.id,
            businessId: w.biz.id,
            paymentPublicId: b.paymentPublicId!,
            amountMinor: 4000,
          });
        } catch (e) {
          err = e;
        } finally {
          d.fake.clearFaults();
        }
        const full = await refundPayment({
          organizationId: w.org.id,
          businessId: w.biz.id,
          paymentPublicId: b.paymentPublicId!,
        }).catch((e: Error) => e);
        const refused = err instanceof RefundError;
        return {
          pass: refused && !(full instanceof Error) && full.amountMinor === AMOUNT,
          detail: `first: ${refused ? "refused" : (err as Error)?.message}; full refund ${full instanceof Error ? full.message : full.amountMinor}`,
        };
      },
    },
    {
      scenario: "S13",
      id: "S13.googlepay-source",
      // DOC.googlePay; `source.card_wallet_type` is in the API reference's payment details.
      title: "a refund event for a Google Pay payment (card source, card_wallet_type) books once",
      async run({ world }) {
        const w = await world("s13gpay");
        const d = w.driver as CheckoutcomDriver;
        const b = await w.collected();
        const cash0 = await w.cash();
        const p = d.payment(b.chargeId);
        p.source = { ...p.source, type: "card", card_wallet_type: "googlepay" };
        const a = d.fake.action(p, "Refund", 1500, true);
        const body = d.event(
          "payment_refunded",
          d.payData(p, { action_id: a.id, amount: a.amount, source: p.source }),
        );
        await w.deliver(body);
        await w.deliver(body);
        return {
          pass: (await w.cash()) === cash0 - 1500n,
          detail: `cash ${(await w.cash()) - cash0} (want -1500)`,
        };
      },
    },
    {
      scenario: "S9",
      id: "S9.dashboard-void",
      title: "a dashboard void of an authorization we booked paid reverses the payment",
      async run({ world }) {
        const w = await world("s9void");
        const d = w.driver as CheckoutcomDriver;
        const b = await w.collected();
        const cash0 = await w.cash();
        const p = d.payment(b.chargeId);
        p.status = "Voided";
        const a = d.fake.action(p, "Void", p.amount, true);
        await w.deliver(d.event("payment_voided", d.payData(p, { action_id: a.id })));
        return {
          pass:
            (await w.cash()) === cash0 - b.amountMinor &&
            (await w.invoiceStatus(b.invoiceId)) !== "paid",
          detail: `cash ${(await w.cash()) - cash0} invoice ${await w.invoiceStatus(b.invoiceId)}`,
        };
      },
    },
  ],
};
