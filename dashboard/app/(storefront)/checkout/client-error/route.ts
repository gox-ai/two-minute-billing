import { forwardBuyerErrorReport } from "@/lib/buyer-error-forward";

/** The checkout's payment-error reports (`lib/buyer-error-report.ts`). Under `/checkout`, so the session cookie comes with it. */
export const dynamic = "force-dynamic";

export function POST(req: Request) {
  return forwardBuyerErrorReport("checkout", req);
}
