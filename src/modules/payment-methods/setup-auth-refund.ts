/**
 * Give back the auth amount a mandate registration captured.
 *
 * Some rails register a mandate with a small real payment (RazorPay: ₹1 for a card or UPI
 * Autopay mandate) and capture it. No invoice owns that money and nothing books it, so
 * without this the customer simply loses it on every saved card. The adapter reports it as
 * `ProviderPaymentMethodRef.setupAuthCharge`; `persistVaultedPaymentMethod` queues this job.
 *
 * Nothing is posted to the ledger: the capture was never booked, so the refund nets it to
 * zero at the gateway and our books never held either half.
 *
 * Durable by the queue: a failed attempt throws and graphile retries with backoff; the last
 * failure logs `setup_auth_refund_failed` at error and stays as a failed job (ops queue).
 *
 * `systemDb` on purpose: a gateway charge id is global, so the "already booked" guard looks
 * across every tenant, not only the job's organization.
 */
import { and, eq, sql } from "drizzle-orm";
import { systemDb } from "@/platform/db";
import { gatewayAccounts, payments, transactions } from "@db/schema";
import { getProvider, resolveAdapter } from "@/providers/registry";
import type { PaymentProvider } from "@/providers/types";
import { createLogger } from "@/platform/logger";
import { claimFirstChargeForRefund } from "@/modules/payment-intents/first-charge-claim";

const log = createLogger("payment-methods.setup-auth-refund");

export const SETUP_AUTH_REFUND_TASK = "refund_setup_auth";
/** graphile backs off exp(attempt) seconds: 12 attempts span about a day. */
export const SETUP_AUTH_REFUND_MAX_ATTEMPTS = 12;

export interface SetupAuthRefundJob {
  organizationId: string;
  businessId: string;
  /** Internal gateway account id; null for an env-configured provider. */
  gatewayAccountId: string | null;
  providerKey: string;
  providerCustomerId: string;
  providerPaymentMethodId: string;
  providerChargeId: string;
  /** Minor units, as a string (JSON has no bigint). */
  amountMinor: string;
  currency: string;
  paymentMethod: string;
  /** The registration also paid a first invoice: wait for the signup to book it. */
  firstCharge?: boolean;
  /**
   * Set on the follow-up job that watches an issued refund until the gateway settles it.
   * `round` counts issues: a refund that ends failed is issued again under a new key.
   */
  refund?: { providerRefundId: string; round: number; requestedAt: string };
}

/** Issues before a refund that keeps failing is left to an operator (logged at error). */
export const SETUP_AUTH_REFUND_MAX_ROUNDS = 3;

/** How long a first-charge registration waits for its signup before it is given back. */
export const FIRST_CHARGE_REFUND_DELAY_MS = 2 * 60 * 60_000;

/** One refund per registration payment, whoever asks: the queue key and the gateway tag. */
export function setupAuthRefundKey(providerKey: string, providerChargeId: string): string {
  return `setup_auth_refund:${providerKey}:${providerChargeId}`;
}

/**
 * Queue the refund. Called after the payment method commits; a queue failure is logged at
 * error with the charge id (`scripts/refund-razorpay-setup-auths.ts` recovers it) and never
 * fails the add-card, because the instrument is already saved.
 */
export async function queueSetupAuthRefund(job: SetupAuthRefundJob): Promise<void> {
  try {
    const { enqueue } = await import("@/platform/jobs");
    await enqueue(SETUP_AUTH_REFUND_TASK, job, {
      jobKey: setupAuthRefundKey(job.providerKey, job.providerChargeId),
      maxAttempts: SETUP_AUTH_REFUND_MAX_ATTEMPTS,
      // Booked by then (the usual case) → the job stands down as `booked_payment`.
      ...(job.firstCharge ? { runAt: new Date(Date.now() + FIRST_CHARGE_REFUND_DELAY_MS) } : {}),
    });
  } catch (e) {
    log.error(e as Error, {
      event: "setup_auth_refund_unqueued",
      provider: job.providerKey,
      charge: job.providerChargeId,
      paymentMethod: job.paymentMethod,
      amountMinor: job.amountMinor,
    });
  }
}

export type SetupAuthRefundOutcome =
  | "refunded"
  | "already_refunded"
  | "not_captured"
  | "booked_payment"
  | "gave_up";

