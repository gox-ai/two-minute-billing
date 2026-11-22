import { forwardVisitBeacon } from "@/lib/storefront-visit";

/** The page's analytics beacon (`storefront-beacon.tsx`). Under `/portal`, so the session cookie comes with it. */
export const dynamic = "force-dynamic";

export function POST(req: Request) {
  return forwardVisitBeacon("portal", req);
}
