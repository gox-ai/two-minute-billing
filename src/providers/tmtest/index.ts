/**
 * TM Billing Test Gateway (C4 / GW-4) — a COMPLETE in-process payment gateway,
 * not a mock. It has its own persistence (tmtest_* tables), deterministic magic
 * instruments (incl. the classic test cards as aliases), and simulates
 * asynchronous gateway webhooks (late failures, slow timeouts) that flow back
 * through the real inbound pipeline.
 *
 * The adapter is bound to a business (it is built from a gateway_accounts row)
 * so it can route its async webhooks to that business's inbound endpoint.
 *
 * INTENTS (contract v2 / C7). tmtest implements the full intent surface, because
 * it is the only gateway CI can drive without credentials — a flow the real
 * adapters support but tmtest cannot simulate is a flow nobody tests:
 *   - `purpose: 'payment'` → `tmpi_…`, a priced authorization; the 3DS card
 *     answers with `authorization.mode: 'redirect'`.
 *   - `purpose: 'setup'`   → `tmseti_…`, a ZERO-amount intent whose product is a
 *     vaulted instrument; answers with `authorization.mode: 'client_secret'`,
 *     mirroring a Stripe SetupIntent.
 *   - `voidIntent` releases an authorized-but-unconsumed intent, idempotently.
 *   - the retry card (see instruments.ts) fails the FIRST attempt on an intent
 *     and lets a later one succeed, so an intent can reach attempt_count = 2.
 */
import { stampNow } from "@/platform/clock";
import { randomUUID } from "node:crypto";
import type {
  PaymentProvider,
  ProviderCapabilities,
  EnsureCustomerInput,
  ProviderCustomerRef,
  VaultPaymentMethodInput,
  ProviderPaymentMethodRef,
  ChargeInput,
  ChargeResult,
  RefundInput,
  RefundResult,
  NormalizeWebhookInput,
  NormalizedProviderEvent,
  VerifyPaymentMethodInput,
  VerifyResult,
  CreateIntentInput,
  IntentRef,
  ConsumeIntentInput,
  ConsumeIntentResult,
  VoidIntentInput,
  VoidIntentResult,
  FetchedIntent,
  IntentPurpose,
  VaultSetupRef,
  BuyerAuthorization,
  InitiateVaultSetupInput,
} from "../types";
import { ProviderIndeterminateError, ProviderRefusalError } from "../types";
import type { CancelPendingChargeInput, CancelPendingChargeResult } from "../types";
import {
  classifyToken,
  expiryFromToken,
  isNeedsAttentionAmount,
  isPendingRefundAmount,
} from "./instruments";
import { signTmtest, verifyTmtest } from "./signing";
import * as store from "./store";
import { loadProfileDecline, loadProfileWait } from "./load-profile";
import { formPostAction, formPostFields } from "./form-post";
import { logSyntheticGatewayRequest } from "../http";
import { bodyId, webhookEventId } from "../webhook-event-id";
import * as preDebit from "./pre-debit";

/** The error code a cancelled tmtest debit carries — what `fetchChargeStatus` replays. */
const TMTEST_CANCELLED_CODE = "debit_cancelled";

const LATE_FAILURE_DELAY_MS = 60_000;
const TIMEOUT_DELAY_MS = 15_000;

const PROVIDER_KEY = "tmtest" as const;

/**
 * Gateway-side id prefixes. `payment` and `setup` intents get DIFFERENT prefixes,
 * mirroring Stripe's `pi_` vs `seti_`, so a test (or a support human reading a
 * transaction) can tell a priced authorization from a zero-amount vault setup
 * from the id alone.
 */
const PAYMENT_INTENT_PREFIX = "tmpi";
const SETUP_INTENT_PREFIX = "tmseti";

/** The instrument a setup intent vaults when the challenge names no test card. */
const DEFAULT_SETUP_TOKEN = "4242424242424242";

/**
 * Rails whose buyer challenge is an EMBEDDED CHECKOUT rather than a redirect or a
 * client-side confirmation — `BuyerAuthorization.mode: 'checkout'`, the shape
 * RazorPay returns for UPI Autopay and netbanking e-mandate. Asking for one of these
 * in `methodTypes` is what makes tmtest answer in checkout mode; a card intent is
 * unaffected and keeps its redirect / client_secret challenge.
 */
const CHECKOUT_RAILS = new Set(["upi", "wallet", "bank_transfer", "emandate", "netbanking"]);

function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "")}`;
}

/**
 * `submitClientResult` (`buyer_auth_mode=sdk`). Each submission is a `tmtest_charges` row
 * of this kind, so a replayed key answers the same outcome. An accepted one is ALSO the
 * new id the gateway hands back (`tmtx_…`): `parent_charge_id` maps it to its intent.
 */
const CLIENT_RESULT_KIND = "client_result";
const CLIENT_RESULT_ALIAS_PREFIX = "tmtx";
/** The browser SDK's simulated answers, carried as `client_result.nonce`. */
const NONCE_OK = "tmtest_ok";
const NONCE_DECLINE = "tmtest_decline";
const CLIENT_RESULT_FAILURES: Record<string, { code: string; message: string }> = {
  card_declined: { code: "card_declined", message: "The card was declined." },
  invalid_client_result: {
    code: "invalid_client_result",
    message: "The payment details from the browser are not valid.",
  },
};

/** The intent an id names: itself, or the intent a `tmtx_…` id maps back to. */
async function canonicalIntentId(id: string): Promise<string> {
  if (!id.startsWith(`${CLIENT_RESULT_ALIAS_PREFIX}_`)) return id;
  const row = await store.getCharge(id);
  return row?.kind === CLIENT_RESULT_KIND && row.parentChargeId ? row.parentChargeId : id;
}

/** The stored check-out descriptor, or null. The column also holds a `form_post` return URL. */
function storedCheckout(
  row: store.TmtestCharge,
): NonNullable<BuyerAuthorization["checkout"]> | null {
  const p = row.checkoutParams;
  return p && "orderId" in p ? (p as NonNullable<BuyerAuthorization["checkout"]>) : null;
}

/** True for ids minted by a `setup` intent (or by `initiateVaultSetup`). */
export function isSetupIntentId(intentId: string): boolean {
  return intentId.startsWith(`${SETUP_INTENT_PREFIX}_`);
}

function challengeUrl(id: string): string {
  return `https://tmtest.local/3ds/${id}`;
}

/** A gateway-side failure that has no room in the return type (setup consume). */
export class TmtestGatewayError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retriable = false,
  ) {
    super(message);
    this.name = "TmtestGatewayError";
  }
}

/** The public reference for a vaulted instrument — one shape for every path that mints one. */
function refFromVault(v: store.TmtestVault): ProviderPaymentMethodRef {
  return {
    providerKey: PROVIDER_KEY,
    providerPaymentMethodId: v.vaultId,
    display: {
      type: "card",
      brand: "visa",
      last4: v.last4 ?? undefined,
      expMonth: v.expMonth ?? undefined,
      expYear: v.expYear ?? undefined,
    },
  };
}

/**
 * Vault a token into the gateway's own vault. Shared by `vaultPaymentMethod`
 * (server-side token) and the `setup` intent flow (the buyer supplies the card
 * during the challenge) so both mint an identical instrument.
 */
async function vaultToken(token: string): Promise<ProviderPaymentMethodRef> {
  const spec = classifyToken(token);
  const exp = expiryFromToken(token, new Date());
  const vaultId = newId("tmpm");
  const row = await store.insertVault({
    vaultId,
    token,
    instrument: spec.pan,
    last4: spec.pan.slice(-4),
    expMonth: exp.expMonth,
    expYear: exp.expYear,
    status: exp.status,
  });
  return refFromVault(row);
}

export class TmtestProvider implements PaymentProvider {
  readonly key = PROVIDER_KEY;
  readonly capabilities: ProviderCapabilities;

  /** The shape every tmtest account shares. The credential-driven flags are added below. */
  private static readonly BASE_CAPABILITIES: ProviderCapabilities = {
    refunds: true,
    partialRefunds: true,
    // Stands in for a gateway that debits a mandate in its own currency only.
    mandateCurrencyAuthoritative: ["card", "upi"],
    currencies: [], // any
    methods: ["card", "upi"],
    verify: true,
    intents: true,
    // The test gateway must be able to stand in for ANY real adapter's intent
    // behaviour, or the flows the real ones gain go unverified in CI.
    intentPurposes: ["payment", "setup"],
    intentVoid: true,
    // The test gateway must be able to stand in for RazorPay's poll too — without it
    // the #15 path (ask the gateway rather than trust our status) could only ever be
    // exercised against a live RazorPay key, which is how it came to be missing.
    intentStatus: true,
    // `async_pending` debits cancel; `async_pending_submitted` ones answer `not_cancelable`.
    pendingDebitCancel: true,
    // Stands in for a gateway with no dispute feed, so the hand-recorded path is
    // verifiable offline. Its synthetic `dispute.*` events still drive the gateway path.
    disputeFeed: false,
  };

