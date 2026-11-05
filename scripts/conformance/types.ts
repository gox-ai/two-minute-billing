/**
 * The shape of a gateway's conformance fixture module. One module per adapter, in
 * `scripts/conformance/fixtures/<gateway>.ts`. `README.md` is the recipe.
 */
import type { NormalizedProviderEvent, ProviderKey } from "@/providers/types";
import type { FakeGateway } from "./fake-http";
import type { World } from "./harness";

export const SCENARIOS = {
  S1: "every documented status maps to a known engine outcome",
  S2: "two partial refunds of ours, then a redelivery, book the exact total",
  S3: "refunds made in the gateway's dashboard are each booked once, at their own amount",
  S4: "a refund failure reverses exactly once",
  S5: "dispute opened, funds withdrawn, then won, lost, and won after a loss",
  S6: "a capture after a booked failure is booked",
  S7: "a lost charge answer resolves and never double-charges",
  S8: "409 / 429 / 5xx / internal answers are never a definite failure",
  S9: "a late failure reverses through lateReversal",
  S10: "a pending debit can be cancelled",
  S11: "duplicate and out-of-order webhooks",
  S12: "a forged signature is refused and nothing is recorded",
  S13: "an old or alternate event version / payload shape",
  S14: "field and currency limits on the request we send",
} as const;
export type ScenarioId = keyof typeof SCENARIOS;
export const SCENARIO_IDS = Object.keys(SCENARIOS) as ScenarioId[];

export type EventType = NormalizedProviderEvent["type"];

/** A page the statuses were read from. `read` is the date (YYYY-MM-DD) someone read it. */
export interface DocSource {
  id: string;
  url: string;
  read: string;
  /**
   * How `gateway-docs:recheck` reads it. `openapi-enum` / `openapi-text` walk `path` in a
   * JSON spec (an enum array, or a description string whose `CODE`-like words are the
   * values); `page` searches the page text.
   */
  check:
    | { kind: "openapi-enum"; path: string[] }
    | { kind: "openapi-text"; path: string[] }
    | { kind: "page" }
    /** An XML Schema `simpleType` named `type`: its `enumeration` values. */
    | { kind: "xsd-enum"; type: string };
}

/** One documented status and what the engine must make of it. */
export interface DocumentedStatus {
  /** What carries the status: `payment`, `refund`, `dispute`, `event:payments`… */
  object: string;
  /** Spelled exactly as the docs spell it. */
  status: string;
  /** `DocSource.id`. */
  doc: string;
  /**
   * The normalized events the route must record for it, in any order. `{ none }` is a
   * reviewed decision that the engine takes no action (recorded as `unknown`), with why.
   */
  expect: EventType[] | { none: string };
}

/** A webhook body ready to sign. */
export interface Body {
  body: string;
  /** Provider event ids the delivery carries, for reading back what the route recorded. */
  eventIds: string[];
}

/** What a billed invoice left behind. */
export interface Billed {
  invoiceId: string;
  invoicePublicId: string;
  paymentId: string | null;
  paymentPublicId: string | null;
  /** The gateway's id for the charge (our `provider_charge_id`), "" when none. */
  chargeId: string;
  /** The payment transaction's status; null when the attempt left only a payment row. */
  txnStatus: string | null;
  /** The payment row's status and failure code (an attempt that threw books only these). */
  paymentStatus: string | null;
  failureCode: string | null;
  subscriptionId: string;
  customerId: string;
  paymentMethodId: string;
  amountMinor: bigint;
}

export type DisputeFlow = "won" | "lost" | "win_after_loss";
/** One delivery of a dispute and the money state it must leave. */
export interface DisputeStep {
  after: "opened" | "withdrawn" | "won" | "lost";
  bodies: Body[];
}
export type RefundState = "pending" | "succeeded" | "failed";
export type TokenKind = "pays" | "declines" | "bank_debit";

/**
 * The gateway, as the scenarios drive it. Each method both changes the fake gateway's
 * state and returns what the gateway would deliver, so a read made while normalizing a
 * webhook sees the same world the webhook describes.
 */
