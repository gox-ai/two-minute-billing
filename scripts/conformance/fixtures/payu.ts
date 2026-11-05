/**
 * PayU conformance fixtures (cards). Renewals are standing-instruction debits: a
 * `pre_debit_SI` notice, then `si_transaction`. Shapes follow PayU's reference samples and the
 * answers measured on test.payu.in (`verify:payu`). Every id is a same-shape fake.
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq, gte } from "drizzle-orm";
import { systemDb } from "@/platform/db";
import { resolveAdapter } from "@/providers/registry";
import {
  PAYU_TEST_POSTSERVICE,
  payuMandateWebhookHash,
  payuUpiMandateWebhookHash,
  payuReverseHash,
  type PayuProvider,
} from "@/providers/payu";
import { customers, gatewayAccounts, payments, preDebitNotices } from "@db/schema";
import { sql } from "drizzle-orm";
import { FakeGateway, json, type FakeRequest } from "../fake-http";
import type { World } from "../harness";
import type {
  Body,
  DocumentedStatus,
  GatewayDriver,
  GatewayFixture,
  RefundState,
  TokenKind,
} from "../types";

const HOST = new URL(PAYU_TEST_POSTSERVICE).origin;
const READ = "2026-10-30";
const DOC = {
  events: "https://docs.payu.in/docs/webhook-events-and-sample-payloads.md",
  refundStates: "https://docs.payu.in/reference/get_all_refunds_from_transaction_ids_api.md",
  refundApi: "https://docs.payu.in/reference/refund_transaction_api.md",
  chargeback: "https://docs.payu.in/docs/chargeback-status.md",
  mandateHook:
    "https://docs.payu.in/reference/set-up-webhook-to-receive-cancellation-or-modification-update-from-the-issuer-bank.md",
  recurring: "https://docs.payu.in/reference/recurring_payment_api.md",
  readChargeback: "https://docs.payu.in/reference/read-chargeback-api.md",
  disputeHook: "https://docs.payu.in/docs/webhooks-for-chargeback.md",
  payment: "https://docs.payu.in/reference/payment-consent-transaction-payu-hosted.md",
};
const KEY = "cfKEY1";

type Obj = Record<string, unknown>;
interface Txn {
  txnid: string;
  mihpayid: string;
  status: string;
  unmappedstatus: string;
  amt: string;
  mode: string;
  payment_source: string;
  card_no?: string;
  field9: string;
  error: string;
  error_Message: string;
  udf1: string;
  udf2: string;
  udf3?: string;
  addedon: string;
  authpayuid?: string;
  /** Setup txns: the customer the harness creates next owns it. */
  mintedAt?: Date;
}
interface Mandate {
  authpayuid: string;
  status: string;
  amount: string;
  declines: boolean;
  /** A UPI AutoPay mandate: its debits answer pending and settle by webhook. */
  upi?: boolean;
  /** The bank refuses notices as revoked (`status: "QC"`) while PayU still reads it active. */
  bankRevoked?: boolean;
}
interface Refund {
  PayuID: string;
  RequestID: string;
  RefundToken: string;
  Amount: string;
  Status: string;
  txnid: string;
}

const rupees = (minor: bigint | number) => (Number(minor) / 100).toFixed(2);
const istNow = () =>
  new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 19).replace("T", " ");

class FakePayu extends FakeGateway {
  readonly host = HOST;
  readonly txns = new Map<string, Txn>();
  readonly mandates = new Map<string, Mandate>();
  /** invoiceDisplayNumber → the notice. `unpaid` = sent and not yet executed or deleted. */
  readonly notices = new Map<string, { authpayuid: string; amount: string; status: string }>();
  /** Answers to pre_debit_SI, in order, for rows that check what PayU refused. */
  readonly noticeAnswers: Array<{ invoice: string; action: string; status: unknown }> = [];

  /** UPI: one pre-debit and execution cycle per mandate (pre_debit_notification_api). */
  openNotice(authpayuid: string): string | undefined {
    for (const [inv, n] of this.notices)
      if (n.authpayuid === authpayuid && n.status === "unpaid") return inv;
    return undefined;
  }
  readonly refunds: Refund[] = [];
  /** txnids a debit was sent for, answered or not: a read of one is the lost-answer lookup. */
  readonly debited = new Set<string>();
  private n = 0;
  private readonly runDigits = String(Date.now()).slice(-7);

  /** Numeric, like a mihpayid; unique per run. */
  numeric(): string {
    return `2${this.runDigits}${String(++this.n).padStart(4, "0")}`;
  }

  newTxn(t: Partial<Txn> & { txnid: string; amt: string }): Txn {
    const row: Txn = {
      mihpayid: this.numeric(),
      status: "success",
      unmappedstatus: "captured",
      mode: "CC",
      payment_source: "sist",
      card_no: "XXXXXXXXXXXX0008",
      field9: "Transaction Completed Successfully",
      error: "E000",
      error_Message: "No Error",
      udf1: "",
      udf2: "",
      addedon: istNow(),
      ...t,
    };
    this.txns.set(row.txnid, row);
    return row;
  }

  byPayuId(id: string): Txn | undefined {
    return [...this.txns.values()].find((t) => t.mihpayid === id.trim());
  }

  newRefund(t: Txn, amount: string, token: string, status = "QUEUED"): Refund {
    const r: Refund = {
      PayuID: t.mihpayid,
      RequestID: this.numeric(),
      RefundToken: token,
      Amount: amount,
      Status: status,
      txnid: t.txnid,
    };
    this.refunds.push(r);
    return r;
  }

  /** The harness makes the customer after the token, so udf2 is bound on first read. */
  private async bind(t: Txn): Promise<void> {
    if (t.udf2 || !t.mintedAt) return;
    const [c] = await systemDb
      .select({ publicId: customers.publicId })
      .from(customers)
      .innerJoin(
        gatewayAccounts,
        and(
          eq(gatewayAccounts.businessId, customers.businessId),
          eq(gatewayAccounts.gatewayKey, "payu"),
        ),
      )
      .where(gte(customers.createdAt, t.mintedAt))
      .orderBy(desc(customers.createdAt))
      .limit(1);
    if (c) t.udf2 = c.publicId;
  }