  /**
   * Whether the MAGIC-AMOUNT rules apply (an amount whose minor units end in 13 →
   * gateway 500). On by default, so every existing test keeps its behaviour.
   *
   * It exists to be switched OFF because the rule is keyed on the AMOUNT, which makes
   * it safe only while the caller chooses its own amounts — true of every verify suite,
   * and false the moment the amounts come from a real book. On a shadow import
   * roughly 1 invoice in 100 totals `…13`, and the rule **overrides the instrument**:
   * a customer with a deliberately-seeded success card fails anyway, with
   * `retriable: true`, which arms a dunning ladder the source book never started and can
   * cancel the subscription. That is not a reporting artefact to be filtered out later —
   * it mutates the state the shadow run exists to measure.
   *
   * So this is not "a shadow-run switch": a rule that silently overrules an explicitly
   * vaulted instrument is wrong for anyone whose amounts they do not control. Off means
   * the vaulted instrument is the ONLY thing that decides the outcome.
   */
  private readonly magicAmounts: boolean;
  /**
   * Force `createIntent` to THROW, for the callers that must survive it. Off unless a
   * gateway account asks for it — see the note at the throw site for why this is a
   * credential and not a magic amount.
   */
  private readonly createIntentFault: "reject" | "reject_stranding" | "indeterminate" | null;

  /** Refuse every CHARGE with a named failure, for the paths that learn from one. */
  private readonly chargeFault: "mandate_missing" | null;

  /** Make `ensureCustomer` refuse (bad keys) or time out. Off unless the account asks. */
  private readonly ensureCustomerFault: "reject" | "indeterminate" | null;

  /**
   * The challenge a buyer-facing intent answers with, for the gateways tmtest stands in
   * for: `sdk` (a browser SDK whose result our server submits) or `form_post` (signed
   * fields POSTed to the gateway, which POSTs the buyer back). Null = redirect /
   * client_secret, as before. A checkout rail keeps its `checkout` challenge either way.
   */
  private readonly buyerAuthMode: "sdk" | "form_post" | null;

  /** Only on `sdk` accounts, as only a nonce gateway has one. */
  readonly submitClientResult?: PaymentProvider["submitClientResult"];

  /** `pre_debit_*` credentials: every covered debit needs a notice sent first. */
  private readonly preDebit: preDebit.TmtestPreDebitOptions | null;
  readonly notifyUpcomingDebit?: PaymentProvider["notifyUpcomingDebit"];
  readonly checkPreDebitNotice?: PaymentProvider["checkPreDebitNotice"];
  /** Notice accounts only: the mandate's state (`pre_debit_fault`). */
  fetchMandate?: PaymentProvider["fetchMandate"];

  /** Only on `settlement_report` accounts: reports `returnCharge` returns by poll. */
  readonly pollSettlements?: PaymentProvider["pollSettlements"];

  constructor(
    private readonly businessId: string,
    options: {
      magicAmounts?: boolean;
      createIntentFault?: "reject" | "reject_stranding" | "indeterminate" | null;
      /**
       * Stand in for a gateway whose off-session confirm reads the mandate REFERENCE —
       * Stripe India, the only real one. tmtest itself debits with the vaulted instrument
       * and reads no reference, so this is off by default and every existing mandate
       * fixture keeps its behaviour; `mandateMissingRefusal` is unreachable without it.
       */
      perDebitMandateReference?: boolean;
      chargeFault?: "mandate_missing" | null;
      ensureCustomerFault?: "reject" | "indeterminate" | null;
      buyerAuthMode?: "sdk" | "form_post" | null;
      preDebit?: preDebit.TmtestPreDebitOptions | null;
      /** Rails on which the gateway notifies the payer itself (`gatewayNotifiesPayer`). */
      gatewayNotifiesPayer?: Array<"card" | "upi">;
      /** Report returns only in a settlement report; `fault` makes every poll throw. */
      settlementReport?: "on" | "fault" | null;
      /** A card setup may collect the first invoice (`setupCollectsFirstCharge`). */
      setupFirstCharge?: boolean;
    } = {},
  ) {
    this.magicAmounts = options.magicAmounts ?? true;
    this.createIntentFault = options.createIntentFault ?? null;
    this.chargeFault = options.chargeFault ?? null;
    this.ensureCustomerFault = options.ensureCustomerFault ?? null;
    this.buyerAuthMode = options.buyerAuthMode ?? null;
    this.preDebit = options.preDebit ?? null;
    let capabilities = options.perDebitMandateReference
      ? { ...TmtestProvider.BASE_CAPABILITIES, mandates: true, perDebitMandateReference: true }
      : TmtestProvider.BASE_CAPABILITIES;
    if (this.buyerAuthMode === "form_post")
      capabilities = { ...capabilities, buyerReturnByPost: true };
    if (options.settlementReport) {
      capabilities = {
        ...capabilities,
        settlementReport: { intervalMinutes: 15, maxWindowHours: 24 },
      };
      const fault = options.settlementReport === "fault";
      this.pollSettlements = (input) => this.readSettlementReport(input, fault);
    }
    if (this.preDebit) {
      const opts = this.preDebit;
      capabilities = { ...capabilities, preDebitNotice: preDebit.preDebitCapability(opts) };
      this.notifyUpcomingDebit = (input) =>
        preDebit.notifyUpcomingDebit(this.businessId, opts, input, (type, data) =>
          this.triggerSyntheticEvent(type, data),
        );
      if (opts.checkLateHours)
        this.checkPreDebitNotice = (input) => preDebit.checkNotice(this.businessId, opts, input);
      this.fetchMandate = async () => preDebit.mandateState(opts);
    }
    if (options.setupFirstCharge)
      capabilities = { ...capabilities, setupCollectsFirstCharge: ["card"] };
    if (options.gatewayNotifiesPayer?.length)
      capabilities = { ...capabilities, gatewayNotifiesPayer: options.gatewayNotifiesPayer };
    this.capabilities = capabilities;
    if (this.buyerAuthMode === "sdk")
      this.submitClientResult = (input) => this.acceptClientResult(input);
  }

  /**
   * The challenge for an intent that needs the buyer, off a checkout rail. `returnUrl` is
   * the one `createIntent` received (already the `/gateway-return` bounce on `form_post`).
   */
  private buyerChallenge(
    intentId: string,
    setup: boolean,
    returnUrl?: string | null,
  ): BuyerAuthorization {
    if (this.buyerAuthMode === "sdk")
      return { mode: "sdk", sdk: { provider: PROVIDER_KEY, params: { intent: intentId } } };
    if (this.buyerAuthMode === "form_post")
      return {
        mode: "form_post",
        formPost: {
          action: formPostAction(),
          fields: formPostFields(intentId, returnUrl ?? undefined),
        },
      };
    return setup
      ? { mode: "client_secret", clientSecret: `${intentId}_secret` }
      : { mode: "redirect", approvalUrl: challengeUrl(intentId) };
  }

  /** What `createIntent` persists for a replay to rebuild the challenge from. */
  private challengeParams(
    checkout: NonNullable<BuyerAuthorization["checkout"]> | null,
    returnUrl?: string,
  ): Record<string, unknown> | null {
    if (checkout) return checkout;
    return this.buyerAuthMode === "form_post" && returnUrl ? { returnUrl } : null;
  }

  /**
   * `submitClientResult`. `client_result.nonce` decides: `tmtest_ok` authorizes,
   * `tmtest_decline` is a card decline, anything else is invalid. An optional
   * `client_result.token` names the card a setup intent vaults.
   *
   * Success answers a NEW id (`tmtx_…`), as a nonce gateway answers with the transaction
   * the nonce became; every intent method here maps it back.
   */
  private async acceptClientResult(input: {
    intentId: string;
    purpose: IntentPurpose;
    clientResult: Record<string, string>;
    idempotencyKey: string;
  }): Promise<FetchedIntent> {
    const intentId = await canonicalIntentId(input.intentId);
    const row = await store.getCharge(intentId);
    if (!row) return { intentId: input.intentId, status: "unknown" };
    const prior = await store.getChargeByIdempotencyKey(row.businessId, input.idempotencyKey);
    if (prior?.kind === CLIENT_RESULT_KIND) return this.clientResultAnswer(prior, intentId);
    // Past the challenge: report where it stands, as the gateway would.
    if (row.status !== "requires_action") return this.fetchIntent({ intentId });

    const nonce = input.clientResult.nonce;
    if (nonce === NONCE_OK) {
      await TmtestProvider.resolveChallenge(intentId, true, input.clientResult.token);
      const alias = newId(CLIENT_RESULT_ALIAS_PREFIX);
      await store.insertCharge({
        chargeId: alias,
        businessId: row.businessId,
        vaultId: null,
        kind: CLIENT_RESULT_KIND,
        parentChargeId: intentId,
        amountMinor: 0n,
        currency: row.currency,
        status: "succeeded",
        idempotencyKey: input.idempotencyKey,
      });
      logSyntheticGatewayRequest({
        gatewayKey: this.key,
        operation: "submit_client_result",
        status: 200,
        requestBody: { intentId: input.intentId },
        responseBody: { intentId, alias, status: "authorized" },
      });
      return this.clientResultAnswer((await store.getCharge(alias))!, intentId);
    }
    const failure =
      CLIENT_RESULT_FAILURES[nonce === NONCE_DECLINE ? "card_declined" : "invalid_client_result"]!;
    await store.setChargeStatus(intentId, "failed", failure.code);
    await store.insertCharge({
      chargeId: newId("tmcr"),
      businessId: row.businessId,
      vaultId: null,
      kind: CLIENT_RESULT_KIND,
      parentChargeId: intentId,
      amountMinor: 0n,
      currency: row.currency,
      status: "failed",
      errorCode: failure.code,
      idempotencyKey: input.idempotencyKey,
    });
    logSyntheticGatewayRequest({
      gatewayKey: this.key,
      operation: "submit_client_result",
      status: 402,
      requestBody: { intentId: input.intentId },
      error: failure.code,
    });
    return { intentId, status: "failed", failure };
  }

