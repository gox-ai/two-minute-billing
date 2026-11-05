/**
 * GoCardless conformance fixtures. Payloads follow the shapes the sandbox delivered
 * (`verify:gocardless-engine`, measured 2026-10-25): every id below is a same-shape fake.
 */
import { createHmac } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { withTenant } from "@/platform/db";
import { refundPayment } from "@/modules/refunds/service";
import { paymentMethods, payments } from "@db/schema";
import { FakeGateway, json, type FakeRequest } from "../fake-http";
import { AMOUNT, invoiceOf, outcomeOf, sweptCancelBeforeWebhook, type World } from "../harness";
import type {
  Body,
  DocumentedStatus,
  ExtraRow,
  GatewayDriver,
  GatewayFixture,
  RefundState,
} from "../types";

const HOST = "https://gocardless.conformance.invalid";
const READ = "2026-10-27";
const DOC = {
  paymentEvents: "https://docs.gocardless.com/docs/api-reference/events/payment",
  refundEvents: "https://docs.gocardless.com/docs/api-reference/events/refund",
  limits: "https://docs.gocardless.com/docs/api-reference/limits",
  payment: "https://docs.gocardless.com/docs/api-reference/payment",
  payto: "https://docs.gocardless.com/docs/collect-payments/recurring-payments/payto",
  schemes: "https://docs.gocardless.com/docs/api-reference/schemes",
};

/** The schemes added after Bacs, SEPA and ACH: our method → scheme, currency, bank country. */
const EXTRA_SCHEMES = {
  au_becs_debit: { scheme: "becs", currency: "AUD", country: "AU" },
  nz_becs_debit: { scheme: "becs_nz", currency: "NZD", country: "NZ" },
  acss_debit: { scheme: "pad", currency: "CAD", country: "CA" },
  autogiro: { scheme: "autogiro", currency: "SEK", country: "SE" },
  betalingsservice: { scheme: "betalingsservice", currency: "DKK", country: "DK" },
  payto: { scheme: "pay_to", currency: "AUD", country: "AU" },
} as const;

interface GcPayment {
  id: string;
  created_at: string;
  status: string;
  amount: number;
  currency: string;
  amount_refunded: number;
  scheme: string;
  links: { mandate: string };
  metadata: Record<string, string>;
}
interface GcRefund {
  id: string;
  status: string;
  amount: number;
  links: { payment: string };
  metadata: Record<string, string>;
}

class FakeGoCardless extends FakeGateway {
  readonly host = HOST;
  readonly payments = new Map<string, GcPayment>();
  readonly refunds = new Map<string, GcRefund>();
  readonly mandates = new Map<string, Record<string, unknown>>();
  readonly banks = new Map<string, Record<string, unknown>>();
  /** Events the driver built, for `GET /events?payment=` (the adapter reads a failure's cause). */
  readonly events: { links: Record<string, string> }[] = [];
  /** Idempotency-Key → the resource it created. */
  private readonly keys = new Map<string, string>();

