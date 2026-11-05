import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { LIMITS, clientResultField, httpUrl, redirectUrl } from "./limits";
import { authenticate } from "@/platform/auth";
import { idempotency, idempotencyOnSend } from "@/platform/idempotency";
import { MAX_LIST_LIMIT } from "@/platform/list-query";
import {
  resolveBusiness,
  badRequest,
  badGateway,
  notFound,
  conflict,
  listResponse,
  requirePerm,
} from "./helpers";
import {
  assertIntentCurrency,
  createPaymentIntent,
  getPaymentIntent,
  authorizePaymentIntent,
  consumePaymentIntent,
  retryPaymentIntent,
  voidPaymentIntent,
  listAttemptsForIntent,
  getPaymentIntentRow,
  getPaymentIntentReversal,
  serializePaymentIntent,
  listPaymentIntentsPage,
  serializePaymentIntentRow,
  serializePaymentAttempt,
  PaymentIntentError,
  PaymentIntentConflictError,
  PaymentIntentVoidUnsupportedError,
} from "@/modules/payment-intents/service";
import { GatewayRouterError } from "@/modules/gateway/router";
import { ProviderIndeterminateError, ProviderRefusalError } from "@/providers/types";
import { parseRequest } from "./strict-params";

/**
 * The intent vocabulary, in full. `voided` is NOT decorative: `voidPaymentIntent`
 * sets it alongside `voided_at`, and a list filtered on it must return those rows
 * rather than an empty page.
 */
const PI_STATUSES = [
  "inited",
  "in_progress",
  "authorized",
  "consumed",
  "expired",
  "voided",
] as const;
const PI_PURPOSES = ["payment", "setup"] as const;

/**
 * Create body.
 *
 * The old shape required a POSITIVE `amount_minor` and a `payment_method`, which
 * made a SETUP intent — the zero-amount authorization whose product is a vaulted
 * instrument, and the majority of what real gateways issue (Stripe `seti_…`) —
 * literally unrepresentable over the API. Nothing in the database ever demanded a
 * positive amount; this line was the whole constraint.
 *
 * Zod cannot express "positive when payment, absent when setup" in the field
 * schema, so the field is merely zero-legal here and the genuinely invalid
 * COMBINATIONS are rejected in `superRefine` below, each on the field the caller
 * has to change.
 */