  /** The answer a recorded submission stands for (also its idempotent replay). */
  private clientResultAnswer(row: store.TmtestCharge, intentId: string): FetchedIntent {
    if (row.status === "succeeded")
      return {
        intentId: row.chargeId,
        status: "authorized",
        gatewayIntentId: row.chargeId,
        providerChargeId: intentId,
      };
    return {
      intentId,
      status: "failed",
      failure:
        CLIENT_RESULT_FAILURES[row.errorCode ?? ""] ??
        CLIENT_RESULT_FAILURES.invalid_client_result!,
    };
  }

  async ensureCustomer(input: EnsureCustomerInput): Promise<ProviderCustomerRef> {
    if (this.ensureCustomerFault === "indeterminate")
      throw new ProviderIndeterminateError(
        "tmtest: timed out with no response (ensure_customer_fault=indeterminate)",
      );
    if (this.ensureCustomerFault === "reject") {
      logSyntheticGatewayRequest({
        gatewayKey: this.key,
        operation: "ensure_customer",
        status: 401,
        requestBody: { customerRef: input.customerRef },
        responseBody: { error: "ensure_customer_fault=reject" },
      });
      throw new ProviderRefusalError(
        "tmtest: the gateway refused the credentials (ensure_customer_fault=reject)",
      );
    }
    logSyntheticGatewayRequest({
      gatewayKey: this.key,
      operation: "ensure_customer",
      status: 200,
      requestBody: { customerRef: input.customerRef },
    });
    return { providerKey: this.key, providerCustomerId: `tmcus_${input.customerRef}` };
  }

  async initiateVaultSetup(input?: InitiateVaultSetupInput): Promise<VaultSetupRef> {
    if (this.buyerAuthMode) {
      // These challenges complete AT the gateway (a submitted nonce, a form post), so the
      // setup needs a row to resolve, as a tracked setup intent has.
      const id = newId(SETUP_INTENT_PREFIX);
      await store.insertCharge({
        chargeId: id,
        businessId: this.businessId,
        vaultId: null,
        kind: "setup_intent",
        amountMinor: 0n,
        currency: input?.currency ?? "USD",
        status: "requires_action",
        checkoutParams: this.challengeParams(null, input?.returnUrl),
      });
      return { setupTokenId: id, ...this.buyerChallenge(id, true, input?.returnUrl) };
    }
    // Deterministic client_secret-mode setup (mirrors Stripe's SetupIntent shape)
    // so the portal add-card flow is verifiable offline. There is no real
    // browser confirmation step: the client "completes" by calling the normal
    // vault endpoint with any of the magic test tokens (see instruments.ts).
    // NOTE: `createIntent({ purpose: 'setup' })` is the TRACKED version of this
    // same handshake — same prefix, same client_secret shape, but recorded as an
    // intent with attempts.
    const id = newId(SETUP_INTENT_PREFIX);
    return { setupTokenId: id, mode: "client_secret", clientSecret: `${id}_secret` };
  }

  async vaultPaymentMethod(input: VaultPaymentMethodInput): Promise<ProviderPaymentMethodRef> {
    const ref = await vaultToken(input.token);
    logSyntheticGatewayRequest({
      gatewayKey: this.key,
      operation: "vault",
      status: 200,
      responseBody: { vaultId: ref.providerPaymentMethodId },
    });
    return ref;
  }

  /** The test vault has no customer scoping: a known vault id is this customer's. */
  async fetchVaultedPaymentMethod(input: {
    providerCustomerId: string;
    providerPaymentMethodId: string;
  }): Promise<(ProviderPaymentMethodRef & { requiresPerDebitMandate?: boolean }) | null> {
    const v = await store.getVault(input.providerPaymentMethodId);
    if (!v) return null;
    return {
      ...refFromVault(v),
      providerCustomerId: input.providerCustomerId,
      // Stands in for a Stripe India account when that credential is set.
      requiresPerDebitMandate: this.capabilities.perDebitMandateReference === true,
    };
  }

  async deletePaymentMethod(input: {
    paymentMethod: { providerPaymentMethodId: string };
  }): Promise<void> {
    // CUST-7 GDPR clear: drop the vaulted instrument so no card survives. Idempotent.
    await store.deleteVault(input.paymentMethod.providerPaymentMethodId);
  }

  async verifyPaymentMethod(input: VerifyPaymentMethodInput): Promise<VerifyResult> {
    const v = await store.getVault(input.paymentMethod.providerPaymentMethodId);
    if (!v) return { verified: false, status: "invalid", detail: "unknown payment method" };
    if (v.status === "expired")
      return { verified: false, status: "expired", detail: "card expired" };
    const behavior = classifyToken(v.token).behavior;
    if (behavior === "hard_decline")
      return { verified: false, status: "invalid", detail: "card declined on verification" };
    return { verified: true, status: "valid" };
  }

  /** Rebuild the ChargeResult a stored charge row originally produced (idempotent replay). */
  private async replayResult(row: store.TmtestCharge): Promise<ChargeResult> {
    switch (row.status) {
      case "succeeded":
        return { status: "succeeded", providerChargeId: row.chargeId };
      case "pending":
        return {
          status: "pending",
          providerChargeId: row.chargeId,
          raw: { tmtest_outcome: "timeout" },
        };
      case "requires_action":
        return {
          status: "requires_action",
          providerChargeId: row.chargeId,
          nextAction: {
            type: "three_d_secure",
            data: { challenge_url: `https://tmtest.local/3ds/${row.chargeId}` },
          },
        };
      default: {
        const code = row.errorCode ?? "charge_failed";
        // Re-derive retriability from the original instrument (vault_ok_charge_fails
        // declines retriably; a hard decline doesn't — same code, different behavior).
        const v = row.vaultId ? await store.getVault(row.vaultId) : null;
        const behavior = v ? classifyToken(v.token).behavior : null;
        const retriable =
          code === "insufficient_funds" ||
          code === "gateway_error" ||
          behavior === "vault_ok_charge_fails" ||
          behavior === "retry_then_success";
        return {
          status: "failed",
          providerChargeId: row.chargeId,
          failure: { code, message: "Replayed gateway outcome", retriable },
          ...(code === "gateway_error" ? { raw: { tmtest_outcome: "needs_attention" } } : {}),
        };
      }
    }
  }

  /**
   * What the gateway says about a charge NOW — the poll the stale-pending sweep
   * makes when a settlement webhook never arrived.
   *
   * Its absence was a hole in the simulator, not a deliberate omission: the sweep
   * skips any adapter without this method and counts the row `unsupported`, so with
   * tmtest silent **every** stale-pending path was unreachable offline — the sweep
   * itself, and the AFA-abandon branch inside it. Both existed with no way to run
   * them except against a live RazorPay key.
   *
   * Delegates to `replayResult`, which is already defined as "rebuild the
   * ChargeResult this stored row produced". That is exactly the right answer, and
   * sharing it means the poll can never drift from what `charge()` said — the same
   * rule RazorPay's own `fetchChargeStatus` follows ("the sweep must not be a second
   * opinion about what settled means"). An unknown id is `pending`, never a guess:
   * a gateway that has not heard of a charge has not failed it.
   */
  async fetchChargeStatus(input: { providerChargeId: string }): Promise<ChargeResult> {
    const row = await store.getCharge(await canonicalIntentId(input.providerChargeId));
    if (!row) return { status: "pending", providerChargeId: input.providerChargeId };
    const result = await this.replayResult(row);
    return { ...result, providerChargeId: input.providerChargeId };
  }

  /**
   * Find a charge whose answer was lost, by the idempotency key it was sent with. `null` =
   * nothing was created; the stored row's outcome otherwise, as `charge()` would have said.
   */
  async locateCharge(input: { idempotencyKey: string }): Promise<ChargeResult | null> {
    const row = await store.getChargeByIdempotencyKey(this.businessId, input.idempotencyKey);
    return row ? this.replayResult(row) : null;
  }