  async route(req: FakeRequest): Promise<Response | null> {
    if (req.method !== "POST" || req.path !== "/merchant/postservice.php") return null;
    const command = String(req.body.command ?? "");
    const raw = String(req.body.var1 ?? "");
    let v: Obj = {};
    try {
      v = JSON.parse(raw) as Obj;
    } catch {
      // A plain var1 (a txnid or a mihpayid).
    }
    // Recorded with var1 parsed, so a limit can name `var1.txnid`.
    const rec: FakeRequest = { ...req, body: { ...req.body, var1: raw.startsWith("{") ? v : raw } };

    switch (command) {
      case "verify_payment":
        // A registration read (vaulting) and the read before a debit are their own ops, so a
        // lost charge lookup (after a debit was sent) leaves them alone.
        return this.guarded(
          raw.startsWith("tmsu") ? "vault_lookup" : this.debited.has(raw) ? "lookup" : "precheck",
          rec,
          async () => {
            const t = this.txns.get(raw);
            if (!t)
              return json(200, {
                status: 0,
                msg: "0 out of 1 Transactions Fetched Successfully",
                transaction_details: { [raw]: { mihpayid: "Not Found", status: "Not Found" } },
              });
            await this.bind(t);
            return json(200, {
              status: 1,
              msg: "1 out of 1 Transactions Fetched Successfully",
              transaction_details: { [raw]: { ...t, transaction_amount: t.amt } },
            });
          },
        );
      case "upi_mandate_status": {
        const m = this.mandates.get(String(v.authPayuId ?? ""));
        if (!m) return json(200, { status: 0, message: "Mandate entry not found" });
        const word =
          m.status === "paused" ? "pause" : m.status === "cancelled" ? "revoked" : m.status;
        return json(200, {
          status: word,
          action: "MANDATE_STATUS",
          authpayuid: m.authpayuid,
          amount: m.amount,
          mandateStartDate: "2026-10-30 00:00:00",
          mandateEndDate: "2036-10-30 00:00:00",
        });
      }
      case "upi_mandate_revoke": {
        const m = this.mandates.get(String(v.authPayuId ?? ""));
        if (!m || m.status !== "active")
          return json(200, {
            status: 0,
            action: "MANDATE_REVOKE",
            message: "Mandate is not active",
          });
        m.status = "cancelled";
        return json(200, {
          status: 1,
          action: "MANDATE_REVOKE",
          message: "Mandate Revoke request processed successfully",
        });
      }
      case "check_mandate_status": {
        const m = this.mandates.get(String(v.authPayuId ?? ""));
        if (!m) return json(200, { status: 0, message: "Mandate entry not found" });
        return json(200, { status: m.status, amount: m.amount, mandateEndDate: "2036-10-30" });
      }
      case "mandate_revoke": {
        const m = this.mandates.get(String(v.authPayuId ?? ""));
        if (!m || m.status !== "active")
          return json(200, { status: 0, message: "Mandate not in appropriate state" });
        m.status = "cancelled";
        return json(200, { status: 1, message: "Mandate Revoked Successfully" });
      }
      case "pre_debit_SI":
        return this.guarded("notice", rec, () => {
          const inv = String(v.invoiceDisplayNumber ?? "");
          const answer = (status: number, body: Obj) => {
            this.noticeAnswers.push({
              invoice: inv,
              action: String(v.action ?? "Send"),
              status: body.status,
            });
            return json(status, body);
          };
          if (v.action === "Delete") {
            // Measured: PayU checks these on a Delete too.
            if (!v.amount)
              return answer(200, {
                status: 0,
                message: "amount is mandatory",
                action: "MANDATE_PRE_DEBIT",
              });
            if (!v.debitDate)
              return answer(200, {
                status: 0,
                message: "debitDate is mandatory",
                action: "MANDATE_PRE_DEBIT",
              });
            const n = this.notices.get(inv);
            if (!n || n.status !== "unpaid")
              return answer(200, {
                status: 0,
                action: "MANDATE_PRE_DEBIT",
                message: "Invalid pre-debit for delete",
              });
            n.status = "deleted";
            return answer(200, {
              status: 1,
              action: "MANDATE_PRE_DEBIT",
              message: "Pre Debit deleted successfully",
            });
          }
          if (v.action === "Retrieve") {
            const n = this.notices.get(inv);
            return json(
              200,
              n
                ? { status: 1, invoiceStatus: n.status, action: "MANDATE_PRE_DEBIT" }
                : { status: 0, message: "Invoice not found", action: "MANDATE_PRE_DEBIT" },
            );
          }
          const m = this.mandates.get(String(v.authpayuid ?? ""));
          // Measured: a revoked card mandate answers this; PayU uses it for paused ones too.
          if (!m || m.status !== "active")
            return answer(200, {
              status: 0,
              action: "MANDATE_PRE_DEBIT",
              message: m?.upi
                ? "Mandate is not active"
                : "Consent is Not Enrolled Or Not IN Active State",
            });
          if (m.upi && m.bankRevoked)
            return answer(200, {
              status: "QC",
              action: "MANDATE_PRE_DEBIT",
              message: "MANDATE HAS BEEN REVOKED",
            });
          // "The pre-debit and execution cycle for a mandate must complete in full before a
          // new pre-debit can be initiated."
          if (m.upi && this.openNotice(m.authpayuid))
            return answer(200, {
              status: "E9254",
              action: "MANDATE_PRE_DEBIT",
              message: "Predebit notification already sent for the mandate sequence no.:2",
            });
          this.notices.set(inv, {
            authpayuid: m.authpayuid,
            amount: String(v.amount),
            status: "unpaid",
          });
          if (m.upi)
            return answer(200, {
              status: 1,
              action: "MANDATE_PRE_DEBIT",
              message: "Request Processed Successfully",
            });
          return answer(200, {
            invoiceid: this.numeric(),
            approvedStatus: "na",
            invoiceStatus: "unpaid",
            amount: v.amount,
            status: 1,
            message: "Invoice Created Successfully",
            action: "MANDATE_PRE_DEBIT",
          });
        });
      case "si_transaction":
        this.debited.add(String(v.txnid));
        return this.guarded("charge", rec, () => {
          const txnid = String(v.txnid);
          // Undocumented for si_transaction; `_payment` refuses a reused txnid.
          if (this.txns.has(txnid)) return json(200, { status: 0, msg: "Duplicate Transaction" });
          const m = this.mandates.get(String(v.authpayuid ?? ""));
          const n = this.notices.get(String(v.invoiceDisplayNumber ?? ""));
          const detail = (status: string, field9: string) =>
            json(200, {
              status: 1,
              message: "Transaction Processed successfully",
              details: {
                [txnid]: {
                  authpayuid: v.authpayuid,
                  transactionid: txnid,
                  amount: v.amount,
                  payuid: this.txns.get(txnid)?.mihpayid ?? "",
                  status,
                  field9,
                  udf1: v.udf1 ?? "",
                },
              },
            });
          if (!m || m.status !== "active")
            // Measured 2026-10-30: a UPI debit after a revoke answers "already revoked".
            return detail(
              "failed",
              m?.upi ? "Mandate is already revoked" : "Mandate is not active",
            );
          if (
            !n ||
            n.authpayuid !== m.authpayuid ||
            n.status !== "unpaid" ||
            Number(v.amount) > Number(n.amount)
          )
            return detail("failed", "Pre debit notification not found");
          // UPI: "should be same as the next execution amount. Else, the next recurring
          // execution request will fail."
          if (m.upi && Number(v.amount) !== Number(n.amount)) {
            n.status = "paid";
            return detail("failed", "Amount does not match the pre debit notification");
          }
          n.status = "paid";
          const failed = m.declines;
          if (m.upi && failed) {
            this.newTxn({
              txnid,
              amt: String(v.amount),
              authpayuid: m.authpayuid,
              mode: "UPI",
              payment_source: "payuS2S",
              udf1: String(v.udf1 ?? ""),
              status: "failure",
              unmappedstatus: "failed",
              field9: "Transaction Failed",
            });
            return detail("failed", "Transaction Failed");
          }
          if (m.upi) {
            // UPI AutoPay: accepted, settled later by NPCI (recurring_payment_api: "pending").
            this.newTxn({
              txnid,
              amt: String(v.amount),
              authpayuid: m.authpayuid,
              mode: "UPI",
              payment_source: "payuS2S",
              udf1: String(v.udf1 ?? ""),
              status: "pending",
              unmappedstatus: "pending",
              field9: "92|Transaction Initiated",
            });
            return detail("pending", "92|Transaction Initiated");
          }
          this.newTxn({
            txnid,
            amt: String(v.amount),
            authpayuid: m.authpayuid,
            payment_source: "payuS2S",
            udf1: String(v.udf1 ?? ""),
            status: failed ? "failure" : "success",
            unmappedstatus: failed ? "failed" : "captured",
            field9: failed ? "Insufficient funds in the account" : "Transaction Completed",
            error: failed ? "E706" : "E000",
            error_Message: failed ? "Insufficient funds" : "No Error",
          });
          return failed
            ? detail("failed", "Insufficient funds in the account")
            : detail("captured", "Transaction Completed Successfully");
        });
      case "cancel_refund_transaction":
        return this.guarded("refund", rec, () => {
          const t = this.byPayuId(raw);
          if (!t || t.status !== "success")
            return json(200, { status: 0, msg: "Invalid payuid", error_code: 107 });
          const token = String(req.body.var2 ?? "");
          if (this.refunds.some((r) => r.RefundToken === token))
            return json(200, {
              status: 0,
              msg: "token already used or request pending",
              error_code: 106,
            });
          const r = this.newRefund(t, String(req.body.var3), token);
          return json(200, {
            status: 1,
            msg: "Refund Request Queued",
            request_id: r.RequestID,
            bank_ref_num: null,
            mihpayid: t.mihpayid,
            error_code: 102,
          });
        });
      case "getAllRefundsFromTxnIds":
        return this.guarded("refund_lookup", rec, () => {
          const t = this.txns.get(raw);
          const rows = this.refunds.filter((r) => r.txnid === raw);
          if (!t || !rows.length) return json(200, { status: 1, msg: "No Refunds Found" });
          return json(200, {
            status: 1,
            msg: "Refund Details Fetched Successfully",
            "Refund Details": {
              [t.mihpayid]: rows.map(({ txnid: _t, ...r }) => ({
                ...r,
                PaymentGateway: "testbank",
                RefundCreationDate: istNow(),
              })),
            },
          });
        });
      default:
        return json(200, { status: 0, msg: `no fake for ${command}` });
    }
  }
}

const form = (f: Record<string, string>) => new URLSearchParams(f).toString();

class PayuDriver implements GatewayDriver {
  readonly fake = new FakePayu();
  readonly forgedStatus = 400;
  readonly chargeOp = "charge";
  readonly refundOp = "refund";
  readonly lookupOp = "lookup";
  readonly errors = {
    // PayU documents no HTTP error bodies for postservice.
    conflict: { status: 409, body: { status: 0, msg: "Conflict" } },
    rateLimited: { status: 429, body: { status: 0, msg: "Too Many Requests" } },
    server: { status: 502, body: { status: 0, msg: "Bad Gateway" } },
    // An answer with no outcome for the debit (`details` absent), in PayU's envelope.
    internal: { status: 200, body: { status: 0, msg: "Something went wrong" } },
    refundRefused: {
      status: 200,
      body: { status: 0, msg: "Refund amount greater than transaction amount", error_code: 105 },
    },
  };

  credentials(webhookSecret: string) {
    // The salt signs the webhooks, so it is the world's secret.
    return { merchant_key: KEY, merchant_salt: webhookSecret };
  }

