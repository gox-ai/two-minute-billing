/**
 * A mandate rail in the buyer's words, and where they cancel it. The rail is the gateway's
 * own code (`upi`, `emandate`, GoCardless schemes, Mollie's `directdebit`), never shown raw.
 */
const RAIL: Record<string, string> = {
  upi: "UPI Autopay",
  card: "card auto-debit",
  emandate: "Netbanking e-Mandate",
  nach: "NACH mandate",
  enach: "eNACH mandate",
  pnach: "NACH mandate",
  bacs: "Bacs Direct Debit",
  sepa_core: "SEPA Direct Debit",
  directdebit: "SEPA Direct Debit",
  ach: "ACH Direct Debit",
  becs: "BECS Direct Debit",
  becs_nz: "BECS Direct Debit",
  pad: "Pre-authorized debit",
  autogiro: "Autogiro",
  betalingsservice: "Betalingsservice",
};

export function mandateRailLabel(rail: string): string {
  return RAIL[rail.toLowerCase()] ?? "Direct Debit";
}

/** Where the payer revokes the authorization itself. */
export function mandateRevokeWhere(rail: string): string {
  switch (rail.toLowerCase()) {
    case "upi":
      return "in your UPI app";
    case "card":
      return "in your bank app, or ask your card issuer";
    case "emandate":
    case "nach":
    case "enach":
    case "pnach":
      return "in your bank app or netbanking";
    default:
      return "with your bank";
  }
}
