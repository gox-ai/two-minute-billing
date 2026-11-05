/**
 * Braintree conformance fixtures. GraphQL answers follow the shapes the sandbox returned
 * (`verify:braintree`, measured); webhook payloads follow the Control Panel's form post.
 * Every id is a same-shape fake. PayPal accounts follow the sandbox's measured behaviour
 * (2026-10-28): a sale goes straight to SETTLING, can be refunded at once, and cannot be
 * voided there.
 *
 * The adapter takes no API base, so the fake owns the sandbox host (never reached).
 * Braintree signs a webhook inside its form body (`bt_signature`), so the driver signs
 * with `signBody`.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { systemDb, withTenant } from "@/platform/db";
import { resolveAdapter } from "@/providers/registry";
import {
  BRAINTREE_SANDBOX_URL,
  signBraintreePayload,
  type BraintreeProvider,
} from "@/providers/braintree";
import { gatewayAccounts, paymentMethods } from "@db/schema";
import { FakeGateway, json, type FakeRequest } from "../fake-http";
import type { World } from "../harness";
import type {
  Body,
  DisputeFlow,
  DisputeStep,
  DocumentedStatus,
  GatewayDriver,
  GatewayFixture,
  RefundState,
  TokenKind,
} from "../types";

const HOST = new URL(BRAINTREE_SANDBOX_URL).origin;
const READ = "2026-10-27";
const READ_5E = "2026-10-28";
const BT = "https://developer.paypal.com/braintree";
const DOC = {
  disputeKinds: `${BT}/docs/reference/general/webhooks/dispute`,
  transactionKinds: `${BT}/docs/reference/general/webhooks/transaction`,
  fraudKinds: `${BT}/docs/reference/general/webhooks/fraud-protection`,
  schema: "https://raw.githubusercontent.com/braintree/graphql-api/master/schema.graphql",
  disputeStages: `${BT}/articles/wells-ic/chargebacks-retrievals-prearbs`,
  duplicateChecking: `${BT}/articles/control-panel/transactions/duplicate-checking`,
  sale: `${BT}/docs/reference/request/transaction/sale/node`,
  refund: `${BT}/docs/reference/request/transaction/refund/node`,
  void: `${BT}/docs/reference/request/transaction/void/node`,
  statuses: `${BT}/docs/reference/general/statuses`,
  paymentMethodKinds: `${BT}/docs/reference/general/webhooks/payment-method`,
  accountUpdaterKinds: `${BT}/docs/reference/general/webhooks/account-updater`,
  accountUpdater: `${BT}/articles/guides/account-updater`,
  threeDSecure: `${BT}/docs/guides/3d-secure/applying-3ds-to-transactions-and-verifications/node/`,
};
const PUBLIC_KEY = "conformancepublickey0001";
/** "Duplicate transaction checking is enabled by default with a 30 second window" (DOC.duplicateChecking). */
const DUPLICATE_WINDOW_MS = 30_000;
/** "The initial transaction was successful": the statuses duplicate checking compares against. */
const DUPLICATE_BASE = new Set([
  "AUTHORIZED",
  "SUBMITTED_FOR_SETTLEMENT",
  "SETTLING",
  "SETTLED",
  "VOIDED",
]);
const NOT_A_CHARGE = new Set(["GATEWAY_REJECTED", "PROCESSOR_DECLINED", "FAILED"]);

/** Engine modules load inside a row: `gateway-docs:recheck` imports this file without the app. */
const engine = async () => ({
  ...(await import("../harness")),
  ...(await import("@/modules/invoicing/service")),
  ...(await import("@/modules/refunds/service")),
  ...(await import("@/platform/clock")),
  ...(await import("@/modules/payments/stale-pending")),
  ...(await import("@/modules/gateway/settlement-report")),
});
/** The clock's gateway passes `ms` from now: the stale-pending sweep, then the settlement poll. */
const later = async (w: World, ms: number) => {
  const { runWithClockScope, sweepStalePendingCharges, pollGatewaySettlementReports } =
    await engine();
  return runWithClockScope({ onlyBusinessId: w.biz.id }, async () => {
    const at = new Date(Date.now() + ms);
    await sweepStalePendingCharges(at);
    return pollGatewaySettlementReports(at);
  });
};

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64").replace(/=+$/, "");
const unb64 = (s: string) => Buffer.from(s, "base64").toString("utf8");
const minorOf = (v: string) => BigInt(Math.round(Number(v) * 100));
const decimal = (m: bigint) => (Number(m) / 100).toFixed(2);

interface Tx {
  legacyId: string;
  kind: "sale" | "credit";
  status: string;
  orderId: string | null;
  amount: string;
  currency: string;
  paymentMethodId: string;
  /** Card number + expiry, what duplicate checking compares for a card. */
  cardKey: string;
  createdAt: number;
  refundedTransactionId?: string;
  gatewayRejectionReason?: string;
  /** The vaulted method's kind; a PayPal sale settles at once. */
  method?: Pm["kind"];
}
interface Pm {
  id: string;
  /** The vault token (what webhooks name). */
  legacy: string;
  customerId: string | null;
  kind: "card" | "bank" | "paypal";
  /** Kept for the bank-account refusal. */
  bank: boolean;
  cardKey: string;
  fingerprint: string;
  last4: string;
  expMonth: string;
  expYear: string;
}
interface Dispute {
  id: string;
  kind: "chargeback" | "retrieval" | "pre_arbitration";
  status: string;
  amount: string;
  amountWon?: string;
  currency: string;
  transactionId: string;
}

type Ext = Record<string, unknown>;
const gqlError = (field: string, message: string, extensions: Ext) => ({
  data: { [field]: null },
  errors: [{ message, path: [field], extensions }],
});

/** A fake nonce's type and 3D Secure result, as `node(id: nonce)` reads them (measured). */
function nonceDetails(nonce: string): Record<string, unknown> | null {
  if (nonce.startsWith("fake-paypal")) return { __typename: "PayPalAccountDetails" };
  if (nonce.startsWith("fake-venmo")) return { __typename: "VenmoAccountDetails" };
  if (nonce.startsWith("fake-valid-us-bank-account")) return { __typename: "UsBankAccountDetails" };
  if (nonce.startsWith("fake-three-d-secure-visa-failed-authentication-nonce"))
    return {
      __typename: "CreditCardDetails",
      threeDSecure: {
        authentication: {
          liabilityShifted: false,
          liabilityShiftPossible: true,
          authenticationStatus: "AUTHENTICATE_FAILED",
        },
      },
    };
  if (nonce.startsWith("fake-")) return { __typename: "CreditCardDetails", threeDSecure: null };
  return null;
}

class FakeBraintree extends FakeGateway {
  readonly host = HOST;
  readonly methods = new Map<string, Pm>();
  readonly txs = new Map<string, Tx>();
  /** Account updater reports, served at `${HOST}/conformance/au/<id>.csv`. */
  readonly reports = new Map<string, string>();
  /** `<mutation>:<apiRequestKey>` → [legacy id, the input it was made with]. */
  private readonly keys = new Map<string, [string, string]>();
  /** Added to the clock, to step past the duplicate-checking window. */
  skewMs = 0;

  now() {
    return Date.now() + this.skewMs;
  }
  legacy() {
    return this.id("cf", 6).toLowerCase();
  }
  sale(legacyId: string): Tx {
    const t = this.txs.get(legacyId);
    if (!t) throw new Error(`fake Braintree has no transaction ${legacyId}`);
    return t;
  }

  newSale(pm: Pm, amount: string, currency: string, orderId: string | null, status: string): Tx {
    const t: Tx = {
      legacyId: this.legacy(),
      kind: "sale",
      status,
      orderId,
      amount,
      currency,
      paymentMethodId: pm.id,
      cardKey: pm.cardKey,
      createdAt: this.now(),
      method: pm.kind,
    };
    this.txs.set(t.legacyId, t);
    return t;
  }

