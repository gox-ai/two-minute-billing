/**
 * The notification catalogue: every kind a member or a destination can receive. Pure.
 * Copy follows ASD-STE100; defaults follow the design's catalogue (2026-11-16).
 */
import type { EventType } from "../events/registry";
import type { PermissionKey } from "../auth/permissions";

export const NOTIFICATION_KINDS = [
  "payment_failed",
  "payment_received",
  "refund_failed",
  "payment_needs_attention",
  "late_payment_failure",
  "possible_fraud",
  "dispute_opened",
  "dispute_evidence_due",
  "dispute_closed",
  "retries_exhausted",
  "invoice_overdue",
  "payment_method_unusable",
  "new_revenue",
  "subscription_created",
  "subscription_cancelled",
  "cancellation_scheduled",
  "subscription_reactivated",
  "trial_ending",
  "customer_portal_change",
  "large_renewal",
  "spend_limit_reached",
  "usage_alert",
  "auto_topup_failed",
  "large_credit_grant",
  "webhook_failing",
  "gateway_attention",
] as const;

export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];
export type NotificationGroup =
  | "Payments"
  | "Disputes"
  | "Collections"
  | "Subscriptions"
  | "Usage and credits"
  | "Operations";
export type NotificationTone = "destructive" | "warning" | "neutral";
export type Timing = "instant" | "summary" | "off";
export type MemberRole = "owner" | "admin" | "manager" | "ops" | "developer" | "custom";

/**
 * A check the fan-out runs on the loaded facts before the kind applies.
 * - fraud_decline: the payment's decline code is in FRAUD_DECLINE_CODES.
 * - first_invoice: the first invoice of its subscription, or of its customer when not recurring.
 * - live_subscription: the customer has a live subscription.
 * - merchant_account: the error code resolves to the `merchant_account` family.
 * - portal: the event's source is the customer portal.
 */
export type DerivedCheck =
  | "fraud_decline"
  | "first_invoice"
  | "live_subscription"
  | "merchant_account"
  | "portal";

export interface KindDef {
  kind: NotificationKind;
  group: NotificationGroup;
  label: string;
  help: string;
  tone: NotificationTone;
  permission: PermissionKey;
  /** Has an "Only above" amount limit. */
  amount: boolean;
  /** Event types, or `clock` (the hourly clock), or `direct` (a module calls in). */
  source: readonly EventType[] | "clock" | "direct";
  derived?: DerivedCheck;
  defaultTiming: (role: MemberRole) => Timing;
  /** Default channels when the kind is Instant. */
  defaultPush: boolean;
  defaultEmail: boolean;
  /** For one recipient and one event, this kind replaces these. */
  supersedes?: readonly NotificationKind[];
}

const always =
  (t: Timing) =>
  (_role: MemberRole): Timing =>
    t;
const instantFor =
  (roles: readonly MemberRole[]) =>
  (role: MemberRole): Timing =>
    roles.includes(role) ? "instant" : "off";

type Def = Omit<KindDef, "kind">;