export interface GatewayDriver {
  /** The fake API. Its state is per run; scenarios use fresh objects. */
  readonly fake: FakeGateway;
  /** Credentials for `createGatewayAccount`, pointing the adapter at the fake. */
  credentials(webhookSecret: string): Record<string, string>;
  /** A token `vaultPaymentMethod` accepts; null when the gateway has no such instrument. */
  token(kind: TokenKind): string | null;
  /** Headers that sign `body` as the gateway would, for the account's notification URL. */
  sign(w: World, body: string, secret: string): Record<string, string>;
  /** The body as posted, when the signature travels inside it (Adyen's per-item HMAC, Braintree's `bt_signature`). */
  signBody?(w: World, body: string, secret: string): string;
  /** The HTTP status the route must answer to a forged signature. */
  readonly forgedStatus: number;
  /** Turn a billed charge into collected money. A sync gateway already has: return []. */
  collect(w: World, chargeId: string): Body[];
  /** The documented status, delivered against `chargeId` (S1). */
  statusEvent(w: World, s: DocumentedStatus, chargeId: string): Body[];
  /** The gateway says the charge succeeded / failed. `late` = after it had succeeded. */
  paymentSucceeded(w: World, chargeId: string): Body[];
  paymentFailed(w: World, chargeId: string, late: boolean): Body[];
  /** A refund of OURS at the gateway reached `state`. */
  refundEvent(w: World, chargeId: string, refundId: string, state: RefundState): Body[];
  /** A refund made in the gateway's dashboard; returns its id and the events up to success. */
  dashboardRefund(
    w: World,
    chargeId: string,
    amountMinor: bigint,
  ): { refundId: string; events: Body[] };
  /** A dispute run to `flow`'s end, step by step; null when the gateway cannot express it. */
  disputeSteps(w: World, chargeId: string, flow: DisputeFlow): DisputeStep[] | null;
  /** Gateway ids of every charge the fake holds on this instrument (the double-charge check). */
  chargesOn(providerPaymentMethodId: string): string[];
  /** The gateway's own outcome on a create, injected for S7 / S8. */
  readonly errors: {
    /** 409 as the gateway documents it on a charge create. */
    conflict: FaultBody;
    rateLimited: FaultBody;
    server: FaultBody;
    /** An "internal" answer in the gateway's own words, when it documents one. */
    internal?: FaultBody;
    /** A documented validation refusal of a refund (nothing created). */
    refundRefused: FaultBody;
  };
  /** True when the gateway documents that a 429 created nothing (a definite failure is then correct). */
  readonly rateLimitCreatesNothing?: { source: string };
  /** Fake op names of the charge create and the refund create. */
  readonly chargeOp: string;
  readonly refundOp: string;
  /** The fake op a charge lookup by our reference uses, when the adapter has one. */
  readonly lookupOp?: string;
}

export interface FaultBody {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

/** A row only this gateway has (an audit finding with no generic scenario). */
export interface ExtraRow {
  scenario: ScenarioId;
  /** `S6.intent-id` — must start with the scenario id. */
  id: string;
  title: string;
  run(ctx: RowContext): Promise<{ pass: boolean; detail?: string }>;
}

export interface RowContext {
  /** `currency` replaces the fixture's for this world (a rail bound to another currency). */
  world(label: string, currency?: string): Promise<World>;
}

export interface GatewayFixture {
  key: ProviderKey;
  /** The business currency every scenario bills in. */
  currency: string;
  docs: DocSource[];
  statuses: DocumentedStatus[];
  /** Scenario (`S10`) or row (`S5.lost`) → one-line reason it does not apply. */
  na: Partial<Record<string, string>>;
  driver: () => GatewayDriver;
  extraRows?: ExtraRow[];
  /** S14: limits on the request we send, from the gateway's docs. */
  limits?: FieldLimit[];
  /** S14: currencies whose amount the gateway takes in other than 2-decimal minor units. */
  currencyAmounts?: CurrencyAmount[];
}

/** A request field and its documented maximum length. */
export interface FieldLimit {
  /** The fake op whose request carries the field. */
  op: string;
  /** Dot path into the request body (form bodies are flattened as `metadata[x]`). */
  field: string;
  max: number;
  source: string;
}

/** `minor` of `currency` must be sent as `sent`. */
export interface CurrencyAmount {
  currency: string;
  minor: bigint;
  sent: number;
  source: string;
}