/** The job that watches an issued refund (one per charge). */
const checkKey = (job: Pick<SetupAuthRefundJob, "providerKey" | "providerChargeId">) =>
  `${setupAuthRefundKey(job.providerKey, job.providerChargeId)}:check`;

/**
 * Run a charge's setup refund jobs now: a refund event for a charge with no payment row may be
 * one of ours, and its watcher (or the delayed first-charge refund) should look at once.
 */
export async function nudgeSetupAuthRefund(providerKey: string, providerChargeId: string) {
  const key = setupAuthRefundKey(providerKey, providerChargeId);
  await systemDb
    .execute(
      sql`update graphile_worker._private_jobs set run_at = now() where key in (${key}, ${`${key}:check`}) and locked_at is null`,
    )
    .catch((e: unknown) =>
      log.warn("could not run a setup refund job early", {
        charge: providerChargeId,
        error: String(e),
      }),
    );
}

async function adapterFor(job: SetupAuthRefundJob): Promise<PaymentProvider> {
  if (!job.gatewayAccountId) return getProvider(job.providerKey);
  const [acc] = await systemDb
    .select()
    .from(gatewayAccounts)
    .where(eq(gatewayAccounts.id, job.gatewayAccountId))
    .limit(1);
  if (!acc) throw new Error(`gateway account ${job.gatewayAccountId} no longer exists`);
  return resolveAdapter(acc);
}

/**
 * One attempt. Throws to retry: the mandate is still registering, the capture has not
 * landed yet, or the gateway refused or could not answer.
 */
export async function refundSetupAuth(
  job: SetupAuthRefundJob,
  attempt: { attempts: number; maxAttempts: number },
): Promise<SetupAuthRefundOutcome> {
  if (job.refund) return watchSetupAuthRefund(job);
  // Money we booked is refunded only through the refunds module, never here.
  const [booked] = await systemDb
    .select({ id: payments.id })
    .from(payments)
    .where(
      and(
        eq(payments.providerKey, job.providerKey),
        eq(payments.providerChargeId, job.providerChargeId),
      ),
    )
    .limit(1);
  const [txn] = booked
    ? [booked]
    : await systemDb
        .select({ id: transactions.id })
        .from(transactions)
        .where(
          and(
            eq(transactions.gatewayKey, job.providerKey),
            eq(transactions.idAtGateway, job.providerChargeId),
          ),
        )
        .limit(1);
  if (txn) {
    log.warn("a registration payment is booked as a payment, so it is not auto-refunded", {
      event: "setup_auth_refund_skipped_booked",
      provider: job.providerKey,
      charge: job.providerChargeId,
    });
    return "booked_payment";
  }

  // A first charge has one owner: the signup that books it, or this refund.
  const owner = await claimFirstChargeForRefund(job.providerKey, job.providerChargeId);
  if (owner === "booked") {
    log.info("a registration payment is held by its signup, so it is not refunded", {
      event: "setup_auth_refund_skipped_booked",
      provider: job.providerKey,
      charge: job.providerChargeId,
    });
    return "booked_payment";
  }

  const adapter = await adapterFor(job);
  // The last two attempts refund whatever the mandate says: the money must come back.
  const finalAttempts = attempt.attempts >= attempt.maxAttempts - 1;
  if (adapter.fetchMandate && !finalAttempts) {
    const mandate = await adapter.fetchMandate({
      providerCustomerId: job.providerCustomerId,
      token: job.providerPaymentMethodId,
    });
    if (mandate?.status === "initiated")
      throw new Error("the mandate is still registering; the refund waits for it");
  }
  if (adapter.fetchChargeStatus) {
    const st = await adapter.fetchChargeStatus({ providerChargeId: job.providerChargeId });
    // Never captured, or the gateway already returned the hold: nothing of theirs to give back.
    if (st.status === "failed") return "not_captured";
    if (st.status === "pending") throw new Error("the registration payment is not captured yet");
  }
  const key = setupAuthRefundKey(job.providerKey, job.providerChargeId);
  if (adapter.locateRefund) {
    const found = await adapter.locateRefund({
      providerChargeId: job.providerChargeId,
      ownershipRef: key,
    });
    if (found && found.status !== "failed") return "already_refunded";
  }
  return issueSetupAuthRefund(job, adapter, 1);
}