  /** A mandate on `scheme`; `ceiling` is a PayTo agreement's `max_amount_per_payment`. */
  mandate(scheme = "bacs", country = "GB", ceiling?: number): string {
    const id = this.id("MD", 8);
    const bank = this.id("BA", 8);
    this.mandates.set(id, {
      id,
      status: "active",
      scheme,
      reference: `REF-${id.slice(-4)}`,
      next_possible_charge_date: new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10),
      ...(ceiling != null ? { consent_parameters: { max_amount_per_payment: ceiling } } : {}),
      links: { customer_bank_account: bank },
    });
    this.banks.set(bank, {
      id: bank,
      account_number_ending: "11",
      bank_name: "TEST BANK",
      country_code: country,
    });
    return id;
  }

  private conflict(id: string) {
    return json(409, {
      error: {
        type: "invalid_state",
        code: 409,
        message: "A resource has already been created with this idempotency key",
        errors: [
          {
            reason: "idempotent_creation_conflict",
            message: "A resource has already been created with this idempotency key",
            links: { conflicting_resource_id: id },
          },
        ],
      },
    });
  }

  async route(req: FakeRequest): Promise<Response | null> {
    const { method, path } = req;
    const key = req.headers["idempotency-key"];
    const seen = key ? this.keys.get(`${path}:${key}`) : undefined;
    const body = req.body as Record<string, Record<string, unknown>>;
    if (method === "POST" && path === "/customers")
      return this.guarded("customer", req, () =>
        seen
          ? this.conflict(seen)
          : json(201, { customers: { id: this.remember(path, key, this.id("CU", 8)) } }),
      );
    if (method === "GET" && path.startsWith("/mandates/")) {
      const m = this.mandates.get(path.slice(10));
      return m ? json(200, { mandates: m }) : json(404, { error: { code: 404 } });
    }
    if (method === "GET" && path.startsWith("/customer_bank_accounts/")) {
      const b = this.banks.get(path.slice(24));
      return b ? json(200, { customer_bank_accounts: b }) : json(404, { error: { code: 404 } });
    }
    if (method === "POST" && path === "/payments")
      return this.guarded("charge", req, () => {
        if (seen) return this.conflict(seen);
        const p = body.payments!;
        const mandateId = String((p.links as Record<string, unknown>).mandate);
        const row: GcPayment = {
          id: this.id("PM", 8),
          created_at: new Date().toISOString(),
          status: "pending_submission",
          amount: Number(p.amount),
          currency: String(p.currency),
          amount_refunded: 0,
          scheme: String(this.mandates.get(mandateId)?.scheme ?? "bacs"),
          links: { mandate: mandateId },
          metadata: (p.metadata as Record<string, string>) ?? {},
        };
        this.payments.set(this.remember(path, key, row.id), row);
        return json(201, { payments: row });
      });
    const cancel = path.match(/^\/payments\/([^/]+)\/actions\/cancel$/);
    if (method === "POST" && cancel)
      return this.guarded("cancel_charge", req, () => {
        const p = this.payments.get(cancel[1]!);
        if (!p) return json(404, { error: { code: 404 } });
        if (p.status === "cancelled") return json(200, { payments: p });
        if (p.status !== "pending_submission")
          return json(422, {
            error: {
              type: "invalid_state",
              code: 422,
              errors: [{ reason: "cancellation_failed" }],
            },
          });
        p.status = "cancelled";
        return json(200, { payments: p });
      });
    // Newest first, with the documented filters and cursor:
    // https://docs.gocardless.com/docs/api-reference/payment (list payments).
    if (method === "GET" && path === "/payments")
      return this.guarded("lookup", req, () => {
        const q = req.url.searchParams;
        const at = (k: string) => (q.get(k) ? Date.parse(q.get(k)!) : undefined);
        const gte = at("created_at[gte]");
        const lte = at("created_at[lte]");
        const currency = q.get("currency");
        const limit = Number(q.get("limit") ?? 50);
        let rows = [...this.payments.values()]
          .reverse()
          .filter(
            (p) =>
              (gte == null || Date.parse(p.created_at) >= gte) &&
              (lte == null || Date.parse(p.created_at) <= lte) &&
              (!currency || p.currency === currency),
          );
        const after = q.get("after");
        if (after) rows = rows.slice(rows.findIndex((p) => p.id === after) + 1);
        const page = rows.slice(0, limit);
        return json(200, {
          payments: page,
          meta: {
            cursors: {
              before: null,
              after: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
            },
            limit,
          },
        });
      });
    if (method === "GET" && path.startsWith("/payments/")) {
      const p = this.payments.get(path.slice(10));
      return p ? json(200, { payments: p }) : json(404, { error: { code: 404 } });
    }
    if (method === "POST" && path === "/refunds")
      return this.guarded("refund", req, () => {
        if (seen) return this.conflict(seen);
        const r = body.refunds!;
        const pay = this.payments.get(String((r.links as Record<string, unknown>).payment));
        if (!pay) return json(404, { error: { code: 404 } });
        const amount = Number(r.amount);
        if (Number(r.total_amount_confirmation) !== pay.amount_refunded + amount)
          return json(422, {
            error: {
              type: "invalid_state",
              code: 422,
              errors: [
                { reason: "total_amount_confirmation_invalid", field: "total_amount_confirmation" },
              ],
            },
          });
        const row = this.refund(pay, amount, (r.metadata as Record<string, string>) ?? {});
        this.remember(path, key, row.id);
        return json(201, { refunds: row });
      });
    if (method === "GET" && path.startsWith("/refunds/")) {
      const r = this.refunds.get(path.slice(9));
      return r ? json(200, { refunds: r }) : json(404, { error: { code: 404 } });
    }
    if (method === "GET" && path === "/events") {
      // Only the per-payment read: the settlement poll must not replay every event.
      const payment = req.url.searchParams.get("payment");
      const rows = payment ? this.events.filter((e) => e.links.payment === payment).reverse() : [];
      return json(200, { events: rows, meta: { cursors: {} } });
    }
    if (method === "GET" && path === "/creditors")
      return json(200, { creditors: [{ id: "CR000000000001", country_code: "GB" }] });
    return null;
  }

  refund(pay: GcPayment, amount: number, metadata: Record<string, string>): GcRefund {
    const row: GcRefund = {
      id: this.id("RF", 8),
      status: "pending_submission",
      amount,
      links: { payment: pay.id },
      metadata,
    };
    pay.amount_refunded += amount;
    this.refunds.set(row.id, row);
    return row;
  }

  /** The key now names `id`: a repeat answers 409 `idempotent_creation_conflict`. */
  private remember(path: string, key: string | undefined, id: string): string {
    if (key) this.keys.set(`${path}:${key}`, id);
    return id;
  }
}