  newRefund(
    sale: Tx,
    amountMinor: bigint,
    status = "SUBMITTED_FOR_SETTLEMENT",
    orderId: string | null = null,
  ): Tx {
    const r: Tx = {
      ...sale,
      legacyId: this.legacy(),
      kind: "credit",
      status,
      orderId,
      amount: decimal(amountMinor),
      createdAt: this.now(),
      refundedTransactionId: sale.legacyId,
    };
    this.txs.set(r.legacyId, r);
    return r;
  }

  refundedMinor(sale: Tx): bigint {
    return [...this.txs.values()]
      .filter(
        (r) =>
          r.refundedTransactionId === sale.legacyId &&
          !["VOIDED", "SETTLEMENT_DECLINED"].includes(r.status),
      )
      .reduce((s, r) => s + minorOf(r.amount), 0n);
  }

  txView(t: Tx) {
    return {
      id: b64(`transaction_${t.legacyId}`),
      legacyId: t.legacyId,
      status: t.status,
      orderId: t.orderId,
      merchantAccountId: "conformance_usd",
      createdAt: new Date(t.createdAt).toISOString(),
      amount: { value: t.amount, currencyCode: t.currency },
      paymentMethodSnapshot:
        t.method === "paypal"
          ? { __typename: "PayPalTransactionDetails" }
          : { __typename: "CreditCardTransactionDetails", creditCard: { brandCode: "VISA" } },
      processorAuthorizationResponse: { legacyCode: "1000", message: "Approved" },
      processorSettlementResponse: null,
      refunds: [...this.txs.values()]
        .filter((r) => r.refundedTransactionId === t.legacyId)
        .map((r) => ({
          ...this.refundView(r),
          orderId: r.orderId,
          amount: { value: r.amount, currencyCode: r.currency },
        })),
      statusHistory: [
        {
          __typename:
            t.status === "GATEWAY_REJECTED" ? "GatewayRejectedEvent" : "TransactionStatusEvent",
          status: t.status,
          ...(t.gatewayRejectionReason ? { gatewayRejectionReason: t.gatewayRejectionReason } : {}),
        },
      ],
    };
  }
  refundView(t: Tx) {
    return { id: b64(`refund_${t.legacyId}`), legacyId: t.legacyId, status: t.status };
  }

  /** One search page. Lower bound inclusive; "one minute is always added to the upper bound" (DOC.schema, `SearchTimestampInput`). */
  private search(
    field: "transactions" | "refunds",
    input: Record<string, unknown>,
    q: string,
    after: unknown,
  ): Response {
    const text = (k: string) => input[k] as { is?: string; startsWith?: string } | undefined;
    const status = input.status as { is?: string; in?: string[] } | undefined;
    const created = input.createdAt as
      | { greaterThanOrEqualTo?: string; lessThanOrEqualTo?: string }
      | undefined;
    const matches = (t: Tx) =>
      t.kind === (field === "refunds" ? "credit" : "sale") &&
      (text("orderId")?.is == null || t.orderId === text("orderId")!.is) &&
      (text("orderId")?.startsWith == null ||
        (t.orderId ?? "").startsWith(text("orderId")!.startsWith!)) &&
      (status?.is == null || t.status === status.is) &&
      (status?.in == null || status.in.includes(t.status)) &&
      (created?.greaterThanOrEqualTo == null ||
        t.createdAt >= Date.parse(created.greaterThanOrEqualTo)) &&
      (created?.lessThanOrEqualTo == null ||
        t.createdAt < Date.parse(created.lessThanOrEqualTo) + 60_000);
    const all = [...this.txs.values()].filter(matches).sort((a, b) => b.createdAt - a.createdAt);
    const first = Number(/\bfirst:\s*(\d+)/.exec(q)?.[1] ?? 50);
    const from = typeof after === "string" ? Number(after) : 0;
    const page = all.slice(from, from + first);
    const next = from + page.length;
    const node = (t: Tx) => (field === "refunds" ? this.refundNode(t) : this.txView(t));
    return json(200, {
      data: {
        search: {
          [field]: {
            pageInfo: {
              hasNextPage: next < all.length,
              hasPreviousPage: false,
              startCursor: page.length ? String(from) : null,
              endCursor: page.length ? String(next) : null,
            },
            edges: page.map((t, i) => ({ cursor: String(from + i + 1), node: node(t) })),
          },
        },
      },
    });
  }
  /** A `Refund` as the poll's search selects it. */
  refundNode(r: Tx) {
    const sale = r.refundedTransactionId ? this.txs.get(r.refundedTransactionId) : undefined;
    return {
      legacyId: r.legacyId,
      status: r.status,
      orderId: r.orderId,
      createdAt: new Date(r.createdAt).toISOString(),
      amount: { value: r.amount, currencyCode: r.currency },
      refundedTransaction: sale ? { legacyId: sale.legacyId, orderId: sale.orderId } : null,
    };
  }

  /** `id` is a global id `<prefix>_<legacy>`. */
  private byGlobal(id: unknown, prefix: string): Tx | undefined {
    const s = typeof id === "string" ? unb64(id) : "";
    return s.startsWith(prefix) ? this.txs.get(s.slice(prefix.length)) : undefined;
  }

  /**
   * Braintree's `apiRequestKey` rule (DOC.schema): the same key with the same input
   * returns "the same transaction in its current status"; with different input it is
   * a VALIDATION error. A request that created nothing does not hold the key.
   */
  private replay(
    field: string,
    input: Record<string, unknown>,
    make: () => { res: Response; made?: string },
    view: (legacyId: string) => Response,
  ): Response {
    const key = typeof input.apiRequestKey === "string" ? `${field}:${input.apiRequestKey}` : null;
    const shape = JSON.stringify(input);
    const seen = key ? this.keys.get(key) : undefined;
    if (seen && seen[1] !== shape)
      return json(
        200,
        gqlError(
          field,
          "An apiRequestKey may only be reused with parameters identical to original request.",
          {
            errorClass: "VALIDATION",
            legacyCode: "915232",
            atMostOnceProcessing: { id: b64(`transaction_${seen[0]}`), legacyId: seen[0] },
          },
        ),
      );
    if (seen) return view(seen[0]);
    const { res, made } = make();
    if (key && made) this.keys.set(key, [made, shape]);
    return res;
  }

  pmView(pm: Pm) {
    return {
      id: pm.id,
      legacyId: pm.legacy,
      customer: pm.customerId ? { id: pm.customerId } : null,
      details:
        pm.kind === "paypal"
          ? { __typename: "PayPalAccountDetails", email: "conformance.payer@example.com" }
          : pm.kind === "bank"
            ? { __typename: "UsBankAccountDetails" }
            : {
                __typename: "CreditCardDetails",
                brandCode: "VISA",
                last4: pm.last4,
                expirationMonth: pm.expMonth,
                expirationYear: pm.expYear,
                uniqueNumberIdentifier: pm.fingerprint,
                binData: {
                  countryOfIssuance: "USA",
                  issuingBank: null,
                  debit: "NO",
                  prepaid: "NO",
                  commercial: "NO",
                },
              },
    };
  }