  /**
   * Stop an `async_pending` debit. Any other pending row (a `timeout`, a submitted debit) is
   * `not_cancelable`: its outcome is coming and nothing here can stop it.
   */
  async cancelPendingCharge(input: CancelPendingChargeInput): Promise<CancelPendingChargeResult> {
    const row = await store.getCharge(input.providerChargeId);
    if (!row) return { status: "not_cancelable", reason: "tmtest: no such charge" };
    if (row.status === "failed" && row.errorCode === TMTEST_CANCELLED_CODE)
      return { status: "cancelled" };
    if (row.status !== "pending")
      return { status: "already_final", charge: await this.fetchChargeStatus(input) };
    const v = row.vaultId ? await store.getVault(row.vaultId) : null;
    const behavior = v ? classifyToken(v.token).behavior : null;
    const cancelled = behavior === "async_pending";
    if (cancelled) await store.setChargeStatus(row.chargeId, "failed", TMTEST_CANCELLED_CODE);
    logSyntheticGatewayRequest({
      gatewayKey: this.key,
      operation: "cancel_charge",
      status: cancelled ? 200 : 422,
      requestBody: { chargeId: row.chargeId },
      responseBody: { status: cancelled ? "cancelled" : "not_cancelable" },
    });
    return cancelled
      ? { status: "cancelled" }
      : { status: "not_cancelable", reason: "tmtest: the debit is already submitted to the bank" };
  }

  /**
   * The refund-side twin. A refund is stored as a charge row with `kind: 'refund'`, so the
   * poll reads the same row `refund()` wrote — the sweep can never be a second opinion
   * about what settled means.
   *
   * An unknown id is `pending`, never `failed`: a gateway that has not heard of a refund
   * has not refused it, and the sweep must not turn ignorance into a reversal.
   */
  async fetchRefundStatus(input: { providerRefundId: string }): Promise<RefundResult> {
    const row = await store.getCharge(input.providerRefundId);
    if (!row) return { status: "pending", providerRefundId: input.providerRefundId };
    const status: RefundResult["status"] =
      row.status === "succeeded" ? "succeeded" : row.status === "failed" ? "failed" : "pending";
    return { status, providerRefundId: input.providerRefundId };
  }

  async charge(input: ChargeInput): Promise<ChargeResult> {
    await loadProfileWait();
    // Gateway-side idempotency: a replayed key returns the ORIGINAL outcome
    // instead of creating a second charge (real-gateway behavior — this is what
    // catches engine-side double-submit bugs).
    if (input.idempotencyKey) {
      const existing = await store.getChargeByIdempotencyKey(this.businessId, input.idempotencyKey);
      if (existing) return this.replayResult(existing);
    }
    if (this.preDebit) {
      const refused = await preDebit.refuseWithoutNotice(this.businessId, this.preDebit, input);
      if (refused) return refused;
    }
    /**
     * Stand in for Stripe answering "this debit needs a mandate and has none".
     *
     * A CHARGE was made — the request reached the gateway and was refused — which is the
     * half that matters: the collection path learns the answer from a refusal it actually
     * received, and only then refuses locally. A credential rather than a magic amount,
     * for the reason `create_intent_fault` is one.
     */
    if (this.chargeFault === "mandate_missing") {
      logSyntheticGatewayRequest({
        gatewayKey: this.key,
        operation: "charge",
        status: 400,
        responseBody: { error: "charge_fault=mandate_missing" },
      });
      return {
        status: "failed",
        providerChargeId: "",
        failure: {
          code: "mandate_missing",
          message:
            "tmtest: the parameter mandate is not provided or invalid " +
            "(charge_fault=mandate_missing)",
          retriable: false,
        },
        raw: { chargeFault: "mandate_missing" },
      };
    }
    const chargeId = newId("tmch");
    const v = await store.getVault(input.paymentMethod.providerPaymentMethodId);
    const behavior = v ? classifyToken(v.token).behavior : "success";
    const loadDecline =
      behavior === "success" ? loadProfileDecline(input.idempotencyKey ?? chargeId) : null;
    let result: ChargeResult;

    // Amount ending in 13 → gateway 500 → needs_attention (overrides instrument),
    // unless magic amounts are disabled for this account — see `magicAmounts`.
    if (this.magicAmounts && isNeedsAttentionAmount(input.amountMinor)) {
      await store.insertCharge({
        chargeId,
        businessId: this.businessId,
        idempotencyKey: input.idempotencyKey ?? null,
        vaultId: v?.vaultId ?? null,
        amountMinor: input.amountMinor,
        currency: input.currency,
        status: "failed",
        errorCode: "gateway_error",
      });
      result = {
        status: "failed",
        providerChargeId: chargeId,
        failure: {
          code: "gateway_error",
          message: "Gateway 500 — outcome unknown",
          retriable: true,
        },
        raw: { tmtest_outcome: "needs_attention" },
      };
    } else if (loadDecline) {
      await store.insertCharge({
        chargeId,
        businessId: this.businessId,
        idempotencyKey: input.idempotencyKey ?? null,
        vaultId: v?.vaultId,
        amountMinor: input.amountMinor,
        currency: input.currency,
        status: "failed",
        errorCode: loadDecline.code,
      });
      result = {
        status: "failed",
        providerChargeId: chargeId,
        failure: {
          code: loadDecline.code,
          message: `Declined (${loadDecline.code})`,
          retriable: loadDecline.retriable,
        },
        raw: { tmtest_outcome: "load_profile_decline" },
      };
    } else {
      switch (behavior) {
        case "hard_decline":
          await store.insertCharge({
            chargeId,
            businessId: this.businessId,
            idempotencyKey: input.idempotencyKey ?? null,
            vaultId: v?.vaultId,
            amountMinor: input.amountMinor,
            currency: input.currency,
            status: "failed",
            errorCode: "card_declined",
          });
          result = {
            status: "failed",
            providerChargeId: chargeId,
            failure: { code: "card_declined", message: "Card was declined", retriable: false },
          };
          break;
        case "expired_card":
          await store.insertCharge({
            chargeId,
            businessId: this.businessId,
            idempotencyKey: input.idempotencyKey ?? null,
            vaultId: v?.vaultId,
            amountMinor: input.amountMinor,
            currency: input.currency,
            status: "failed",
            errorCode: "expired_card",
          });
          result = {
            status: "failed",
            providerChargeId: chargeId,
            failure: { code: "expired_card", message: "Card has expired", retriable: false },
          };
          break;
        case "mandate_revoked":
          await store.insertCharge({
            chargeId,
            businessId: this.businessId,
            idempotencyKey: input.idempotencyKey ?? null,
            vaultId: v?.vaultId,
            amountMinor: input.amountMinor,
            currency: input.currency,
            status: "failed",
            errorCode: "revocation_of_authorization",
          });
          result = {
            status: "failed",
            providerChargeId: chargeId,
            failure: {
              code: "revocation_of_authorization",
              message: "The payer revoked the authorization",
              retriable: false,
            },
          };
          break;
        case "insufficient_funds":
          await store.insertCharge({
            chargeId,
            businessId: this.businessId,
            idempotencyKey: input.idempotencyKey ?? null,
            vaultId: v?.vaultId,
            amountMinor: input.amountMinor,
            currency: input.currency,
            status: "failed",
            errorCode: "insufficient_funds",
          });
          result = {
            status: "failed",
            providerChargeId: chargeId,
            failure: { code: "insufficient_funds", message: "Insufficient funds", retriable: true },
          };
          break;
        case "retry_then_success": {
          // Multi-attempt simulation on the plain charge path: the FIRST charge on
          // this instrument declines retriably, every later one succeeds. The
          // attempt counter is the gateway's own charge ledger — no extra state.
          const spent = v ? await store.hasFailedChargeForVault(this.businessId, v.vaultId) : true;
          if (spent) {
            await store.insertCharge({
              chargeId,
              businessId: this.businessId,
              idempotencyKey: input.idempotencyKey ?? null,
              vaultId: v?.vaultId,
              amountMinor: input.amountMinor,
              currency: input.currency,
              status: "succeeded",
            });
            result = {
              status: "succeeded",
              providerChargeId: chargeId,
              raw: { tmtest_outcome: "retry_succeeded" },
            };
          } else {
            await store.insertCharge({
              chargeId,
              businessId: this.businessId,
              idempotencyKey: input.idempotencyKey ?? null,
              vaultId: v?.vaultId,
              amountMinor: input.amountMinor,
              currency: input.currency,
              status: "failed",
              errorCode: "card_declined",
            });
            result = {
              status: "failed",
              providerChargeId: chargeId,
              failure: {
                code: "card_declined",
                message: "First attempt declined — retry to succeed",
                retriable: true,
              },
              raw: { tmtest_outcome: "retry_pending" },
            };
          }
          break;
        }
        case "vault_ok_charge_fails":
          await store.insertCharge({
            chargeId,
            businessId: this.businessId,
            idempotencyKey: input.idempotencyKey ?? null,
            vaultId: v?.vaultId,
            amountMinor: input.amountMinor,
            currency: input.currency,
            status: "failed",
            errorCode: "card_declined",
          });
          result = {
            status: "failed",
            providerChargeId: chargeId,
            failure: { code: "card_declined", message: "Charge failed", retriable: true },
          };
          break;
        case "requires_action":
          await store.insertCharge({
            chargeId,
            businessId: this.businessId,
            idempotencyKey: input.idempotencyKey ?? null,
            vaultId: v?.vaultId,
            amountMinor: input.amountMinor,
            currency: input.currency,
            status: "requires_action",
          });
          result = {
            status: "requires_action",
            providerChargeId: chargeId,
            nextAction: {
              type: "three_d_secure",
              data: { challenge_url: `https://tmtest.local/3ds/${chargeId}` },
            },
          };
          break;
        case "late_failure": {
          await store.insertCharge({
            chargeId,
            businessId: this.businessId,
            idempotencyKey: input.idempotencyKey ?? null,
            vaultId: v?.vaultId,
            amountMinor: input.amountMinor,
            currency: input.currency,
            status: "succeeded",
          });
          await this.enqueue(
            "charge.failed",
            {
              charge_id: chargeId,
              amount_minor: Number(input.amountMinor),
              currency: input.currency,
              reversal: true,
              error_code: "reversal",
            },
            LATE_FAILURE_DELAY_MS,
          );
          result = {
            status: "succeeded",
            providerChargeId: chargeId,
            raw: { tmtest_outcome: "late_failure_scheduled" },
          };
          break;
        }
        case "timeout": {
          await store.insertCharge({
            chargeId,
            businessId: this.businessId,
            idempotencyKey: input.idempotencyKey ?? null,
            vaultId: v?.vaultId,
            amountMinor: input.amountMinor,
            currency: input.currency,
            status: "pending",
          });
          await this.enqueue(
            "charge.succeeded",
            {
              charge_id: chargeId,
              amount_minor: Number(input.amountMinor),
              currency: input.currency,
            },
            TIMEOUT_DELAY_MS,
          );
          result = {
            status: "pending",
            providerChargeId: chargeId,
            raw: { tmtest_outcome: "timeout" },
          };
          break;
        }
        case "async_pending":
        case "async_pending_submitted": {
          // No `enqueue`: unlike `timeout`, this one does not settle itself. The
          // rails it stands in for are waiting on a bank or a buyer, and a
          // self-settling fixture would hide every bug in that wait.
          //
          // The outcome tag is deliberately NOT 'timeout'/'needs_attention' — those
          // two are matched by name in collectInvoice and would route this to the
          // wrong branch, which is precisely the confusion this instrument exists to
          // end.
          await store.insertCharge({
            chargeId,
            businessId: this.businessId,
            idempotencyKey: input.idempotencyKey ?? null,
            vaultId: v?.vaultId,
            amountMinor: input.amountMinor,
            currency: input.currency,
            status: "pending",
          });
          result = {
            status: "pending",
            providerChargeId: chargeId,
            raw: { tmtest_outcome: "async_pending" },
          };
          break;
        }
        case "lost_answer_charged":
        case "lost_answer_not_created": {
          if (behavior === "lost_answer_charged")
            await store.insertCharge({
              chargeId,
              businessId: this.businessId,
              idempotencyKey: input.idempotencyKey ?? null,
              vaultId: v?.vaultId,
              amountMinor: input.amountMinor,
              currency: input.currency,
              status: "succeeded",
            });
          logSyntheticGatewayRequest({
            gatewayKey: this.key,
            operation: "charge",
            status: 504,
            error: `tmtest: no response (${behavior})`,
          });
          throw new ProviderIndeterminateError(
            `tmtest: the charge request timed out with no response (${behavior})`,
          );
        }
        case "success":
        default:
          await store.insertCharge({
            chargeId,
            businessId: this.businessId,
            idempotencyKey: input.idempotencyKey ?? null,
            vaultId: v?.vaultId,
            amountMinor: input.amountMinor,
            currency: input.currency,
            status: "succeeded",
          });
          result = { status: "succeeded", providerChargeId: chargeId };
      }
    }

    logSyntheticGatewayRequest({
      gatewayKey: this.key,
      operation: "charge",
      status: result.status === "failed" ? 402 : 200,
      // `description` is echoed for the same reason `create_intent` echoes it: it is the
      // only way a suite can prove what the ENGINE sent, since a real adapter puts it on
      // the gateway's own object where nothing here can read it back.
      requestBody: {
        amountMinor: Number(input.amountMinor),
        currency: input.currency,
        description: input.description ?? null,
      },
      responseBody: result,
      error: result.status === "failed" ? result.failure?.message : undefined,
    });
    return result;
  }

