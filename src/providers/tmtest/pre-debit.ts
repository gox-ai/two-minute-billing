/**
 * Gateway-sent pre-debit notices, simulated (credentials `pre_debit_*`). Stands in for the
 * India e-mandate gateways that need a notice API call before every debit. Notices live in
 * `tmtest_charges` as `kind: 'pre_debit_notice'` rows; `charge()` refuses a covered debit
 * that does not name a valid one, which is how a suite proves the engine passes it.
 */
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { systemDb } from "@/platform/db";
import { tmtestCharges } from "@db/schema";
import { logSyntheticGatewayRequest } from "../http";
import type { ChargeInput, ChargeResult, PaymentProvider, ProviderCapabilities } from "../types";
import { PRE_DEBIT_NOT_DUE_CODE } from "../types";

export const NOTICE_KIND = "pre_debit_notice";
/** The refusal a covered debit gets without a valid notice. */
export const NOTICE_MISSING_CODE = "pre_debit_notice_missing";

export interface TmtestPreDebitOptions {
  leadHours: number;
  validHours?: number;
  maxDebits: number;
  /** `async`: answer `pending`, then report the outcome by signed webhook. */
  mode: "sync" | "async";
  /** `fail`: the gateway refuses every notice. */
  /**
   * `fail`: a retriable refusal. `dead`: the mandate is gone. `paused`: refused in the same
   * words as `dead`, but `fetchMandate` reads paused (PayU says the same for both).
   * `cycle_open`: refused because another notice is still open for the mandate (PayU UPI).
   */
  fault: "fail" | "dead" | "paused" | "cycle_open" | null;
  /** `checkPreDebitNotice` answers "not before now + N h" on a notice's first check. */
  checkLateHours?: number;
  /** The first covered debit on a notice is refused as too early, wait N h. */
  notDueHours?: number;
}

type NotifyInput = Parameters<NonNullable<PaymentProvider["notifyUpcomingDebit"]>>[0];
type NotifyAnswer = Awaited<ReturnType<NonNullable<PaymentProvider["notifyUpcomingDebit"]>>>;
interface NoticeState {
  debits: number;
  lastChargeKey?: string;
  debitAt: string;
  checked?: boolean;
  notDueServed?: boolean;
}

/** Parse the `pre_debit_*` credentials. Null when `pre_debit_lead_hours` is unset. */
export function preDebitOptionsFromCredentials(
  creds: Record<string, unknown>,
): TmtestPreDebitOptions | null {
  const lead = Number(creds.pre_debit_lead_hours);
  if (creds.pre_debit_lead_hours == null || !Number.isFinite(lead) || lead < 0) return null;
  const valid = Number(creds.pre_debit_valid_hours);
  const max = Number(creds.pre_debit_max_debits);
  return {
    leadHours: lead,
    ...(creds.pre_debit_valid_hours != null && Number.isFinite(valid) ? { validHours: valid } : {}),
    maxDebits: Number.isInteger(max) && max > 0 ? max : 4,
    mode: creds.pre_debit_mode === "async" ? "async" : "sync",
    fault:
      creds.pre_debit_fault === "fail" ||
      creds.pre_debit_fault === "dead" ||
      creds.pre_debit_fault === "paused" ||
      creds.pre_debit_fault === "cycle_open"
        ? creds.pre_debit_fault
        : null,
    ...(Number(creds.pre_debit_check_late_hours) > 0
      ? { checkLateHours: Number(creds.pre_debit_check_late_hours) }
      : {}),
    ...(Number(creds.pre_debit_not_due_hours) > 0
      ? { notDueHours: Number(creds.pre_debit_not_due_hours) }
      : {}),
  };
}

/** Mark one flag on a notice's state. */
async function markNotice(id: string, flag: "checked" | "notDueServed") {
  await systemDb
    .update(tmtestCharges)
    .set({
      checkoutParams: sql`jsonb_set(${tmtestCharges.checkoutParams}, ${`{${flag}}`}::text[], 'true'::jsonb)`,
    })
    .where(eq(tmtestCharges.id, id));
}