class GoCardlessDriver implements GatewayDriver {
  readonly fake = new FakeGoCardless();
  readonly forgedStatus = 498;
  readonly chargeOp = "charge";
  readonly refundOp = "refund";
  readonly lookupOp = "lookup";
  readonly rateLimitCreatesNothing = { source: DOC.limits };
  readonly errors = {
    // GoCardless's documented 409 on a create; here without the resource link, so the
    // adapter cannot read what the key made.
    conflict: {
      status: 409,
      body: {
        error: {
          type: "invalid_state",
          code: 409,
          errors: [{ reason: "idempotent_creation_conflict" }],
        },
      },
    },
    rateLimited: {
      status: 429,
      body: {
        error: {
          type: "invalid_api_usage",
          code: 429,
          errors: [{ reason: "rate_limit_exceeded" }],
        },
      },
      headers: { "ratelimit-reset": new Date(Date.now() + 1000).toUTCString() },
    },
    server: {
      status: 500,
      body: {
        error: { type: "gocardless", code: 500, errors: [{ reason: "internal_server_error" }] },
      },
    },
    refundRefused: {
      status: 422,
      body: {
        error: {
          type: "invalid_state",
          code: 422,
          errors: [{ reason: "available_refund_amount_insufficient" }],
        },
      },
    },
  };
  private seq = 0;
  /** The scheme the next `pays` instrument is set up on (extra-scheme rows). */
  nextScheme?: { scheme: string; country: string; ceiling?: number };

  credentials(webhookSecret: string) {
    return { access_token: "sandbox_conformance", webhook_secret: webhookSecret, api_base: HOST };
  }
  token(kind: "pays" | "declines" | "bank_debit") {
    if (kind !== "pays") return null;
    const next = this.nextScheme;
    return next ? this.fake.mandate(next.scheme, next.country, next.ceiling) : this.fake.mandate();
  }
  sign(_w: World, body: string, secret: string) {
    return { "webhook-signature": createHmac("sha256", secret).update(body).digest("hex") };
  }

  private event(
    resource_type: string,
    action: string,
    links: Record<string, string>,
    details: Record<string, unknown> = {},
    metadata: Record<string, string> = {},
  ): Body {
    const id = `EV${String(++this.seq).padStart(12, "0")}${Date.now().toString(36).toUpperCase()}`;
    const ev = {
      id,
      created_at: new Date().toISOString(),
      resource_type,
      action,
      links,
      details: { origin: "gocardless", ...details },
      resource_metadata: metadata,
    };
    this.fake.events.push(ev);
    return {
      body: JSON.stringify({
        events: [ev],
        meta: { webhook_id: `WB${String(this.seq).padStart(12, "0")}` },
      }),
      eventIds: [id],
    };
  }
  private pay(id: string) {
    const p = this.fake.payments.get(id);
    if (!p) throw new Error(`fake GoCardless has no payment ${id}`);
    return p;
  }
  private payEvent(id: string, action: string, details: Record<string, unknown> = {}) {
    return this.event("payments", action, { payment: id }, details, this.pay(id).metadata);
  }

