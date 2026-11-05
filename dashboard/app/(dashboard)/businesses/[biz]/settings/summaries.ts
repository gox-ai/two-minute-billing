import type { Business } from "@/lib/api";

/**
 * Value hints for the settings hub rows — the current setting sits on the right of
 * each row, so the index is readable without drilling in.
 *
 * Each of these derives from a real field and spells out the ENGINE default when
 * the field is unset — never a vague "default". If a value can't be summarized
 * truthfully, return undefined so the row renders no hint at all.
 */

export function currencySummary(
  base: string | null | undefined,
  enabled: string[] | null | undefined,
): string | undefined {
  if (!base && !enabled?.length) return undefined;
  if (!enabled?.length) return base ? `${base} only` : undefined;
  const others = enabled.filter((c) => c !== base);
  if (others.length === 0) return base ?? enabled[0];
  const head = [base ?? enabled[0], others[0]].filter(Boolean).join(", ");
  return others.length === 1 ? head : `${head}, +${others.length - 1} more`;
}

export function frequencySummary(freqs: Business["billing_frequencies"]): string {
  if (!freqs || freqs.length === 0) return "Any frequency";
  return freqs.length === 1 ? "1 frequency" : `${freqs.length} frequencies`;
}

export function dunningSummary(
  config: Business["dunning_config"],
  legacyDays: number[] | null | undefined,
): string {
  // The master switch wins: reporting a retry count for a business that duns
  // nothing is the kind of hint that reads as a working feature.
  if (config?.enabled === false) return "Off";
  const retries = config?.retries?.length ?? legacyDays?.length ?? 0;
  // The engine falls back to [1,3,5,7] when nothing is configured — say so
  // rather than implying dunning is off.
  const label =
    retries === 0 ? "Default (4 retries)" : retries === 1 ? "1 retry" : `${retries} retries`;
  const period = config?.dunning_period_days;
  return period ? `${label}, ${period}-day period` : label;
}

export function resolveEmailSummary(cfg: Business["email_config"]): string {
  if (!cfg?.enabled) return "Disabled";
  const types = cfg.types ?? {};
  const off = Object.values(types).filter((v) => v === false).length;
  return off === 0 ? "Enabled" : `Enabled, ${off} muted`;
}

/**
 * Brand styles hint. Counts what is SET rather than claiming a state: "no brand set"
 * is the truthful summary for a business that has none, and it is the common case.
 */
export function brandSummary(b: Business): string {
  const images = [b.logo_url, b.icon_url, b.favicon_url].filter(Boolean).length;
  const parts: string[] = [];
  if (images > 0) parts.push(`${images} of 3 images`);
  if (b.brand_color) parts.push(b.brand_color.toUpperCase());
  return parts.length > 0 ? parts.join(" · ") : "No brand set";
}
