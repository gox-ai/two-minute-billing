// Relative, so verify:edition can import this file from the engine side.
import { isCloud } from "./edition";

/**
 * Account billing (F4): Cloud bills its organizations for their plan. The dashboard reads it
 * from ACCOUNT_BILLING_URL with ACCOUNT_BILLING_TOKEN, and only when TMBILLING_EDITION=cloud:
 * a self-hosted copy has no Billing page and no plan limits, whatever else is set.
 */
const URL_ = process.env.ACCOUNT_BILLING_URL?.replace(/\/+$/, "");
const TOKEN = process.env.ACCOUNT_BILLING_TOKEN;

export const accountBillingEnabled = (): boolean => isCloud() && !!URL_ && !!TOKEN;

export interface PlanPrice {
  id: string;
  tier: string;
  name: string;
  currency: string;
  interval: "month" | "year";
  amount_minor: number;
  volume_limit_minor: number | null;
}

export interface AccountBilling {
  organization: string;
  /** Live access from an agreement, not a plan: the page offers no plans. */
  agreement: boolean;
  currency: string;
  live_access: "locked" | "enabled";
  status: "active" | "restricted";
  /** Why it is read-only: its plan is unpaid, or staff approved it over its limit. */
  restricted_reason: "unpaid" | "over_limit" | null;
  plan:
    | (Omit<PlanPrice, "id"> & {
        price: string;
        subscription: string;
        subscription_status: string;
        renews_at: string | null;
      })
    | null;
  /** The Free plan: what the organization is on while `plan` is null. */
  free: PlanPrice;
  /** The paid plans to buy. */
  prices: PlanPrice[];
  /** The monthly volume the current plan covers; null on an agreement. */
  limit_minor: number | null;
  /** This month's volume is above `limit_minor`. A notice only. */
  over_limit: boolean;
  usage: { volume_minor: number | null; from: string; to: string; note: string | null };
}

async function call<T>(path: string, body?: unknown): Promise<T> {
  if (!accountBillingEnabled() || !URL_ || !TOKEN)
    throw new Error("Account billing is not set up on this deployment.");
  const res = await fetch(`${URL_}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "x-account-billing-token": TOKEN,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });
  const json = (await res.json().catch(() => ({}))) as T & { error?: { message?: string } };
  if (!res.ok) throw new Error(json.error?.message ?? `Account billing answered ${res.status}.`);
  return json;
}

export const getAccountBilling = (org: string) =>
  call<AccountBilling>(`/v1/account_billing/${encodeURIComponent(org)}`);

export const planCheckout = (org: string, price: string, returnUrl: string) =>
  call<{ url: string }>(`/v1/account_billing/${encodeURIComponent(org)}/checkout`, {
    price,
    return_url: returnUrl,
  });

export const billingPortal = (org: string, returnUrl: string) =>
  call<{ url: string }>(`/v1/account_billing/${encodeURIComponent(org)}/portal`, {
    return_url: returnUrl,
  });