  collect(_w: World, chargeId: string) {
    return this.paymentSucceeded(_w, chargeId);
  }
  paymentSucceeded(_w: World, chargeId: string) {
    this.pay(chargeId).status = "confirmed";
    return [this.payEvent(chargeId, "confirmed")];
  }
  paymentFailed(_w: World, chargeId: string, _late: boolean) {
    this.pay(chargeId).status = "failed";
    return [this.payEvent(chargeId, "failed", { origin: "bank", cause: "insufficient_funds" })];
  }
  refundEvent(_w: World, _chargeId: string, refundId: string, state: RefundState) {
    const r = this.fake.refunds.get(refundId);
    if (!r) throw new Error(`fake GoCardless has no refund ${refundId}`);
    const action = { pending: "created", succeeded: "paid", failed: "failed" }[state];
    if (state === "succeeded") r.status = "paid";
    if (state === "failed" && r.status !== "failed") {
      r.status = "failed";
      this.pay(r.links.payment).amount_refunded -= r.amount;
    }
    // Refund events link only the refund (measured).
    return [
      this.event("refunds", action, { refund: r.id }, { cause: `refund_${action}` }, r.metadata),
    ];
  }
  dashboardRefund(w: World, chargeId: string, amountMinor: bigint) {
    const r = this.fake.refund(this.pay(chargeId), Number(amountMinor), {});
    const created = this.event(
      "refunds",
      "created",
      { refund: r.id },
      { origin: "api", cause: "refund_created" },
    );
    return {
      refundId: r.id,
      events: [created, ...this.refundEvent(w, chargeId, r.id, "succeeded")],
    };
  }
  disputeSteps(_w: World, chargeId: string, flow: "won" | "lost" | "win_after_loss") {
    if (flow !== "won") return null;
    this.pay(chargeId).status = "charged_back";
    const back = this.payEvent(chargeId, "charged_back", {
      origin: "bank",
      cause: "authorisation_disputed",
    });
    const cancelled = this.payEvent(chargeId, "chargeback_cancelled", {
      cause: "chargeback_cancelled",
    });
    return [
      { after: "withdrawn" as const, bodies: [back] },
      { after: "won" as const, bodies: [cancelled] },
    ];
  }
  chargesOn(mandateId: string) {
    return [...this.fake.payments.values()]
      .filter((p) => p.links.mandate === mandateId)
      .map((p) => p.id);
  }

  statusEvent(w: World, st: DocumentedStatus, chargeId: string): Body[] {
    if (st.object === "event:refunds") {
      const r = this.fake.refund(this.pay(chargeId), 1000, {});
      if (st.status === "paid") r.status = "paid";
      if (st.status === "failed" || st.status === "funds_returned") r.status = "failed";
      return [this.event("refunds", st.status, { refund: r.id }, { cause: `refund_${st.status}` })];
    }
    const status: Record<string, string> = {
      failed: "failed",
      cancelled: "cancelled",
      customer_approval_denied: "customer_approval_denied",
      charged_back: "charged_back",
      paid_out: "paid_out",
    };
    if (status[st.status]) this.pay(chargeId).status = status[st.status]!;
    const cause =
      st.status === "failed"
        ? "insufficient_funds"
        : st.status === "charged_back"
          ? "authorisation_disputed"
          : st.status;
    return [this.payEvent(chargeId, st.status, { cause })];
  }
}

const pay = (status: string, expect: DocumentedStatus["expect"]): DocumentedStatus => ({
  object: "event:payments",
  status,
  doc: "payment-events",
  expect,
});
const ref = (status: string, expect: DocumentedStatus["expect"]): DocumentedStatus => ({
  object: "event:refunds",
  status,
  doc: "refund-events",
  expect,
});

type ExtraMethod = keyof typeof EXTRA_SCHEMES;