/** Issue round `round` of the refund; a pending answer is watched by a follow-up job. */
async function issueSetupAuthRefund(
  job: SetupAuthRefundJob,
  adapter: PaymentProvider,
  round: number,
): Promise<SetupAuthRefundOutcome> {
  const base = setupAuthRefundKey(job.providerKey, job.providerChargeId);
  const key = round === 1 ? base : `${base}:r${round}`;
  const res = await adapter.refund({
    providerChargeId: job.providerChargeId,
    amountMinor: BigInt(job.amountMinor),
    currency: job.currency,
    idempotencyKey: key,
    ownershipRef: key,
    reason: "Mandate registration amount returned",
  });
  if (res.status === "failed") {
    const raw = res.raw as { error?: { description?: string } } | undefined;
    throw new Error(
      `the gateway refused the refund: ${raw?.error?.description ?? JSON.stringify(res.raw)}`,
    );
  }
  log.info("a mandate registration payment was refunded", {
    event: "setup_auth_refunded",
    provider: job.providerKey,
    charge: job.providerChargeId,
    refund: res.providerRefundId,
    refundStatus: res.status,
    round,
    amountMinor: job.amountMinor,
    paymentMethod: job.paymentMethod,
  });
  if (res.status === "succeeded" || !adapter.fetchRefundStatus || !res.providerRefundId)
    return "refunded";
  // Accepted is not settled: a refund can still end failed (measured on PayU).
  const { enqueue } = await import("@/platform/jobs");
  await enqueue(
    SETUP_AUTH_REFUND_TASK,
    {
      ...job,
      refund: {
        providerRefundId: res.providerRefundId,
        round,
        requestedAt: new Date().toISOString(),
      },
    },
    { jobKey: checkKey(job), maxAttempts: SETUP_AUTH_REFUND_MAX_ATTEMPTS },
  );
  // Issued; the follow-up job watches it to a final state.
  return "refunded";
}

/** The follow-up: settled → done; still moving → retry later; failed → issue again. */
async function watchSetupAuthRefund(job: SetupAuthRefundJob): Promise<SetupAuthRefundOutcome> {
  const adapter = await adapterFor(job);
  const r = job.refund!;
  const st = await adapter.fetchRefundStatus!({
    providerRefundId: r.providerRefundId,
    providerChargeId: job.providerChargeId,
    requestedAt: new Date(r.requestedAt),
  });
  if (st.status === "succeeded") return "refunded";
  if (st.status === "pending") throw new Error("the setup refund has not settled yet");
  if (r.round >= SETUP_AUTH_REFUND_MAX_ROUNDS) {
    log.error(
      new Error("a setup refund kept failing; the payer still has to get this money back"),
      {
        event: "setup_auth_refund_failed",
        provider: job.providerKey,
        charge: job.providerChargeId,
        refund: r.providerRefundId,
        rounds: r.round,
        amountMinor: job.amountMinor,
      },
    );
    return "gave_up";
  }
  const { refund: _done, ...fresh } = job;
  return issueSetupAuthRefund(fresh, adapter, r.round + 1);
}

/**
 * A refused registration that still took money (PayU E755): no instrument, nothing books it,
 * so it goes back through the same durable job.
 */
export async function queueRefusedRegistrationRefund(input: {
  organizationId: string;
  businessId: string;
  gatewayAccountId: string | null;
  providerKey: string;
  providerCustomerId: string;
  charge: { providerChargeId: string; amountMinor: bigint; currency: string };
  intent?: string;
}): Promise<void> {
  log.warn("a refused mandate registration took money; it is refunded", {
    event: "refused_registration_refund_queued",
    provider: input.providerKey,
    charge: input.charge.providerChargeId,
    amountMinor: String(input.charge.amountMinor),
    intent: input.intent ?? null,
  });
  await queueSetupAuthRefund({
    organizationId: input.organizationId,
    businessId: input.businessId,
    gatewayAccountId: input.gatewayAccountId,
    providerKey: input.providerKey,
    providerCustomerId: input.providerCustomerId,
    providerPaymentMethodId: "",
    providerChargeId: input.charge.providerChargeId,
    amountMinor: String(input.charge.amountMinor),
    currency: input.charge.currency,
    paymentMethod: input.intent ?? "",
  });
}
