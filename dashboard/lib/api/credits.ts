// Credit units, grants, holds and the live balance. Server-only (imports the API client).
// Routes and shapes follow design G3 § 7; pure helpers and shared types are in `lib/credits.ts`.
import { apiGet, apiGetOrNull, apiWrite, type PagedList } from "@/lib/api";
import { resetRules, type PlanCreditResets } from "@/lib/billing-rules";
import { resolveCreditConfig, type CreditConfigInput } from "@/lib/credits";
import type {
  CreditApplicability,
  CreditCategory,
  CreditOnExhausted,
  CreditTaxTreatment,
  CreditUnit,
  CustomerCreditSettings,
  ResolvedCreditConfig,
} from "@/lib/credits";

interface List<T> {
  object: "list";
  data: T[];
}

export interface CreditGrant {
  object: "credit_grant";
  /** `cgr_…` */
  id: string;
  customer: string;
  currency: string;
  /** Credit unit key; null = money. */
  unit: string | null;
  /** Units at grant, in the unit's smallest step. */
  amount: number;
  face_minor: number;
  cost_basis_minor: number;
  /** Σ movements: never stored. */
  remaining: { units: number; face_minor: number; cost_minor: number };
  category: CreditCategory;
  priority: number;
  effective_at: string;
  expires_at: string | null;
  applicability: CreditApplicability;
  source: string;
  /** The invoice that sold it (paid grants). */
  invoice: string | null;
  tax_treatment: CreditTaxTreatment | null;
  on_exhausted: CreditOnExhausted | null;
  status: "pending" | "active" | "expired" | "voided";
  restored_from?: string | null;
  /** `atur_…`: the automatic top-up run that sold it. */
  auto_top_up_run?: string | null;
  created_at: string;
}

export interface CreditHold {
  object: "credit_hold";
  /** `chd_…` */
  id: string;
  customer: string;
  currency: string;
  amount_minor: number;
  meter: string | null;
  scope: Record<string, string> | null;
  status: "held" | "captured" | "released" | "expired";
  expires_at: string;
  captured_minor: number | null;
  overdraft: boolean;
  created_at: string;
}

export interface CreditTransaction {
  object: "credit_transaction";
  id: string;
  /** grant | activate | draw | expire | void | restore | rollover_in | rollover_out | hold */
  kind: string;
  grant: string;
  category: CreditCategory;
  unit: string | null;
  /** Signed, in the unit's smallest step. */
  units: number;
  /** Signed. */
  face_minor: number;
  cost_minor: number;
  currency: string;
  invoice: string | null;
  created_at: string;
}

/** The live balance in the customer's currency: the access check without a meter (§ 3.5, § 3.9). */
export interface CreditBalance {
  currency: string;
  available_minor: number;
  /** Per custom unit, in the unit's smallest step. */
  available_units: Array<{ unit: string; units: number }>;
  balance: {
    grants_minor: number;
    unbilled_usage_minor: number;
    open_holds_minor: number;
    overdraft_limit_minor: number;
  };
  on_exhausted: { policy: CreditOnExhausted; source: string };
}

const b = (biz: string) => `/v1/businesses/${biz}`;
const c = (biz: string, cus: string) => `${b(biz)}/customers/${encodeURIComponent(cus)}`;

// ── Units ───────────────────────────────────────────────────────────────────────

export async function listCreditUnits(biz: string): Promise<List<CreditUnit>> {
  const data: CreditUnit[] = [];
  let after: string | null = null;
  for (let page = 0; page < 20; page++) {
    const q = new URLSearchParams({ limit: "100", ...(after ? { starting_after: after } : {}) });
    const res: PagedList<CreditUnit> = await apiGet<PagedList<CreditUnit>>(
      `${b(biz)}/credit_units?${q}`,
    );
    data.push(...res.data);
    if (!res.has_more || !res.next_cursor) break;
    after = res.next_cursor;
  }
  return { object: "list", data };
}

export const getCreditUnit = (biz: string, unit: string) =>
  apiGetOrNull<CreditUnit>(`${b(biz)}/credit_units/${encodeURIComponent(unit)}`);

export interface CreditUnitWrite {
  id?: string;
  name?: string;
  plural_name?: string;
  currency?: string;
  minor_per_unit?: string;
  decimals?: number;
  expected_version?: number;
}

export const createCreditUnit = (biz: string, body: CreditUnitWrite) =>
  apiWrite(`${b(biz)}/credit_units`, body, "POST");