const createBody = z
  .object({
    /** What the intent is FOR. Defaults to the original, only meaning. */
    purpose: z.enum(PI_PURPOSES).default("payment"),
    /** `payment` only — a setup intent has nothing vaulted yet to authorize. */
    payment_method: z.string().max(LIMITS.id).min(1).optional(),
    /** `setup` only — for `payment` the customer comes from the payment method. */
    customer: z.string().max(LIMITS.id).min(1).optional(),
    amount_minor: z.number().int().min(0).max(LIMITS.amountMinor).optional(),
    currency: z.string().length(3),
    /** Context links (`payment_intents.invoice_id` / `.subscription_id`). */
    invoice: z.string().max(LIMITS.id).min(1).optional(),
    subscription: z.string().max(LIMITS.id).min(1).optional(),
    /** Where the gateway returns the buyer after a redirect challenge. */
    return_url: redirectUrl().optional(),
    cancel_url: redirectUrl().optional(),
    /** Instruments the buyer may use, in our canonical vocabulary (`card`, `upi`, …). */
    method_types: z.array(z.string().min(1)).nonempty().optional(),
    /** off_session buyers cannot complete a challenge. */
    session: z.enum(["on_session", "off_session"]).optional(),
    /**
     * Pin the intent to this gateway account (`gwa_…`) instead of routing. It must be
     * this business's, active, in its mode, and able to take the currency and method.
     */
    gateway_account: z.string().max(LIMITS.id).min(1).optional(),
    /**
     * `setup` only — the per-debit ceiling of the mandate this intent registers, in
     * minor units of `currency`.
     *
     * Mandate rails (RazorPay e-mandate/UPI/card) demand an upper bound at registration
     * and enforce it at debit time, so leaving it to the adapter's default silently caps
     * what the business can ever bill this customer. It now reaches a real field the
     * whole way down — engine input → `CreateIntentInput.maxAmountMinor` → the adapter —
     * AND is persisted (`payment_intents.max_amount_minor`, 0174) so a retry re-registers
     * with the same number. It is meaningless for `payment`, which registers no mandate,
     * and is rejected there rather than ignored.
     */
    max_amount_minor: z.number().int().positive().max(LIMITS.amountMinor).optional(),
  })
  .superRefine((b, ctx) => {
    if (b.purpose === "payment") {
      if (!b.payment_method)
        ctx.addIssue({
          code: "custom",
          path: ["payment_method"],
          message: "A payment intent requires a payment method",
        });
      if (b.amount_minor == null || b.amount_minor <= 0)
        ctx.addIssue({
          code: "custom",
          path: ["amount_minor"],
          message: "A payment intent requires a positive amount_minor",
        });
      if (b.customer)
        ctx.addIssue({
          code: "custom",
          path: ["customer"],
          message: "A payment intent takes its customer from the payment method. Omit customer",
        });
      if (b.max_amount_minor != null)
        ctx.addIssue({
          code: "custom",
          path: ["max_amount_minor"],
          message:
            "max_amount_minor is the ceiling of a mandate and applies to setup intents only. Omit it. amount_minor sets the cap of a payment intent",
        });
      return;
    }
    // setup
    if (!b.customer)
      ctx.addIssue({
        code: "custom",
        path: ["customer"],
        message: "A setup intent requires a customer",
      });
    if (b.payment_method)
      ctx.addIssue({
        code: "custom",
        path: ["payment_method"],
        message:
          "A setup intent must not name a payment method. The buyer supplies the instrument during the challenge",
      });
    if (b.amount_minor != null && b.amount_minor !== 0)
      ctx.addIssue({
        code: "custom",
        path: ["amount_minor"],
        message: "A setup intent authorizes zero. Omit amount_minor or pass 0",
      });
  });

/**
 * The list query, validated by hand rather than through `parseListQuery`.
 *
 * `parseListQuery` would also admit `?q=` and `sort_by[…]`, which
 * `listPaymentIntentsPage` accepts in its signature but does not implement — an
 * accepted-and-ignored search returns a full, silently unfiltered page, the exact
 * failure GUIDE §3.4 exists to prevent. So: a closed allow-list, and every value
 * checked against the vocabulary it belongs to.
 */
// `offset` is `starting_after` under the list contract's second name (`next_offset`).
const LIST_PARAMS = ["limit", "starting_after", "offset", "status", "purpose", "invoice"] as const;

