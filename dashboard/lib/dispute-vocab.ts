// Dispute vocabulary shared by the server actions and the client components. No server imports.

/** The engine's reason vocabulary for a hand-recorded dispute (`DISPUTE_REASONS`). */
export const DISPUTE_REASON_OPTIONS = [
  { value: "fraudulent", label: "Fraudulent" },
  { value: "unrecognized", label: "Not recognized" },
  { value: "duplicate", label: "Duplicate charge" },
  { value: "subscription_canceled", label: "Subscription cancelled" },
  { value: "product_not_received", label: "Product not received" },
  { value: "product_unacceptable", label: "Product not acceptable" },
  { value: "credit_not_processed", label: "Credit not processed" },
  { value: "general", label: "General" },
] as const;
export type DisputeReason = (typeof DISPUTE_REASON_OPTIONS)[number]["value"];

/** A reason's label, or the gateway's own text when it is not in our vocabulary. */
export const disputeReasonLabel = (reason: string | null) =>
  reason ? (DISPUTE_REASON_OPTIONS.find((o) => o.value === reason)?.label ?? reason) : "—";

/** Beside the outcome buttons on a gateway dispute whose gateway never sends the result. */
export const disputeOutcomeNote = (gatewayName: string) =>
  `${gatewayName} does not send the final result of this dispute. When you know the result, mark the dispute as won or lost.`;

/** Dispute status → chip tone. Won is a good outcome (green); lost/needs-response bad. */
export function disputeStatusTone(status: string): "green" | "tan" | "red" | "gray" {
  switch (status) {
    case "won":
      return "green";
    case "lost":
      return "red";
    case "needs_response":
    case "under_review":
      return "tan";
    default:
      return "gray";
  }
}