  async refund(input: RefundInput): Promise<RefundResult> {
    const refundId = newId("tmrf");
    // Amount ending in 13 → refund failure. Same switch as `charge`: a refund of a real
    // invoice is just as likely to end in 13, and a spurious refund failure is a
    // fabricated divergence in the other direction.
    if (
      this.magicAmounts &&
      input.amountMinor != null &&
      isNeedsAttentionAmount(input.amountMinor)
    ) {
      logSyntheticGatewayRequest({
        gatewayKey: this.key,
        operation: "refund",
        status: 500,
        requestBody: { chargeId: input.providerChargeId },
        error: "needs_attention",
      });
      return { status: "failed", providerRefundId: refundId };
    }
    const parent = await store.getCharge(await canonicalIntentId(input.providerChargeId));
    const amount = input.amountMinor ?? parent?.amountMinor ?? 0n;
    // Amount ending in 17 → accepted but unsettled, the ordinary card/bank case. Recorded
    // as a `pending` charge row so a later settlement webhook has something to confirm.
    const pending =
      this.magicAmounts && input.amountMinor != null && isPendingRefundAmount(input.amountMinor);
    await store.insertCharge({
      chargeId: refundId,
      businessId: parent?.businessId ?? this.businessId,
      vaultId: parent?.vaultId ?? null,
      kind: "refund",
      parentChargeId: input.providerChargeId,
      amountMinor: amount,
      currency: parent?.currency ?? "USD",
      status: pending ? "pending" : "succeeded",
    });
    logSyntheticGatewayRequest({
      gatewayKey: this.key,
      operation: "refund",
      status: 200,
      requestBody: { chargeId: input.providerChargeId },
      responseBody: { refundId, pending },
    });
    return { status: pending ? "pending" : "succeeded", providerRefundId: refundId };
  }

  /**
   * The embedded-checkout descriptor for an intent, or null when the caller asked for
   * no checkout rail. Built from CREATE-time inputs — which is exactly why it is
   * persisted (`tmtest_charges.checkout_params`, 0175): a replayed create key has to
   * hand back the SAME descriptor, and by then the input is gone.
   */
  private checkoutFor(
    input: CreateIntentInput,
    intentId: string,
  ): NonNullable<BuyerAuthorization["checkout"]> | null {
    const rail = input.methodTypes?.find((m) => CHECKOUT_RAILS.has(m));
    if (!rail) return null;
    return {
      provider: PROVIDER_KEY,
      keyId: `tmkey_${this.businessId}`,
      orderId: intentId,
      customerId: input.customer.providerCustomerId,
      // A `setup` intent registers a MANDATE — the checkout must be opened in
      // recurring mode or the rail refuses to store one.
      recurring: input.purpose === "setup",
      method: rail,
    };
  }

  /** Rebuild the IntentRef a stored intent row originally produced (idempotent replay). */
  private intentRefFor(row: store.TmtestCharge): IntentRef {
    const setup = row.kind === "setup_intent";
    if (row.status === "requires_action") {
      const checkout = storedCheckout(row);
      const returnUrl = row.checkoutParams?.returnUrl;
      return {
        intentId: row.chargeId,
        status: "requires_action",
        authorization: checkout
          ? { mode: "checkout", checkout }
          : this.buyerChallenge(
              row.chargeId,
              setup,
              typeof returnUrl === "string" ? returnUrl : null,
            ),
      };
    }
    // Anything past the challenge (authorized / captured / voided) replays as
    // `authorized` — IntentRef has no vocabulary for the later states, and a
    // create-key replay is only ever asking "which intent did I already make?".
    return { intentId: row.chargeId, status: row.status === "inited" ? "inited" : "authorized" };
  }

