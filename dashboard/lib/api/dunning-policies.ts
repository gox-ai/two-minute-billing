// Typed fetchers for named dunning policies (Settings → Dunning → Policies).
// Server-only. Shapes mirror src/api/dunning-policy-routes.ts.
import { apiGet, apiGetOrNull, apiWrite } from "@/lib/api";
import type { Business } from "@/lib/api";

/** The per-invoice keys of `dunning_config` a policy owns. The stored config is always the full set. */
export type DunningPolicyConfig = Omit<
  NonNullable<Business["dunning_config"]>,
  | "collect_on_payment_method_update"
  | "no_payment_method_at_renewal"
  | "require_successful_charge_on_reactivation"
  | "plan_policies"
>;

export interface DunningPolicy {
  object: "dunning_policy";
  id: string;
  name: string;
  code: string;
  description: string | null;
  config: DunningPolicyConfig;
  archived: boolean;
  archived_at: string | null;
  customer_count: number;
  created_at: string;
  updated_at: string;
  resource_version: number;
}

/** Unpaginated: a business holds a handful of policies. */
export function listDunningPolicies(biz: string, opts?: { includeArchived?: boolean }) {
  const q = opts?.includeArchived ? "?include_archived=true" : "";
  return apiGet<{ object: "list"; data: DunningPolicy[] }>(
    `/v1/businesses/${biz}/dunning_policies${q}`,
  );
}

export function getDunningPolicy(biz: string, dpol: string) {
  return apiGetOrNull<DunningPolicy>(`/v1/businesses/${biz}/dunning_policies/${dpol}`);
}

export function createDunningPolicy(
  biz: string,
  body: { name: string; code: string; description?: string | null; config: DunningPolicyConfig },
) {
  return apiWrite(`/v1/businesses/${biz}/dunning_policies`, body, "POST");
}

/** `config` REPLACES the whole stored set. */
export function updateDunningPolicy(
  biz: string,
  dpol: string,
  body: Partial<{
    name: string;
    code: string;
    description: string | null;
    config: DunningPolicyConfig;
    expected_version: number;
  }>,
) {
  return apiWrite(`/v1/businesses/${biz}/dunning_policies/${dpol}`, body, "PATCH");
}

/** 409 while customers use the policy; the message names how many. */
export function archiveDunningPolicy(biz: string, dpol: string) {
  return apiWrite(`/v1/businesses/${biz}/dunning_policies/${dpol}/archive`, {}, "POST");
}
