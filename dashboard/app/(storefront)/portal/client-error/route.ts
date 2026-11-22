import { forwardBuyerErrorReport } from "@/lib/buyer-error-forward";

/** The portal's payment-error reports (`lib/buyer-error-report.ts`). Under `/portal`, so the session cookie comes with it. */
export const dynamic = "force-dynamic";

export function POST(req: Request) {
  return forwardBuyerErrorReport("portal", req);
}