/** Bill on a mandate of `method`'s scheme, in its currency. A PayTo ceiling is optional. */
async function billOn(
  world: (label: string, currency?: string) => Promise<World>,
  method: ExtraMethod,
  ceiling?: number,
) {
  const s = EXTRA_SCHEMES[method];
  const w = await world(`sch-${method}`, s.currency);
  const d = w.driver as GoCardlessDriver;
  // The caller clears it once billed: the driver is shared by every world.
  d.nextScheme = { scheme: s.scheme, country: s.country, ...(ceiling ? { ceiling } : {}) };
  return { w, d, s };
}

async function rowsOf(w: World, paymentMethodId: string, invoiceId: string) {
  return withTenant(w.org.id, async (tx) => {
    const [pm] = await tx
      .select()
      .from(paymentMethods)
      .where(eq(paymentMethods.id, paymentMethodId));
    const [pay] = await tx
      .select()
      .from(payments)
      .where(eq(payments.invoiceId, invoiceId))
      .orderBy(desc(payments.createdAt))
      .limit(1);
    return { pm, pay };
  });
}

/**
 * One row per added scheme: the mandate is saved as our method, the debit goes out in the
 * scheme's currency, and the payment records the method that paid. A partial refund books
 * the same on every scheme (GoCardless documents one refund rule for all of them).
 */
const schemeRows: ExtraRow[] = (Object.keys(EXTRA_SCHEMES) as ExtraMethod[]).flatMap(
  (method): ExtraRow[] => [
    {
      scenario: "S1",
      id: `S1.scheme.${method}`,
      title: `a ${EXTRA_SCHEMES[method].scheme} mandate collects in ${EXTRA_SCHEMES[method].currency} and records ${method} (${DOC.schemes})`,
      async run({ world }) {
        const { w, d, s } = await billOn(
          world,
          method,
          method === "payto" ? Number(AMOUNT) * 5 : undefined,
        );
        try {
          const b = await w.collected();
          const sent = d.fake.payments.get(b.chargeId);
          const { pm, pay } = await rowsOf(w, b.paymentMethodId, b.invoiceId);
          return {
            pass:
              sent?.currency === s.currency &&
              sent.scheme === s.scheme &&
              pm?.type === method &&
              pay?.methodType === method &&
              (await w.balanced()),
            detail: `sent ${sent?.currency}/${sent?.scheme} pm ${pm?.type} payment.method_type ${pay?.methodType}`,
          };
        } finally {
          d.nextScheme = undefined;
        }
      },
    },
    {
      scenario: "S2",
      id: `S2.scheme.${method}`,
      title: `a partial refund on a ${EXTRA_SCHEMES[method].scheme} payment books once, at its amount`,
      async run({ world }) {
        const { w, d } = await billOn(
          world,
          method,
          method === "payto" ? Number(AMOUNT) * 5 : undefined,
        );
        try {
          const b = await w.collected();
          const cash0 = await w.cash();
          const r = await refundPayment({
            organizationId: w.org.id,
            businessId: w.biz.id,
            paymentPublicId: b.paymentPublicId!,
            amountMinor: 3000,
          });
          await w.deliver(d.refundEvent(w, b.chargeId, r.providerRefundId!, "succeeded"));
          const rows = await w.refundRows(b.paymentId!);
          return {
            pass:
              (await w.cash()) === cash0 - 3000n &&
              rows.length === 1 &&
              rows[0]!.status === "succeeded" &&
              (await w.balanced()),
            detail: `cash ${(await w.cash()) - cash0} rows ${rows.map((x) => `${x.amountMinor}:${x.status}`)}`,
          };
        } finally {
          d.nextScheme = undefined;
        }
      },
    },
  ],
);