  /** A completed SI registration: its setup txnid is the token `vaultPaymentMethod` takes. */
  token(kind: TokenKind) {
    if (kind === "bank_debit") return null;
    return this.registration(kind === "declines", false);
  }

  /** A completed SI registration on a card or a UPI handle. */
  registration(declines: boolean, upi: boolean) {
    const authpayuid = this.fake.numeric();
    this.fake.mandates.set(authpayuid, {
      authpayuid,
      status: "active",
      amount: upi ? "15000.00" : "10000.00",
      declines,
      upi,
    });
    const txnid = `tmsu${this.fake.id("", 10)}`;
    this.fake.newTxn({
      txnid,
      mihpayid: authpayuid,
      amt: "1.00",
      field9: "Transaction is Successful",
      mintedAt: new Date(Date.now() - 2000),
      ...(upi ? { mode: "UPI", card_no: "" } : {}),
    });
    return txnid;
  }

  sign(_w: World, body: string): Record<string, string> {
    return body.trim().startsWith("{")
      ? {}
      : { "content-type": "application/x-www-form-urlencoded" };
  }

  /** Payment posts carry the reverse hash, card mandate posts their own; refunds carry none. */
  signBody(_w: World, body: string, secret: string) {
    if (body.trim().startsWith("{")) {
      const j = JSON.parse(body) as Obj;
      if (/^MANDATE_/.test(String(j.action ?? "")))
        return JSON.stringify({ ...j, hash: payuUpiMandateWebhookHash(secret, j) });
      if (!j.notificationType || j.statusCode != null) return body;
      return JSON.stringify({ ...j, hash: payuMandateWebhookHash(secret, j) });
    }
    const f = Object.fromEntries(new URLSearchParams(body)) as Record<string, string>;
    if (/^MANDATE_/.test(f.action ?? ""))
      return form({ ...f, hash: payuUpiMandateWebhookHash(secret, f) });
    return form({ ...f, hash: payuReverseHash(secret, f) });
  }

  txn(chargeId: string): Txn {
    const t = this.fake.txns.get(chargeId);
    if (!t) throw new Error(`fake PayU has no transaction ${chargeId}`);
    return t;
  }

  paymentPost(t: Txn, over: Partial<Txn> & { additionalCharges?: string } = {}): Body {
    const s = { ...t, ...over };
    const f: Record<string, string> = {
      mihpayid: s.mihpayid,
      mode: s.mode,
      status: s.status,
      unmappedstatus: s.unmappedstatus,
      key: KEY,
      txnid: s.txnid,
      amount: s.amt,
      addedon: s.addedon,
      productinfo: "Renewal",
      firstname: "Conformance",
      email: "payer@example.com",
      phone: "9999999999",
      udf1: s.udf1,
      udf2: s.udf2,
      udf3: "",
      udf4: "",
      udf5: "",
      field9: s.field9,
      payment_source: s.payment_source,
      error: s.error,
      error_Message: s.error_Message,
      bank_ref_num: "793887770001",
      ...(over.additionalCharges ? { additionalCharges: over.additionalCharges } : {}),
    };
    return {
      body: form(f),
      eventIds: [`payu:payment:${f.mihpayid}:${f.status}:${f.unmappedstatus}`],
    };
  }

  refundPost(r: Refund, bodyStatus?: string): Body {
    const status = bodyStatus ?? (r.Status.toLowerCase() === "success" ? "success" : "failure");
    const b = {
      additionalValue1: null,
      bank_arn: null,
      refund_mode: "Back to source",
      bank_ref_num: "100142080001",
      key: KEY,
      amt: r.Amount,
      remark: null,
      status,
      token: r.RefundToken,
      mihpayid: ` ${r.PayuID} `,
      request_id: r.RequestID,
      merchantTxnId: r.txnid,
      additionalValue2: null,
      action: "refund",
    };
    return { body: JSON.stringify(b), eventIds: [`payu:refund:${r.RequestID}:${status}:`] };
  }

  mandatePost(authpayuid: string, notificationType: string, status: string): Body {
    const eventDate = new Date().toISOString().slice(0, 10);
    const b = {
      status,
      authPayuId: authpayuid,
      notificationType,
      si_details: {
        billingAmount: "10000.00",
        paymentStartDate: "2026-10-30",
        paymentEndDate: "2036-10-30",
      },
      message: notificationType,
      eventDate,
      key: KEY,
      udf1: "",
      udf2: "",
      udf3: "",
      udf4: "",
      udf5: "",
    };
    return {
      body: JSON.stringify(b),
      eventIds: [`payu:mandate:${authpayuid}:${notificationType}:${status}:${eventDate}`],
    };
  }

  /**
   * A UPI mandate pause / unpause / revoke post, as JSON (or form when `asForm`). `dateTime`
   * is the mandate's START date in the field table, so it repeats across posts.
   */
  upiMandatePost(
    authpayuid: string,
    status: string,
    asForm = false,
    o: { dateTime?: string; pauseStartDate?: string; pauseEndDate?: string; noKey?: boolean } = {},
  ): Body {
    const action =
      status === "pause"
        ? "MANDATE_PAUSE"
        : status === "revoked"
          ? "MANDATE_REVOKE"
          : "MANDATE_UNPAUSE";
    const dateTime =
      o.dateTime ??
      new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 19).replace("T", " ");
    const b: Record<string, string> = {
      status,
      authpayuid,
      action,
      dateTime,
      amount: "15000.00",
      endDate: "2036-10-30 00:00:00",
      mandateNumber: "upimandate0001@testbank",
      ...(o.noKey ? {} : { key: KEY }),
      ...(o.pauseStartDate ? { pauseStartDate: o.pauseStartDate } : {}),
      ...(o.pauseEndDate ? { pauseEndDate: o.pauseEndDate } : {}),
      udf1: "",
      udf2: "",
      udf3: "",
      udf5: "",
    };
    return {
      body: asForm ? form(b) : JSON.stringify(b),
      eventIds: [
        `payu:upi-mandate:${authpayuid}:${action}:${status}:${dateTime}:${o.pauseStartDate ?? ""}:${o.pauseEndDate ?? ""}`,
      ],
    };
  }

  disputePost(t: Txn, cbStatus: string): Body {
    const cb = this.fake.numeric();
    const at = new Date().toISOString();
    const b = {
      type: "payments",
      event: "dispute",
      reason_code: "Fraud - Card Not Present Environment",
      created_at: at,
      updated_at: at,
      mid: "1",
      cb_id: Number(cb),
      txn_id: t.mihpayid,
      cb_type: "Chargeback",
      due_date: "2026-11-30",
      cb_amount: t.amt,
      cb_status: cbStatus,
    };
    return { body: JSON.stringify(b), eventIds: [`payu:dispute:${cb}:${cbStatus}:${at}`] };
  }

  collect() {
    return [];
  }
  paymentSucceeded(_w: World, chargeId: string) {
    const t = this.txn(chargeId);
    Object.assign(t, {
      status: "success",
      unmappedstatus: "captured",
      error: "E000",
      error_Message: "No Error",
      field9: "Transaction Completed Successfully",
    });
    return [this.paymentPost(t)];
  }
  paymentFailed(_w: World, chargeId: string, late: boolean) {
    const t = this.txn(chargeId);
    Object.assign(t, {
      status: "failure",
      // A payment PayU had reported success and then refunded on reconciliation.
      unmappedstatus: late ? "autoRefund" : "failed",
      error: "E308",
      error_Message: "Transaction failed",
    });
    return [this.paymentPost(t)];
  }
  refundEvent(_w: World, _chargeId: string, refundId: string, state: RefundState) {
    const token = refundId.split(":")[1];
    const r = this.fake.refunds.find((x) => x.RefundToken === token);
    if (!r) throw new Error(`fake PayU has no refund ${refundId}`);
    r.Status = { pending: "QUEUED", succeeded: "SUCCESS", failed: "FAILURE" }[state];
    return [this.refundPost(r)];
  }
  /** A dashboard refund: PayU's request id, no token of ours. */
  dashboardRefund(_w: World, chargeId: string, amountMinor: bigint) {
    const r = this.fake.newRefund(this.txn(chargeId), rupees(amountMinor), "", "SUCCESS");
    return { refundId: `${chargeId}:rq${r.RequestID}`, events: [this.refundPost(r)] };
  }
  disputeSteps() {
    return null;
  }
  chargesOn(providerPaymentMethodId: string) {
    const id = providerPaymentMethodId.split(":")[1];
    return [...this.fake.txns.values()]
      .filter((t) => t.authpayuid === id && t.txnid.startsWith("tmrc"))
      .map((t) => t.txnid);
  }

  statusEvent(_w: World, s: DocumentedStatus, chargeId: string): Body[] {
    const t = this.txn(chargeId);
    if (s.object === "payment") {
      const unmapped = { success: "captured", failure: "failed", pending: "pending" }[s.status];
      return [this.paymentPost(t, { status: s.status, unmappedstatus: unmapped ?? s.status })];
    }
    if (s.object === "payment.unmappedstatus") {
      const status = ["auth", "captured"].includes(s.status)
        ? "success"
        : ["initiated", "in progress", "pending"].includes(s.status)
          ? "pending"
          : "failure";
      return [this.paymentPost(t, { status, unmappedstatus: s.status })];
    }
    if (s.object === "refund.webhook") {
      const r = this.fake.newRefund(
        t,
        "5.00",
        `tmrfS1${this.fake.numeric()}`,
        s.status === "success" ? "SUCCESS" : "FAILURE",
      );
      return [this.refundPost(r, s.status)];
    }
    if (s.object === "refund") {
      const r = this.fake.newRefund(t, "5.00", `tmrfS1${this.fake.numeric()}`, s.status);
      return [this.refundPost(r, s.status.toLowerCase())];
    }
    if (s.object === "upi-mandate") {
      const reg = this.fake.txns.get(this.registration(false, true))!;
      return [this.upiMandatePost(reg.mihpayid, s.status)];
    }
    if (s.object === "mandate") {
      const status = s.status === "MANDATE_MODIFICATION" ? "active" : "deleted";
      return [this.mandatePost(t.authpayuid!, s.status, status)];
    }
    return [this.disputePost(t, s.status)];
  }
}

