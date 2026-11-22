import { paymentMethodTypeLabel } from "./filter-options";
import { brandLabel } from "./labels";

/**
 * How a saved instrument is named to the buyer, on the portal and the checkout. A mandate rail
 * is named when there is no number to show. With no brand, the method type's display name is
 * used, never the raw id ("us_bank_account").
 */
export function instrumentLabel(pm: {
  type: string;
  brand?: string | null;
  last4?: string | null;
  mandateRail?: string | null;
}): string {
  // Gateways report brands in mixed case and as codes (`visa`, `Visa`, `mast`).
  const brand = pm.brand?.trim() ? brandLabel(pm.brand.trim()) : null;
  const name = brand ?? paymentMethodTypeLabel(pm.type);
  if (pm.last4) return `${name} •••• ${pm.last4}`;
  if (pm.type === "paypal") return "PayPal account";
  switch ((pm.mandateRail ?? "").toLowerCase()) {
    case "upi":
      return "UPI Autopay";
    case "emandate":
      return "Netbanking e-Mandate";
    case "nach":
      return "NACH mandate";
    default:
      return name;
  }
}
