// Typed fetchers for Reason Codes (Settings → Reason Codes).
// Server-only — imports the frozen api client. Shapes mirror src/api/reason-code-routes.
import { apiGet, apiWrite } from "@/lib/api";

interface List<T> {
  object: "list";
  data: T[];
}

export const REASON_CODE_APPLIES_TO = ["subscription_cancellation", "refund"] as const;
export type ReasonCodeAppliesTo = (typeof REASON_CODE_APPLIES_TO)[number];

export const APPLIES_TO_LABEL: Record<ReasonCodeAppliesTo, string> = {
  subscription_cancellation: "Subscription cancellation",
  refund: "Refund",
};

export interface ReasonCode {
  object: "reason_code";
  id: string;
  applies_to: ReasonCodeAppliesTo;
  code: string;
  label: string;
  position: number;
  enabled: boolean;
  created_at: string;
  updated_at: string;
  resource_version: number;
}

export function listReasonCodes(biz: string, appliesTo?: ReasonCodeAppliesTo) {
  const suffix = appliesTo ? `?applies_to=${appliesTo}` : "";
  return apiGet<List<ReasonCode>>(`/v1/businesses/${biz}/reason_codes${suffix}`);
}

/**
 * What a picker should offer: enabled codes in order, or the built-in defaults
 * when the business has defined none. `is_fallback` says which — so the UI can
 * be honest that nothing has been configured yet.
 */
export function listOfferedReasons(biz: string, appliesTo: ReasonCodeAppliesTo) {
  return apiGet<{
    object: "list";
    data: Array<{ code: string; label: string }>;
    is_fallback: boolean;
  }>(`/v1/businesses/${biz}/reason_codes?applies_to=${appliesTo}&offered=true`);
}

export function createReasonCode(
  biz: string,
  body: { applies_to: ReasonCodeAppliesTo; code: string; label: string; enabled?: boolean },
) {
  return apiWrite(`/v1/businesses/${biz}/reason_codes`, body, "POST");
}

export function updateReasonCode(
  biz: string,
  id: string,
  body: Partial<{ label: string; position: number; enabled: boolean }>,
) {
  return apiWrite(`/v1/businesses/${biz}/reason_codes/${id}`, body, "PATCH");
}

export function deleteReasonCode(biz: string, id: string) {
  return apiWrite(`/v1/businesses/${biz}/reason_codes/${id}`, {}, "DELETE");
}
