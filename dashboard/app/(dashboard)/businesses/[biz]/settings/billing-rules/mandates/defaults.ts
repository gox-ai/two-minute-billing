// Mirrors MANDATE_HEADROOM_BPS (payment-methods/service.ts) and SMALLEST_RAIL_CEILING_CAP_MINOR
// (payment-methods/mandate-afa.ts, NPCI's UPI Autopay cap in paise). Keep in step.
export const DEFAULT_HEADROOM_BPS = 13_000;
export const DEFAULT_RAIL_CAP_MINOR = 10_000_000;