  async createIntent(input: CreateIntentInput): Promise<IntentRef> {
    /**
     * A gateway that rejects the REQUEST, before idempotency and before any object is
     * minted. Distinct from a refusal returned as `IntentRef.failure`: this one throws,
     * which is the path that left production with no record at all on 2026-09-06 and the
     * path `createPaymentIntent`'s backstop exists for.
     */
    /**
     * A gateway that THROWS, rather than returning a refusal as data — the path that left
     * production with no record at all on 2026-09-06.
     *
     * Keyed on the ACCOUNT's credentials, not on a magic amount. The amount namespace is
     * effectively exhausted: only one two-digit suffix is unused across `scripts/`, and a
     * value chosen there silently hijacks every existing fixture that happens to end in
     * it (measured — `4321` broke `verify:gateway` on the first attempt). A credential
     * misbehaves for exactly the account under test and nothing else.
     */
    if (this.createIntentFault === "reject") {
      throw new TmtestGatewayError(
        "request_rejected",
        "tmtest: the gateway rejected the request itself (create_intent_fault=reject)",
      );
    }
    /**
     * Refused, but the object EXISTS — Stripe's real shape for the missing-`mandate`
     * failure: the PaymentIntent was created, the confirm was refused, and the id is the
     * only handle anyone has on money armed at the gateway. Returned as DATA, because an
     * adapter that throws here discards that id and the engine can then only learn of the
     * intent from `orphaned_gateway_intents` calling it unexplained.
     */
    if (this.createIntentFault === "reject_stranding") {
      const stranded = newId(PAYMENT_INTENT_PREFIX);
      logSyntheticGatewayRequest({
        gatewayKey: this.key,
        operation: "create_intent",
        status: 400,
        // Echoed like every other synthetic log here — without it a suite reading this row
        // back cannot tell "the engine sent no description" from "this fixture did not
        // record the one it was sent".
        responseBody: {
          intentId: stranded,
          error: "create_intent_fault=reject_stranding",
          description: input.description ?? null,
        },
      });
      return {
        intentId: stranded,
        status: "inited",
        failure: {
          code: "gateway_request_rejected",
          message:
            "tmtest: refused the request after creating the intent " +
            "(create_intent_fault=reject_stranding)",
          retriable: false,
        },
        raw: { createIntentFault: "reject_stranding", intentId: stranded },
      };
    }
    if (this.createIntentFault === "indeterminate") {
      // A timeout: the request may or may not have been processed. The caller must NOT
      // record a definite failure over an unknown state.
      throw new ProviderIndeterminateError(
        "tmtest: timed out with no response (create_intent_fault=indeterminate)",
      );
    }

    // Gateway-side idempotency, same contract as `charge`: a replayed create key
    // returns the ORIGINAL intent instead of minting a second one.
    if (input.idempotencyKey) {
      const existing = await store.getChargeByIdempotencyKey(this.businessId, input.idempotencyKey);
      if (existing && (existing.kind === "intent" || existing.kind === "setup_intent"))
        return this.intentRefFor(existing);
    }

    // ── purpose: 'setup' — a ZERO-amount intent whose product is a vaulted card ──
    // There is no instrument yet (the buyer supplies it during the challenge), so
    // the intent is born `requires_action` with a client_secret, exactly like a
    // Stripe SetupIntent. `resolveChallenge(id, true, token)` is the buyer
    // completing it; `consumeIntent` then harvests the instrument.
    if (input.purpose === "setup") {
      const intentId = newId(SETUP_INTENT_PREFIX);
      const checkout = this.checkoutFor(input, intentId);
      await store.insertCharge({
        chargeId: intentId,
        businessId: this.businessId,
        vaultId: null,
        kind: "setup_intent",
        // A setup that collects the first invoice holds it here (zero otherwise).
        amountMinor: this.capabilities.setupCollectsFirstCharge
          ? (input.firstChargeMinor ?? 0n)
          : 0n,
        currency: input.currency,
        status: "requires_action",
        idempotencyKey: input.idempotencyKey ?? null,
        checkoutParams: this.challengeParams(checkout, input.returnUrl),
      });
      logSyntheticGatewayRequest({
        gatewayKey: this.key,
        operation: "create_setup_intent",
        status: 200,
        // Echoed for the same reason `charge` and `create_intent` echo it: proving what
        // the ENGINE sent is the only assertion available, since a real adapter puts the
        // description on the gateway's own object.
        responseBody: {
          intentId,
          mode: checkout ? "checkout" : (this.buyerAuthMode ?? "client_secret"),
          description: input.description ?? null,
        },
      });
      return {
        intentId,
        status: "requires_action",
        authorization: checkout
          ? { mode: "checkout", checkout }
          : this.buyerChallenge(intentId, true, input.returnUrl),
      };
    }

    // ── purpose: 'payment' — a priced authorization against a vaulted card ──────
    const intentId = newId(PAYMENT_INTENT_PREFIX);
    const checkout = this.checkoutFor(input, intentId);
    const v = input.paymentMethod
      ? await store.getVault(input.paymentMethod.providerPaymentMethodId)
      : null;
    const behavior = v ? classifyToken(v.token).behavior : "success";
    // A checkout rail ALWAYS needs the buyer: there is no vaulted instrument to
    // authorize off-session, whatever the card behaviour says. So does an `sdk` /
    // `form_post` intent with no instrument: the buyer supplies it in that challenge.
    const requiresAction =
      behavior === "requires_action" || checkout != null || (this.buyerAuthMode != null && !v);
    // Store the intent as a gateway-side charge row so consumeIntent can capture it.
    await store.insertCharge({
      chargeId: intentId,
      businessId: this.businessId,
      vaultId: v?.vaultId ?? null,
      kind: "intent",
      amountMinor: input.amountMinor ?? 0n,
      currency: input.currency,
      status: requiresAction ? "requires_action" : "authorized",
      idempotencyKey: input.idempotencyKey ?? null,
      checkoutParams: requiresAction ? this.challengeParams(checkout, input.returnUrl) : null,
    });
    logSyntheticGatewayRequest({
      gatewayKey: this.key,
      operation: "create_intent",
      status: 200,
      // `description` is echoed so a suite can assert what the ENGINE sent, which is the
      // only way to prove the label reached a gateway at all — the real adapters put it on
      // the gateway's own object, where no test of ours can read it back.
      responseBody: { intentId, requiresAction, description: input.description ?? null },
    });
    if (requiresAction) {
      return {
        intentId,
        status: "requires_action",
        authorization: checkout
          ? { mode: "checkout", checkout }
          : this.buyerChallenge(intentId, false, input.returnUrl),
      };
    }
    return { intentId, status: "authorized" };
  }

  /**
   * Consume an intent. What that MEANS depends on the purpose: capture money for
   * a `payment` intent, harvest the vaulted instrument for a `setup` one.
   *
   * The purpose is taken from the STORED row's kind when we have it — the row is
   * the gateway's own record of what it minted, and returning a union member that
   * disagrees with it would hand the caller a `charge` for an object that never
   * held an amount.
   */
  async consumeIntent(input: ConsumeIntentInput): Promise<ConsumeIntentResult> {
    // A `tmtx_…` id is the transaction a client result became, so the charge answers
    // under it, as a nonce gateway's capture does.
    const asked = input.intentId;
    input = { ...input, intentId: await canonicalIntentId(input.intentId) };
    const row = await store.getCharge(input.intentId);
    const purpose: IntentPurpose = row
      ? row.kind === "setup_intent"
        ? "setup"
        : "payment"
      : (input.purpose ?? (isSetupIntentId(input.intentId) ? "setup" : "payment"));
    if (purpose === "setup") return { purpose, paymentMethod: await this.consumeSetup(input, row) };
    const charge = await this.capturePayment(input, row);
    return {
      purpose,
      charge: asked === input.intentId ? charge : { ...charge, providerChargeId: asked },
    };
  }

  /**
   * Has this intent's instrument been told to fail its first attempt, and has that
   * failure not been spent yet? Returns 'fail' for a fresh failure, 'replay' when
   * the SAME idempotency key asks again (a gateway replays the same answer), and
   * null when the attempt should be allowed through.
   */
  private async retryGate(
    row: store.TmtestCharge,
    key: string | null,
  ): Promise<"fail" | "replay" | null> {
    const v = row.vaultId ? await store.getVault(row.vaultId) : null;
    if (!v || classifyToken(v.token).behavior !== "retry_then_success") return null;
    if (store.isFailedAttemptKey(row, key)) return "replay";
    if (store.attemptAlreadyFailed(row)) return null; // failure already spent → let it through
    return "fail";
  }

  /** `payment` intents: capture the gateway-side authorization into a charge. */
  private async capturePayment(
    input: ConsumeIntentInput,
    intent: store.TmtestCharge | null,
  ): Promise<ChargeResult> {
    if (!intent)
      return {
        status: "failed",
        providerChargeId: input.intentId,
        failure: { code: "intent_not_found", message: "Unknown intent", retriable: false },
      };
    if (intent.status === "voided")
      return {
        status: "failed",
        providerChargeId: input.intentId,
        failure: {
          code: "intent_voided",
          message: "Intent was voided and cannot be captured",
          retriable: false,
        },
      };
    if (intent.status === "requires_action")
      return {
        status: "requires_action",
        providerChargeId: input.intentId,
        nextAction: {
          type: "three_d_secure",
          data: { challenge_url: challengeUrl(input.intentId) },
        },
      };

    // Multi-attempt simulation (retry card): decline the first attempt but LEAVE
    // THE INTENT AUTHORIZED, so the engine can attempt it again and the intent
    // reaches attempt_count = 2 — the shape "Payment Attempts" shows.
    const gate = await this.retryGate(intent, input.idempotencyKey ?? null);
    if (gate) {
      if (gate === "fail")
        await store.markIntentAttemptFailed(intent.chargeId, input.idempotencyKey ?? null);
      return {
        status: "failed",
        providerChargeId: input.intentId,
        failure: {
          code: "card_declined",
          message: "First attempt declined — retry this intent to succeed",
          retriable: true,
        },
        raw: { tmtest_outcome: gate === "replay" ? "retry_pending_replay" : "retry_pending" },
      };
    }

    // Atomic capture: exactly one caller wins; the same idempotency key replays
    // the success; anything else is rejected (real-gateway double-capture guard).
    const outcome = await store.captureIntentCharge(input.intentId, input.idempotencyKey ?? null);
    if (outcome === "captured" || outcome === "replay")
      return { status: "succeeded", providerChargeId: input.intentId };
    return {
      status: "failed",
      providerChargeId: input.intentId,
      failure: {
        code: "intent_already_consumed",
        message: "Intent was already captured",
        retriable: false,
      },
    };
  }

