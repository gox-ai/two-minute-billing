// Settings → Credits: the limits on free credit in a unit with no money value
// (`credit_config.unit_grant_limits`). Pure, relative imports only: a unit test reads it.
import { toSmallestStep } from "./credits";

/** One unit's limits as the API stores them: the unit's smallest step. Null = not set. */
export type UnitGrantLimits = Record<
  string,
  { max_units?: number | null; alert_above_units?: number | null }
>;

/** What the form posts for one unit: the text as typed, in whole units. */
export interface UnitLimitDraft {
  unit: string;
  plural: string;
  decimals: number;
  max: string;
  alert: string;
}

/**
 * A typed limit → the unit's smallest step. Empty = no limit (null). 0 is a limit.
 * `undefined` when the text is not a number with at most `decimals` places.
 */
export function unitLimitSteps(text: string, decimals: number): number | null | undefined {
  const t = text.trim();
  if (t === "") return null;
  if (!/^\d+(?:\.\d+)?$/.test(t)) return undefined;
  if ((t.split(".")[1] ?? "").length > decimals) return undefined;
  if (Number(t) === 0) return 0;
  return toSmallestStep(t, decimals) ?? undefined;
}

/** The inverse, for the field: 1250 at 2 decimals → "12.5". Null → "". */
export function unitLimitInput(steps: number | null | undefined, decimals: number): string {
  if (steps == null) return "";
  if (decimals === 0) return String(steps);
  const digits = String(steps).padStart(decimals + 1, "0");
  const frac = digits.slice(-decimals).replace(/0+$/, "");
  const whole = digits.slice(0, -decimals);
  return frac ? `${whole}.${frac}` : whole;
}

/** The id of one unit's field. An error is keyed on the field at fault. */
export const unitLimitErrorKey = (unit: string, field: "max" | "alert") =>
  `unit_grant_${field}_${unit}`;

/**
 * The `unit_grant_limits` value to send: the stored map with the posted units set or
 * removed. A unit that is not posted (archived, or it now has a rate) keeps its entry.
 */
export function unitGrantLimitsBody(
  drafts: readonly UnitLimitDraft[],
  stored: UnitGrantLimits,
): { ok: true; value: UnitGrantLimits } | { ok: false; errors: Record<string, string> } {
  const value: UnitGrantLimits = { ...stored };
  const errors: Record<string, string> = {};
  const format = (d: UnitLimitDraft) =>
    d.decimals === 0
      ? "a whole number"
      : `a number with up to ${d.decimals} decimal ${d.decimals === 1 ? "place" : "places"}`;
  for (const d of drafts) {
    const maxKey = unitLimitErrorKey(d.unit, "max");
    const alertKey = unitLimitErrorKey(d.unit, "alert");
    const max = unitLimitSteps(d.max, d.decimals);
    const alert = unitLimitSteps(d.alert, d.decimals);
    if (max === undefined) errors[maxKey] = `Enter the maximum for ${d.plural} as ${format(d)}.`;
    else if (alert === undefined)
      errors[alertKey] = `Enter the alert amount for ${d.plural} as ${format(d)}.`;
    else if (max != null && alert != null && alert > max)
      errors[alertKey] = `The alert amount for ${d.plural} must not be more than the maximum.`;
    else if (max == null && alert == null) delete value[d.unit];
    else value[d.unit] = { max_units: max, alert_above_units: alert };
  }
  return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, value };
}