export const updateCreditUnit = (biz: string, unit: string, body: CreditUnitWrite) =>
  apiWrite(`${b(biz)}/credit_units/${encodeURIComponent(unit)}`, body, "PATCH");
export const archiveCreditUnit = (biz: string, unit: string) =>
  apiWrite(`${b(biz)}/credit_units/${encodeURIComponent(unit)}/archive`, {}, "POST");

// ── Customer: balance, grants, holds, transactions ─────────────────────────────

/** No meter and no estimate: the check only reads (no lock, no write). */
export const getCreditBalance = (biz: string, cus: string) =>
  apiGet<CreditBalance>(`${c(biz, cus)}/access`);

export const listCreditGrants = (biz: string, cus: string, status?: string) =>
  apiGet<PagedList<CreditGrant>>(
    `${c(biz, cus)}/credit_grants?limit=100${status ? `&status=${status}` : ""}`,
  );

export interface CreditGrantWrite {
  category: CreditCategory;
  unit: string | null;
  amount: number;
  currency?: string;
  priority?: number;
  expires_at?: string;
  on_exhausted?: CreditOnExhausted | null;
  /** Paid only: net price, the cost basis. */
  price_minor?: number;
  tax_treatment?: CreditTaxTreatment;
  mark_paid?: { method: string; reference?: string; paid_at?: string };
}

export const createCreditGrant = (biz: string, cus: string, body: CreditGrantWrite) =>
  apiWrite(`${c(biz, cus)}/credit_grants`, body, "POST");
export const voidCreditGrant = (biz: string, cus: string, grant: string) =>
  apiWrite(`${c(biz, cus)}/credit_grants/${encodeURIComponent(grant)}/void`, {}, "POST");

export const listCreditHolds = (biz: string, cus: string, status = "held") =>
  apiGet<PagedList<CreditHold>>(
    `${b(biz)}/credit_holds?customer=${encodeURIComponent(cus)}&status=${status}&limit=100`,
  );
export const releaseCreditHold = (biz: string, hold: string) =>
  apiWrite(`${b(biz)}/credit_holds/${encodeURIComponent(hold)}/release`, {}, "POST");

export interface CreditTransactionFilters {
  grant?: string;
  kind?: string;
  category?: string;
  unit?: string;
  invoice?: string;
  /** Unix seconds. */
  created_gte?: string;
  created_lt?: string;
  starting_after?: string;
}

export function listCreditTransactions(
  biz: string,
  cus: string,
  f: CreditTransactionFilters,
  limit = 25,
): Promise<PagedList<CreditTransaction>> {
  const q = new URLSearchParams({ limit: String(limit) });
  for (const k of ["grant", "kind", "category", "unit", "invoice", "starting_after"] as const)
    if (f[k]) q.set(k, f[k]!);
  if (f.created_gte) q.set("created[gte]", f.created_gte);
  if (f.created_lt) q.set("created[lt]", f.created_lt);
  return apiGet<PagedList<CreditTransaction>>(`${c(biz, cus)}/credit_transactions?${q}`);
}

/** PATCH customer `credit_settings` whole. */
export const updateCustomerCreditSettings = (
  biz: string,
  cus: string,
  settings: CustomerCreditSettings | null,
) => apiWrite(c(biz, cus), { credit_settings: settings }, "PATCH");

/** PATCH business `credit_config` whole. */
export const updateCreditConfig = (
  biz: string,
  config: ResolvedCreditConfig,
  expectedVersion?: number,
) =>
  apiWrite(
    b(biz),
    { credit_config: config, ...(expectedVersion ? { expected_version: expectedVersion } : {}) },
    "PATCH",
  );

/**
 * What the price form's "Grants credit" card needs. Null when the units cannot be read, so
 * the card is not offered rather than offered without its choices.
 */
export async function loadGrantsCreditContext(
  biz: string,
  business: object | undefined,
): Promise<{
  units: CreditUnit[];
  blockingEnabled: boolean;
  defaultTaxTreatment: CreditTaxTreatment | null;
  firstWindowDefault: PlanCreditResets["first_window"];
} | null> {
  const units = await listCreditUnits(biz).catch(() => null);
  if (!units) return null;
  const cfg = resolveCreditConfig(
    (business as { credit_config?: CreditConfigInput } | undefined)?.credit_config,
  );
  return {
    units: units.data,
    blockingEnabled: cfg.blocking_enabled,
    defaultTaxTreatment: cfg.default_tax_treatment,
    firstWindowDefault: resetRules(business as { billing_rules_config?: object | null } | undefined)
      .planCredits.first_window,
  };
}