export async function registerPaymentIntentRoutes(app: FastifyInstance) {
  /**
   * List payment intents. There was NO list route at all, which is why the
   * dashboard could only be a create-and-inspect form. Cursor-paginated per
   * GUIDE §3.4; `?status=` / `?purpose=` narrow in SQL. `attempt_count` rides
   * along on every row via `serializePaymentIntent`.
   */
  app.get(
    "/v1/businesses/:biz/payment_intents",
    { preHandler: [authenticate, requirePerm("payments:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const q = req.query as Record<string, string | undefined>;

      for (const key of Object.keys(q)) {
        if (!(LIST_PARAMS as readonly string[]).includes(key))
          return badRequest(
            reply,
            `Unknown query parameter '${key}'. Supported: ${LIST_PARAMS.join(", ")}.`,
          );
      }
      if (q.limit != null) {
        const n = Number(q.limit);
        if (isNaN(n) || !Number.isInteger(n) || n < 1)
          return badRequest(reply, "limit must be a positive integer");
        if (n > MAX_LIST_LIMIT) return badRequest(reply, `limit must be ${MAX_LIST_LIMIT} or less`);
      }
      // An unknown status used to fall straight through to `eq(status, '…')` and
      // come back as an empty list — a typo that reads as "this business has no
      // intents" instead of "that is not a status".
      if (q.status && !(PI_STATUSES as readonly string[]).includes(q.status))
        return badRequest(
          reply,
          `Unknown status '${q.status}'. Valid statuses: ${PI_STATUSES.join(", ")}.`,
        );
      if (q.purpose && !(PI_PURPOSES as readonly string[]).includes(q.purpose))
        return badRequest(
          reply,
          `Unknown purpose '${q.purpose}'. Valid purposes: ${PI_PURPOSES.join(", ")}.`,
        );

      const page = await listPaymentIntentsPage(req.organization!.id, business.id, {
        limit: q.limit ? Number(q.limit) : undefined,
        startingAfter: q.starting_after ?? q.offset,
        status: q.status,
        purpose: q.purpose,
        // Resolved inside the service, like `createPaymentIntent`'s own invoice id.
        invoicePublicId: q.invoice,
      });
      return listResponse(page, serializePaymentIntentRow);
    },
  );

  app.post(
    "/v1/businesses/:biz/payment_intents",
    {
      preHandler: [authenticate, requirePerm("payments:collect"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const parsed = parseRequest(createBody, req.body);
      if (!parsed.success) return badRequest(reply, parsed.error);
      const b = parsed.data;
      try {
        await assertIntentCurrency({
          organizationId: req.organization!.id,
          business,
          currency: b.currency,
          invoicePublicId: b.invoice,
          subscriptionPublicId: b.subscription,
        });
        const { intent, attempt } = await createPaymentIntent({
          organizationId: req.organization!.id,
          businessId: business.id,
          purpose: b.purpose,
          paymentMethodPublicId: b.payment_method,
          customerPublicId: b.customer,
          amountMinor: b.amount_minor,
          currency: b.currency,
          invoicePublicId: b.invoice,
          subscriptionPublicId: b.subscription,
          returnUrl: b.return_url,
          cancelUrl: b.cancel_url,
          methodTypes: b.method_types,
          session: b.session,
          maxAmountMinor: b.max_amount_minor,
          ...(b.gateway_account ? { gatewayAccountId: b.gateway_account } : {}),
        });
        // Attempt #1 is part of the create outcome, not a second fetch: the
        // buyer's challenge lives on the ATTEMPT, and a client that has to
        // round-trip for it will render the intent before it knows the next step.
        return reply
          .code(201)
          .send({ ...serializePaymentIntent(intent), attempt: serializePaymentAttempt(attempt) });
      } catch (e) {
        if (e instanceof PaymentIntentError) return badRequest(reply, e.message);
        if (e instanceof GatewayRouterError) return badRequest(reply, e.message);
        if (e instanceof ProviderRefusalError) return badRequest(reply, e.message);
        // #42 · LAST of the mapped classes and FIRST of the two gateway ones in
        // meaning: a refusal is a request someone can fix (400), this is a fact we
        // could not establish (502, retriable). Unrelated to the classes above, so it
        // cannot be shadowed by them — but it must stay above the bare `throw`, which
        // is the 500 this exists to stop.
        if (e instanceof ProviderIndeterminateError) return badGateway(reply, e.message);
        throw e;
      }
    },
  );

  app.get(
    "/v1/businesses/:biz/payment_intents/:pi",
    { preHandler: [authenticate, requirePerm("payments:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const { pi } = req.params as { pi: string };
      // The ROW read, not the bare intent: this response used to carry no customer,
      // no gateway and no card, so the detail page had to drop its Customer
      // Information card and the summary's Gateway row. Same query shape as the
      // list, so the two cannot drift apart again.
      const row = await getPaymentIntentRow(req.organization!.id, business.id, pi);
      if (!row) return notFound(reply, "Payment intent not found");
      // The detail page reads "Attempt 1 / Attempt 2 / …" — oldest first. The intent
      // alone cannot tell you a buyer failed 3DS twice before succeeding.
      const attempts = await listAttemptsForIntent(req.organization!.id, business.id, pi);
      // The timeline names the VOIDING transaction under "Transaction Voided".
      // Only read it when the intent was actually voided — every other intent would
      // pay for a query guaranteed to return nothing.
      const reversal = row.intent.voidedAt
        ? await getPaymentIntentReversal(req.organization!.id, row.intent.id)
        : null;
      return {
        ...serializePaymentIntentRow(row),
        attempts: attempts.map((a) => serializePaymentAttempt(a, a.method)),
        voided_transaction: reversal
          ? { id: reversal.publicId, created_at: reversal.createdAt }
          : null,
      };
    },
  );

  /** Every attempt of one intent, oldest first — rendered as cards on the detail page. */
  app.get(
    "/v1/businesses/:biz/payment_intents/:pi/attempts",
    { preHandler: [authenticate, requirePerm("payments:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const { pi } = req.params as { pi: string };
      // `listAttemptsForIntent` returns [] for a missing intent, which would read
      // as "no attempts yet" — resolve the intent first so a bad id is a 404.
      const row = await getPaymentIntent(req.organization!.id, business.id, pi);
      if (!row) return notFound(reply, "Payment intent not found");
      const attempts = await listAttemptsForIntent(req.organization!.id, business.id, pi);
      return {
        object: "list" as const,
        data: attempts.map((a) => serializePaymentAttempt(a, a.method)),
      };
    },
  );

  /**
   * TEST MODE ONLY — force-pass the gateway challenge.
   *
   * This route calls tmtest's `resolveChallenge(…, true)`: it DECIDES that the
   * buyer passed 3DS. A real gateway decides that itself and tells us over a
   * webhook; if a live business could call this, an intent would sit at
   * `authorized` in our engine while the gateway still considers the buyer
   * unauthenticated, and the following consume would capture money the issuer
   * never approved. Gated on the business, not the gateway key, because the
   * gateway account is chosen per intent and a live business must never have a
   * hand-authorize handle at all.
   */
  app.post(
    "/v1/businesses/:biz/payment_intents/:pi/authorize",
    {
      preHandler: [authenticate, requirePerm("payments:collect"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      if (business.livemode !== "test")
        return badRequest(
          reply,
          "You can authorize an intent by hand only on test businesses. On a live business, the gateway's webhook authorizes the intent when the buyer completes the challenge.",
        );
      const { pi } = req.params as { pi: string };
      try {
        const row = await authorizePaymentIntent(req.organization!.id, business.id, pi);
        if (!row) return notFound(reply, "Payment intent not found");
        return serializePaymentIntent(row);
      } catch (e) {
        if (e instanceof PaymentIntentError) return badRequest(reply, e.message);
        throw e;
      }
    },
  );

  /**
   * Try again — mint attempt N+1 against the gateway. The previous attempt is
   * never mutated, so the failed 3DS that came before a success stays on the
   * timeline (this is what "Payment Attempts: 2" means).
   */
  app.post(
    "/v1/businesses/:biz/payment_intents/:pi/retry",
    {
      preHandler: [authenticate, requirePerm("payments:collect"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const { pi } = req.params as { pi: string };
      try {
        const res = await retryPaymentIntent(req.organization!.id, business.id, pi);
        if (!res) return notFound(reply, "Payment intent not found");
        return {
          ...serializePaymentIntent(res.intent),
          attempt: serializePaymentAttempt(res.attempt),
        };
      } catch (e) {
        if (e instanceof PaymentIntentError) return badRequest(reply, e.message);
        if (e instanceof GatewayRouterError) return badRequest(reply, e.message);
        if (e instanceof ProviderRefusalError) return badRequest(reply, e.message);
        // #42 · LAST of the mapped classes and FIRST of the two gateway ones in
        // meaning: a refusal is a request someone can fix (400), this is a fact we
        // could not establish (502, retriable). Unrelated to the classes above, so it
        // cannot be shadowed by them — but it must stay above the bare `throw`, which
        // is the 500 this exists to stop.
        if (e instanceof ProviderIndeterminateError) return badGateway(reply, e.message);
        throw e;
      }
    },
  );

  /**
   * Release an authorized, unconsumed intent — the state `expires_at` could not
   * express, because a cancellation is not a timeout.
   *
   * A gateway with no true void (RazorPay: an authorization is either captured or
   * left to lapse) fails here BY NAME. We never substitute a refund: that would
   * post real money movement for a payment that never settled.
   */
  app.post(
    "/v1/businesses/:biz/payment_intents/:pi/void",
    {
      preHandler: [authenticate, requirePerm("payments:refund"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const { pi } = req.params as { pi: string };
      try {
        const res = await voidPaymentIntent(req.organization!.id, business.id, pi);
        if (!res) return notFound(reply, "Payment intent not found");
        return {
          ...serializePaymentIntent(res.intent),
          attempt: res.attempt ? serializePaymentAttempt(res.attempt) : null,
        };
      } catch (e) {
        // Ordered: the unsupported-gateway case is a PaymentIntentError subclass and
        // its message is the one that names the gateway and says why not a refund.
        if (e instanceof PaymentIntentVoidUnsupportedError) return badRequest(reply, e.message);
        if (e instanceof PaymentIntentError) return badRequest(reply, e.message);
        /**
         * #42 — THE route this defect was reported on. #32 made an adapter throw when
         * it cannot establish which authorization to void, and with nothing here that
         * throw fell through as a 500: "Internal server error" on a condition where
         * nothing is wrong with the request, nothing is wrong with us, and trying again
         * is exactly right. 502 + `retriable: true`, with the adapter's own sentence,
         * which says what we could not establish and NEVER what became of the hold.
         *
         * Below `PaymentIntentError` because these are unrelated classes and this is
         * the newest, most specific case; above the bare `throw`, which is the 500.
         */
        if (e instanceof ProviderIndeterminateError) return badGateway(reply, e.message);
        throw e;
      }
    },
  );

  /**
   * Consume an authorized intent.
   *  - `purpose: payment` → capture INTO an invoice (`invoice` required; the
   *    engine books payment + ledger + transaction and settles it).
   *  - `purpose: setup`   → no invoice and no money; the product is the vaulted
   *    instrument, returned as `payment_method`.
   * `invoice` is therefore optional HERE and required by purpose in the engine,
   * which is the only place that knows the intent's purpose.
   */
  const consumeBody = z.object({
    invoice: z.string().max(LIMITS.id).min(1).optional(),
    /** What the buyer's browser SDK returned, for a `next_action.mode: 'sdk'` intent. */
    client_result: clientResultField().optional(),
  });
  app.post(
    "/v1/businesses/:biz/payment_intents/:pi/consume",
    {
      preHandler: [authenticate, requirePerm("payments:collect"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const { pi } = req.params as { pi: string };
      const parsed = parseRequest(consumeBody, req.body ?? {});
      if (!parsed.success) return badRequest(reply, parsed.error);
      try {
        const res = await consumePaymentIntent(
          req.organization!.id,
          business.id,
          pi,
          parsed.data.invoice,
          parsed.data.client_result ? { clientResult: parsed.data.client_result } : undefined,
        );
        if (!res) return notFound(reply, "Payment intent not found");
        return {
          ...serializePaymentIntent(res.intent),
          attempt: res.attempt ? serializePaymentAttempt(res.attempt) : null,
          charge_status: res.charge?.status ?? null,
          payment_method: res.paymentMethod?.publicId ?? null,
        };
      } catch (e) {
        if (e instanceof PaymentIntentConflictError) return conflict(reply, e.message);
        if (e instanceof PaymentIntentError) return badRequest(reply, e.message);
        throw e;
      }
    },
  );
}