/** `checkPreDebitNotice` (`pre_debit_check_late_hours`): late once, then due. */
export async function checkNotice(
  businessId: string,
  opts: TmtestPreDebitOptions,
  input: { notificationRef: string; now: Date },
): Promise<{ status: "sent" | "failed"; executableAfter?: Date }> {
  const [n] = await systemDb
    .select()
    .from(tmtestCharges)
    .where(
      and(
        eq(tmtestCharges.chargeId, input.notificationRef),
        eq(tmtestCharges.businessId, businessId),
        eq(tmtestCharges.kind, NOTICE_KIND),
      ),
    )
    .limit(1);
  if (!n || n.status !== "notice_sent") return { status: "failed" };
  const state = (n.checkoutParams ?? {}) as unknown as NoticeState;
  if (state.checked || !opts.checkLateHours) return { status: "sent" };
  await markNotice(n.id, "checked");
  return {
    status: "sent",
    executableAfter: new Date(input.now.getTime() + opts.checkLateHours * 3_600_000),
  };
}

/** The mandate rails tmtest offers: card and UPI. */
export function preDebitCapability(
  opts: TmtestPreDebitOptions,
): NonNullable<ProviderCapabilities["preDebitNotice"]> {
  return {
    methods: ["card", "upi"],
    minLeadHours: opts.leadHours,
    ...(opts.validHours != null ? { validForHours: opts.validHours } : {}),
    maxDebitsPerNotice: opts.maxDebits,
    exactAmount: true,
  };
}

async function noticeByKey(businessId: string, key: string) {
  const [r] = await systemDb
    .select()
    .from(tmtestCharges)
    .where(
      and(
        eq(tmtestCharges.businessId, businessId),
        eq(tmtestCharges.kind, NOTICE_KIND),
        eq(tmtestCharges.idempotencyKey, key),
      ),
    )
    .limit(1);
  return r ?? null;
}

const FAILURE = { code: "notice_rejected", message: "The bank did not accept the notice." };
const DEAD = { code: "mandate_expired", message: "The mandate is not active." };
const CYCLE_OPEN = {
  code: "pre_debit_cycle_open",
  message: "An earlier notice is still open for this mandate.",
};

function answerFor(row: typeof tmtestCharges.$inferSelect, async: boolean): NotifyAnswer {
  if (async) return { status: "pending", notificationRef: row.chargeId };
  return row.status === "notice_sent"
    ? { status: "sent", notificationRef: row.chargeId }
    : {
        status: "failed",
        notificationRef: row.chargeId,
        failure:
          row.errorCode === DEAD.code
            ? { ...DEAD, retriable: false }
            : row.errorCode === CYCLE_OPEN.code
              ? { ...CYCLE_OPEN, retriable: true }
              : { ...FAILURE, retriable: true },
      };
}

