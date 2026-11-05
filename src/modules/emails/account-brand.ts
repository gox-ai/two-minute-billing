import { config } from "@/platform/config";

/** Who signs the emails we send people about their own account (sign-up, invites, security). */
export interface AccountBrand {
  /** Product name in subjects, body and footer. */
  name: string;
  /** Hosted PNG logo; null renders the name as a text wordmark. */
  logoUrl: string | null;
  supportEmail: string | null;
}

/**
 * Cloud is Two Minute Billing with its logo. A self-hosted deployment is not us, so it signs
 * with its own `MAIL_FROM_NAME` and no logo.
 */
export function accountBrand(): AccountBrand {
  const cloud = config.TMBILLING_EDITION === "cloud";
  const base = config.DASHBOARD_BASE_URL?.replace(/\/$/, "");
  return {
    name: cloud ? "Two Minute Billing" : config.MAIL_FROM_NAME,
    logoUrl: cloud && base ? `${base}/brand/email-logo.png` : null,
    supportEmail: config.SUPPORT_EMAIL ?? null,
  };
}