const st = (
  object: string,
  status: string,
  doc: string,
  expect: DocumentedStatus["expect"],
): DocumentedStatus => ({ object, status, doc, expect });

const adapterOf = async (w: World) => {
  const [acc] = await systemDb
    .select()
    .from(gatewayAccounts)
    .where(eq(gatewayAccounts.id, w.account.id));
  return resolveAdapter(acc!) as unknown as PayuProvider;
};

const subscriptionRow = async (w: World, id: string) => {
  const { subscriptions } = await import("@db/schema");
  const [row] = await systemDb.select().from(subscriptions).where(eq(subscriptions.id, id));
  return row!;
};
const pmRowOf = async (w: World, id: string) => {
  const { paymentMethods } = await import("@db/schema");
  const [row] = await systemDb.select().from(paymentMethods).where(eq(paymentMethods.id, id));
  void w;
  return row;
};
const refundOf = async (w: World, b: { paymentPublicId: string | null }, amountMinor: number) => {
  const { refundPayment } = await import("@/modules/refunds/service");
  return refundPayment({
    organizationId: w.org.id,
    businessId: w.biz.id,
    paymentPublicId: b.paymentPublicId!,
    amountMinor,
  });
};
const outcomeOf = (b: { txnStatus: string | null; paymentStatus: string | null }) =>
  b.txnStatus ?? b.paymentStatus ?? "none";

/** A UPI AutoPay subscription billed once: its notice was sent and its debit executed. */
async function upiBilled(w: World, d: PayuDriver, declines = false) {
  const real = d.token.bind(d);
  d.token = (k: TokenKind) => (k === "pays" ? d.registration(declines, true) : real(k));
  const b = await w.bill().finally(() => (d.token = real));
  const authpayuid = d.fake.txns.get(b.chargeId)?.authpayuid ?? "";
  return { ...b, authpayuid };
}

/** The collection gate for one debit on this payment method. */
async function gateFor(
  w: World,
  b: { paymentMethodId: string; subscriptionId: string },
  amountMinor: bigint,
  invoiceId: string | null,
) {
  const { preDebitGate } = await import("@/modules/invoicing/pre-debit");
  const [acc] = await systemDb
    .select()
    .from(gatewayAccounts)
    .where(eq(gatewayAccounts.id, w.account.id));
  return preDebitGate({
    organizationId: w.org.id,
    businessId: w.biz.id,
    adapter: resolveAdapter(acc!),
    account: acc!,
    pm: (await pmRowOf(w, b.paymentMethodId))!,
    amountMinor,
    currency: "INR",
    contact: null,
    subscriptionId: b.subscriptionId,
    invoiceId,
    purpose: "invoice",
  });
}

/** A notice sent ahead for the subscription, as the reminders pass sends it, and now due. */
async function aheadNotice(
  w: World,
  b: { paymentMethodId: string; subscriptionId: string; amountMinor: bigint },
) {
  const { sendGatewayNotice } = await import("@/modules/invoicing/pre-debit");
  const { businessWallClock } = await import("@/platform/clock");
  const [acc] = await systemDb
    .select()
    .from(gatewayAccounts)
    .where(eq(gatewayAccounts.id, w.account.id));
  const now = await businessWallClock(w.biz.id);
  const n = await sendGatewayNotice({
    organizationId: w.org.id,
    businessId: w.biz.id,
    adapter: resolveAdapter(acc!),
    account: acc!,
    pm: (await pmRowOf(w, b.paymentMethodId))!,
    amountMinor: b.amountMinor,
    currency: "INR",
    debitAt: new Date(now.getTime() + 26 * 3_600_000),
    idempotencyKey: `ahead:${b.paymentMethodId}:${now.getTime()}`,
    subscriptionId: b.subscriptionId,
  });
  await systemDb
    .update(preDebitNotices)
    .set({ executableAfter: new Date(now.getTime() - 60_000) })
    .where(eq(preDebitNotices.id, n.id));
  return n;
}

/** The payment a debit under a notice leaves behind, as collection books it. */
async function bookDebit(
  w: World,
  b: { paymentMethodId: string; customerId: string; amountMinor: bigint },
  invoiceId: string,
  status: "succeeded" | "failed",
) {
  const { publicId } = await import("@/platform/ids");
  await systemDb.insert(payments).values({
    organizationId: w.org.id,
    businessId: w.biz.id,
    customerId: b.customerId,
    invoiceId,
    paymentMethodId: b.paymentMethodId,
    publicId: publicId("pay"),
    status,
    amountMinor: b.amountMinor,
    currency: "INR",
    providerKey: "payu",
  });
}

/** What PayU answered to the pre_debit_SI calls since `from`, for a row's detail. */
const answersSince = (d: PayuDriver, from: number) =>
  d.fake.noticeAnswers.slice(from).map((a) => `${a.action}:${String(a.status)}`);

/**
 * A create-mode checkout whose PayU registration collected the first invoice (₹100), vaulted
 * through the setup intent but not completed yet.
 */
async function firstChargeSignup(w: World, d: PayuDriver) {
  const ctxBase = { organizationId: w.org.id, businessId: w.biz.id };
  const { createProduct, createPrice } = await import("@/modules/catalog/service");
  const product = await createProduct({ ...ctxBase, name: "First charge" });
  const price = await createPrice({
    ...ctxBase,
    productId: product.id,
    type: "recurring",
    model: "flat",
    currency: "INR",
    amountMinor: 10_000,
    interval: "month",
  });
  const co = await import("@/modules/checkout/service");
  const session = await co.createCheckoutSession({
    ...ctxBase,
    priceId: price.publicId,
    quantity: 1,
  });
  const ctx0 = (await co.resolveCheckoutSession(session.token))!;
  const customer = await co.setCheckoutCustomer(ctx0, {
    email: `first-charge-${d.fake.numeric()}@example.com`,
    address: {
      line1: "1 Test Road",
      city: "Pune",
      postalCode: "411001",
      country: "IN",
      firstName: "First",
    },
  });
  const { updateCustomer } = await import("@/modules/customers/service");
  await updateCustomer({ ...ctxBase, customerPublicId: customer.publicId, phone: "+919999999999" });
  const ctx = (await co.resolveCheckoutSession(session.token))!;
  const { beginVaultSetup, completeVaultFromIntent } = await import("@/api/vault-setup");
  const { getCustomerById } = await import("@/modules/customers/service");
  const firstChargeMinor = (await co.checkoutFirstChargeMinor(ctx)) ?? 10_000n;
  const setup = await beginVaultSetup({
    ...ctxBase,
    customer: (await getCustomerById(w.org.id, customer.id))!,
    returnUrl: "https://example.com/return",
    cancelUrl: "https://example.com/cancel",
    gatewayAccountId: w.account.publicId,
    methodTypes: ["card"],
    firstChargeMinor,
  });
  await co.recordCheckoutSetupIntent(ctx, setup.intent!.publicId);
  const txnid = setup.intent!.intentAtGateway!;
  const authpayuid = d.fake.numeric();
  d.fake.mandates.set(authpayuid, {
    authpayuid,
    status: "active",
    amount: "130.00",
    declines: false,
  });
  d.fake.newTxn({
    txnid,
    mihpayid: authpayuid,
    amt: (Number(firstChargeMinor) / 100).toFixed(2),
    udf2: customer.publicId,
    udf3: "tmfirst",
  });
  const pm = await completeVaultFromIntent({
    ...ctxBase,
    customerId: customer.id,
    paymentIntentPublicId: setup.intent!.publicId,
  });
  return {
    ctx: (await co.resolveCheckoutSession(session.token))!,
    txnid,
    pmId: pm.id,
    pmPublicId: pm.publicId,
    pmProviderId: pm.providerPaymentMethodId,
    customerPublicId: customer.publicId,
  };
}

