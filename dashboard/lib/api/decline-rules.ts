import { apiGet, apiPatch, apiDelete } from "@/lib/api";

/**
 * How one gateway decline behaves for this business.
 *
 * `built_in` is ours and the same for every merchant; `override` is theirs, null until
 * they change something; `effective` is what the engine will actually do. All three are
 * returned together because a screen that showed only the result could not say "you
 * changed this" or honestly offer to put it back.
 */
export interface DeclineRule {
  object: "decline_rule";
  id: string;
  /**
   * False for a code we recognise but no rule names. The row is real and its answer is
   * real; there is simply nothing for an override to attach to, so the screen shows it
   * without controls rather than omitting it.
   */
  overridable: boolean;
  /** A gateway key from `GET /v1/gateways`. */
  gateway: string;
  matches: { field: string; op: string; value: string };
  code: string;
  /** `gateway.<family>.<code>` — the hierarchical axis beside our flat code. */
  error_id: string;
  family: string;
  built_in: { retriable: boolean; message: string | null; exposed_to_payer: boolean };
  override: {
    retriable: boolean | null;
    message: string | null;
    exposed_to_payer: boolean | null;
    /** Who changed it and when — so a surprising setting has a person to ask. */
    updated_by: string | null;
    updated_at: string | null;
    /** "code" means this came from the canonical code above the rule, not from the rule. */
    level: "rule" | "code";
  } | null;
  effective: { retriable: boolean; message: string | null; exposed_to_payer: boolean };
}

/** A setting made on the canonical code, covering every rule that produces it. */
export interface DeclineCodeOverride {
  object: "decline_code_override";
  code: string;
  retriable: boolean | null;
  message: string | null;
  exposed_to_payer: boolean | null;
  updated_by: string | null;
  updated_at: string | null;
}

export interface DeclineRuleList {
  object: "list";
  data: DeclineRule[];
  /**
   * Listed separately from `data` because a code setting can be invisible there: when
   * every rule under it also has its own row, the narrower rows win everywhere and the
   * code setting would show nowhere while still being on the books.
   */
  code_overrides: DeclineCodeOverride[];
  /** Settings whose rule a deploy removed. They no longer apply and the merchant should know. */
  orphaned_overrides: { id: string; decline_rule: string }[];
}

export const listDeclineRules = (biz: string, q?: { gateway?: string; overridden?: boolean }) => {
  const p = new URLSearchParams();
  if (q?.gateway) p.set("gateway", q.gateway);
  if (q?.overridden) p.set("overridden", "true");
  const qs = p.toString();
  return apiGet<DeclineRuleList>(`/v1/businesses/${biz}/decline_rules${qs ? `?${qs}` : ""}`);
};

/**
 * `null` clears one part of the override; an omitted key leaves it alone. The API types
 * carry the same distinction — see the route's `patchBody`.
 */
export const patchDeclineRule = (
  biz: string,
  rule: string,
  body: { retriable?: boolean | null; message?: string | null; exposed_to_payer?: boolean | null },
) => apiPatch(`/v1/businesses/${biz}/decline_rules/${rule}`, body);

/** Remove the override entirely. Answers 200 even when there was nothing to remove. */
export const resetDeclineRule = (biz: string, rule: string) =>
  apiDelete(`/v1/businesses/${biz}/decline_rules/${rule}`);

/** The second level: one setting for every rule that means the same thing. */
export const patchDeclineCode = (
  biz: string,
  code: string,
  body: { retriable?: boolean | null; message?: string | null; exposed_to_payer?: boolean | null },
) => apiPatch(`/v1/businesses/${biz}/decline_codes/${code}`, body);

export const resetDeclineCode = (biz: string, code: string) =>
  apiDelete(`/v1/businesses/${biz}/decline_codes/${code}`);
