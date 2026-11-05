/**
 * Authorize.net conformance fixtures. JSON API answers follow the shapes the sandbox
 * returned (`verify:authorizenet`, measured 2026-10-24: a UTF-8 BOM on every body).
 * Every id is a same-shape fake: Authorize.net ids are all digits, so they come from a
 * run-unique numeric counter, not `this.id()`.
 */
import { createHash, createHmac, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { systemDb } from "@/platform/db";
import { resolveAdapter } from "@/providers/registry";
import { signAuthorizenetPayload, type AuthorizenetProvider } from "@/providers/authorizenet";
import { gatewayAccounts } from "@db/schema";
import { FakeGateway, type FakeRequest } from "../fake-http";
import type { World } from "../harness";
import type {
  Body,
  DocumentedStatus,
  GatewayDriver,
  GatewayFixture,
  RefundState,
  TokenKind,
} from "../types";

const HOST = "https://authorizenet.conformance.invalid";
const READ = "2026-10-27";
const DOC = {
  xsd: "https://api.authorize.net/xml/v1/schema/AnetApiSchema.xsd",
  webhooks: "https://developer.authorize.net/api/reference/features/webhooks.html",
  codes: "https://developer.authorize.net/api/reference/dist/json/responseCodes.json",
  apiref: "https://developer.authorize.net/api/reference/index.html",
  echeck: "https://developer.authorize.net/api/reference/features/echeck.html",
  echeckGuide: "https://www.authorize.net/content/dam/documents/en/echeck-user-guide.pdf",
};
/** eCheck facts, read 2026-10-28. */
const ECHECK_READ = "2026-10-28";
const BOM = "﻿";
const OK = { resultCode: "Ok", message: [{ code: "I00001", text: "Successful." }] };
const UNSUCCESSFUL = {
  resultCode: "Error",
  message: [{ code: "E00027", text: "The transaction was unsuccessful." }],
};
/** A settled transaction sits in its settlement day's batch, as the daily card batch does. */
const DAY_MS = 86_400_000;
const batchIdOf = (settledAt: number) => String(9_000_000_000 + Math.floor(settledAt / DAY_MS));
/** API dateTimes are whole seconds. */
const toSecond = (ms: number) => Math.floor(ms / 1000) * 1000;
/** Not in the merchant's unsettled list. */
const SETTLED = new Set([
  "settledSuccessfully",
  "refundSettledSuccessfully",
  "settlementError",
  "returnedItem",
  "chargeback",
  "chargebackReversal",
]);
const VOIDABLE = new Set([
  "capturedPendingSettlement",
  "authorizedPendingCapture",
  "FDSPendingReview",
  "FDSAuthorizedPendingReview",
  "underReview",
  "approvedReview",
  "pendingSettlement",
]);
const REFUSED = new Set([
  "declined",
  "expired",
  "generalError",
  "failedReview",
  "settlementError",
  "communicationError",
  "voided",
  "returnedItem",
]);
const REVIEW = new Set([
  "FDSPendingReview",
  "FDSAuthorizedPendingReview",
  "underReview",
  "approvedReview",
]);

/** Fake op per `transactionType`, the names faults are injected by. */
const TX_OP: Record<string, string> = {
  authCaptureTransaction: "charge",
  authOnlyTransaction: "authorize",
  refundTransaction: "refund",
  voidTransaction: "void",
  priorAuthCaptureTransaction: "capture",
};
const anet = (status: number, body: unknown) =>
  new Response(BOM + JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
const minorOf = (v: string) => BigInt(Math.round(Number(v) * 100));
const decimal = (m: bigint) => (Number(m) / 100).toFixed(2);
/** The account's Signature Key (128 hex) for a world secret. */
const signatureKey = (secret: string) =>
  createHash("sha512").update(secret).digest("hex").toUpperCase();

interface Tx {
  transId: string;
  type: string;
  status: string;
  amount: string;
  invoiceNumber: string | null;
  description?: string;
  refTransId?: string;
  cp?: string;
  pp?: string;
  submitted: number;
  reasonCode: string;
  /** An eCheck: pending until its batch settles. */
  bank?: boolean;
  /** When the status first entered a settled one: its batch's settlement time. */
  settledAt?: number;
}
interface PayProfile {
  cp: string;
  declines: boolean;
}

class FakeAuthorizenet extends FakeGateway {
  readonly host = HOST;
  private readonly base = String(Date.now());
  private n = 0;
  readonly profiles = new Map<string, string>();
  readonly payProfiles = new Map<string, PayProfile>();
  readonly txs = new Map<string, Tx>();
  readonly webhooks = new Map<
    string,
    { webhookId: string; name: string; url: string; eventTypes: string[]; status: string }
  >();
  skewMs = 0;
  /** The next charge is held by the Fraud Detection Suite (responseCode 4, reason 252). */
  holdNext = false;
  /** The next charge debits a bank account (an eCheck). */
  echeckNext = false;
  /** The Transaction Details API answers E00011 (the merchant has not enabled it). */
  listsRefused = false;
  /** A charge create's answer was lost: the next list read is the lost-answer lookup. */
  private answerLost = false;

  /** All digits, run-unique (the engine looks ids up across the whole database). */
  num(): string {
    return `${this.base}${String(++this.n).padStart(5, "0")}`;
  }
  now() {
    return Date.now() + this.skewMs;
  }
  tx(id: string): Tx {
    const t = this.txs.get(id);
    if (!t) throw new Error(`fake Authorize.net has no transaction ${id}`);
    return t;
  }
  newTx(over: Partial<Tx> & { type: string; status: string; amount: string }): Tx {
    const { status, ...rest } = over;
    const t = {
      transId: this.num(),
      invoiceNumber: null,
      submitted: this.now(),
      reasonCode: "1",
      ...rest,
    } as Tx;
    // Settling stamps the batch time, however a row sets the status.
    let current = "";
    Object.defineProperty(t, "status", {
      enumerable: true,
      get: () => current,
      set: (v: string) => {
        current = v;
        if (SETTLED.has(v)) t.settledAt ??= this.now();
      },
    });
    t.status = status;
    this.txs.set(t.transId, t);
    return t;
  }
  /** A refund of `sale` as the Merchant Interface makes one (no reference of ours). */
  newRefund(
    sale: Tx,
    amountMinor: bigint,
    status = "refundPendingSettlement",
    invoiceNumber: string | null = null,
  ): Tx {
    return this.newTx({
      type: "refundTransaction",
      status,
      amount: decimal(amountMinor),
      invoiceNumber,
      refTransId: sale.transId,
      cp: sale.cp,
      pp: sale.pp,
    });
  }
  refundedMinor(sale: Tx): bigint {
    return [...this.txs.values()]
      .filter(
        (r) =>
          r.refTransId === sale.transId && r.type === "refundTransaction" && !REFUSED.has(r.status),
      )
      .reduce((s, r) => s + minorOf(r.amount), 0n);
  }

  view(t: Tx) {
    return {
      transId: t.transId,
      ...(t.refTransId ? { refTransId: t.refTransId } : {}),
      submitTimeUTC: new Date(t.submitted).toISOString(),
      transactionType: t.type,
      transactionStatus: t.status,
      responseCode: REFUSED.has(t.status) ? 2 : REVIEW.has(t.status) ? 4 : 1,
      responseReasonCode: Number(t.reasonCode),
      responseReasonDescription: t.reasonCode === "1" ? "Approval" : "Declined",
      authAmount: Number(t.amount),
      settleAmount: Number(t.amount),
      order: {
        ...(t.invoiceNumber ? { invoiceNumber: t.invoiceNumber } : {}),
        ...(t.description ? { description: t.description } : {}),
      },
      payment: t.bank
        ? {
            bankAccount: {
              accountType: "checking",
              routingNumber: "XXXX0028",
              accountNumber: "XXXX7891",
              nameOnAccount: "Conformance Payer",
              echeckType: "WEB",
            },
          }
        : { creditCard: { cardNumber: "XXXX1111", expirationDate: "XXXX", cardType: "Visa" } },
      ...(t.cp ? { profile: { customerProfileId: t.cp, customerPaymentProfileId: t.pp } } : {}),
    };
  }

  private listOp(): string {
    if (!this.answerLost) return "list";
    this.answerLost = false;
    return "lookup";
  }

  private result(t: Tx, refId: unknown, code: "1" | "2" | "4") {
    return anet(200, {
      transactionResponse: {
        responseCode: code,
        authCode: code === "1" ? "CONF01" : "",
        transId: t.transId,
        ...(t.refTransId ? { refTransID: t.refTransId } : {}),
        accountNumber: t.bank ? "XXXX7891" : "XXXX1111",
        accountType: t.bank ? "eCheck" : "Visa",
        ...(code === "2"
          ? { errors: [{ errorCode: "2", errorText: "This transaction has been declined." }] }
          : {
              messages: [
                { code: t.reasonCode, description: "This transaction has been approved." },
              ],
            }),
      },
      refId,
      messages: code === "2" ? UNSUCCESSFUL : OK,
    });
  }
  private error(refId: unknown, reason: string, text: string, transId = "0") {
    return anet(200, {
      transactionResponse: {
        responseCode: "3",
        transId,
        errors: [{ errorCode: reason, errorText: text }],
      },
      refId,
      messages: UNSUCCESSFUL,
    });
  }

  /** `createTransactionRequest`, by transaction type. */
  private transaction(r: Record<string, unknown>): Response {
    const refId = r.refId;
    const tr = r.transactionRequest as Record<string, any>;
    const type = String(tr.transactionType);
    const settings = (tr.transactionSettings?.setting ?? []) as Array<{
      settingName: string;
      settingValue: string;
    }>;
    const windowS = Number(
      settings.find((s) => s.settingName === "duplicateWindow")?.settingValue ?? 120,
    );
    const invoiceNumber = tr.order?.invoiceNumber ?? null;
    const pp = tr.profile?.paymentProfile?.paymentProfileId as string | undefined;

    // Reason 11 (DOC.codes): same type, amount, invoice number and card inside the window.
    // With `duplicateWindow` sent, the answer names the original transaction.
    if (["authCaptureTransaction", "authOnlyTransaction", "refundTransaction"].includes(type)) {
      const dup = [...this.txs.values()].find(
        (t) =>
          t.type === type &&
          t.amount === tr.amount &&
          t.invoiceNumber === invoiceNumber &&
          (t.pp ?? t.refTransId) === (pp ?? tr.refTransId) &&
          this.now() - t.submitted <= windowS * 1000,
      );
      if (dup)
        return this.error(refId, "11", "A duplicate transaction has been submitted.", dup.transId);
    }
    if (type === "authCaptureTransaction" || type === "authOnlyTransaction") {
      const prof = pp ? this.payProfiles.get(pp) : undefined;
      if (!prof)
        return anet(200, {
          messages: {
            resultCode: "Error",
            message: [{ code: "E00040", text: "The record cannot be found." }],
          },
        });
      const held = this.holdNext;
      const status = prof.declines
        ? "declined"
        : held
          ? "FDSPendingReview"
          : type === "authOnlyTransaction"
            ? "authorizedPendingCapture"
            : "capturedPendingSettlement";
      const t = this.newTx({
        type,
        status,
        amount: String(tr.amount),
        invoiceNumber,
        description: tr.order?.description,
        cp: tr.profile.customerProfileId,
        pp,
        reasonCode: prof.declines ? "2" : held ? "252" : "1",
        ...(this.echeckNext ? { bank: true } : {}),
      });
      return this.result(t, refId, prof.declines ? "2" : held ? "4" : "1");
    }
    const orig = this.txs.get(String(tr.refTransId));
    if (!orig) return this.error(refId, "16", "The transaction cannot be found.");
    if (type === "refundTransaction") {
      if (orig.status !== "settledSuccessfully")
        return this.error(
          refId,
          "54",
          "The referenced transaction does not meet the criteria for issuing a credit.",
        );
      if (minorOf(String(tr.amount)) + this.refundedMinor(orig) > minorOf(orig.amount))
        return this.error(
          refId,
          "55",
          "The sum of credits against the referenced transaction would exceed original debit amount.",
        );
      const t = this.newRefund(
        orig,
        minorOf(String(tr.amount)),
        "refundPendingSettlement",
        invoiceNumber,
      );
      return this.result(t, refId, "1");
    }
    if (type === "voidTransaction") {
      if (orig.status === "voided")
        return anet(200, {
          transactionResponse: {
            responseCode: "1",
            transId: orig.transId,
            messages: [{ code: "310", description: "This transaction has already been voided." }],
          },
          refId,
          messages: OK,
        });
      if (!VOIDABLE.has(orig.status) && orig.status !== "refundPendingSettlement")
        return this.error(refId, "16", "The transaction cannot be found.");
      orig.status = "voided";
      return this.result(orig, refId, "1");
    }
    if (type === "priorAuthCaptureTransaction") {
      orig.status = "capturedPendingSettlement";
      return this.result(orig, refId, "1");
    }
    return this.error(refId, "3", "A referenced transaction is required.");
  }

  private refused() {
    return anet(200, {
      messages: {
        resultCode: "Error",
        message: [
          { code: "E00011", text: "Access denied. You do not have the appropriate permissions." },
        ],
      },
    });
  }

  /**
   * `getSettledBatchList`: batches settled in the inclusive date range, by batch id ascending;
   * no dates = the past 24 hours (DOC.apiref, Get Settled Batch List).
   */
  private batches(r: Record<string, any>): Response {
    if (this.listsRefused) return this.refused();
    const last = r.lastSettlementDate ? Date.parse(r.lastSettlementDate) : this.now();
    const first = r.firstSettlementDate ? Date.parse(r.firstSettlementDate) : last - DAY_MS;
    // "cannot exceed 31 days" (DOC.apiref); the refusal's code is undocumented.
    if (last - first > 31 * DAY_MS)
      return anet(200, {
        messages: {
          resultCode: "Error",
          message: [{ code: "E00001", text: "The date range cannot exceed 31 days." }],
        },
      });
    const times = new Map<string, number>();
    for (const t of this.txs.values()) {
      if (t.settledAt == null) continue;
      const id = batchIdOf(t.settledAt);
      times.set(id, Math.max(times.get(id) ?? 0, toSecond(t.settledAt)));
    }
    const batchList = [...times]
      .filter(([, at]) => at >= toSecond(first) && at <= toSecond(last))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([batchId, at]) => ({
        batchId,
        settlementTimeUTC: new Date(at).toISOString().replace(/\.\d{3}Z$/, "Z"),
        settlementState: "settledSuccessfully",
        paymentMethod: "creditCard",
        marketType: "eCommerce",
      }));
    return anet(200, { batchList, messages: OK });
  }

  private list(root: string, r: Record<string, any>): Response {
    if (this.listsRefused) return this.refused();
    const limit = Number(r.paging?.limit ?? 1000);
    const page = Number(r.paging?.offset ?? 1);
    const pool = [...this.txs.values()]
      .filter((t) =>
        root === "getUnsettledTransactionListRequest"
          ? !SETTLED.has(t.status)
          : root === "getTransactionListRequest"
            ? t.settledAt != null && batchIdOf(t.settledAt) === r.batchId
            : SETTLED.has(t.status) && t.cp === r.customerProfileId,
      )
      .sort((a, b) => b.submitted - a.submitted);
    const transactions = pool.slice((page - 1) * limit, page * limit).map((t) => ({
      transId: t.transId,
      submitTimeUTC: new Date(t.submitted).toISOString(),
      transactionStatus: t.status,
      ...(t.invoiceNumber ? { invoiceNumber: t.invoiceNumber } : {}),
      accountType: t.bank ? "eCheck" : "Visa",
      accountNumber: t.bank ? "XXXX7891" : "XXXX1111",
      settleAmount: Number(t.amount),
    }));
    return anet(200, { transactions, totalNumInResultSet: pool.length, messages: OK });
  }

  async route(req: FakeRequest): Promise<Response | null> {
    if (req.path.startsWith("/rest/v1/webhooks")) return this.rest(req);
    if (req.method !== "POST" || req.path !== "/xml/v1/request.api") return null;
    const root = Object.keys(req.body)[0] ?? "";
    const r = (req.body[root] ?? {}) as Record<string, any>;
    switch (root) {
      case "authenticateTestRequest":
        return anet(200, { messages: OK });
      case "getMerchantDetailsRequest":
        return anet(200, { publicClientKey: "conformancePublicClientKey000001", messages: OK });
      case "createCustomerProfileRequest": {
        const ref = r.profile?.merchantCustomerId;
        const existing = [...this.profiles].find(([, m]) => m === ref)?.[0];
        if (existing)
          return anet(200, {
            messages: {
              resultCode: "Error",
              message: [
                { code: "E00039", text: `A duplicate record with ID ${existing} already exists.` },
              ],
            },
          });
        const cp = this.num();
        this.profiles.set(cp, ref);
        return anet(200, { customerProfileId: cp, customerPaymentProfileIdList: [], messages: OK });
      }
      case "updateCustomerProfileRequest":
      case "deleteCustomerPaymentProfileRequest":
        return anet(200, { messages: OK });
      case "createCustomerPaymentProfileRequest": {
        const pp = this.num();
        const value = String(r.paymentProfile?.payment?.opaqueData?.dataValue ?? "");
        this.payProfiles.set(pp, {
          cp: String(r.customerProfileId),
          declines: value.startsWith("conf-declines"),
        });
        return anet(200, {
          customerProfileId: String(r.customerProfileId),
          customerPaymentProfileId: pp,
          validationDirectResponse:
            "1,1,1,(TESTMODE) This transaction has been approved.,000000,P,0,none,Test transaction for ValidateCustomerPaymentProfile.,0.00,CC,auth_only",
          messages: OK,
        });
      }
      case "getCustomerPaymentProfileRequest": {
        const p = this.payProfiles.get(String(r.customerPaymentProfileId));
        if (!p)
          return anet(200, {
            messages: {
              resultCode: "Error",
              message: [{ code: "E00040", text: "The record cannot be found." }],
            },
          });
        return anet(200, {
          paymentProfile: {
            customerProfileId: p.cp,
            customerPaymentProfileId: String(r.customerPaymentProfileId),
            payment: {
              creditCard: { cardNumber: "XXXX1111", expirationDate: "2034-12", cardType: "Visa" },
            },
          },
          messages: OK,
        });
      }
      case "getTransactionDetailsRequest": {
        const t = this.txs.get(String(r.transId));
        if (!t)
          return anet(200, {
            messages: {
              resultCode: "Error",
              message: [{ code: "E00040", text: "The record cannot be found." }],
            },
          });
        return anet(200, { transaction: this.view(t), messages: OK });
      }
      case "getUnsettledTransactionListRequest":
      case "getTransactionListForCustomerRequest":
      case "getTransactionListRequest":
        return this.guarded(this.listOp(), req, () => this.list(root, r));
      case "getSettledBatchListRequest":
        return this.guarded(this.listOp(), req, () => this.batches(r));
      case "createTransactionRequest": {
        const type = String(r.transactionRequest?.transactionType);
        const op = TX_OP[type] ?? "transaction";
        try {
          return await this.guarded(op, req, () => this.transaction(r));
        } catch (e) {
          if (op === "charge") this.answerLost = true;
          throw e;
        }
      }
    }
    return anet(200, {
      messages: {
        resultCode: "Error",
        message: [{ code: "E00003", text: `Unsupported by the conformance fake: ${root}` }],
      },
    });
  }

  private rest(req: FakeRequest): Response {
    const id = req.path.split("/")[4];
    const list = () => [...this.webhooks.values()];
    if (req.method === "GET" && !id) return anet(200, list());
    if (req.method === "POST") {
      const w = {
        webhookId: randomUUID(),
        name: String(req.body.name ?? ""),
        url: String(req.body.url),
        eventTypes: req.body.eventTypes as string[],
        status: String(req.body.status ?? "active"),
      };
      this.webhooks.set(w.webhookId, w);
      return anet(200, w);
    }
    const w = id ? this.webhooks.get(decodeURIComponent(id)) : undefined;
    if (!w) return anet(404, { status: 404, reason: "ERROR_RESOURCE_NOT_FOUND" });
    if (req.method === "PUT") Object.assign(w, req.body);
    if (req.method === "DELETE") this.webhooks.delete(w.webhookId);
    return anet(200, w);
  }
}

class AuthorizenetDriver implements GatewayDriver {
  readonly fake = new FakeAuthorizenet();
  readonly forgedStatus = 400;
  readonly chargeOp = "charge";
  readonly refundOp = "refund";
  readonly lookupOp = "lookup";
  readonly errors = {
    // No 409 is documented (S8.charge-409 is n/a); kept for the type.
    conflict: {
      status: 409,
      body: {
        messages: {
          resultCode: "Error",
          message: [
            { code: "E00001", text: "An error occurred during processing. Please try again." },
          ],
        },
      },
    },
    rateLimited: {
      status: 429,
      body: {
        messages: {
          resultCode: "Error",
          message: [
            { code: "E00001", text: "An error occurred during processing. Please try again." },
          ],
        },
      },
    },
    server: {
      status: 500,
      body: {
        messages: {
          resultCode: "Error",
          message: [
            { code: "E00001", text: "An error occurred during processing. Please try again." },
          ],
        },
      },
    },
    // Reason 19: Authorize.net got no answer from the processor (DOC.codes).
    internal: {
      status: 200,
      body: {
        transactionResponse: {
          responseCode: "3",
          transId: "0",
          errors: [
            {
              errorCode: "19",
              errorText: "An error occurred during processing.  Please try again.",
            },
          ],
        },
        messages: UNSUCCESSFUL,
      },
    },
    refundRefused: {
      status: 200,
      body: {
        transactionResponse: {
          responseCode: "3",
          transId: "0",
          errors: [
            {
              errorCode: "55",
              errorText:
                "The sum of credits against the referenced transaction would exceed original debit amount.",
            },
          ],
        },
        messages: UNSUCCESSFUL,
      },
    },
  };

  credentials(webhookSecret: string) {
    return {
      api_login_id: "conformLogin01",
      transaction_key: "conform00000Key1",
      signature_key: signatureKey(webhookSecret),
      api_base: HOST,
    };
  }
  token(kind: TokenKind) {
    return kind === "pays" ? `conf-pays-${randomUUID()}` : null;
  }
  sign(_w: World, body: string, secret: string) {
    return { "x-anet-signature": signAuthorizenetPayload(signatureKey(secret), body) };
  }

  /** A notification as WH shows it; `payload.id` is the transaction (or profile) id. */
  event(eventType: string, payload: Record<string, unknown>): Body {
    const notificationId = randomUUID();
    return {
      body: JSON.stringify({
        notificationId,
        eventType: `net.authorize.${eventType}`,
        eventDate: new Date().toISOString(),
        webhookId: "00000000-0000-4000-8000-00000000c0f1",
        payload,
      }),
      eventIds: [`anet_${notificationId}`],
    };
  }
  txEvent(
    eventType: string,
    t: Tx,
    responseCode = REFUSED.has(t.status) ? 2 : REVIEW.has(t.status) ? 4 : 1,
  ) {
    return this.event(eventType, {
      responseCode,
      authCode: responseCode === 1 ? "CONF01" : "",
      avsResponse: "Y",
      authAmount: Number(t.amount),
      ...(t.invoiceNumber ? { merchantReferenceId: t.invoiceNumber } : {}),
      entityName: "transaction",
      id: t.transId,
    });
  }

  collect(_w: World, id: string) {
    // The daily batch settles it; Authorize.net sends no event for that.
    this.fake.tx(id).status = "settledSuccessfully";
    return [];
  }
  paymentSucceeded(_w: World, id: string) {
    const t = this.fake.tx(id);
    if (!["settledSuccessfully", "capturedPendingSettlement"].includes(t.status))
      t.status = "capturedPendingSettlement";
    return [this.txEvent("payment.authcapture.created", t)];
  }
  paymentFailed(_w: World, id: string) {
    const t = this.fake.tx(id);
    t.status = "declined";
    return [this.txEvent("payment.authcapture.created", t)];
  }
  refundEvent(_w: World, _id: string, refundId: string, state: RefundState) {
    const r = this.fake.tx(refundId);
    if (state === "pending") return [];
    if (state === "failed") {
      // A refund is undone by voiding it before the batch settles.
      r.status = "voided";
      return [this.txEvent("payment.void.created", r, 1)];
    }
    return [this.txEvent("payment.refund.created", r)];
  }
  dashboardRefund(_w: World, id: string, amountMinor: bigint) {
    const r = this.fake.newRefund(this.fake.tx(id), amountMinor);
    return { refundId: r.transId, events: [this.txEvent("payment.refund.created", r)] };
  }
  disputeSteps() {
    return null;
  }
  chargesOn(pp: string) {
    return [...this.fake.txs.values()]
      .filter((t) => t.type === "authCaptureTransaction" && t.pp === pp && !REFUSED.has(t.status))
      .map((t) => t.transId);
  }

  statusEvent(_w: World, s: DocumentedStatus, id: string): Body[] {
    const sale = this.fake.tx(id);
    if (s.object === "transaction") {
      sale.status = s.status;
      return [this.txEvent("payment.authcapture.created", sale)];
    }
    if (s.object === "refund")
      return [this.txEvent("payment.refund.created", this.fake.newRefund(sale, 500n, s.status), 1)];
    const type = s.status.replace(/^net\.authorize\./, "");
    const fresh = (status: string, txType = "authCaptureTransaction") =>
      this.fake.newTx({ type: txType, status, amount: sale.amount, cp: sale.cp, pp: sale.pp });
    switch (type) {
      case "payment.authorization.created":
        return [this.txEvent(type, fresh("authorizedPendingCapture", "authOnlyTransaction"))];
      case "payment.refund.created":
        return [this.txEvent(type, this.fake.newRefund(sale, 500n), 1)];
      case "payment.void.created":
        return [this.txEvent(type, fresh("voided"), 1)];
      case "payment.fraud.held":
        return [this.txEvent(type, fresh("FDSPendingReview"))];
      case "payment.fraud.approved":
        return [this.txEvent(type, fresh("capturedPendingSettlement"))];
      case "payment.fraud.declined":
        return [this.txEvent(type, fresh("declined"))];
      case "customer.paymentProfile.created":
      case "customer.paymentProfile.updated":
      case "customer.paymentProfile.deleted":
        return [
          this.event(type, {
            customerProfileId: Number(sale.cp),
            entityName: "customerPaymentProfile",
            id: sale.pp,
          }),
        ];
    }
    if (type.startsWith("customer.subscription."))
      return [
        this.event(type, {
          name: "Conformance plan",
          amount: 100,
          status: "active",
          entityName: "subscription",
          id: "9000001",
        }),
      ];
    if (type.startsWith("customer."))
      return [this.event(type, { entityName: "customerProfile", id: sale.cp })];
    return [this.txEvent(type, sale)];
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
const tx = (s: string, expect: DocumentedStatus["expect"]) =>
  st("transaction", s, "transaction-status", expect);
const ev = (s: string, expect: DocumentedStatus["expect"]) =>
  st("event", `net.authorize.${s}`, "webhook-events", expect);
const NO_MONEY = { none: "A customer profile event carries no money." };
const NO_ARB = {
  none: "Authorize.net's own recurring billing (ARB) is never used: the engine owns subscriptions.",
};

const adapterOf = async (w: World) => {
  const [acc] = await systemDb
    .select()
    .from(gatewayAccounts)
    .where(eq(gatewayAccounts.id, w.account.id));
  return resolveAdapter(acc!) as unknown as AuthorizenetProvider;
};
/** Engine modules load inside a row: `gateway-docs:recheck` imports this file without the app. */
const engine = async () => ({
  ...(await import("../harness")),
  ...(await import("@/platform/clock")),
  ...(await import("@/modules/payments/stale-pending")),
  ...(await import("@/modules/refunds/service")),
  ...(await import("@/modules/gateway/settlement-report")),
  ...(await import("@/modules/payments/pending-debit")),
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
/** A direct adapter charge on a fresh vaulted card, for rows about the duplicate window. */
async function directCharge(w: World, key: string, pp: { cp: string; pp: string }) {
  return (await adapterOf(w))
    .charge({
      amountMinor: 4200n,
      currency: "USD",
      customer: { providerKey: "authorizenet", providerCustomerId: pp.cp },
      paymentMethod: {
        providerKey: "authorizenet",
        providerPaymentMethodId: pp.pp,
        providerCustomerId: pp.cp,
        display: {} as never,
      },
      idempotencyKey: key,
    })
    .catch((e: Error) => e);
}
async function vaulted(w: World) {
  const d = w.driver as AuthorizenetDriver;
  const b = await w.bill();
  const t = d.fake.tx(b.chargeId);
  return { b, cp: t.cp!, pp: t.pp! };
}

export const authorizenetFixture: GatewayFixture = {
  key: "authorizenet",
  currency: "USD",
  docs: [
    {
      id: "transaction-status",
      url: DOC.xsd,
      read: READ,
      check: { kind: "xsd-enum", type: "transactionStatusEnum" },
    },
    { id: "webhook-events", url: DOC.webhooks, read: READ, check: { kind: "page" } },
    { id: "echeck", url: DOC.echeck, read: ECHECK_READ, check: { kind: "page" } },
  ],
  statuses: [
    tx("authorizedPendingCapture", ["charge.pending"]),
    tx("capturedPendingSettlement", ["charge.succeeded"]),
    tx("communicationError", ["charge.failed"]),
    st("refund", "refundSettledSuccessfully", "transaction-status", ["charge.refunded"]),
    st("refund", "refundPendingSettlement", "transaction-status", ["charge.refunded"]),
    tx("approvedReview", ["charge.pending"]),
    tx("declined", ["charge.failed"]),
    // The void failed, so the money is still captured.
    tx("couldNotVoid", ["charge.succeeded"]),
    tx("expired", ["charge.failed"]),
    tx("generalError", ["charge.failed"]),
    tx("pendingFinalSettlement", ["charge.succeeded"]),
    tx("pendingSettlement", ["charge.succeeded"]),
    tx("failedReview", ["charge.failed"]),
    tx("settledSuccessfully", ["charge.succeeded"]),
    tx("settlementError", ["charge.failed"]),
    tx("underReview", ["charge.pending"]),
    tx("updatingSettlement", ["charge.succeeded"]),
    tx("voided", ["charge.failed"]),
    tx("FDSPendingReview", ["charge.pending"]),
    tx("FDSAuthorizedPendingReview", ["charge.pending"]),
    // eCheck: an ACH return, an unauthorized-debit claim, and that claim reversed. No webhook
    // reports them; the settlement poll reads them from eCheck batches (rows below).
    tx("returnedItem", ["charge.failed"]),
    tx("chargeback", ["charge.failed"]),
    tx("chargebackReversal", ["charge.succeeded"]),
    tx("authorizedPendingRelease", ["charge.pending"]),
    ev("payment.authcapture.created", ["charge.succeeded"]),
    ev("payment.authorization.created", ["intent.authorized"]),
    ev("payment.capture.created", {
      none: "We never send a capture-only transaction; captures are prior-auth captures.",
    }),
    ev("payment.priorAuthCapture.created", ["charge.succeeded"]),
    ev("payment.refund.created", ["charge.refunded"]),
    ev("payment.void.created", ["charge.refunded"]),
    ev("payment.fraud.held", ["review.opened"]),
    ev("payment.fraud.approved", ["charge.succeeded", "review.closed"]),
    ev("payment.fraud.declined", ["charge.failed", "review.closed"]),
    ev("customer.created", NO_MONEY),
    ev("customer.deleted", NO_MONEY),
    ev("customer.updated", NO_MONEY),
    ev("customer.paymentProfile.created", NO_MONEY),
    ev("customer.paymentProfile.updated", ["payment_method.updated"]),
    ev("customer.paymentProfile.deleted", ["payment_method.detached"]),
    ev("customer.subscription.cancelled", NO_ARB),
    ev("customer.subscription.created", NO_ARB),
    ev("customer.subscription.expired", NO_ARB),
    ev("customer.subscription.expiring", NO_ARB),
    ev("customer.subscription.failed", NO_ARB),
    ev("customer.subscription.suspended", NO_ARB),
    ev("customer.subscription.terminated", NO_ARB),
    ev("customer.subscription.updated", NO_ARB),
  ],
  na: {
    S5: `No dispute webhook or API exists (${DOC.webhooks}, read ${READ}); the adapter declares \`disputeFeed: false\` and operators record disputes.`,
    "S6.after-failure":
      "A declined Authorize.net transaction is final; a retry is a new transaction with a new id.",
    "S8.charge-409": `The API answers every request with HTTP 200 and documents no 409; a repeat inside \`duplicateWindow\` is reason 11 (${DOC.codes}, read ${READ}), covered by S7.duplicate-window.`,
    S9: `No event follows a card charge after capture: no webhook exists for settlement (${DOC.webhooks}, read ${READ}). The settlement poll reads it from the batch report: S9.settlement-error-after-success.`,
    // Rows below replace the generic body, which vaults a bank token directly: Authorize.net
    // saves a bank account only after the payer accepts our ACH authorization.
    S10: `An eCheck is pending until its batch settles, and only a void stops it then (${DOC.echeck}, read ${ECHECK_READ}). The S10 rows bill an eCheck through the fake.`,
    S13: `Authorize.net webhooks carry no version; one payload shape (${DOC.webhooks}, read ${READ}).`,
  },
  limits: [
    {
      op: "charge",
      field: "createTransactionRequest.transactionRequest.order.invoiceNumber",
      max: 20,
      source: DOC.xsd,
    },
    {
      op: "charge",
      field: "createTransactionRequest.transactionRequest.order.description",
      max: 255,
      source: DOC.xsd,
    },
    { op: "charge", field: "createTransactionRequest.refId", max: 20, source: DOC.apiref },
  ],
  driver: () => new AuthorizenetDriver(),
  extraRows: [
    {
      scenario: "S1",
      id: "S1.fraud-approved-declined",
      title: "fraud.approved on a held charge the issuer then declined is not booked as paid",
      async run({ world }) {
        const w = await world("s1fd");
        const d = w.driver as AuthorizenetDriver;
        d.fake.holdNext = true;
        const b = await w.bill().finally(() => (d.fake.holdNext = false));
        const cash0 = await w.cash();
        const t = d.fake.tx(b.chargeId);
        t.status = "declined";
        await w.deliver(d.txEvent("payment.fraud.approved", t, 1));
        const inv = await w.invoiceStatus(b.invoiceId);
        return {
          pass: (await w.cash()) === cash0 && inv !== "paid",
          detail: `cash ${(await w.cash()) - cash0} invoice ${inv}`,
        };
      },
    },
    {
      scenario: "S1",
      id: "S1.fraud-approved-still-held",
      title:
        "fraud.approved while the transaction still reads FDSPendingReview is not booked as paid",
      async run({ world }) {
        const w = await world("s1fh");
        const d = w.driver as AuthorizenetDriver;
        d.fake.holdNext = true;
        const b = await w.bill().finally(() => (d.fake.holdNext = false));
        const cash0 = await w.cash();
        await w.deliver(d.txEvent("payment.fraud.approved", d.fake.tx(b.chargeId), 1));
        const inv = await w.invoiceStatus(b.invoiceId);
        return {
          pass: (await w.cash()) === cash0 && inv !== "paid",
          detail: `cash ${(await w.cash()) - cash0} invoice ${inv}`,
        };
      },
    },
    {
      scenario: "S10",
      id: "S10.echeck-cancels",
      title: "a pending eCheck is voided: no money moves, and a repeat is harmless",
      async run({ world }) {
        const { cancelPendingDebit } = await engine();
        const w = await world("s10ec");
        const d = w.driver as AuthorizenetDriver;
        d.fake.echeckNext = true;
        const b = await w.bill().finally(() => (d.fake.echeckNext = false));
        if (b.paymentStatus !== "pending")
          return { pass: false, detail: `setup: payment ${b.paymentStatus}` };
        const cash0 = await w.cash();
        const cancel = () =>
          cancelPendingDebit({
            organizationId: w.org.id,
            businessId: w.biz.id,
            paymentId: b.paymentId!,
            purpose: "operator",
          });
        const r = await cancel();
        const again = await cancel();
        const after = await w.reload(b);
        return {
          pass:
            r.outcome === "cancelled" &&
            again.outcome !== "cancelled" &&
            d.fake.tx(b.chargeId).status === "voided" &&
            after.paymentStatus === "failed" &&
            after.failureCode === "debit_cancelled" &&
            (await w.cash()) === cash0 &&
            (await w.balanced()),
          detail: `${r.outcome}/${again.outcome} tx ${d.fake.tx(b.chargeId).status} payment ${after.paymentStatus} ${after.failureCode} cash ${(await w.cash()) - cash0}`,
        };
      },
    },
    {
      scenario: "S10",
      id: "S10.echeck-settled-is-final",
      title: "an eCheck that settled before the cancel is booked as paid, not voided",
      async run({ world }) {
        const { cancelPendingDebit } = await engine();
        const w = await world("s10es");
        const d = w.driver as AuthorizenetDriver;
        d.fake.echeckNext = true;
        const b = await w.bill().finally(() => (d.fake.echeckNext = false));
        const cash0 = await w.cash();
        d.fake.tx(b.chargeId).status = "settledSuccessfully";
        const r = await cancelPendingDebit({
          organizationId: w.org.id,
          businessId: w.biz.id,
          paymentId: b.paymentId!,
          purpose: "operator",
        });
        const inv = await w.invoiceStatus(b.invoiceId);
        return {
          pass:
            r.outcome === "settled" &&
            inv === "paid" &&
            (await w.cash()) === cash0 + b.amountMinor &&
            (await w.balanced()),
          detail: `${r.outcome} invoice ${inv} cash ${(await w.cash()) - cash0}`,
        };
      },
    },
    {
      scenario: "S10",
      id: "S10.echeck-dashboard-void",
      title:
        "a Merchant Interface void of a pending eCheck books the debit cancelled: no refund, invoice still due",
      async run({ world }) {
        const w = await world("s10ev");
        const d = w.driver as AuthorizenetDriver;
        d.fake.echeckNext = true;
        const b = await w.bill().finally(() => (d.fake.echeckNext = false));
        const cash0 = await w.cash();
        const t = d.fake.tx(b.chargeId);
        t.status = "voided";
        await w.deliver(d.txEvent("payment.void.created", t, 1));
        const n = await w.entries();
        await w.redeliver();
        const after = await w.reload(b);
        const inv = await w.invoiceStatus(b.invoiceId);
        const rows = await w.refundRows(b.paymentId!);
        return {
          pass:
            after.paymentStatus === "failed" &&
            after.failureCode === "debit_cancelled" &&
            inv !== "paid" &&
            rows.length === 0 &&
            (await w.cash()) === cash0 &&
            (await w.entries()) === n &&
            (await w.balanced()),
          detail: `payment ${after.paymentStatus} ${after.failureCode} invoice ${inv} refunds ${rows.length} cash ${(await w.cash()) - cash0}`,
        };
      },
    },
    {
      scenario: "S10",
      id: "S10.echeck-swept-before-webhook",
      title:
        "a voided eCheck found by the stale-pending sweep before its webhook books as the webhook does",
      async run({ world }) {
        const { sweptCancelBeforeWebhook } = await engine();
        const w = await world("s10sw");
        const d = w.driver as AuthorizenetDriver;
        d.fake.echeckNext = true;
        const b = await w.bill().finally(() => (d.fake.echeckNext = false));
        if (b.paymentStatus !== "pending")
          return { pass: false, detail: `setup: payment ${b.paymentStatus}` };
        const t = d.fake.tx(b.chargeId);
        t.status = "voided";
        return sweptCancelBeforeWebhook(w, b, () => d.txEvent("payment.void.created", t, 1));
      },
    },
    {
      scenario: "S3",
      id: "S3.late-event-own-amount",
      title:
        "two Merchant Interface refunds whose events arrive newest first are each booked at their own amount",
      async run({ world }) {
        const w = await world("s3le");
        const d = w.driver as AuthorizenetDriver;
        const b = await w.collected();
        const cash0 = await w.cash();
        const sale = d.fake.tx(b.chargeId);
        const first = d.fake.newRefund(sale, 3000n);
        const second = d.fake.newRefund(sale, 2000n);
        await w.deliver(d.txEvent("payment.refund.created", second, 1));
        await w.deliver(d.txEvent("payment.refund.created", first, 1));
        const rows = await w.refundRows(b.paymentId!);
        const amounts = rows.map((r) => r.amountMinor).sort();
        return {
          pass: (await w.cash()) === cash0 - 5000n && amounts.join() === "2000,3000",
          detail: `cash ${(await w.cash()) - cash0} rows ${amounts.join(",")}`,
        };
      },
    },
    {
      scenario: "S4",
      id: "S4.refund-settlement-error",
      title: "our refund that a settled batch reports as settlementError is reversed once",
      async run({ world }) {
        const { refundPayment } = await engine();
        const w = await world("s4se");
        const d = w.driver as AuthorizenetDriver;
        const b = await w.collected();
        const cash0 = await w.cash();
        const r = await refundPayment({
          organizationId: w.org.id,
          businessId: w.biz.id,
          paymentPublicId: b.paymentPublicId!,
          amountMinor: 3000,
        }).catch((e: Error) => e);
        const refundId = [...d.fake.txs.values()].find(
          (t) => t.refTransId === b.chargeId && t.type === "refundTransaction",
        )?.transId;
        const booked = (await w.cash()) - cash0;
        if (refundId) d.fake.tx(refundId).status = "settlementError";
        await later(w, 25 * 3_600_000);
        await later(w, 31 * 3_600_000);
        const rows = await w.refundRows(b.paymentId!);
        return {
          pass:
            !(r instanceof Error) &&
            booked === -3000n &&
            (await w.cash()) === cash0 &&
            rows.length === 1 &&
            rows[0]!.status === "failed",
          detail: `refund ${r instanceof Error ? r.message : r.status}; booked ${booked}; cash after ${(await w.cash()) - cash0}; rows ${rows.map((x) => x.status)}`,
        };
      },
    },
    {
      scenario: "S6",
      id: "S6.void-captured-auth",
      title: "a Merchant Interface void of a captured authorization takes the payment back",
      async run({ world }) {
        // Unmeasured: whether a captured authorization reads back as `authOnlyTransaction`.
        const { AMOUNT } = await engine();
        const w = await world("s6va");
        const d = w.driver as AuthorizenetDriver;
        const b = await w.bill();
        const cash0 = await w.cash();
        const t = d.fake.tx(b.chargeId);
        t.type = "authOnlyTransaction";
        t.status = "voided";
        await w.deliver(d.txEvent("payment.void.created", t, 1));
        return {
          pass: (await w.cash()) === cash0 - AMOUNT,
          detail: `cash ${(await w.cash()) - cash0} (want -${AMOUNT})`,
        };
      },
    },
    {
      scenario: "S7",
      id: "S7.duplicate-window",
      title: "a repeat inside duplicateWindow (reason 11) adopts the original transaction",
      async run({ world }) {
        const w = await world("s7dw");
        const d = w.driver as AuthorizenetDriver;
        const v = await vaulted(w);
        const key = `conf_dup_${randomUUID()}`;
        const first = await directCharge(w, key, v);
        d.fake.listsRefused = true;
        const second = await directCharge(w, key, v).finally(() => (d.fake.listsRefused = false));
        const made = d.chargesOn(v.pp).length;
        const id = (r: unknown) =>
          r instanceof Error ? r.message : (r as { providerChargeId: string }).providerChargeId;
        return {
          pass:
            !(first instanceof Error) &&
            !(second instanceof Error) &&
            id(first) === id(second) &&
            made === 2,
          detail: `first ${id(first)} second ${id(second)} charges ${made} (the bill's and one)`,
        };
      },
    },
    {
      scenario: "S7",
      id: "S7.lookup-pages",
      title:
        "a key re-sent after the duplicate window finds its unsettled original behind 1000 newer transactions",
      async run({ world }) {
        const w = await world("s7lp");
        const d = w.driver as AuthorizenetDriver;
        const v = await vaulted(w);
        const key = `conf_page_${randomUUID()}`;
        const first = await directCharge(w, key, v);
        d.fake.skewMs += 1000;
        for (let i = 0; i < 1000; i++)
          d.fake.newTx({
            type: "authCaptureTransaction",
            status: "capturedPendingSettlement",
            amount: "1.00",
            invoiceNumber: `INV-OTHER-${i}`,
          });
        d.fake.skewMs += 28_800_000 + 60_000;
        const second = await directCharge(w, key, v);
        const made = d.chargesOn(v.pp).length;
        const id = (r: unknown) =>
          r instanceof Error ? r.message : (r as { providerChargeId: string }).providerChargeId;
        return {
          pass: id(first) === id(second) && made === 2,
          detail: `first ${id(first)} second ${id(second)} charges ${made} (want 2)`,
        };
      },
    },
    {
      scenario: "S8",
      id: "S8.void-refund-lost-answer",
      title:
        "a full refund before settlement (a void) whose answer is lost is booked once the void is known",
      async run({ world }) {
        const { AMOUNT, refundPayment } = await engine();
        const w = await world("s8vl");
        const d = w.driver as AuthorizenetDriver;
        const b = await w.bill();
        const cash0 = await w.cash();
        d.fake.inject("void", { kind: "network", afterCreate: true }, 1);
        const r = await refundPayment({
          organizationId: w.org.id,
          businessId: w.biz.id,
          paymentPublicId: b.paymentPublicId!,
        })
          .catch((e: Error) => e)
          .finally(() => d.fake.clearFaults());
        await w.deliver(d.txEvent("payment.void.created", d.fake.tx(b.chargeId), 1));
        const rows = await w.refundRows(b.paymentId!);
        return {
          pass: rows.some((x) => x.status === "succeeded") && (await w.cash()) === cash0 - AMOUNT,
          detail: `refund ${r instanceof Error ? `threw ${r.message.slice(0, 80)}` : r.status}; rows ${rows.map((x) => x.status)}; cash ${(await w.cash()) - cash0}`,
        };
      },
    },
    {
      scenario: "S8",
      id: "S8.refund-could-not-void",
      title:
        "a refund of a charge whose void failed (couldNotVoid, money still captured) is not told there is no money",
      async run({ world }) {
        const { refundPayment } = await engine();
        const w = await world("s8cv");
        const d = w.driver as AuthorizenetDriver;
        const b = await w.bill();
        d.fake.tx(b.chargeId).status = "couldNotVoid";
        const r = await refundPayment({
          organizationId: w.org.id,
          businessId: w.biz.id,
          paymentPublicId: b.paymentPublicId!,
        }).catch((e: Error) => e);
        const msg = r instanceof Error ? r.message : "";
        return {
          pass: !/no money to refund/i.test(msg),
          detail: msg.slice(0, 160) || "refund accepted",
        };
      },
    },
    {
      scenario: "S9",
      id: "S9.settlement-error-after-success",
      title: "a captured card charge that later reads settlementError is reversed",
      async run({ world }) {
        const { AMOUNT } = await engine();
        const w = await world("s9se");
        const d = w.driver as AuthorizenetDriver;
        const b = await w.bill();
        const cash0 = await w.cash();
        d.fake.tx(b.chargeId).status = "settlementError";
        const first = await later(w, 25 * 3_600_000);
        const reversed = (await w.cash()) === cash0 - AMOUNT;
        // A later pass re-reads the batch (lookback): booked once.
        await later(w, 31 * 3_600_000);
        await later(w, 8 * 86_400_000);
        const inv = await w.invoiceStatus(b.invoiceId);
        return {
          pass: reversed && (await w.cash()) === cash0 - AMOUNT && inv !== "paid",
          detail: `cash ${(await w.cash()) - cash0} invoice ${inv}; first poll ${first.events} events ${first.errors.map((e) => e.message).join("; ")}`,
        };
      },
    },
    {
      scenario: "S12",
      id: "S12.one-signature-form",
      title:
        "only one Signature Key form verifies: a body signed with the hex-decoded key is refused",
      async run({ world }) {
        const w = await world("s12sf");
        const d = w.driver as AuthorizenetDriver;
        const ev = d.event("customer.created", { entityName: "customerProfile", id: "900000001" });
        const hexSig = createHmac("sha512", Buffer.from(signatureKey(w.secret), "hex"))
          .update(ev.body)
          .digest("hex");
        const res = await w.app.inject({
          method: "POST",
          url: `/v1/gateway_webhooks/authorizenet?id=${w.account.publicId}`,
          headers: {
            "content-type": "application/json",
            host: new URL(w.notificationUrl).host,
            "x-anet-signature": `sha512=${hexSig}`,
          },
          payload: ev.body,
        });
        return {
          pass: res.statusCode === 400,
          detail: `hex-key signature answered ${res.statusCode}`,
        };
      },
    },
    {
      scenario: "S12",
      id: "S12.inactive-endpoint-reported",
      title: "an endpoint Authorize.net set inactive after its retries shows in the health check",
      async run({ world }) {
        const w = await world("s12ie");
        const d = w.driver as AuthorizenetDriver;
        const adapter = await adapterOf(w);
        if (d.fake.webhooks.size === 0)
          await adapter.provisionWebhookEndpoint({ url: w.notificationUrl });
        for (const hook of d.fake.webhooks.values()) hook.status = "inactive";
        const h = await adapter.healthCheck();
        return {
          pass: !h.ok || /inactive/i.test(h.detail ?? ""),
          detail: `healthCheck ok=${h.ok} detail ${h.detail ?? ""}`,
        };
      },
    },
  ],
};