const DEFS: Record<NotificationKind, Def> = {
  // ── Payments ──
  payment_failed: {
    group: "Payments",
    label: "Payment failed",
    help: "A charge on a customer's payment method failed.",
    tone: "destructive",
    permission: "payments:view",
    amount: true,
    source: ["payment_failed"],
    defaultTiming: always("instant"),
    defaultPush: true,
    defaultEmail: false,
  },
  payment_received: {
    group: "Payments",
    label: "Payment received",
    help: "A payment succeeded.",
    tone: "neutral",
    permission: "payments:view",
    amount: true,
    source: ["payment_succeeded"],
    defaultTiming: always("summary"),
    defaultPush: true,
    defaultEmail: false,
  },
  refund_failed: {
    group: "Payments",
    label: "Refund failed",
    help: "The payment gateway refused a refund.",
    tone: "destructive",
    permission: "payments:view",
    amount: true,
    source: ["refund_failed"],
    defaultTiming: always("instant"),
    defaultPush: true,
    defaultEmail: true,
  },
  payment_needs_attention: {
    group: "Payments",
    label: "Payment needs attention",
    help: "We do not know the result of a payment. Check it in the gateway.",
    tone: "warning",
    permission: "payments:view",
    amount: true,
    source: ["transaction_needs_attention"],
    defaultTiming: always("instant"),
    defaultPush: true,
    defaultEmail: false,
  },
  late_payment_failure: {
    group: "Payments",
    label: "Late payment failure",
    help: "A payment that showed as paid failed later.",
    tone: "destructive",
    permission: "payments:view",
    amount: true,
    source: ["transaction_late_failure"],
    defaultTiming: always("instant"),
    defaultPush: true,
    defaultEmail: true,
  },
  possible_fraud: {
    group: "Payments",
    label: "Possible fraud",
    help: "The gateway refused a payment as fraud, or a lost or stolen card.",
    tone: "destructive",
    permission: "payments:view",
    amount: false,
    source: ["payment_failed"],
    derived: "fraud_decline",
    defaultTiming: always("instant"),
    defaultPush: true,
    defaultEmail: true,
    supersedes: ["payment_failed"],
  },
  // ── Disputes ──
  dispute_opened: {
    group: "Disputes",
    label: "Dispute opened",
    help: "A customer disputed a payment with their bank.",
    tone: "destructive",
    permission: "payments:view",
    amount: false,
    source: ["dispute_created"],
    defaultTiming: always("instant"),
    defaultPush: true,
    defaultEmail: true,
  },
  dispute_evidence_due: {
    group: "Disputes",
    label: "Evidence due soon",
    help: "3 days and 1 day before the evidence deadline.",
    tone: "warning",
    permission: "payments:view",
    amount: false,
    source: "clock",
    defaultTiming: always("instant"),
    defaultPush: true,
    defaultEmail: true,
  },
  dispute_closed: {
    group: "Disputes",
    label: "Dispute won or lost",
    help: "The bank decided a dispute for you or for the customer.",
    tone: "neutral",
    permission: "payments:view",
    amount: false,
    source: ["dispute_won", "dispute_lost"],
    defaultTiming: always("summary"),
    defaultPush: true,
    defaultEmail: false,
  },
  // ── Collections ──
  retries_exhausted: {
    group: "Collections",
    label: "All payment retries failed",
    help: "The invoice stays unpaid. We do not try again.",
    tone: "destructive",
    permission: "invoices:view",
    amount: true,
    // `invoice_not_paid` follows it for the same invoice, so it is not a source.
    source: ["invoice_dunning_exhausted"],
    defaultTiming: always("instant"),
    defaultPush: true,
    defaultEmail: false,
  },
  invoice_overdue: {
    group: "Collections",
    label: "Invoice overdue",
    help: "An unpaid invoice is past its due date.",
    tone: "warning",
    permission: "invoices:view",
    amount: true,
    source: "clock",
    defaultTiming: always("summary"),
    defaultPush: true,
    defaultEmail: false,
  },
  payment_method_unusable: {
    group: "Collections",
    label: "Payment method no longer works",
    help: "A card expired or the gateway marked it invalid, and the customer has a live subscription.",
    tone: "warning",
    permission: "payment_methods:view",
    amount: false,
    source: ["payment_source_invalidated", "payment_source_expired"],
    derived: "live_subscription",
    defaultTiming: always("summary"),
    defaultPush: true,
    defaultEmail: false,
  },
  // ── Subscriptions ──
  new_revenue: {
    group: "Subscriptions",
    label: "New revenue",
    help: "The first invoice of a new customer or subscription.",
    tone: "neutral",
    permission: "invoices:view",
    amount: true,
    source: ["invoice_generated"],
    derived: "first_invoice",
    defaultTiming: always("summary"),
    defaultPush: true,
    defaultEmail: false,
  },
  subscription_created: {
    group: "Subscriptions",
    label: "New subscription",
    help: "A customer started a subscription.",
    tone: "neutral",
    permission: "subscriptions:view",
    amount: false,
    source: ["subscription_created"],
    defaultTiming: always("summary"),
    defaultPush: true,
    defaultEmail: false,
  },
  subscription_cancelled: {
    group: "Subscriptions",
    label: "Subscription cancelled",
    help: "A subscription stopped.",
    tone: "neutral",
    permission: "subscriptions:view",
    amount: false,
    source: ["subscription_canceled"],
    defaultTiming: always("summary"),
    defaultPush: true,
    defaultEmail: false,
  },
  cancellation_scheduled: {
    group: "Subscriptions",
    label: "Cancellation scheduled",
    help: "A customer set their subscription to end later.",
    tone: "neutral",
    permission: "subscriptions:view",
    amount: false,
    source: ["subscription_cancel_scheduled"],
    defaultTiming: always("off"),
    defaultPush: true,
    defaultEmail: false,
  },
  subscription_reactivated: {
    group: "Subscriptions",
    label: "Subscription reactivated",
    help: "A cancelled subscription started again.",
    tone: "neutral",
    permission: "subscriptions:view",
    amount: false,
    source: ["subscription_reactivated"],
    defaultTiming: always("off"),
    defaultPush: true,
    defaultEmail: false,
  },
  trial_ending: {
    group: "Subscriptions",
    label: "Trial ends soon",
    help: "A customer's free trial ends in a few days.",
    tone: "neutral",
    permission: "subscriptions:view",
    amount: false,
    source: ["subscription_trial_ending"],
    defaultTiming: always("off"),
    defaultPush: true,
    defaultEmail: false,
  },
  customer_portal_change: {
    group: "Subscriptions",
    label: "Changed by the customer",
    help: "The customer changed their plan, add-ons or quantity, or paused or cancelled, in the portal.",
    tone: "neutral",
    permission: "subscriptions:view",
    amount: false,
    source: [
      "subscription_changed",
      "subscription_change_scheduled",
      "subscription_paused",
      "subscription_pause_scheduled",
      "subscription_canceled",
      "subscription_cancel_scheduled",
    ],
    derived: "portal",
    defaultTiming: always("off"),
    defaultPush: true,
    defaultEmail: false,
    supersedes: ["subscription_cancelled", "cancellation_scheduled"],
  },
  large_renewal: {
    group: "Subscriptions",
    label: "Large renewal soon",
    help: "A yearly subscription renews in 30 days, and again in 7 days.",
    tone: "neutral",
    permission: "subscriptions:view",
    amount: true,
    source: "clock",
    defaultTiming: always("off"),
    defaultPush: true,
    defaultEmail: false,
  },
  // ── Usage and credits ──
  spend_limit_reached: {
    group: "Usage and credits",
    label: "Spending limit reached",
    help: "The customer's new usage is refused.",
    tone: "warning",
    permission: "usage_controls:view",
    amount: false,
    source: ["spend_limit_reached"],
    defaultTiming: always("instant"),
    defaultPush: true,
    defaultEmail: false,
  },
  usage_alert: {
    group: "Usage and credits",
    label: "Usage alert",
    help: "A customer's usage passed an alert you set on the subscription.",
    tone: "neutral",
    permission: "usage_controls:view",
    amount: false,
    source: ["usage_alert_triggered", "usage_threshold_reached"],
    defaultTiming: always("off"),
    defaultPush: true,
    defaultEmail: false,
  },
  auto_topup_failed: {
    group: "Usage and credits",
    label: "Automatic top-up failed",
    help: "We could not charge a customer for an automatic credit top-up.",
    tone: "destructive",
    permission: "usage_controls:view",
    amount: true,
    source: [
      "credit_auto_topup_failed",
      "credit_auto_topup_hard_declined",
      "credit_auto_topup_retries_exhausted",
    ],
    defaultTiming: always("instant"),
    defaultPush: true,
    defaultEmail: false,
  },
  large_credit_grant: {
    group: "Usage and credits",
    label: "Large free credit grant",
    help: "Someone gave a customer free credit above the business's grant limit.",
    tone: "warning",
    permission: "credits:view",
    amount: false,
    source: "direct",
    defaultTiming: instantFor(["owner", "admin"]),
    defaultPush: true,
    defaultEmail: true,
  },
  // ── Operations ──
  webhook_failing: {
    group: "Operations",
    label: "Webhook endpoint failing",
    help: "Deliveries to one of your endpoints failed after all retries.",
    tone: "warning",
    permission: "webhooks:view",
    amount: false,
    source: "clock",
    // The owner holds every admin permission, so it counts as an admin here.
    defaultTiming: instantFor(["owner", "admin", "developer"]),
    defaultPush: false,
    defaultEmail: true,
  },
  gateway_attention: {
    group: "Operations",
    label: "Payment gateway needs attention",
    help: "The gateway refused a payment because of your account with it, for example revoked keys.",
    tone: "destructive",
    permission: "gateways:view",
    amount: false,
    source: ["payment_attempt_failed"],
    derived: "merchant_account",
    defaultTiming: instantFor(["owner", "admin", "developer"]),
    defaultPush: true,
    defaultEmail: true,
  },
};