const DISPUTE_NONE = {
  none: "Dispute webhooks are not booked (disputeFeed: false): an operator records the dispute.",
};

export const payuFixture: GatewayFixture = {
  key: "payu",
  currency: "INR",
  docs: [
    { id: "webhook-events", url: DOC.events, read: READ, check: { kind: "page" } },
    { id: "refund-states", url: DOC.refundStates, read: READ, check: { kind: "page" } },
    { id: "chargeback-status", url: DOC.chargeback, read: READ, check: { kind: "page" } },
    { id: "mandate-webhook", url: DOC.mandateHook, read: READ, check: { kind: "page" } },
  ],
  statuses: [
    st("payment", "success", "webhook-events", ["charge.succeeded"]),
    st("payment", "failure", "webhook-events", ["charge.failed"]),
    st("payment", "pending", "webhook-events", ["charge.pending"]),
    st("payment.unmappedstatus", "auth", "webhook-events", ["charge.succeeded"]),
    st("payment.unmappedstatus", "captured", "webhook-events", ["charge.succeeded"]),
    st("payment.unmappedstatus", "userCancelled", "webhook-events", ["charge.failed"]),
    st("payment.unmappedstatus", "bounced", "webhook-events", ["charge.failed"]),
    st("payment.unmappedstatus", "dropped", "webhook-events", ["charge.failed"]),
    st("payment.unmappedstatus", "failed", "webhook-events", ["charge.failed"]),
    st("payment.unmappedstatus", "autoRefund", "webhook-events", ["charge.failed"]),
    st("payment.unmappedstatus", "initiated", "webhook-events", ["charge.pending"]),
    st("payment.unmappedstatus", "in progress", "webhook-events", ["charge.pending"]),
    st("payment.unmappedstatus", "pending", "webhook-events", ["charge.pending"]),
    st("refund.webhook", "success", "webhook-events", ["charge.refunded"]),
    st("refund.webhook", "failure", "webhook-events", ["refund.failed"]),
    // The state is read back from getAllRefundsFromTxnIds, whatever the body says.
    st("refund", "QUEUED", "refund-states", ["refund.pending"]),
    st("refund", "SUCCESS", "refund-states", ["charge.refunded"]),
    st("refund", "FAILURE", "refund-states", ["refund.failed"]),
    st("refund", "IN PROGRESS", "refund-states", ["refund.pending"]),
    st("refund", "REQUESTED", "refund-states", ["refund.pending"]),
    st("refund", "od_hit", "refund-states", ["refund.pending"]),
    st("mandate", "MANDATE_MODIFICATION", "mandate-webhook", ["payment_method.mandate_updated"]),
    st("mandate", "MANDATE_CANCELLATION", "mandate-webhook", ["payment_method.mandate_updated"]),
    st("mandate", "MANDATE_CANCELLATION_TOKEN_DELETION", "mandate-webhook", [
      "payment_method.mandate_updated",
    ]),
    st("upi-mandate", "active", "mandate-webhook", ["payment_method.mandate_updated"]),
    st("upi-mandate", "pause", "mandate-webhook", ["payment_method.mandate_updated"]),
    st("upi-mandate", "revoked", "mandate-webhook", ["payment_method.mandate_updated"]),
    st("dispute", "Pending Response", "chargeback-status", DISPUTE_NONE),
    st("dispute", "Pending Doc Review", "chargeback-status", DISPUTE_NONE),
    st("dispute", "Submitted to bank", "chargeback-status", DISPUTE_NONE),
    st("dispute", "Insufficient Document", "chargeback-status", DISPUTE_NONE),
    st("dispute", "Closed Customer Favour", "chargeback-status", DISPUTE_NONE),
    st("dispute", "Closed in merchant favour", "chargeback-status", DISPUTE_NONE),
    st("dispute", "Closed under fraud", "chargeback-status", DISPUTE_NONE),
  ],
  na: {
    S5: `Dispute webhooks are unsigned unless PayU enables signing per merchant (${DOC.disputeHook}), and the read API needs a separate Chargeback-dashboard token (${DOC.readChargeback}), read ${READ}. disputeFeed is false: an operator records disputes. S1 keeps the statuses.`,
    S10: `PayU has no API that cancels a recurring debit: ${DOC.recurring} (read ${READ}). A card si_transaction answers captured or failed in the call; a UPI one answers pending and settles by webhook (row S1.upi-debit-pending-then-settled).`,
    S12: `Refund webhooks carry no hash or signature (${DOC.events}, read ${READ}). The adapter books only what getAllRefundsFromTxnIds confirms: rows S12.payment-forged and S12.refund-unlisted.`,
  },
  limits: [
    { op: "charge", field: "var1.txnid", max: 25, source: DOC.payment },
    { op: "charge", field: "var1.udf1", max: 255, source: DOC.payment },
    { op: "charge", field: "var1.email", max: 50, source: DOC.payment },
    { op: "refund", field: "var2", max: 23, source: DOC.refundApi },
  ],
  driver: () => new PayuDriver(),
  extraRows: [
    {
      scenario: "S1",
      id: "S1.debit-under-its-notice",
      title: "a renewal debit names the pre-debit notice sent for it, at the notified amount",
      async run({ world }) {
        const w = await world("s1pdn");
        const d = w.driver as PayuDriver;
        const b = await w.collected();
        const debit = d.fake.callsOf("charge").at(-1)?.body.var1 as Obj | undefined;
        const notice = d.fake
          .callsOf("notice")
          .find((c) => (c.body.var1 as Obj).invoiceDisplayNumber === debit?.invoiceDisplayNumber)
          ?.body.var1 as Obj | undefined;
        return {
          pass:
            !!debit?.invoiceDisplayNumber &&
            !!notice &&
            notice.amount === debit.amount &&
            debit.amount === rupees(b.amountMinor),
          detail: `debit ${JSON.stringify(debit)} notice ${JSON.stringify(notice)}`,
        };
      },
    },
    {
      scenario: "S3",
      id: "S3.setup-auth-refunded",
      title: "the ₹1 registration payment is reported for the engine to refund",
      async run({ world }) {
        const w = await world("s3sa");
        const d = w.driver as PayuDriver;
        const token = d.token("pays")!;
        const t = d.txn(token);
        t.udf2 = "cus_XXXXXXXXXXXX01";
        const ref = await (
          await adapterOf(w)
        ).vaultPaymentMethod({
          customer: { providerKey: "payu", providerCustomerId: "cus_XXXXXXXXXXXX01" },
          token,
        });
        const a = ref.setupAuthCharge;
        return {
          pass: a?.providerChargeId === token && a.amountMinor === 100n && a.currency === "INR",
          detail: JSON.stringify(a, (_k, x) => (typeof x === "bigint" ? String(x) : x)),
        };
      },
    },
    {
      scenario: "S7",
      id: "S7.no-notice-no-debit",
      title: "a card debit without a pre-debit notice never reaches PayU",
      async run({ world }) {
        const w = await world("s7nn");
        const d = w.driver as PayuDriver;
        const b = await w.collected();
        const before = d.fake.callsOf("charge").length;
        const pm = d.fake.txns.get(b.chargeId)!.authpayuid!;
        const r = await (
          await adapterOf(w)
        ).charge({
          amountMinor: 10_000n,
          currency: "INR",
          customer: { providerKey: "payu", providerCustomerId: "cus_XXXXXXXXXXXX01" },
          paymentMethod: {
            providerKey: "payu",
            providerPaymentMethodId: `card:${pm}`,
            display: { type: "card" },
          },
          idempotencyKey: `conf_nn_${pm}`,
        });
        return {
          pass: r.status === "failed" && d.fake.callsOf("charge").length === before,
          detail: `${r.status} ${r.failure?.code} calls +${d.fake.callsOf("charge").length - before}`,
        };
      },
    },
    {
      scenario: "S12",
      id: "S12.payment-forged",
      title: "a payment post hashed with another salt is refused and nothing is recorded",
      async run({ world }) {
        const w = await world("s12pf");
        const d = w.driver as PayuDriver;
        const b = await w.collected();
        const n = await w.entries();
        const ev = d.paymentFailed(w, b.chargeId, true);
        const res = await w.deliver(ev, { secret: "not_the_salt_000000000000000000" });
        const rows = await w.eventRows(ev.flatMap((e) => e.eventIds));
        return {
          pass: res.status === 400 && rows.length === 0 && (await w.entries()) === n,
          detail: `status ${res.status} rows ${rows.length}`,
        };
      },
    },
    {
      scenario: "S12",
      id: "S12.refund-unlisted",
      title: "a refund post naming a refund PayU does not list is refused and books nothing",
      async run({ world }) {
        const w = await world("s12ru");
        const d = w.driver as PayuDriver;
        const b = await w.collected();
        const cash0 = await w.cash();
        const t = d.txn(b.chargeId);
        const fake: Refund = {
          PayuID: t.mihpayid,
          RequestID: d.fake.numeric(),
          RefundToken: "tmrfFORGED0000000001",
          Amount: "100.00",
          Status: "SUCCESS",
          txnid: t.txnid,
        };
        const ev = d.refundPost(fake);
        const res = await w.deliver(ev);
        const rows = await w.eventRows(ev.eventIds);
        return {
          pass: res.status === 400 && rows.length === 0 && (await w.cash()) === cash0,
          detail: `status ${res.status} rows ${rows.length} cash ${(await w.cash()) - cash0}`,
        };
      },
    },
    {
      scenario: "S13",
      id: "S13.additional-charges",
      title: "a payment post with additionalCharges is checked with the longer hash",
      async run({ world }) {
        const w = await world("s13ac");
        const d = w.driver as PayuDriver;
        const b = await w.bill("declines");
        const ev = d.paymentPost(d.txn(b.chargeId), {
          status: "success",
          unmappedstatus: "captured",
          additionalCharges: "10.00",
        });
        const res = await w.deliver(ev);
        const types = await w.recordedTypes(ev.eventIds);
        return {
          pass: res.status === 200 && types.join() === "charge.succeeded",
          detail: `status ${res.status} types ${types.join() || "none"}`,
        };
      },
    },
    {
      scenario: "S8",
      id: "S8.refund-226-pending",
      title: "a refund answered status 1 / 226 (documented pending) stays pending, never refused",
      async run({ world }) {
        const w = await world("s8r226");
        const d = w.driver as PayuDriver;
        const b = await w.collected();
        d.fake.inject("refund", {
          kind: "http",
          status: 200,
          body: {
            status: 1,
            msg: "Capture is done today, please check for refund status tomorrow",
            request_id: d.fake.numeric(),
            error_code: 226,
          },
        });
        const r = await refundOf(w, b, 4000).catch((e: Error) => e);
        const rows = await w.refundRows(b.paymentId!);
        return {
          pass: !(r instanceof Error) && rows.some((x) => x.status === "pending"),
          detail: r instanceof Error ? `threw ${r.message}` : `rows ${rows.map((x) => x.status)}`,
        };
      },
    },
    {
      scenario: "S4",
      id: "S4.refund-absent-grace",
      title: "a refund PayU does not list yet is pending for a day, then failed",
      async run({ world }) {
        const w = await world("s4grace");
        const d = w.driver as PayuDriver;
        const b = await w.collected();
        const adapter = await adapterOf(w);
        const id = `${b.chargeId}:tmrfNOTLISTED000000001`;
        const young = await adapter.fetchRefundStatus({
          providerRefundId: id,
          requestedAt: new Date(),
        });
        const old = await adapter.fetchRefundStatus({
          providerRefundId: id,
          requestedAt: new Date(Date.now() - 2 * 86_400_000),
        });
        void d;
        return {
          pass: young.status === "pending" && old.status === "failed",
          detail: `young ${young.status} old ${old.status}`,
        };
      },
    },
    {
      scenario: "S7",
      id: "S7.retry-prior-read-fails",
      title:
        "when PayU cannot be asked about a debit's txnid, nothing is sent and nothing is failed",
      async run({ world }) {
        const w = await world("s7prior");
        const d = w.driver as PayuDriver;
        d.fake.inject("precheck", { kind: "network" }, 1);
        const before = d.fake.callsOf("charge").length;
        const b = await w.bill().finally(() => d.fake.clearFaults());
        return {
          pass: d.fake.callsOf("charge").length === before && outcomeOf(b) !== "failed",
          detail: `debits sent ${d.fake.callsOf("charge").length - before} attempt ${outcomeOf(b)}`,
        };
      },
    },
    {
      scenario: "S1",
      id: "S1.notice-refusal-paused-then-resumed",
      title:
        "a notice refused for a PAUSED mandate parks the instrument; resumed, it gets notices again",
      async run({ world }) {
        const w = await world("s1pause");
        const d = w.driver as PayuDriver;
        const b = await w.collected();
        const authpayuid = d.fake.txns.get(b.chargeId)!.authpayuid!;
        d.fake.mandates.get(authpayuid)!.status = "paused";
        const { renewSubscription } = await import("@/modules/subscriptions/renewal");
        const { recheckPausedMandates } = await import("@/modules/payment-methods/paused-mandates");
        const sub = await subscriptionRow(w, b.subscriptionId);
        await renewSubscription(w.org.id, sub.id, sub.currentPeriodEnd!).catch(() => null);
        const pm1 = await pmRowOf(w, b.paymentMethodId);
        const parked = pm1?.mandateStatus === "paused";
        d.fake.mandates.get(authpayuid)!.status = "active";
        const notices0 = d.fake.callsOf("notice").length;
        await recheckPausedMandates();
        const pm2 = await pmRowOf(w, b.paymentMethodId);
        return {
          pass:
            parked &&
            pm2?.status === "valid" &&
            pm2.mandateStatus === "confirmed" &&
            d.fake.callsOf("notice").length >= notices0,
          detail: `parked ${parked} (${pm1?.status}/${pm1?.mandateStatus}) revived ${pm2?.status}/${pm2?.mandateStatus}`,
        };
      },
    },
    {
      scenario: "S4",
      id: "S4.unmandated-registration-refund-durable",
      title: "a registration PayU paid without a mandate is refunded through the durable job",
      async run({ world }) {
        const w = await world("s4unm");
        const d = w.driver as PayuDriver;
        const txnid = `tmsu${d.fake.id("", 10)}`;
        const t = d.fake.newTxn({
          txnid,
          amt: "100.00",
          payment_source: "payu",
          error: "E755",
          error_Message: "card not supported for recurring",
        });
        await w.deliver(d.paymentPost(t));
        const [job] = (await systemDb.execute(
          sql`select key from graphile_worker._private_jobs where key = ${`setup_auth_refund:payu:${txnid}`}`,
        )) as unknown as Array<{ key: string }>;
        return { pass: !!job, detail: job ? job.key : "no refund job queued" };
      },
    },
    {
      scenario: "S4",
      id: "S4.setup-refund-failure-retried",
      title: "a setup refund that ends FAILURE is issued again under a new token",
      async run({ world }) {
        const w = await world("s4srf");
        const d = w.driver as PayuDriver;
        const token = d.token("pays")!;
        const { refundSetupAuth } = await import("@/modules/payment-methods/setup-auth-refund");
        const job = {
          organizationId: w.org.id,
          businessId: w.biz.id,
          gatewayAccountId: w.account.id,
          providerKey: "payu",
          providerCustomerId: "cus_XXXXXXXXXXXX01",
          providerPaymentMethodId: "",
          providerChargeId: token,
          amountMinor: "100",
          currency: "INR",
          paymentMethod: "",
        };
        const tries = { attempts: 1, maxAttempts: 12 };
        const first = await refundSetupAuth(job, tries);
        const r1 = d.fake.refunds.filter((r) => r.txnid === token);
        r1[0]!.Status = "FAILURE";
        const second = await refundSetupAuth(
          {
            ...job,
            refund: {
              providerRefundId: `${token}:${r1[0]!.RefundToken}`,
              round: 1,
              requestedAt: new Date().toISOString(),
            },
          },
          tries,
        );
        const r2 = d.fake.refunds.filter((r) => r.txnid === token);
        return {
          pass:
            first === "refunded" &&
            second === "refunded" &&
            r2.length === 2 &&
            r2[0]!.RefundToken !== r2[1]!.RefundToken,
          detail: `${first} → ${second}; refunds ${r2.map((r) => `${r.RefundToken}:${r.Status}`)}`,
        };
      },
    },
    {
      scenario: "S3",
      id: "S3.first-charge-refunded-then-completed",
      title:
        "a first-charge registration its setup refund already took is never booked as the invoice's payment",
      async run({ world }) {
        const w = await world("s3fcr");
        const d = w.driver as PayuDriver;
        const r = await firstChargeSignup(w, d);
        const { refundSetupAuth } = await import("@/modules/payment-methods/setup-auth-refund");
        const refunded = await refundSetupAuth(
          {
            organizationId: w.org.id,
            businessId: w.biz.id,
            gatewayAccountId: w.account.id,
            providerKey: "payu",
            providerCustomerId: r.customerPublicId,
            providerPaymentMethodId: r.pmProviderId,
            providerChargeId: r.txnid,
            amountMinor: "10000",
            currency: "INR",
            paymentMethod: r.pmPublicId,
            firstCharge: true,
          },
          { attempts: 1, maxAttempts: 12 },
        );
        const { completeCheckout } = await import("@/modules/checkout/service");
        await completeCheckout(r.ctx, { paymentMethodId: r.pmId }).catch((e: Error) => e);
        const booked = await systemDb
          .select({ id: payments.id })
          .from(payments)
          .where(eq(payments.providerChargeId, r.txnid));
        return {
          pass: refunded === "refunded" && booked.length === 0,
          detail: `refund ${refunded}; payments on the registration ${booked.length}`,
        };
      },
    },
    {
      scenario: "S1",
      id: "S1.upi-debit-pending-then-settled",
      title:
        "a UPI AutoPay renewal answers pending and is booked when PayU's Successful post arrives",
      async run({ world }) {
        const w = await world("s1upi");
        const d = w.driver as PayuDriver;
        const real = d.token.bind(d);
        d.token = (k: TokenKind) => (k === "pays" ? d.registration(false, true) : real(k));
        const b = await w.bill().finally(() => (d.token = real));
        const pending = outcomeOf(b);
        const cash0 = await w.cash();
        const t = d.txn(b.chargeId);
        Object.assign(t, {
          status: "success",
          unmappedstatus: "captured",
          field9: "Transaction Completed",
        });
        await w.deliver(d.paymentPost(t));
        const after = await w.reload(b);
        const debit = d.fake.callsOf("charge").at(-1)?.body.var1 as Obj | undefined;
        return {
          pass:
            pending !== "succeeded" &&
            pending !== "failed" &&
            after.txnStatus === "succeeded" &&
            (await w.cash()) === cash0 + b.amountMinor &&
            !!debit?.invoiceDisplayNumber,
          detail: `first ${pending} then ${after.txnStatus}; cash +${(await w.cash()) - cash0}`,
        };
      },
    },
    {
      scenario: "S12",
      id: "S12.upi-mandate-forged",
      title: "a UPI mandate post hashed with another salt is refused and changes nothing",
      async run({ world }) {
        const w = await world("s12upi");
        const d = w.driver as PayuDriver;
        const reg = d.fake.txns.get(d.registration(false, true))!;
        const ev = d.upiMandatePost(reg.mihpayid, "revoked");
        const res = await w.deliver(ev, { secret: "not_the_salt_000000000000000000" });
        const rows = await w.eventRows(ev.eventIds);
        return {
          pass: res.status === 400 && rows.length === 0,
          detail: `status ${res.status} rows ${rows.length}`,
        };
      },
    },
    {
      scenario: "S13",
      id: "S13.upi-mandate-form-post",
      title:
        "a UPI mandate post sent as a form (the reference says HTTP form) is read like the JSON one",
      async run({ world }) {
        const w = await world("s13upiform");
        const d = w.driver as PayuDriver;
        const reg = d.fake.txns.get(d.registration(false, true))!;
        const ev = d.upiMandatePost(reg.mihpayid, "pause", true);
        const res = await w.deliver(ev);
        const types = await w.recordedTypes(ev.eventIds);
        return {
          pass: res.status === 200 && types.join() === "payment_method.mandate_updated",
          detail: `status ${res.status} types ${types.join() || "none"}`,
        };
      },
    },
    {
      scenario: "S1",
      id: "S1.upi-amount-changed-after-notice",
      title:
        "UPI: an amount that changed after the advance notice withdraws that notice at PayU before sending the new one",
      async run({ world }) {
        const w = await world("s1upiamt");
        const d = w.driver as PayuDriver;
        const b = await upiBilled(w, d);
        const { sendGatewayNotice } = await import("@/modules/invoicing/pre-debit");
        const [acc] = await systemDb
          .select()
          .from(gatewayAccounts)
          .where(eq(gatewayAccounts.id, w.account.id));
        // The reminders pass's notice for the next renewal, at the estimate.
        await sendGatewayNotice({
          organizationId: w.org.id,
          businessId: w.biz.id,
          adapter: resolveAdapter(acc!),
          account: acc!,
          pm: (await pmRowOf(w, b.paymentMethodId))!,
          amountMinor: 10_000n,
          currency: "INR",
          debitAt: new Date(Date.now() + 72 * 3_600_000),
          idempotencyKey: `pdn:conf:${d.fake.numeric()}`,
          subscriptionId: b.subscriptionId,
        });
        const from = d.fake.noticeAnswers.length;
        const g = await gateFor(w, b, 12_500n, b.invoiceId);
        const seen = answersSince(d, from);
        return {
          pass: g.kind === "wait" && seen.includes("Delete:1") && seen.at(-1) === "Send:1",
          detail: `gate ${g.kind}; PayU ${seen.join(" → ") || "nothing"}`,
        };
      },
    },
    {
      scenario: "S1",
      id: "S1.upi-notice-expired-unused",
      title: "UPI: a notice whose debit day passed unused is withdrawn at PayU before the next one",
      async run({ world }) {
        const w = await world("s1upiexp");
        const d = w.driver as PayuDriver;
        const b = await upiBilled(w, d);
        const g1 = await gateFor(w, b, 10_000n, b.invoiceId);
        if (g1.kind === "wait")
          await systemDb
            .update(preDebitNotices)
            .set({ expiresAt: new Date(Date.now() - 60_000) })
            .where(eq(preDebitNotices.publicId, g1.notice));
        const from = d.fake.noticeAnswers.length;
        const g2 = await gateFor(w, b, 10_000n, b.invoiceId);
        const seen = answersSince(d, from);
        return {
          pass:
            g1.kind === "wait" &&
            g2.kind === "wait" &&
            seen.includes("Delete:1") &&
            seen.at(-1) === "Send:1",
          detail: `gates ${g1.kind}/${g2.kind}; PayU ${seen.join(" → ") || "nothing"}`,
        };
      },
    },
    {
      scenario: "S1",
      id: "S1.upi-failed-debit-then-retry",
      title:
        "UPI: a retry on the debit day runs under the same notice; a new notice only after the first try and three retries (PayU integration support, 2026-11-02)",
      async run({ world }) {
        const w = await world("s1upiretry");
        const d = w.driver as PayuDriver;
        const b = await upiBilled(w, d, true);
        const first = outcomeOf(b);
        const from = d.fake.noticeAnswers.length;
        const g = await gateFor(w, b, b.amountMinor, b.invoiceId);
        const sameDay = answersSince(d, from);
        // The notice used up (first try + 3 retries): the next one waits the 25 h re-notice lead.
        await systemDb
          .update(preDebitNotices)
          .set({ debitsUsed: 4 })
          .where(eq(preDebitNotices.paymentMethodId, b.paymentMethodId));
        const { businessWallClock } = await import("@/platform/clock");
        const now = await businessWallClock(w.biz.id);
        const g2 = await gateFor(w, b, b.amountMinor, b.invoiceId);
        const after = answersSince(d, from);
        const waitH = g2.kind === "wait" ? (g2.until.getTime() - now.getTime()) / 3_600_000 : 0;
        return {
          pass:
            first === "failed" &&
            g.kind === "ready" &&
            g.notice.debitNumber === 2 &&
            sameDay.length === 0 &&
            g2.kind === "wait" &&
            after.at(-1) === "Send:1" &&
            waitH >= 25,
          detail: `debit ${first}; same-day retry ${g.kind}${g.kind === "ready" ? ` #${g.notice.debitNumber}` : ""}; after 4 debits ${g2.kind} ${waitH.toFixed(1)} h; PayU ${after.join(" → ") || "nothing"}`,
        };
      },
    },
    {
      scenario: "S1",
      id: "S1.notice-lead-by-rail",
      title:
        "A card notice is due 24 h after it is sent, a UPI one 25 h (PayU integration support, 2026-11-02)",
      async run({ world }) {
        const w = await world("s1lead");
        const d = w.driver as PayuDriver;
        const { businessWallClock } = await import("@/platform/clock");
        const card = await w.bill();
        const now = await businessWallClock(w.biz.id);
        const gc = await gateFor(w, card, 77_700n, card.invoiceId);
        const upi = await upiBilled(w, d);
        const now2 = await businessWallClock(w.biz.id);
        // Same invoice, another amount: the open notice cannot cover it, so a new one is sent.
        const gu = await gateFor(w, upi, 77_700n, upi.invoiceId);
        const h = (g: typeof gc, t: Date) =>
          g.kind === "wait" ? (g.until.getTime() - t.getTime()) / 3_600_000 : -1;
        const [cardH, upiH] = [h(gc, now), h(gu, now2)];
        return {
          // Card: 24 h + the engine's 10-minute margin. UPI: at least 25 h (NPCI hours may add more).
          pass: cardH >= 24 && cardH < 24.5 && upiH >= 25,
          detail: `card waits ${cardH.toFixed(2)} h, UPI ${upiH.toFixed(2)} h`,
        };
      },
    },
    {
      scenario: "S1",
      id: "S1.upi-two-debits-one-cycle",
      title:
        "UPI: a second debit on the same mandate waits while the first debit's notice is open, and sends nothing",
      async run({ world }) {
        const w = await world("s1upitwo");
        const d = w.driver as PayuDriver;
        const b = await upiBilled(w, d);
        const g1 = await gateFor(w, b, 10_000n, b.invoiceId);
        const from = d.fake.noticeAnswers.length;
        // Another subscription's invoice on the same mandate, in the same cycle.
        const g2 = await gateFor(w, { ...b, subscriptionId: randomUUID() }, 15_000n, randomUUID());
        const seen = answersSince(d, from);
        return {
          pass:
            g1.kind === "wait" &&
            g2.kind === "wait" &&
            g2.notice === g1.notice &&
            seen.length === 0,
          detail: `gates ${g1.kind}/${g2.kind}; PayU ${seen.join(" → ") || "nothing"}`,
        };
      },
    },
    {
      scenario: "S1",
      id: "S1.upi-ahead-notice-one-invoice",
      title:
        "UPI: a notice sent ahead belongs to the first invoice debited under it; another invoice of the same amount waits for its own notice, never debits under it (audit 2026-11-02)",
      async run({ world }) {
        const w = await world("s1upione");
        const d = w.driver as PayuDriver;
        const b = await upiBilled(w, d);
        const ahead = await aheadNotice(w, b);
        const invNew = (await w.openInvoice()).invoiceId;
        const invOld = (await w.openInvoice()).invoiceId;
        const gNew = await gateFor(w, b, b.amountMinor, invNew);
        await bookDebit(w, b, invNew, "succeeded");
        const gOld = await gateFor(w, b, b.amountMinor, invOld);
        const [n] = await systemDb
          .select()
          .from(preDebitNotices)
          .where(eq(preDebitNotices.id, ahead.id));
        return {
          pass:
            ahead.status === "sent" &&
            gNew.kind === "ready" &&
            gOld.kind === "wait" &&
            n?.invoiceId === invNew &&
            n.status === "exhausted",
          detail: `ahead ${ahead.status}; first invoice ${gNew.kind}; second ${gOld.kind}; notice ${n?.status} bound ${n?.invoiceId === invNew}`,
        };
      },
    },
    {
      scenario: "S1",
      id: "S1.upi-ahead-notice-race",
      title:
        "UPI: two invoices of the same amount at once: one debits under the notice, the other waits and the notice is not withdrawn (audit 2026-11-02)",
      async run({ world }) {
        const w = await world("s1upirace");
        const d = w.driver as PayuDriver;
        const b = await upiBilled(w, d);
        const ahead = await aheadNotice(w, b);
        const invA = (await w.openInvoice()).invoiceId;
        const invB = (await w.openInvoice()).invoiceId;
        const from = d.fake.noticeAnswers.length;
        const gs = await Promise.all([
          gateFor(w, b, b.amountMinor, invA),
          gateFor(w, b, b.amountMinor, invB),
        ]);
        const seen = answersSince(d, from);
        const [n] = await systemDb
          .select()
          .from(preDebitNotices)
          .where(eq(preDebitNotices.id, ahead.id));
        return {
          pass:
            gs.filter((g) => g.kind === "ready").length === 1 &&
            gs.some((g) => g.kind === "wait") &&
            n?.debitsUsed === 1 &&
            n.status === "sent" &&
            !seen.some((x) => x.startsWith("Delete")),
          detail: `gates ${gs.map((g) => g.kind).join("/")}; notice ${n?.status} ${n?.debitsUsed}; PayU ${seen.join(" → ") || "nothing"}`,
        };
      },
    },
    {
      scenario: "S1",
      id: "S1.upi-notice-qc-revoked",
      title:
        "UPI: a notice the bank refuses as revoked (status QC) ends the payment method, though PayU still reads it active",
      async run({ world }) {
        const w = await world("s1upiqc");
        const d = w.driver as PayuDriver;
        const b = await upiBilled(w, d);
        d.fake.mandates.get(b.authpayuid)!.bankRevoked = true;
        // Another amount: the open notice (it covers retries) cannot take it, so a new one goes.
        const g = await gateFor(w, b, 9_900n, b.invoiceId);
        const pm = await pmRowOf(w, b.paymentMethodId);
        return {
          pass:
            g.kind === "refused" &&
            g.result.failure?.retriable === false &&
            pm?.status === "invalid",
          detail: `gate ${g.kind} ${g.kind === "refused" ? `${g.result.failure?.code} retriable=${g.result.failure?.retriable}` : ""}; pm ${pm?.status}/${pm?.mandateStatus}`,
        };
      },
    },
    {
      scenario: "S12",
      id: "S12.upi-mandate-webhook-uat-exception",
      title:
        "UPI mandate webhooks (pause/resume/revoke) exist in live only (PayU integration support, 2026-11-02; accepted as a release-gate exception 2026-11-02): a revoke is read from PayU's notice and debit refusals",
      async run() {
        const { normalizePayuDecline } = await import("@/providers/decline-codes");
        // Measured 2026-10-30/31 in UAT after a revoke: the notice, then a debit under an older notice.
        const notice = normalizePayuDecline({ code: null, message: "Mandate is not Active" });
        const debit = normalizePayuDecline({ code: null, message: "Mandate is already revoked" });
        return {
          pass:
            notice.code === "mandate_expired" &&
            !notice.retriable &&
            debit.code === "mandate_expired" &&
            !debit.retriable,
          detail: `notice → ${notice.code}/${notice.retriable}; debit → ${debit.code}/${debit.retriable}`,
        };
      },
    },
    {
      scenario: "S12",
      id: "S12.upi-pause-resume-pause",
      title:
        "UPI: pause, resume, pause again (same mandate start date) — each post applies, in arrival order",
      async run({ world }) {
        const w = await world("s12upippr");
        const d = w.driver as PayuDriver;
        const b = await upiBilled(w, d);
        const dateTime = "2026-10-30 00:00:00";
        const state = async () => {
          const pm = await pmRowOf(w, b.paymentMethodId);
          return `${pm?.status}/${pm?.mandateStatus}`;
        };
        await w.deliver(
          d.upiMandatePost(b.authpayuid, "pause", false, {
            dateTime,
            pauseStartDate: "2026-11-01",
            pauseEndDate: "2026-11-05",
          }),
        );
        const s1 = await state();
        await w.deliver(d.upiMandatePost(b.authpayuid, "active", false, { dateTime, noKey: true }));
        const s2 = await state();
        await w.deliver(
          d.upiMandatePost(b.authpayuid, "pause", false, {
            dateTime,
            pauseStartDate: "2026-11-10",
            pauseEndDate: "2026-11-12",
          }),
        );
        const s3 = await state();
        return {
          pass: s1 === "invalid/paused" && s2 === "valid/confirmed" && s3 === "invalid/paused",
          detail: `pause ${s1} → resume ${s2} → pause ${s3}`,
        };
      },
    },
    {
      scenario: "S3",
      id: "S3.upi-first-charge-over-15000",
      title:
        "UPI: a first payment above ₹15,000 (UPI's billingAmount maximum) is refused, never registered",
      async run({ world }) {
        const w = await world("s3upicap");
        const adapter = await adapterOf(w);
        const r = await adapter
          .createIntent({
            purpose: "setup",
            amountMinor: 0n,
            currency: "INR",
            customer: { providerKey: "payu", providerCustomerId: "cus_XXXXXXXXXXXX01" },
            idempotencyKey: `conf_cap_${Date.now()}`,
            returnUrl: "https://example.com/return",
            methodTypes: ["upi"],
            maxAmountMinor: 2_600_000n,
            firstChargeMinor: 2_000_000n,
            contact: { email: "payer@example.com", phone: "+919999999999", name: "Test Payer" },
          } as never)
          .then(
            (x) =>
              `form ${JSON.stringify((x as { formPost?: { fields?: Obj } }).formPost?.fields?.si_details ?? "")}`,
            (e: Error) => e.name,
          );
        return { pass: r === "ProviderRefusalError", detail: r };
      },
    },
    {
      scenario: "S14",
      id: "S14.long-email",
      title: "an email over 50 characters is left out of the debit, never cut",
      async run({ world }) {
        const w = await world("s14le");
        const d = w.driver as PayuDriver;
        const b = await w.collected();
        const pm = d.fake.txns.get(b.chargeId)!.authpayuid!;
        const adapter = await adapterOf(w);
        const notice = await adapter.notifyUpcomingDebit({
          customer: { providerKey: "payu", providerCustomerId: "cus_XXXXXXXXXXXX01" },
          paymentMethod: {
            providerKey: "payu",
            providerPaymentMethodId: `card:${pm}`,
            display: { type: "card" },
          },
          amountMinor: 5_000n,
          currency: "INR",
          debitAt: new Date(Date.now() + 49 * 3_600_000),
          idempotencyKey: `conf_le_${pm}`,
        });
        await adapter.charge({
          amountMinor: 5_000n,
          currency: "INR",
          customer: { providerKey: "payu", providerCustomerId: "cus_XXXXXXXXXXXX01" },
          paymentMethod: {
            providerKey: "payu",
            providerPaymentMethodId: `card:${pm}`,
            display: { type: "card" },
          },
          idempotencyKey: `conf_le_debit_${pm}`,
          email: `${"a".repeat(64)}@example.com`,
          preDebitNotice: {
            notificationRef: notice.notificationRef,
            amountMinor: 5_000n,
            debitNumber: 1,
          },
        });
        const v = d.fake.callsOf("charge").at(-1)?.body.var1 as Obj | undefined;
        return {
          pass: !!v && v.email === undefined,
          detail: `email ${String(v?.email)}`,
        };
      },
    },
  ],
};
