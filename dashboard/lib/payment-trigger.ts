import { gatewayName } from "./labels";

/** What started a payment attempt (engine `JourneyTrigger`). */
export type PaymentTrigger =
  | "billing_clock"
  | "dashboard"
  | "portal"
  | "new_payment_method"
  | "offline"
  | "api"
  | "checkout"
  | "webhook"
  | "mcp";

/** What started a payment (engine `initiated_by`). */
export interface PaymentInitiator {
  trigger: PaymentTrigger;
  actor: string | null;
}

/** Only a person is worth naming; system actors (`billing_clock`, a bare `dashboard` key) are not. */
function person(actor: string | null): string | null {
  return actor && actor.includes("@") ? actor : null;
}

/**
 * How a payment's start reads. `retryNumber` is known only on the invoice timeline; without it
 * a clock charge reads as an automatic charge, not as a first charge.
 */
export function paymentTriggerLabel(
  a: { trigger: PaymentTrigger | null; actor: string | null },
  retryNumber?: number | null,
): string | null {
  switch (a.trigger) {
    case "billing_clock":
      if (retryNumber === undefined) return "Automatic charge by the billing clock";
      return retryNumber ? `Automatic retry ${retryNumber}` : "First charge";
    case "dashboard":
      return person(a.actor) ? `Manual collection by ${person(a.actor)}` : "Manual collection";
    case "portal":
      return "Paid by the customer in the portal";
    case "new_payment_method":
      return "Charged when the customer added a payment method";
    case "offline":
      return person(a.actor) ? `Recorded by ${person(a.actor)}` : "Recorded offline";
    case "checkout":
      return "Paid by the customer in checkout";
    case "webhook":
      return `Confirmed by ${gatewayName(a.actor) ?? "the payment gateway"}`;
    case "mcp":
      return "Collected by an AI agent (MCP)";
    case "api":
      return "Collected through the API";
    default:
      return null;
  }
}

/** The "Source" row of a payment page: the label, or "Not recorded". */
export function paymentSourceText(a: PaymentInitiator | null | undefined): string {
  return (a && paymentTriggerLabel(a)) ?? "Not recorded";
}