const BY_KIND = new Map<string, KindDef>(
  NOTIFICATION_KINDS.map((kind) => [kind, { kind, ...DEFS[kind] }]),
);

export const CATALOGUE: readonly KindDef[] = NOTIFICATION_KINDS.map((k) => BY_KIND.get(k)!);

export function isNotificationKind(v: string): v is NotificationKind {
  return BY_KIND.has(v);
}

export function kindDef(kind: NotificationKind): KindDef;
export function kindDef(kind: string): KindDef | undefined;
export function kindDef(kind: string): KindDef | undefined {
  return BY_KIND.get(kind);
}

/** Event type → kinds it can produce. Built once; the sink reads it on every event. */
const BY_EVENT = new Map<string, NotificationKind[]>();
for (const def of CATALOGUE) {
  if (!Array.isArray(def.source)) continue;
  for (const t of def.source) BY_EVENT.set(t, [...(BY_EVENT.get(t) ?? []), def.kind]);
}

/** Every event type some kind listens to. */
export const SOURCE_EVENT_TYPES: ReadonlySet<string> = new Set(BY_EVENT.keys());

/**
 * Kinds an event may produce, before the derived checks. Cheap: one map lookup. A portal kind
 * is a candidate only when the event's source is the customer portal.
 */
export function candidateKinds(event: {
  type: string;
  source?: string | null;
}): NotificationKind[] {
  const kinds = BY_EVENT.get(event.type);
  if (!kinds) return [];
  return event.source === "portal" ? kinds : kinds.filter((k) => DEFS[k].derived !== "portal");
}

export interface KindPreference {
  timing: Timing;
  push: boolean;
  email: boolean;
  above?: Record<string, number>;
}

/** What a member gets on the first save. Off and summary rows keep the channels they get if set to Instant. */
export function defaultPreferences(role: MemberRole): Record<NotificationKind, KindPreference> {
  const out = {} as Record<NotificationKind, KindPreference>;
  for (const def of CATALOGUE)
    out[def.kind] = {
      timing: def.defaultTiming(role),
      push: def.defaultPush,
      email: def.defaultEmail,
    };
  return out;
}

/**
 * Canonical decline tokens that mean fraud or a lost or stolen card, on every gateway
 * (`src/providers/decline-codes.ts` maps each gateway's codes onto them; all four are in its
 * TERMINAL set). Left out: `highest_risk_level` maps to `network_do_not_retry`, and gateway
 * risk-rule refusals (`FRAUD`, `RISK_THRESHOLD`) map to `card_declined`; both tokens also
 * cover refusals that are not fraud.
 */
export const FRAUD_DECLINE_CODES: ReadonlySet<string> = new Set([
  "fraudulent",
  "stolen_card",
  "lost_card",
  "pickup_card",
]);