  async route(req: FakeRequest): Promise<Response | null> {
    const report = /^\/conformance\/au\/(\w+)\.csv$/.exec(req.path)?.[1];
    if (req.method === "GET" && report)
      return this.guarded("account_updater_report", req, () => {
        const csv = this.reports.get(report);
        return csv == null
          ? new Response("Not found", { status: 404 })
          : new Response(csv, { status: 200, headers: { "content-type": "text/csv" } });
      });
    if (req.method !== "POST" || req.path !== "/graphql") return null;
    const q = String(req.body.query ?? "");
    const vars = (req.body.variables ?? {}) as Record<string, unknown>;
    const input = (vars.input ?? {}) as Record<string, unknown>;
    if (/^\s*query\s*\{\s*ping/.test(q)) return json(200, { data: { ping: "pong" } });
    // `TransactionSearchInput` / `RefundSearchInput` (DOC.schema): status, orderId, createdAt;
    // `first` + `after` paging. A search by status is the settlement poll's.
    const searched = /\bsearch\s*\{\s*(transactions|refunds)\s*\(/.exec(q)?.[1];
    if (searched)
      return this.guarded(
        searched === "refunds"
          ? "settlement_search"
          : input.status
            ? "settlement_search"
            : "lookup",
        req,
        () => this.search(searched as "transactions" | "refunds", input, q, vars.after),
      );
    if (/\bidsFromLegacyIds\s*\(/.test(q)) {
      const ids = (input.ids ?? []) as { legacyId: string }[];
      const byLegacy = new Map([...this.methods.values()].map((m) => [m.legacy, m.id]));
      return json(200, {
        data: { idsFromLegacyIds: ids.map((i) => byLegacy.get(i.legacyId) ?? null) },
      });
    }
    const field =
      /\b(createCustomer|updateCustomer|vaultPaymentMethod|deletePaymentMethodFromVault|chargePaymentMethod|authorizePaymentMethod|captureTransaction|refundTransaction|reverseTransaction|voidTransaction|createClientToken)\s*\(/.exec(
        q,
      )?.[1] ?? (/\bnode\s*\(/.test(q) ? "node" : null);
    const txAnswer = (f: string) => (legacyId: string) =>
      json(200, { data: { [f]: { transaction: this.txView(this.sale(legacyId)) } } });

    switch (field) {
      case "createCustomer":
        return json(200, {
          data: { createCustomer: { customer: { id: b64(`customer_${this.legacy()}`) } } },
        });
      case "updateCustomer":
        return json(200, { data: { updateCustomer: { customer: { id: input.customerId } } } });
      case "createClientToken":
        return json(200, {
          data: { createClientToken: { clientToken: "conformance-client-token" } },
        });
      case "deletePaymentMethodFromVault":
        this.methods.delete(String(input.paymentMethodId));
        return json(200, { data: { deletePaymentMethodFromVault: { clientMutationId: null } } });
      case "vaultPaymentMethod":
        return this.guarded("vault", req, () => {
          const nonce = String(input.paymentMethodId);
          const bank = nonce.startsWith("fake-valid-us-bank-account-nonce");
          const kind: Pm["kind"] = bank
            ? "bank"
            : nonce.startsWith("fake-paypal")
              ? "paypal"
              : "card";
          const legacy = this.legacy();
          const pm: Pm = {
            // "paymentmethod_cc_…" / "paymentmethod_pp_…" (measured in the sandbox).
            id: b64(`paymentmethod_${kind === "paypal" ? "pp" : "cc"}_${legacy}`),
            legacy,
            customerId: typeof input.customerId === "string" ? input.customerId : null,
            kind,
            bank,
            cardKey: kind === "card" ? "4111111111111111/12/2034" : `${kind}:${legacy}`,
            fingerprint: `conf${randomUUID().replace(/-/g, "").slice(0, 24)}`,
            last4: "1111",
            expMonth: "12",
            expYear: "2034",
          };
          this.methods.set(pm.id, pm);
          return json(200, {
            data: {
              vaultPaymentMethod: {
                paymentMethod: this.pmView(pm),
                // PayPal accounts and bank accounts carry no card verification.
                verification:
                  kind !== "card"
                    ? null
                    : {
                        status: "VERIFIED",
                        gatewayRejectionReason: null,
                        processorResponse: {
                          legacyCode: "1000",
                          message: "Approved",
                          cvvResponse: "MATCHES",
                          avsPostalCodeResponse: "MATCHES",
                          avsStreetAddressResponse: "MATCHES",
                        },
                      },
              },
            },
          });
        });
      case "chargePaymentMethod":
      case "authorizePaymentMethod":
        return this.guarded(field === "chargePaymentMethod" ? "charge" : "authorize", req, () =>
          this.replay(
            field,
            input,
            () => {
              const pm = this.methods.get(String(input.paymentMethodId));
              if (!pm)
                return {
                  res: json(
                    200,
                    gqlError(
                      field,
                      "Multi-use payment method ID is invalid or could not be found.",
                      {
                        errorClass: "VALIDATION",
                        legacyCode: "91518",
                        inputPath: ["input", "paymentMethodId"],
                      },
                    ),
                  ),
                };
              const t = (input.transaction ?? {}) as Record<string, unknown>;
              const amount = String(t.amount);
              const orderId = typeof t.orderId === "string" ? t.orderId : null;
              const dup = [...this.txs.values()].some(
                (x) =>
                  x.kind === "sale" &&
                  x.cardKey === pm.cardKey &&
                  x.amount === amount &&
                  x.orderId === orderId &&
                  DUPLICATE_BASE.has(x.status) &&
                  this.now() - x.createdAt <= DUPLICATE_WINDOW_MS,
              );
              const sale = this.newSale(
                pm,
                amount,
                "USD",
                orderId,
                dup
                  ? "GATEWAY_REJECTED"
                  : field === "chargePaymentMethod"
                    ? // "We capture PayPal funds immediately when you submit" (PayPal server-side guide).
                      pm.kind === "paypal"
                      ? "SETTLING"
                      : "SUBMITTED_FOR_SETTLEMENT"
                    : "AUTHORIZED",
              );
              if (dup) sale.gatewayRejectionReason = "DUPLICATE";
              return { res: txAnswer(field)(sale.legacyId), made: sale.legacyId };
            },
            txAnswer(field),
          ),
        );
      case "captureTransaction":
      case "voidTransaction":
        return this.guarded(field === "captureTransaction" ? "capture" : "void", req, () =>
          this.replay(
            field,
            input,
            () => {
              const sale = this.byGlobal(input.transactionId, "transaction_");
              if (!sale)
                return {
                  res: json(
                    200,
                    gqlError(field, "Transaction not found.", { errorClass: "NOT_FOUND" }),
                  ),
                };
              // "authorized, submitted for settlement, or - for PayPal - settlement pending" (DOC.void).
              const from =
                field === "captureTransaction"
                  ? ["AUTHORIZED"]
                  : [
                      "AUTHORIZED",
                      "SUBMITTED_FOR_SETTLEMENT",
                      ...(sale.method === "paypal" ? ["SETTLEMENT_PENDING"] : []),
                    ];
              if (!from.includes(sale.status))
                return {
                  res: json(
                    200,
                    gqlError(field, `Transaction status is ${sale.status.toLowerCase()}.`, {
                      errorClass: "VALIDATION",
                      legacyCode: field === "captureTransaction" ? "91507" : "91504",
                      inputPath: ["input", "transactionId"],
                    }),
                  ),
                };
              sale.status =
                field === "voidTransaction"
                  ? "VOIDED"
                  : sale.method === "paypal"
                    ? "SETTLING"
                    : "SUBMITTED_FOR_SETTLEMENT";
              return { res: txAnswer(field)(sale.legacyId), made: sale.legacyId };
            },
            txAnswer(field),
          ),
        );
      case "refundTransaction":
        return this.guarded("refund", req, () =>
          this.replay(
            field,
            input,
            () => {
              const sale = this.byGlobal(input.transactionId, "transaction_");
              if (!sale)
                return {
                  res: json(
                    200,
                    gqlError(field, "Transaction not found.", { errorClass: "NOT_FOUND" }),
                  ),
                };
              if (!["SETTLED", "SETTLING"].includes(sale.status))
                return {
                  res: json(
                    200,
                    gqlError(field, "Cannot refund transaction unless it is settled.", {
                      errorClass: "VALIDATION",
                      legacyCode: "91506",
                      inputPath: ["input", "transactionId"],
                    }),
                  ),
                };
              const refund = (input.refund ?? {}) as Record<string, unknown>;
              const left = minorOf(sale.amount) - this.refundedMinor(sale);
              const amt = refund.amount != null ? minorOf(String(refund.amount)) : left;
              if (amt > left)
                return {
                  res: json(
                    200,
                    gqlError(field, "Refund amount is too large.", {
                      errorClass: "VALIDATION",
                      legacyCode: "91521",
                      inputPath: ["input", "refund", "amount"],
                    }),
                  ),
                };
              const r = this.newRefund(
                sale,
                amt,
                "SUBMITTED_FOR_SETTLEMENT",
                (refund.orderId as string) ?? null,
              );
              return {
                res: json(200, { data: { refundTransaction: { refund: this.refundView(r) } } }),
                made: r.legacyId,
              };
            },
            (legacyId) =>
              json(200, {
                data: { refundTransaction: { refund: this.refundView(this.sale(legacyId)) } },
              }),
          ),
        );
      case "reverseTransaction":
        return this.guarded("reverse", req, () =>
          this.replay(
            field,
            input,
            () => {
              const sale = this.byGlobal(input.transactionId, "transaction_");
              if (!sale)
                return {
                  res: json(
                    200,
                    gqlError(field, "Transaction not found.", { errorClass: "NOT_FOUND" }),
                  ),
                };
              if (
                ["AUTHORIZED", "SUBMITTED_FOR_SETTLEMENT"].includes(sale.status) ||
                (sale.method === "paypal" && sale.status === "SETTLEMENT_PENDING")
              ) {
                sale.status = "VOIDED";
                const v = {
                  __typename: "Transaction",
                  ...this.refundView(sale),
                  id: b64(`transaction_${sale.legacyId}`),
                };
                return {
                  res: json(200, { data: { reverseTransaction: { reversal: v } } }),
                  made: sale.legacyId,
                };
              }
              if (["SETTLED", "SETTLING"].includes(sale.status)) {
                const r = this.newRefund(sale, minorOf(sale.amount) - this.refundedMinor(sale));
                const v = { __typename: "Refund", ...this.refundView(r) };
                return {
                  res: json(200, { data: { reverseTransaction: { reversal: v } } }),
                  made: r.legacyId,
                };
              }
              return {
                res: json(
                  200,
                  gqlError(
                    field,
                    "Transaction can only be voided if status is authorized or submitted_for_settlement.",
                    {
                      errorClass: "VALIDATION",
                      legacyCode: "91504",
                      inputPath: ["input", "transactionId"],
                    },
                  ),
                ),
              };
            },
            (legacyId) => {
              const t = this.sale(legacyId);
              const v =
                t.kind === "credit"
                  ? { __typename: "Refund", ...this.refundView(t) }
                  : {
                      __typename: "Transaction",
                      ...this.refundView(t),
                      id: b64(`transaction_${t.legacyId}`),
                    };
              return json(200, { data: { reverseTransaction: { reversal: v } } });
            },
          ),
        );
      case "node": {
        const raw = typeof vars.id === "string" ? unb64(vars.id) : "";
        if (raw.startsWith("refund_")) {
          const r = this.txs.get(raw.slice(7));
          return json(200, {
            data: { node: r?.kind === "credit" ? { id: vars.id, status: r.status } : null },
          });
        }
        if (raw.startsWith("transaction_")) {
          const t = this.txs.get(raw.slice(12));
          return json(200, { data: { node: t?.kind === "sale" ? this.txView(t) : null } });
        }
        const pm = this.methods.get(String(vars.id));
        if (pm) return json(200, { data: { node: this.pmView(pm) } });
        // A single-use nonce reads as a PaymentMethod with its details (measured).
        const details = nonceDetails(String(vars.id));
        return json(200, {
          data: { node: details ? { id: vars.id, usage: "SINGLE_USE", details } : null },
        });
      }
    }
    return json(200, {
      data: null,
      errors: [
        {
          message: "Unsupported by the conformance fake.",
          extensions: { errorClass: "NOT_IMPLEMENTED" },
        },
      ],
    });
  }
}

const xmlTx = (t: Tx, extra = "") =>
  `<transaction><id>${t.legacyId}</id><status>${t.status.toLowerCase()}</status><type>${t.kind}</type>` +
  `<currency-iso-code>${t.currency}</currency-iso-code><amount>${t.amount}</amount>` +
  (t.orderId ? `<order-id>${t.orderId}</order-id>` : `<order-id nil="true"/>`) +
  `<created-at type="datetime">${new Date(t.createdAt).toISOString()}</created-at>` +
  (t.refundedTransactionId
    ? `<refunded-transaction-id>${t.refundedTransactionId}</refunded-transaction-id>`
    : "") +
  `${extra}</transaction>`;

const SETTLEMENT_DECLINED =
  "<processor-settlement-response-code>4001</processor-settlement-response-code>" +
  "<processor-settlement-response-text>Settlement Declined</processor-settlement-response-text>";

const xmlDispute = (d: Dispute) =>
  `<dispute><amount-disputed>${d.amount}</amount-disputed>` +
  (d.amountWon ? `<amount-won>${d.amountWon}</amount-won>` : "") +
  `<currency-iso-code>${d.currency}</currency-iso-code>` +
  `<received-date type="date">2026-10-01</received-date><reply-by-date type="date">2034-10-21</reply-by-date>` +
  `<kind>${d.kind}</kind><status>${d.status}</status><reason>fraud</reason><id>${d.id}</id>` +
  `<transaction><id>${d.transactionId}</id><amount>${d.amount}</amount></transaction></dispute>`;

/** The dispute status each dispute kind of notification reports. */
const DISPUTE_STATUS: Record<string, string> = {
  dispute_opened: "open",
  dispute_under_review: "under_review",
  dispute_disputed: "disputed",
  dispute_won: "won",
  dispute_lost: "lost",
  dispute_accepted: "accepted",
  dispute_auto_accepted: "auto_accepted",
  dispute_expired: "expired",
};

class BraintreeDriver implements GatewayDriver {
  readonly fake = new FakeBraintree();
  readonly forgedStatus = 400;
  readonly chargeOp = "charge";
  readonly refundOp = "refund";
  readonly lookupOp = "lookup";
  /** Braintree answers HTTP 200 with `errors[]` (DOC.schema, "Understanding Responses"). */
  readonly errors = {
    conflict: {
      status: 200,
      body: gqlError(
        "chargePaymentMethod",
        "A previous request with this apiRequestKey is still in-flight.",
        {
          errorClass: "VALIDATION",
          legacyCode: "915233",
        },
      ),
    },
    rateLimited: {
      status: 200,
      body: gqlError("chargePaymentMethod", "Rate limit exceeded.", {
        errorClass: "RESOURCE_LIMIT",
      }),
    },
    server: {
      status: 500,
      body: {
        errors: [{ message: "Internal Server Error", extensions: { errorClass: "INTERNAL" } }],
      },
    },
    internal: {
      status: 200,
      body: gqlError("chargePaymentMethod", "An unexpected error occurred.", {
        errorClass: "INTERNAL",
      }),
    },
    refundRefused: {
      status: 200,
      body: gqlError("refundTransaction", "Refund amount is too large.", {
        errorClass: "VALIDATION",
        legacyCode: "91521",
        inputPath: ["input", "refund", "amount"],
      }),
    },
  };
  /** "…receives a … RESOURCE_LIMIT … error, and no transaction is created" (DOC.schema, `apiRequestKey`). */
  readonly rateLimitCreatesNothing = { source: DOC.schema };
  private tick = 0;

  credentials(webhookSecret: string) {
    // Braintree signs webhooks with the API key pair: the private key is the secret.
    return {
      merchant_id: "conformancemerchant01",
      public_key: PUBLIC_KEY,
      private_key: webhookSecret,
    };
  }
  /** The next `pays` instrument, when a row wants one that is not a card. */
  nextToken: string | null = null;
  token(kind: TokenKind) {
    if (kind !== "pays") return null;
    const next = this.nextToken;
    this.nextToken = null;
    return next ?? `fake-valid-visa-nonce-${randomUUID().slice(0, 8)}`;
  }
  sign() {
    return { "content-type": "application/x-www-form-urlencoded" };
  }
  signBody(_w: World, btPayload: string, secret: string) {
    return new URLSearchParams({
      bt_signature: signBraintreePayload(PUBLIC_KEY, secret, btPayload),
      bt_payload: btPayload,
    }).toString();
  }

  /** `bt_payload` as posted: base64 XML with a trailing newline. */
  notification(kind: string, subject: string, subjectId: string): Body {
    const ts = new Date(Date.now() + ++this.tick).toISOString();
    const xml =
      `<?xml version="1.0" encoding="UTF-8"?>\n<notification><timestamp type="datetime">${ts}</timestamp>` +
      `<kind>${kind}</kind><subject>${subject}</subject></notification>`;
    return {
      body: `${Buffer.from(xml).toString("base64")}\n`,
      eventIds: [`bt_${kind}_${subjectId}_${ts}`],
    };
  }
  txNote(kind: string, t: Tx, extra = "") {
    return this.notification(kind, xmlTx(t, extra), t.legacyId);
  }
  disputeNote(kind: string, d: Dispute) {
    d.status = DISPUTE_STATUS[kind] ?? d.status;
    return this.notification(kind, xmlDispute(d), d.id);
  }
  /** A payer revoked a vaulted PayPal account (subject as the SDKs' sample: token + global id). */
  revokedNote(pm: Pm, withGlobalId = true) {
    return this.notification(
      "payment_method_revoked_by_customer",
      `<paypal-account><token>${pm.legacy}</token>` +
        (withGlobalId ? `<global-id>${pm.id}</global-id>` : "") +
        `<revoked-at type="datetime">${new Date().toISOString()}</revoked-at></paypal-account>`,
      pm.legacy,
    );
  }
  /**
   * The daily report: a CSV the fake serves. Columns are our assumption (the guide names
   * only `update_type`); the adapter reads any header that names a token.
   */
  updaterNote(rows: [Pm, string][]) {
    const id = this.fake.legacy();
    this.fake.reports.set(
      id,
      "payment_method_token,update_type\n" +
        rows.map(([pm, type]) => `${pm.legacy},${type}`).join("\n") +
        "\n",
    );
    const note = this.notification(
      "account_updater_daily_report",
      `<account-updater-daily-report><report-date type="date">2026-10-27</report-date>` +
        `<report-url>${HOST}/conformance/au/${id}.csv</report-url></account-updater-daily-report>`,
      "2026-10-27",
    );
    // One event per changed card, under the delivery's id plus the token.
    const changed = rows.filter(([, t]) => /^New (account number|expiry date)$/.test(t));
    return {
      ...note,
      eventIds: changed.length
        ? changed.map(([pm]) => `${note.eventIds[0]}_${pm.legacy}`)
        : note.eventIds,
    };
  }
  newDispute(chargeId: string, kind: Dispute["kind"] = "chargeback"): Dispute {
    const s = this.fake.sale(chargeId);
    return {
      id: this.fake.legacy(),
      kind,
      status: "open",
      amount: s.amount,
      currency: s.currency,
      transactionId: s.legacyId,
    };
  }

  collect(_w: World, id: string) {
    // The nightly batch settles a card sale; no webhook says so.
    this.fake.sale(id).status = "SETTLED";
    return [];
  }
  // Transaction webhooks exist "for ACH and SEPA Direct Debit" only (DOC.transactionKinds).
  // They are the only delivery Braintree has for these, so the fixture sends them for a card.
  paymentSucceeded(_w: World, id: string) {
    const s = this.fake.sale(id);
    s.status = "SETTLED";
    return [this.txNote("transaction_settled", s)];
  }
  paymentFailed(_w: World, id: string) {
    const s = this.fake.sale(id);
    s.status = "SETTLEMENT_DECLINED";
    return [this.txNote("transaction_settlement_declined", s, SETTLEMENT_DECLINED)];
  }
  refundEvent(_w: World, _id: string, refundId: string, state: RefundState) {
    const r = this.fake.sale(refundId);
    if (state === "pending") return [];
    r.status = state === "succeeded" ? "SETTLED" : "SETTLEMENT_DECLINED";
    return [
      state === "succeeded"
        ? this.txNote("transaction_settled", r)
        : this.txNote("transaction_settlement_declined", r, SETTLEMENT_DECLINED),
    ];
  }
  dashboardRefund(_w: World, id: string, amountMinor: bigint) {
    const r = this.fake.newRefund(this.fake.sale(id), amountMinor, "SETTLED");
    return { refundId: r.legacyId, events: [this.txNote("transaction_settled", r)] };
  }
  disputeSteps(_w: World, id: string, flow: DisputeFlow): DisputeStep[] {
    const d = this.newDispute(id);
    const steps: DisputeStep[] = [
      { after: "withdrawn", bodies: [this.disputeNote("dispute_opened", d)] },
    ];
    const won: DisputeStep = { after: "won", bodies: [this.disputeNote("dispute_won", { ...d })] };
    const lost: DisputeStep = {
      after: "lost",
      bodies: [this.disputeNote("dispute_lost", { ...d })],
    };
    return flow === "won"
      ? [...steps, won]
      : flow === "lost"
        ? [...steps, lost]
        : [...steps, lost, won];
  }
  chargesOn(paymentMethodId: string) {
    return [...this.fake.txs.values()]
      .filter(
        (t) =>
          t.kind === "sale" && t.paymentMethodId === paymentMethodId && !NOT_A_CHARGE.has(t.status),
      )
      .map((t) => t.legacyId);
  }

  statusEvent(_w: World, st: DocumentedStatus, id: string): Body[] {
    const sale = this.fake.sale(id);
    const pm = this.fake.methods.get(sale.paymentMethodId)!;
    if (st.object === "payment_method")
      return [
        st.status === "payment_method_revoked_by_customer"
          ? this.revokedNote(pm)
          : this.notification(
              st.status,
              `<venmo-account><token>${pm.legacy}</token></venmo-account>`,
              pm.legacy,
            ),
      ];
    if (st.object === "account_updater") {
      pm.expYear = "2036";
      return [this.updaterNote([[pm, "New expiry date"]])];
    }
    if (st.object === "dispute") return [this.disputeNote(st.status, this.newDispute(id))];
    if (st.object === "review")
      return [
        this.notification(
          st.status,
          `<transaction-review><transaction-id>${id}</transaction-id><decision>approved</decision></transaction-review>`,
          id,
        ),
      ];
    const declined = st.status === "transaction_settlement_declined";
    const t =
      st.object === "refund" ? this.fake.newRefund(sale, 500n, "SUBMITTED_FOR_SETTLEMENT") : sale;
    t.status = declined
      ? "SETTLEMENT_DECLINED"
      : st.status === "transaction_settled"
        ? "SETTLED"
        : "FAILED";
    return [this.txNote(st.status, t, declined ? SETTLEMENT_DECLINED : "")];
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
  return resolveAdapter(acc!) as unknown as BraintreeProvider;
};
const vaultedId = async (w: World, paymentMethodId: string) => {
  const [pm] = await withTenant(w.org.id, (tx) =>
    tx.select().from(paymentMethods).where(eq(paymentMethods.id, paymentMethodId)),
  );
  return pm!.providerPaymentMethodId;
};

const pmRow = async (w: World, paymentMethodId: string) => {
  const [pm] = await withTenant(w.org.id, (tx) =>
    tx.select().from(paymentMethods).where(eq(paymentMethods.id, paymentMethodId)),
  );
  return pm!;
};

/** A dispute of `kind` opened then closed by `close`; returns the money it left. */
async function disputeRun(w: World, kind: Dispute["kind"], close: string, amountWon?: string) {
  const d = w.driver as BraintreeDriver;
  const b = await w.collected();
  const cash0 = await w.cash();
  const dsp = d.newDispute(b.chargeId, kind);
  await w.deliver(d.disputeNote("dispute_opened", dsp));
  const opened = (await w.cash()) - cash0;
  await w.deliver(d.disputeNote(close, { ...dsp, ...(amountWon ? { amountWon } : {}) }));
  return { opened, cash: (await w.cash()) - cash0, losses: await w.bal("dispute_losses") };
}

export const braintreeFixture: GatewayFixture = {
  key: "braintree",
  currency: "USD",
  docs: [
    { id: "dispute-kinds", url: DOC.disputeKinds, read: READ, check: { kind: "page" } },
    { id: "transaction-kinds", url: DOC.transactionKinds, read: READ, check: { kind: "page" } },
    { id: "fraud-kinds", url: DOC.fraudKinds, read: READ, check: { kind: "page" } },
    {
      id: "payment-method-kinds",
      url: DOC.paymentMethodKinds,
      read: READ_5E,
      check: { kind: "page" },
    },
    {
      id: "account-updater-kinds",
      url: DOC.accountUpdaterKinds,
      read: READ_5E,
      check: { kind: "page" },
    },
  ],
  statuses: [
    st("dispute", "dispute_opened", "dispute-kinds", [
      "dispute.created",
      "dispute.funds_withdrawn",
    ]),
    st("dispute", "dispute_under_review", "dispute-kinds", ["dispute.created"]),
    st("dispute", "dispute_disputed", "dispute-kinds", ["dispute.created"]),
    st("dispute", "dispute_won", "dispute-kinds", ["dispute.won"]),
    st("dispute", "dispute_lost", "dispute-kinds", ["dispute.lost"]),
    st("dispute", "dispute_accepted", "dispute-kinds", ["dispute.lost"]),
    st("dispute", "dispute_auto_accepted", "dispute-kinds", ["dispute.lost"]),
    st("dispute", "dispute_expired", "dispute-kinds", ["dispute.lost"]),
    st("sale", "transaction_settled", "transaction-kinds", ["charge.succeeded"]),
    st("sale", "transaction_settlement_declined", "transaction-kinds", ["charge.failed"]),
    // The refund landed. Booked once by id: ours is already booked, a Control Panel one is new.
    st("refund", "transaction_settled", "transaction-kinds", ["charge.refunded"]),
    st("refund", "transaction_settlement_declined", "transaction-kinds", ["refund.failed"]),
    st("review", "transaction_reviewed", "fraud-kinds", ["review.closed"]),
    // "…when a customer cancels their PayPal billing agreement, removes their Venmo
    // connection, or when Venmo suspends the account" (DOC.paymentMethodKinds).
    st("payment_method", "payment_method_revoked_by_customer", "payment-method-kinds", [
      "payment_method.detached",
    ]),
    st("payment_method", "payment_method_customer_data_updated", "payment-method-kinds", {
      none: "Venmo Enriched Customer Data changed (a profile, not the payment method); we do not use that feature.",
    }),
    // "A daily report containing all vaulted payment methods updated in the last 24 hours."
    st("account_updater", "account_updater_daily_report", "account-updater-kinds", [
      "payment_method.updated",
    ]),
  ],
  na: {
    "S6.after-failure": `A declined, rejected or failed Braintree transaction is final; a retry is a new transaction (PaymentStatus in ${DOC.schema}, read ${READ}).`,
    S10: `Cards, PayPal and Venmo only: a sale is collected when it is authorized (a PayPal sale settles at submission), so there is no pending debit to cancel (${DOC.statuses}, read ${READ_5E}).`,
    S13: `Braintree webhooks carry no event version; the API version is pinned per request (\`Braintree-Version\`), not per payload: ${DOC.schema} (read ${READ}).`,
  },
  // "Maximum 255 characters or 127 for PayPal transactions": one cap for every method.
  limits: [
    { op: "charge", field: "variables.input.transaction.orderId", max: 127, source: DOC.sale },
    { op: "refund", field: "variables.input.refund.orderId", max: 127, source: DOC.refund },
  ],
  driver: () => new BraintreeDriver(),
  extraRows: [
    {
      scenario: "S3",
      id: "S3.paypal-refund-while-settling",
      title:
        "a PayPal sale (SETTLING at once) takes a partial refund straight away, then the rest, with no void",
      async run({ world }) {
        const { refundPayment, AMOUNT } = await engine();
        const w = await world("s3pp");
        const d = w.driver as BraintreeDriver;
        d.nextToken = "fake-paypal-billing-agreement-nonce";
        const b = await w.bill();
        const cash0 = await w.cash();
        const ctx = { organizationId: w.org.id, businessId: w.biz.id };
        const first = await refundPayment({
          ...ctx,
          paymentPublicId: b.paymentPublicId!,
          amountMinor: 3000,
        }).catch((e: Error) => e);
        const rest = await refundPayment({
          ...ctx,
          paymentPublicId: b.paymentPublicId!,
          amountMinor: Number(AMOUNT) - 3000,
        }).catch((e: Error) => e);
        const sale = d.fake.txs.get(b.chargeId);
        const credits = [...d.fake.txs.values()].filter(
          (t) => t.kind === "credit" && t.refundedTransactionId === b.chargeId,
        );
        return {
          pass:
            b.txnStatus === "succeeded" &&
            !(first instanceof Error) &&
            !(rest instanceof Error) &&
            sale?.status === "SETTLING" &&
            credits.length === 2 &&
            d.fake.callsOf("void").length === 0 &&
            (await w.cash()) === cash0 - AMOUNT,
          detail: `charge ${b.txnStatus}; refunds ${first instanceof Error ? first.message : first.status}/${rest instanceof Error ? rest.message : rest.status}; sale ${sale?.status}; credits ${credits.length}; cash ${(await w.cash()) - cash0}`,
        };
      },
    },
    {
      scenario: "S4",
      id: "S4.paypal-settlement-pending-void",
      title:
        "a PayPal sale still in SETTLEMENT_PENDING is refunded in full by a void, booked once (DOC.void)",
      async run({ world }) {
        const { refundPayment, AMOUNT } = await engine();
        const w = await world("s4pv");
        const d = w.driver as BraintreeDriver;
        d.nextToken = "fake-paypal-billing-agreement-nonce";
        const b = await w.bill();
        d.fake.sale(b.chargeId).status = "SETTLEMENT_PENDING";
        const cash0 = await w.cash();
        const r = await refundPayment({
          organizationId: w.org.id,
          businessId: w.biz.id,
          paymentPublicId: b.paymentPublicId!,
        }).catch((e: Error) => e);
        const rows = await w.refundRows(b.paymentId!);
        return {
          pass:
            !(r instanceof Error) &&
            d.fake.sale(b.chargeId).status === "VOIDED" &&
            rows.length === 1 &&
            rows[0]!.status === "succeeded" &&
            (await w.cash()) === cash0 - AMOUNT,
          detail: `refund ${r instanceof Error ? r.message : r.status}; sale ${d.fake.sale(b.chargeId).status}; rows ${rows.map((x) => x.status)}; cash ${(await w.cash()) - cash0}`,
        };
      },
    },
    {
      scenario: "S8",
      id: "S8.account-updater-report-unreachable",
      title:
        "a daily report that cannot be fetched fails the delivery; the redelivery updates the card once",
      async run({ world }) {
        const w = await world("s8au");
        const d = w.driver as BraintreeDriver;
        const b = await w.bill();
        const pm = d.fake.methods.get(await vaultedId(w, b.paymentMethodId))!;
        pm.expYear = "2037";
        d.fake.inject("account_updater_report", { kind: "http", status: 503, body: {} }, 1);
        const first = await w.deliver(d.updaterNote([[pm, "New expiry date"]]));
        const again = await w.redeliver();
        const row = await pmRow(w, b.paymentMethodId);
        return {
          pass: first.status !== 200 && again.status === 200 && row.expYear === 2037,
          detail: `first ${first.status}; redelivery ${again.status} ${again.results}; exp ${row.expMonth}/${row.expYear}`,
        };
      },
    },
    {
      scenario: "S12",
      id: "S12.three-d-secure-refused",
      title:
        "a card whose 3D Secure failed (AUTHENTICATE_FAILED) is refused before it is saved (DOC.threeDSecure)",
      async run({ world }) {
        const w = await world("s12td");
        const d = w.driver as BraintreeDriver;
        const adapter = await adapterOf(w);
        const customer = await adapter.ensureCustomer({
          customerRef: `cus_conf_${randomUUID().slice(0, 8)}`,
        } as never);
        const intent = await adapter.createIntent({
          purpose: "setup",
          currency: "USD",
          customer,
          idempotencyKey: `conf_td_${randomUUID().slice(0, 8)}`,
        } as never);
        const vaults = d.fake.callsOf("vault").length;
        const r = await adapter.submitClientResult!({
          intentId: intent.intentId,
          purpose: "setup",
          clientResult: { nonce: "fake-three-d-secure-visa-failed-authentication-nonce" },
          idempotencyKey: `conf_td_${randomUUID().slice(0, 8)}`,
        });
        return {
          pass:
            r.status === "failed" &&
            r.failure?.code === "authentication_required" &&
            d.fake.callsOf("vault").length === vaults,
          detail: `${r.status} ${r.failure?.code ?? ""}; vault calls ${d.fake.callsOf("vault").length - vaults}`,
        };
      },
    },
    {
      scenario: "S12",
      id: "S12.paypal-on-card-intent",
      title: "a PayPal nonce on an intent that offered cards only is refused, and nothing is saved",
      async run({ world }) {
        const w = await world("s12pc");
        const d = w.driver as BraintreeDriver;
        const adapter = await adapterOf(w);
        const customer = await adapter.ensureCustomer({
          customerRef: `cus_conf_${randomUUID().slice(0, 8)}`,
        } as never);
        const intent = await adapter.createIntent({
          purpose: "setup",
          currency: "USD",
          customer,
          idempotencyKey: `conf_pc_${randomUUID().slice(0, 8)}`,
          methodTypes: ["card"],
        } as never);
        const vaults = d.fake.callsOf("vault").length;
        const r = await adapter.submitClientResult!({
          intentId: intent.intentId,
          purpose: "setup",
          clientResult: { nonce: "fake-paypal-billing-agreement-nonce" },
          idempotencyKey: `conf_pc_${randomUUID().slice(0, 8)}`,
        });
        return {
          pass: r.status === "failed" && d.fake.callsOf("vault").length === vaults,
          detail: `${r.status} ${r.failure?.code ?? ""}`,
        };
      },
    },
    {
      scenario: "S12",
      id: "S12.revoked-method-invalid",
      title:
        "a PayPal billing agreement the payer revoked makes the saved method invalid, by global id or by token",
      async run({ world }) {
        const w = await world("s12rv");
        const d = w.driver as BraintreeDriver;
        const out: string[] = [];
        for (const withGlobalId of [true, false]) {
          d.nextToken = "fake-paypal-billing-agreement-nonce";
          const b = await w.bill();
          const pm = d.fake.methods.get(await vaultedId(w, b.paymentMethodId))!;
          const res = await w.deliver(d.revokedNote(pm, withGlobalId));
          const row = await pmRow(w, b.paymentMethodId);
          out.push(`${withGlobalId ? "global" : "token"}:${res.status}:${row.status}`);
        }
        return {
          pass: out.every((o) => o.endsWith(":200:invalid")),
          detail: out.join(" "),
        };
      },
    },
    {
      scenario: "S12",
      id: "S12.account-updater-card-changed",
      title:
        "the daily report updates a card's expiry under the same token; a card-is-current row changes nothing",
      async run({ world }) {
        const w = await world("s12au");
        const d = w.driver as BraintreeDriver;
        const changed = await w.bill();
        const same = await w.bill();
        const pmA = d.fake.methods.get(await vaultedId(w, changed.paymentMethodId))!;
        const pmB = d.fake.methods.get(await vaultedId(w, same.paymentMethodId))!;
        pmA.expMonth = "03";
        pmA.expYear = "2036";
        const res = await w.deliver(
          d.updaterNote([
            [pmA, "New expiry date"],
            [pmB, "Match found - card is current"],
          ]),
        );
        const a = await pmRow(w, changed.paymentMethodId);
        const bRow = await pmRow(w, same.paymentMethodId);
        return {
          pass:
            res.status === 200 &&
            a.expMonth === 3 &&
            a.expYear === 2036 &&
            a.providerPaymentMethodId === pmA.id &&
            bRow.expYear === 2034,
          detail: `${res.status} ${res.results}; changed ${a.expMonth}/${a.expYear}; current ${bRow.expMonth}/${bRow.expYear}`,
        };
      },
    },
    {
      scenario: "S3",
      id: "S3.next-refund-after-dashboard",
      title:
        "a refund refused because a Control Panel refund took the money is refused, not stranded pending",
      async run({ world }) {
        const w = await world("s3nr");
        const d = w.driver as BraintreeDriver;
        const { RefundError, refundPayment } = await engine();
        const b = await w.collected();
        d.dashboardRefund(w, b.chargeId, 6000n);
        const r = await refundPayment({
          organizationId: w.org.id,
          businessId: w.biz.id,
          paymentPublicId: b.paymentPublicId!,
          amountMinor: 5000,
        }).catch((e: Error) => e);
        const rows = await w.refundRows(b.paymentId!);
        return {
          pass: r instanceof RefundError && !rows.some((x) => x.status === "pending"),
          detail: `${r instanceof Error ? `${r.name}: ${r.message.slice(0, 120)}` : "refund accepted"}; rows ${rows.map((x) => x.status)}`,
        };
      },
    },
    {
      scenario: "S3",
      id: "S3.dashboard-refund-no-webhook",
      title:
        "a Control Panel card refund, which sends no webhook, is found by the settlement poll and booked once at its own amount",
      async run({ world }) {
        const w = await world("s3nw");
        const d = w.driver as BraintreeDriver;
        const b = await w.collected();
        const cash0 = await w.cash();
        // Card refunds have no transaction webhook (DOC.transactionKinds): nothing is delivered.
        const r = d.fake.newRefund(d.fake.sale(b.chargeId), 2500n, "SUBMITTED_FOR_SETTLEMENT");
        const poll = await later(w, 3_600_000);
        const polled = (await w.cash()) - cash0;
        // Where a webhook does exist for the refund, it is the same refund: not booked again.
        r.status = "SETTLED";
        await w.deliver(d.txNote("transaction_settled", r));
        await later(w, 2 * 3_600_000);
        const rows = await w.refundRows(b.paymentId!);
        return {
          pass:
            polled === -2500n &&
            (await w.cash()) === cash0 - 2500n &&
            rows.length === 1 &&
            rows[0]!.amountMinor === 2500n,
          detail: `after poll ${polled} (events ${poll.events}, errors ${poll.errors.map((e) => e.message).join("; ")}); after webhook ${(await w.cash()) - cash0}; rows ${rows.map((x) => `${x.amountMinor}:${x.status}`)}`,
        };
      },
    },
    {
      scenario: "S4",
      id: "S4.voided-refund-polled",
      title:
        "our refund later voided in the Control Panel (no webhook) is reversed by the settlement poll, once",
      async run({ world }) {
        const { refundPayment } = await engine();
        const w = await world("s4vp");
        const d = w.driver as BraintreeDriver;
        const b = await w.collected();
        const cash0 = await w.cash();
        const made = await refundPayment({
          organizationId: w.org.id,
          businessId: w.biz.id,
          paymentPublicId: b.paymentPublicId!,
          amountMinor: 3000,
        }).catch((e: Error) => e);
        const booked = (await w.cash()) - cash0;
        const r = [...d.fake.txs.values()].find(
          (t) => t.kind === "credit" && t.refundedTransactionId === b.chargeId,
        );
        if (r) r.status = "VOIDED";
        await later(w, 3_600_000);
        await later(w, 2 * 3_600_000);
        const rows = await w.refundRows(b.paymentId!);
        return {
          pass:
            !(made instanceof Error) &&
            booked === -3000n &&
            (await w.cash()) === cash0 &&
            rows.length === 1 &&
            rows[0]!.status === "failed",
          detail: `refund ${made instanceof Error ? made.message : made.status}; booked ${booked}; cash after ${(await w.cash()) - cash0}; rows ${rows.map((x) => x.status)}`,
        };
      },
    },
    {
      scenario: "S4",
      id: "S4.voided-refund-is-failed",
      title: "a Refund Braintree reports VOIDED (the customer gets nothing) reads as failed",
      async run({ world }) {
        const w = await world("s4vr");
        const d = w.driver as BraintreeDriver;
        const b = await w.collected();
        const r = d.fake.newRefund(d.fake.sale(b.chargeId), 3000n, "VOIDED");
        const got = await (await adapterOf(w)).fetchRefundStatus({ providerRefundId: r.legacyId });
        return { pass: got.status === "failed", detail: `fetchRefundStatus → ${got.status}` };
      },
    },
    {
      scenario: "S5",
      id: "S5.retrieval-expired-no-loss",
      title: "a retrieval that expires books no loss (its funds were never withdrawn)",
      async run({ world }) {
        const r = await disputeRun(await world("s5re"), "retrieval", "dispute_expired");
        return {
          pass: r.cash === 0n && r.losses === 0n,
          detail: `cash ${r.cash} losses ${r.losses}`,
        };
      },
    },
    {
      scenario: "S5",
      id: "S5.pre-arbitration-withdrawn",
      title: "a pre-arbitration takes the money when it opens, like a chargeback",
      async run({ world }) {
        const { AMOUNT } = await engine();
        const r = await disputeRun(await world("s5pa"), "pre_arbitration", "dispute_lost");
        return {
          pass: r.opened === -AMOUNT && r.cash === -AMOUNT && r.losses === AMOUNT,
          detail: `after open cash ${r.opened}; after loss cash ${r.cash} losses ${r.losses}`,
        };
      },
    },
    {
      scenario: "S5",
      id: "S5.partial-win",
      title: "a dispute won for part of the amount (`amount-won`) reinstates only that part",
      async run({ world }) {
        const r = await disputeRun(await world("s5pw"), "chargeback", "dispute_won", "60.00");
        return {
          pass: r.cash === -4000n && r.losses === 4000n,
          detail: `cash ${r.cash} losses ${r.losses} (want -4000 / 4000)`,
        };
      },
    },
    {
      scenario: "S7",
      id: "S7.no-double-charge-after-window",
      title:
        "a lost answer, then the next collection after the 30-second duplicate window, charges once",
      async run({ world }) {
        const { collectInvoice, invoiceOf, outcomeOf, subscriptionOf } = await engine();
        const w = await world("s7dw");
        const d = w.driver as BraintreeDriver;
        d.fake.inject("charge", { kind: "network", afterCreate: true }, 6);
        const b = await w.bill().finally(() => d.fake.clearFaults());
        d.fake.skewMs += DUPLICATE_WINDOW_MS + 1000;
        await collectInvoice({
          organizationId: w.org.id,
          businessId: w.biz.id,
          invoice: await invoiceOf(w, b.invoiceId),
          subscription: await subscriptionOf(w, b.subscriptionId),
        }).catch(() => null);
        const made = d.chargesOn(await vaultedId(w, b.paymentMethodId));
        return {
          pass: made.length === 1,
          detail: `first attempt ${outcomeOf(b)}; charges at the gateway ${made.length}`,
        };
      },
    },
    {
      scenario: "S8",
      id: "S8.charge-service-availability",
      title: "a SERVICE_AVAILABILITY answer to a charge is never a definite failure",
      async run({ world }) {
        const w = await world("s8sa");
        const d = w.driver as BraintreeDriver;
        d.fake.inject(
          "charge",
          {
            kind: "http",
            status: 200,
            body: gqlError("chargePaymentMethod", "Service unavailable.", {
              errorClass: "SERVICE_AVAILABILITY",
            }),
          },
          6,
        );
        const b = await w.bill().finally(() => d.fake.clearFaults());
        const { outcomeOf } = await engine();
        return {
          pass: outcomeOf(b) !== "failed",
          detail: `attempt ${outcomeOf(b)} ${b.failureCode ?? ""}`,
        };
      },
    },
    {
      scenario: "S9",
      id: "S9.card-settlement-declined-polled",
      title:
        "a card sale declined at settlement, which sends no webhook, is reversed by the settlement poll, once",
      async run({ world }) {
        const { AMOUNT } = await engine();
        const w = await world("s9cd");
        const d = w.driver as BraintreeDriver;
        const b = await w.collected();
        const cash0 = await w.cash();
        d.fake.sale(b.chargeId).status = "SETTLEMENT_DECLINED";
        await later(w, 3_600_000);
        const reversed = (await w.cash()) - cash0;
        // The next pass reads the same decline again (status lookback): booked once.
        await later(w, 2 * 3_600_000);
        const inv = await w.invoiceStatus(b.invoiceId);
        return {
          pass: reversed === -AMOUNT && (await w.cash()) === cash0 - AMOUNT && inv !== "paid",
          detail: `after first poll ${reversed}; after second ${(await w.cash()) - cash0}; invoice ${inv}`,
        };
      },
    },
    {
      scenario: "S12",
      id: "S12.nonce-type",
      title: "a nonce that is not a card (a US bank account) is refused at vault",
      async run({ world }) {
        const w = await world("s12nt");
        const adapter = await adapterOf(w);
        const customer = await adapter.ensureCustomer({
          customerRef: `cus_conf_${randomUUID().slice(0, 8)}`,
        } as never);
        const r = await adapter
          .vaultPaymentMethod({ customer, token: "fake-valid-us-bank-account-nonce" } as never)
          .catch((e: Error) => e);
        return {
          pass: r instanceof Error,
          detail: r instanceof Error ? r.message : `vaulted as ${JSON.stringify(r.display)}`,
        };
      },
    },
  ],
};