export const gocardlessFixture: GatewayFixture = {
  key: "gocardless",
  currency: "GBP",
  docs: [
    { id: "payment-events", url: DOC.paymentEvents, read: READ, check: { kind: "page" } },
    { id: "refund-events", url: DOC.refundEvents, read: READ, check: { kind: "page" } },
  ],
  // GoCardless reports state as event actions; these are every action on the two pages.
  statuses: [
    pay("created", ["charge.pending"]),
    pay("customer_approval_granted", ["charge.pending"]),
    pay("customer_approval_denied", ["charge.failed"]),
    pay("submitted", ["charge.pending"]),
    pay("confirmed", ["charge.succeeded"]),
    pay("chargeback_cancelled", ["dispute.funds_reinstated"]),
    pay("paid_out", ["charge.updated"]),
    pay("late_failure_settled", ["charge.updated"]),
    pay("chargeback_settled", ["charge.updated"]),
    pay("surcharge_fee_debited", ["charge.updated"]),
    pay("failed", ["charge.failed"]),
    pay("charged_back", ["dispute.created", "dispute.funds_withdrawn"]),
    pay("cancelled", ["charge.failed"]),
    pay("resubmission_requested", ["charge.pending"]),
    pay("sds_settlement_delayed", {
      none: "A settlement-timing notice; the payment's own events carry its money.",
    }),
    ref("created", ["refund.pending"]),
    ref("failed", ["refund.failed"]),
    ref("paid", ["charge.refunded"]),
    ref("refund_settled", {
      none: "The refund was deducted from a payout; `paid` already booked it.",
    }),
    ref("funds_returned", ["refund.failed"]),
  ],
  na: {
    "S5.lost":
      "A GoCardless chargeback has no lost verdict: the money is withdrawn at `charged_back` and stays withdrawn.",
    "S5.win_after_loss": "No lost verdict to win after (see S5.lost).",
    S13: "GoCardless has one API version (2015-07-06) and one event shape.",
  },
  limits: [
    { op: "charge", field: "header:idempotency-key", max: 128, source: DOC.limits },
    { op: "charge", field: "payments.metadata.tmbilling_ref", max: 500, source: DOC.payment },
    { op: "refund", field: "header:idempotency-key", max: 128, source: DOC.limits },
    { op: "refund", field: "refunds.metadata.tmbilling_ref", max: 500, source: DOC.payment },
  ],
  driver: () => new GoCardlessDriver(),
  extraRows: [
    ...schemeRows,
    {
      scenario: "S1",
      id: "S1.payto-over-ceiling",
      title: `a renewal above the PayTo agreement's maximum is refused before GoCardless sees it (${DOC.payto})`,
      async run({ world }) {
        const { w, d } = await billOn(world, "payto", Number(AMOUNT) / 2);
        try {
          const b = await w.bill();
          const { pm } = await rowsOf(w, b.paymentMethodId, b.invoiceId);
          const sent = d.chargesOn(pm?.providerPaymentMethodId ?? "");
          return {
            pass:
              outcomeOf(b) === "failed" &&
              b.failureCode === "mandate_ceiling_exceeded" &&
              sent.length === 0 &&
              pm?.mandateMaxAmountMinor === AMOUNT / 2n,
            detail: `${outcomeOf(b)} ${b.failureCode} sent ${sent.length} ceiling ${pm?.mandateMaxAmountMinor}`,
          };
        } finally {
          d.nextScheme = undefined;
        }
      },
    },
    {
      scenario: "S10",
      id: "S10.cancel-swept-before-webhook",
      title:
        "a debit cancelled in the GoCardless dashboard and found by the sweep before its webhook books as the webhook does",
      async run({ world }) {
        const w = await world("s10sw");
        const d = w.driver as GoCardlessDriver;
        const b = await w.bill();
        if (b.paymentStatus !== "pending")
          return { pass: false, detail: `setup: payment ${b.paymentStatus}` };
        d.fake.payments.get(b.chargeId)!.status = "cancelled";
        const ev = d["payEvent"](b.chargeId, "cancelled", {
          origin: "api",
          cause: "payment_cancelled",
        });
        return sweptCancelBeforeWebhook(w, b, () => ev);
      },
    },
    {
      scenario: "S10",
      id: "S10.dashboard-cancel-webhook",
      title:
        "a GoCardless `cancelled` (payment_cancelled) webhook books the debit cancelled, not a decline",
      async run({ world }) {
        const w = await world("s10wh");
        const d = w.driver as GoCardlessDriver;
        const b = await w.bill();
        const cash0 = await w.cash();
        d.fake.payments.get(b.chargeId)!.status = "cancelled";
        await w.deliver(
          d["payEvent"](b.chargeId, "cancelled", { origin: "api", cause: "payment_cancelled" }),
        );
        const after = await w.reload(b);
        const inv = await invoiceOf(w, b.invoiceId);
        return {
          pass:
            after.paymentStatus === "failed" &&
            after.failureCode === "debit_cancelled" &&
            inv.status === "payment_due" &&
            inv.dunningStatus === "stopped" &&
            (await w.cash()) === cash0,
          detail: `payment ${after.paymentStatus} ${after.failureCode} invoice ${inv.status}/${inv.dunningStatus}`,
        };
      },
    },
    {
      scenario: "S11",
      id: "S11.chargeback-before-confirmation",
      title:
        "a batch listing the chargeback before its payment's confirmation books the clawback (measured live 2026-10-27)",
      async run({ world }) {
        const w = await world("s11cb");
        const d = w.driver as GoCardlessDriver;
        const b = await w.bill();
        const cash0 = await w.cash();
        const confirmed = JSON.parse(d["payEvent"](b.chargeId, "confirmed").body).events[0];
        const back = JSON.parse(
          d["payEvent"](b.chargeId, "charged_back", {
            origin: "bank",
            cause: "authorisation_disputed",
          }).body,
        ).events[0];
        confirmed.created_at = new Date(Date.now() - 1000).toISOString();
        d.fake.payments.get(b.chargeId)!.status = "charged_back";
        const body = JSON.stringify({
          events: [back, confirmed],
          meta: { webhook_id: "WB000000000098" },
        });
        const res = await w.deliver({ body, eventIds: [back.id, confirmed.id] });
        const held = await w.bal("disputed_funds");
        return {
          pass: (await w.cash()) === cash0 && held === b.amountMinor,
          detail: `webhook ${res.status} ${res.results.join(",")}; cash ${(await w.cash()) - cash0} disputed_funds ${held}`,
        };
      },
    },
    {
      scenario: "S11",
      id: "S11.chargeback-alone-before-settlement",
      title:
        "a chargeback delivered while the payment is still pending is retried, not marked withdrawn",
      async run({ world }) {
        const w = await world("s11cp");
        const d = w.driver as GoCardlessDriver;
        const b = await w.bill();
        const cash0 = await w.cash();
        const back = d["payEvent"](b.chargeId, "charged_back", {
          origin: "bank",
          cause: "authorisation_disputed",
        });
        const early = await w.deliver(back);
        await w.deliver(d.paymentSucceeded(w, b.chargeId));
        const again = await w.deliver(back);
        const held = await w.bal("disputed_funds");
        return {
          pass:
            early.status !== 200 &&
            again.status === 200 &&
            (await w.cash()) === cash0 &&
            held === b.amountMinor,
          detail: `first ${early.status} ${early.results.join(",")}; redelivered ${again.status}; cash ${(await w.cash()) - cash0} disputed_funds ${held}`,
        };
      },
    },
    {
      scenario: "S11",
      id: "S11.batch-newest-first",
      title: "a batch delivered newest first ends on the newest payment state",
      async run({ world }) {
        const w = await world("s11gc");
        const d = w.driver as GoCardlessDriver;
        const b = await w.bill();
        const cash0 = await w.cash();
        d.fake.payments.get(b.chargeId)!.status = "confirmed";
        const submitted = JSON.parse(d["payEvent"](b.chargeId, "submitted").body).events[0];
        const confirmed = JSON.parse(d["payEvent"](b.chargeId, "confirmed").body).events[0];
        submitted.created_at = new Date(Date.now() - 5000).toISOString();
        const body = JSON.stringify({
          events: [confirmed, submitted],
          meta: { webhook_id: "WB000000000099" },
        });
        await w.deliver({ body, eventIds: [confirmed.id, submitted.id] });
        const after = await w.reload(b);
        return {
          pass: after.txnStatus === "succeeded" && (await w.cash()) === cash0 + b.amountMinor,
          detail: `txn ${after.txnStatus} cash ${(await w.cash()) - cash0}`,
        };
      },
    },
  ],
};
