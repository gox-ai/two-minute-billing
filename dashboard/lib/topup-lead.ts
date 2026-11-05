// Pure: no imports, so the engine's unit tests can load it.

/**
 * The lead-time inputs of the automatic top-up form: the saved config's `lead_time` (its
 * payment method's notice lead and the burn the API measured), else the runway's burn and no
 * lead. With them the form warns while the operator types, not only after a save.
 */
export function topupLeadInputs(
  topup: {
    lead_time?: { lead_hours: number; burn_minor_per_day: number | null } | null;
  } | null,
  runwayBurnPerDay: number | null,
): { leadHours: number | null; burnPerDay: number | null } {
  return {
    leadHours: topup?.lead_time?.lead_hours ?? null,
    burnPerDay: topup?.lead_time?.burn_minor_per_day ?? runwayBurnPerDay,
  };
}