  /**
   * `setup` intents: hand back the instrument the buyer vaulted during the
   * challenge. No money moves, so there is no ChargeResult to carry a failure —
   * a failed setup consume throws `TmtestGatewayError` (which is also how the
   * retry card's first attempt reports itself here).
   */
  private async consumeSetup(
    input: ConsumeIntentInput,
    intent: store.TmtestCharge | null,
  ): Promise<ProviderPaymentMethodRef> {
    if (!intent)
      throw new TmtestGatewayError("intent_not_found", `Unknown setup intent ${input.intentId}`);
    if (intent.status === "voided")
      throw new TmtestGatewayError("intent_voided", "Setup intent was voided");
    if (intent.status === "requires_action")
      throw new TmtestGatewayError(
        "intent_requires_action",
        "Buyer has not completed the setup challenge",
        true,
      );

    // The challenge normally vaults the card (resolveChallenge's token argument).
    // If it was approved without naming one, vault the default success card now,
    // so the minimal create → resolve → consume path still yields an instrument.
    let vaultId = intent.vaultId;
    if (!vaultId) {
      const minted = await vaultToken(DEFAULT_SETUP_TOKEN);
      vaultId = minted.providerPaymentMethodId;
      await store.setChargeVault(intent.chargeId, vaultId);
    }
    const v = await store.getVault(vaultId);
    if (!v)
      throw new TmtestGatewayError("payment_method_missing", "Vaulted instrument disappeared");

    const gate = await this.retryGate({ ...intent, vaultId }, input.idempotencyKey ?? null);
    if (gate) {
      if (gate === "fail")
        await store.markIntentAttemptFailed(intent.chargeId, input.idempotencyKey ?? null);
      throw new TmtestGatewayError(
        "card_declined",
        "First attempt declined — retry this setup intent to succeed",
        true,
      );
    }

    // Mark it consumed. Unlike a payment capture, a repeat consume is NOT an
    // error: no money moved, and the instrument is the same object either way —
    // so a replay (or a second caller) gets the same ref back.
    await store.captureIntentCharge(intent.chargeId, input.idempotencyKey ?? null);
    logSyntheticGatewayRequest({
      gatewayKey: this.key,
      operation: "consume_setup_intent",
      status: 200,
      responseBody: { intentId: intent.chargeId, vaultId },
    });
    const ref = refFromVault(v);
    // The registration collected the first invoice: reported like a mandate's auth payment.
    return intent.amountMinor > 0n
      ? {
          ...ref,
          setupAuthCharge: {
            providerChargeId: intent.chargeId,
            amountMinor: intent.amountMinor,
            currency: intent.currency,
            firstCharge: true,
          },
        }
      : ref;
  }

  /** A setup that collected a first invoice: its amount, and whether a refund exists on it. */
  async setupChargeState(
    providerChargeId: string,
  ): Promise<{ capturedMinor: bigint; refunded: boolean } | null> {
    const row = await store.getCharge(providerChargeId);
    if (!row || row.kind !== "setup_intent" || row.amountMinor <= 0n) return null;
    return { capturedMinor: row.amountMinor, refunded: await store.hasRefund(providerChargeId) };
  }

  /**
   * Release an authorized-but-unconsumed intent (Stripe `paymentIntents.cancel`,
   * PayPal void). Idempotent: voiding twice resolves `{ voided: true }` with the
   * same void id. A CAPTURED intent cannot be voided — a real gateway makes you
   * refund it instead — so that answers `{ voided: false }`.
   */
  async voidIntent(input: VoidIntentInput): Promise<VoidIntentResult> {
    input = { ...input, intentId: await canonicalIntentId(input.intentId) };
    // `held` rides back on every answer: the store decides it from the status the void
    // CLAIMED, which is the only moment that distinguishes an authorized hold from a
    // checkout the buyer abandoned. See `VoidIntentResult.held` for why the engine must
    // not infer this itself, and `store.voidIntentCharge` for why `already_voided`
    // deliberately answers `undefined` rather than `false`.
    const { outcome, held } = await store.voidIntentCharge(input.intentId);
    if (outcome === "not_found" || outcome === "captured") {
      logSyntheticGatewayRequest({
        gatewayKey: this.key,
        operation: "void_intent",
        status: 409,
        requestBody: { intentId: input.intentId },
        error: outcome,
      });
      return { voided: false };
    }
    if (outcome === "already_voided") {
      const prior = await store.getChildCharge(input.intentId, "void");
      return { voided: true, providerTransactionId: prior?.chargeId };
    }
    // Record the reversal as its own gateway row (same shape as a refund) so the
    // void has an id the intent timeline can show.
    const row = await store.getCharge(input.intentId);
    const voidId = newId("tmvd");
    await store.insertCharge({
      chargeId: voidId,
      businessId: row?.businessId ?? this.businessId,
      vaultId: row?.vaultId ?? null,
      kind: "void",
      parentChargeId: input.intentId,
      amountMinor: row?.amountMinor ?? 0n,
      currency: row?.currency ?? "USD",
      status: "succeeded",
    });
    logSyntheticGatewayRequest({
      gatewayKey: this.key,
      operation: "void_intent",
      status: 200,
      requestBody: { intentId: input.intentId },
      responseBody: { voidId, held },
    });
    return { voided: true, providerTransactionId: voidId, held };
  }

  /**
   * What the gateway says about an intent NOW — the poll `releaseHoldBeforeExpiry`
   * makes instead of trusting our own `payment_intents.status` (defect #15).
   *
   * Carried here for the same reason `fetchChargeStatus` is: without it the whole
   * path is unreachable offline and could only be exercised against a live RazorPay
   * key. It reads the SAME stored row `createIntent`/`resolveChallenge` wrote, so the
   * poll can never be a second opinion about what the gateway thinks — the rule
   * RazorPay's own poll follows.
   *
   * The status map is the gateway's row status, not ours, and the two do NOT run in
   * lockstep: that divergence is exactly the defect. A row this gateway calls
   * `authorized` while our intent still says `in_progress` is a real hold that our
   * record has not caught up with.
   *
   * An unknown id answers `unknown`, never `failed` or `voided`: a gateway that has
   * not heard of an order has not refused it, and the caller must not turn our
   * ignorance into "nothing is held".
   */
  async fetchIntent(input: { intentId: string }): Promise<FetchedIntent> {
    const row = await store.getCharge(await canonicalIntentId(input.intentId));
    if (!row) return { intentId: input.intentId, status: "unknown" };
    const status: FetchedIntent["status"] =
      row.status === "authorized"
        ? "authorized"
        : row.status === "requires_action"
          ? "requires_action"
          : row.status === "inited"
            ? "inited"
            : row.status === "voided"
              ? "voided"
              : row.status === "failed"
                ? "failed"
                : // `succeeded` is a captured intent — money moved, so it is not a hold.
                  "consumed";
    return {
      intentId: input.intentId,
      status,
      // The intent row IS the charge on this gateway (one row, one id), unlike
      // RazorPay's order/payment split — so the charge id is the intent id.
      providerChargeId: row.chargeId,
      ...(row.amountMinor != null ? { amountMinor: row.amountMinor } : {}),
      ...(row.currency ? { currency: row.currency } : {}),
    };
  }

  /**
   * The gateway resolving a 3DS challenge (buyer completed the flow). Flips a
   * requires_action intent/charge to authorized/succeeded. Used by the tmtest
   * simulator route to complete on-session 3DS in tests.
   *
   * `token` is the card the buyer typed into the challenge — meaningful for a
   * `setup` intent, which has no instrument until this moment: it is vaulted here
   * and `consumeIntent` hands it back. Existing two-argument callers are
   * unaffected (a setup intent then vaults the default success card).
   */
  static async resolveChallenge(
    id: string,
    approve: boolean,
    token?: string,
  ): Promise<"authorized" | "declined" | "unknown"> {
    id = await canonicalIntentId(id);
    const row = await store.getCharge(id);
    if (!row) return "unknown";
    if (row.status === "voided") return "unknown";
    const isIntent = row.kind === "intent" || row.kind === "setup_intent";
    if (approve) {
      if (row.kind === "setup_intent" && !row.vaultId) {
        const minted = await vaultToken(token ?? DEFAULT_SETUP_TOKEN);
        await store.setChargeVault(id, minted.providerPaymentMethodId);
      }
      // Preserve a spent-attempt marker: re-authorizing an intent that already
      // burned its simulated failure must not rearm it (that would loop forever).
      const marker = store.attemptAlreadyFailed(row) ? row.errorCode : null;
      await store.setChargeStatus(id, isIntent ? "authorized" : "succeeded", marker);
      return "authorized";
    }
    await store.setChargeStatus(id, "failed", "authentication_failed");
    return "declined";
  }

  /**
   * Test hook: the bank returns a booked charge after settlement (an ACH-style return).
   * Nothing is sent by webhook; only `pollSettlements` reports it, from `occurredAt` on.
   * R01/R09 (insufficient or uncollected funds) are retriable; other codes are not.
   */
  static async returnCharge(
    chargeId: string,
    opts: { occurredAt: Date; code?: string },
  ): Promise<string> {
    const parent = await store.getCharge(chargeId);
    if (!parent) throw new Error(`tmtest: no charge ${chargeId} to return`);
    const returnId = newId("tmrt");
    await store.insertCharge({
      chargeId: returnId,
      businessId: parent.businessId,
      kind: "return",
      parentChargeId: chargeId,
      amountMinor: parent.amountMinor,
      currency: parent.currency,
      status: "succeeded",
      errorCode: opts.code ?? "R01",
      createdAt: opts.occurredAt,
    });
    return returnId;
  }

