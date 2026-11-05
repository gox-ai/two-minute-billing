/**
 * The edition, read from the dashboard server's own TMBILLING_EDITION (the API reads the same
 * name). `cloud` is our hosted service; anything else is a self-hosted install, which shows no
 * sign-up, no plans and no Settings → Billing. next.config.mjs refuses an unknown value.
 *
 * Every Cloud-only screen asks this AND its own setting, and the API enforces the same rule.
 */
export const isCloud = (): boolean => process.env.TMBILLING_EDITION === "cloud";