/** `notifyUpcomingDebit`, idempotent on the key. */
export async function notifyUpcomingDebit(
  businessId: string,
  opts: TmtestPreDebitOptions,
  input: NotifyInput,
  emit: (type: string, data: Record<string, unknown>) => Promise<string>,
): Promise<NotifyAnswer> {
  const async = opts.mode === "async";
  const prior = await noticeByKey(businessId, input.idempotencyKey);
  if (prior) return answerFor(prior, async);
  const failed = opts.fault !== null;
  const why =
    opts.fault === "dead" || opts.fault === "paused"
      ? DEAD
      : opts.fault === "cycle_open"
        ? CYCLE_OPEN
        : FAILURE;
  const state: NoticeState = { debits: 0, debitAt: input.debitAt.toISOString() };
  const [row] = await systemDb
    .insert(tmtestCharges)
    .values({
      chargeId: `tmpdn_${randomUUID().replace(/-/g, "")}`,
      businessId,
      kind: NOTICE_KIND,
      vaultId: input.paymentMethod.providerPaymentMethodId,
      amountMinor: input.amountMinor,
      currency: input.currency,
      // The gateway's own state: settled at once, even when it reports by webhook later.
      status: failed ? "notice_failed" : "notice_sent",
      errorCode: failed ? why.code : null,
      idempotencyKey: input.idempotencyKey,
      checkoutParams: state as unknown as Record<string, unknown>,
    })
    .returning();
  logSyntheticGatewayRequest({
    gatewayKey: "tmtest",
    operation: "pre_debit_notice",
    status: failed ? 422 : 200,
    requestBody: { amount_minor: Number(input.amountMinor), debit_at: state.debitAt },
    responseBody: { notification_ref: row!.chargeId, status: row!.status },
  });
  if (async)
    await emit("pre_debit_notice.updated", {
      notification_ref: row!.chargeId,
      status: failed ? "failed" : "sent",
      ...(failed ? { failure_code: why.code, failure_message: why.message } : {}),
    });
  return answerFor(row!, async);
}

/**
 * The gateway's check on a covered debit: a sent notice for this instrument, for exactly
 * this amount, not used up. Counts the debit against the notice. Null = may go ahead.
 */
export async function refuseWithoutNotice(
  businessId: string,
  opts: TmtestPreDebitOptions,
  input: ChargeInput,
): Promise<ChargeResult | null> {
  if (!(preDebitCapability(opts).methods as string[]).includes(input.paymentMethod.display.type))
    return null;
  const given = input.preDebitNotice;
  const [n] = given
    ? await systemDb
        .select()
        .from(tmtestCharges)
        .where(
          and(
            eq(tmtestCharges.chargeId, given.notificationRef),
            eq(tmtestCharges.businessId, businessId),
            eq(tmtestCharges.kind, NOTICE_KIND),
          ),
        )
        .limit(1)
    : [];
  const state = (n?.checkoutParams ?? null) as NoticeState | null;
  const valid =
    !!n &&
    !!given &&
    n.status === "notice_sent" &&
    n.vaultId === input.paymentMethod.providerPaymentMethodId &&
    n.amountMinor === input.amountMinor &&
    given.amountMinor === input.amountMinor &&
    (state?.debits ?? 0) < opts.maxDebits;
  if (!valid) {
    logSyntheticGatewayRequest({
      gatewayKey: "tmtest",
      operation: "charge",
      status: 400,
      responseBody: { error: NOTICE_MISSING_CODE },
    });
    return {
      status: "failed",
      providerChargeId: "",
      failure: {
        code: NOTICE_MISSING_CODE,
        message: "tmtest: no valid pre-debit notice covers this debit",
        retriable: true,
      },
      raw: { preDebitNotice: given?.notificationRef ?? null },
    };
  }
  if (opts.notDueHours && !state?.notDueServed) {
    await markNotice(n!.id, "notDueServed");
    return {
      status: "failed",
      providerChargeId: "",
      failure: {
        code: PRE_DEBIT_NOT_DUE_CODE,
        message: "tmtest: too early for this notice",
        retriable: true,
        retryAfterMs: opts.notDueHours * 3_600_000,
      },
    };
  }
  await systemDb
    .update(tmtestCharges)
    .set({
      checkoutParams: sql`jsonb_set(jsonb_set(${tmtestCharges.checkoutParams}, '{debits}',
        to_jsonb(coalesce((${tmtestCharges.checkoutParams}->>'debits')::int, 0) + 1)),
        '{lastChargeKey}', to_jsonb(${input.idempotencyKey ?? ""}::text))`,
    })
    .where(eq(tmtestCharges.id, n!.id));
  return null;
}

/** The mandate as the gateway reads it now (`fetchMandate`). */
export function mandateState(opts: TmtestPreDebitOptions): { status: string } {
  return {
    status: opts.fault === "dead" ? "cancelled" : opts.fault === "paused" ? "paused" : "confirmed",
  };
}