  /** Returns in `[since, until)` as the late-failure event a webhook would carry. */
  private async readSettlementReport(
    input: { since: Date; until: Date },
    fault: boolean,
  ): Promise<NormalizedProviderEvent[]> {
    if (fault) {
      logSyntheticGatewayRequest({
        gatewayKey: this.key,
        operation: "settlement_report",
        status: 503,
        requestBody: input,
        error: "settlement_report_unavailable",
      });
      throw new TmtestGatewayError("settlement_report_unavailable", "Report unavailable", true);
    }
    const rows = await store.listReturns(this.businessId, input.since, input.until);
    logSyntheticGatewayRequest({
      gatewayKey: this.key,
      operation: "settlement_report",
      status: 200,
      requestBody: input,
      responseBody: { returns: rows.map((r) => r.chargeId) },
    });
    return rows.map((r) => {
      const code = r.errorCode ?? "R01";
      const retriable = code === "R01" || code === "R09";
      const eventId = `${r.chargeId}_evt`;
      return {
        providerEventId: eventId,
        // The existing late-failure path: a reversal of a charge we booked as succeeded.
        type: "charge.failed" as const,
        providerChargeId: r.parentChargeId ?? undefined,
        failureCode: code,
        failureRetriable: retriable,
        occurredAt: r.createdAt,
        raw: {
          id: eventId,
          type: "charge.failed",
          business: this.businessId,
          occurred_at: r.createdAt.toISOString(),
          data: {
            charge_id: r.parentChargeId,
            return_id: r.chargeId,
            amount_minor: Number(r.amountMinor),
            currency: r.currency,
            reversal: true,
            retriable,
            error_code: code,
            source: "settlement_report",
          },
        },
      };
    });
  }

  private async enqueue(
    eventType: string,
    data: Record<string, unknown>,
    delayMs: number,
  ): Promise<void> {
    const eventId = newId("tmev");
    const payloadObj = {
      id: eventId,
      type: eventType,
      business: this.businessId,
      occurred_at: stampNow().toISOString(),
      data,
    };
    await store.enqueueOutbound({
      businessId: this.businessId,
      eventId,
      eventType,
      payload: payloadObj,
      signature: signTmtest(payloadObj),
      deliverAfter: new Date(Date.now() + delayMs),
    });
  }

  /**
   * Test hook (card-updater / disputes): enqueue an arbitrary synthetic gateway
   * event (e.g. `payment_method.updated`, `dispute.created`) that flows through
   * the REAL inbound pipeline on the next `advanceTmtest` — signature-verified +
   * normalized + handled exactly like an external gateway webhook. Returns the
   * synthetic provider event id so verify suites can assert on it.
   */
  async triggerSyntheticEvent(
    eventType: string,
    data: Record<string, unknown>,
    delayMs = 0,
  ): Promise<string> {
    const eventId = newId("tmev");
    const payloadObj = {
      id: eventId,
      type: eventType,
      business: this.businessId,
      occurred_at: stampNow().toISOString(),
      data,
    };
    await store.enqueueOutbound({
      businessId: this.businessId,
      eventId,
      eventType,
      payload: payloadObj,
      signature: signTmtest(payloadObj),
      deliverAfter: new Date(Date.now() + delayMs),
    });
    return eventId;
  }

  /** The synthetic gateway's event id is in the body. */
  webhookEventId(input: NormalizeWebhookInput): string {
    return webhookEventId([bodyId(input.payload)], input.payload);
  }

  async normalizeWebhook(input: NormalizeWebhookInput): Promise<NormalizedProviderEvent[]> {
    const body = typeof input.payload === "string" ? input.payload : input.payload.toString("utf8");
    const sig = (input.headers["x-tmtest-signature"] as string | undefined) ?? "";
    const evt = JSON.parse(body) as {
      id: string;
      type: string;
      occurred_at: string;
      data: Record<string, unknown>;
    };
    if (!verifyTmtest(evt, sig)) throw new Error("tmtest webhook signature verification failed");
    const eventId = this.webhookEventId(input);
    const d = evt.data;
    const occurredAt = new Date(evt.occurred_at);

    // ── Automatic card updater (synthetic) ────────────────────────────────────
    if (evt.type === "payment_method.updated") {
      return [
        {
          providerEventId: eventId,
          type: "payment_method.updated",
          providerPaymentMethodId: d.provider_payment_method_id as string | undefined,
          card: {
            brand: (d.brand as string | undefined) ?? null,
            last4: (d.last4 as string | undefined) ?? null,
            expMonth: (d.exp_month as number | undefined) ?? null,
            expYear: (d.exp_year as number | undefined) ?? null,
          },
          occurredAt,
          raw: evt,
        },
      ];
    }

    // ── Intent lifecycle (synthetic) ──────────────────────────────────────────
    // The same vocabulary the real gateways now emit, so CI can exercise the
    // authorize / fail / void / setup path end-to-end without a live gateway. The
    // correlation key is `provider_intent_id` — what the engine stores in
    // `payment_intents.intent_at_gateway` — and never `charge_id`: an
    // authorized-but-unconsumed intent has no transaction to key on.
    if (evt.type.startsWith("intent.")) {
      const intentId = (d.provider_intent_id ?? d.intent_id ?? d.charge_id) as string | undefined;
      const pmId = d.provider_payment_method_id as string | undefined;
      return [
        {
          providerEventId: eventId,
          type: evt.type as NormalizedProviderEvent["type"],
          ...(intentId ? { providerIntentId: intentId } : {}),
          ...(pmId ? { providerPaymentMethodId: pmId } : {}),
          occurredAt,
          raw: evt,
        },
      ];
    }

    // ── Pre-debit notice outcome (`pre_debit_mode=async`) ─────────────────────
    if (evt.type === "pre_debit_notice.updated") {
      return [
        {
          providerEventId: eventId,
          type: "pre_debit_notice.updated",
          preDebitNotice: {
            notificationRef: d.notification_ref as string,
            status: d.status === "failed" ? "failed" : "sent",
            ...(d.executable_after
              ? { executableAfter: new Date(d.executable_after as string) }
              : {}),
            ...(d.failure_code ? { failureCode: d.failure_code as string } : {}),
            ...(d.failure_message ? { failureMessage: d.failure_message as string } : {}),
          },
          occurredAt,
          raw: evt,
        },
      ];
    }

    // ── Dispute lifecycle (synthetic) ─────────────────────────────────────────
    if (evt.type.startsWith("dispute.")) {
      return [
        {
          providerEventId: eventId,
          type: evt.type as NormalizedProviderEvent["type"],
          providerDisputeId: d.provider_dispute_id as string | undefined,
          providerChargeId: d.provider_charge_id as string | undefined,
          disputeReason: (d.reason as string | undefined) ?? null,
          disputeStatus: (d.status as string | undefined) ?? null,
          disputeAmountMinor: d.amount_minor != null ? BigInt(d.amount_minor as number) : undefined,
          disputeCurrency: (d.currency as string | undefined) ?? null,
          evidenceDueBy: d.evidence_due_by ? new Date(d.evidence_due_by as string) : null,
          occurredAt,
          raw: evt,
        },
      ];
    }

    const type =
      evt.type === "charge.succeeded"
        ? "charge.succeeded"
        : evt.type === "charge.failed"
          ? "charge.failed"
          : evt.type === "charge.refunded"
            ? "charge.refunded"
            : "unknown";
    /**
     * CARRY THE INTENT ID ON A CHARGE EVENT, when the payload names one.
     *
     * A `charge.succeeded` the engine has no `transactions` row for is now RECONCILED
     * rather than ignored (`reconcileUnmatchedCapture`, 2026-08-31, after a buyer was
     * charged twice on INV-5510 and the second payment existed nowhere) — and the only
     * thing that can attribute such a capture to a customer and an invoice is our intent.
     * RazorPay's adapter reads it off `payment.entity.order_id`; this gateway had no
     * equivalent, so the path was UNREACHABLE offline and could not be regression-tested
     * at all. Same key the intent branch above accepts.
     *
     * Optional, so every existing synthetic charge event normalises byte-identically.
     */
    const chargeIntentId = (evt.data.provider_intent_id ?? evt.data.intent_id) as
      | string
      | undefined;
    const captured =
      type === "charge.succeeded" && typeof evt.data.amount_minor === "number"
        ? BigInt(evt.data.amount_minor)
        : undefined;
    return [
      {
        providerEventId: eventId,
        type,
        providerChargeId: evt.data.charge_id as string | undefined,
        ...(chargeIntentId ? { providerIntentId: chargeIntentId } : {}),
        ...(captured != null ? { capturedAmountMinor: captured } : {}),
        occurredAt,
        raw: evt,
      },
    ];
  }

  async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    logSyntheticGatewayRequest({ gatewayKey: this.key, operation: "health_check", status: 200 });
    return { ok: true, detail: "TM Test Gateway is always healthy" };
  }
}
