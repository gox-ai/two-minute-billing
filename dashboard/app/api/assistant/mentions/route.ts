import { NextRequest } from "next/server";
import { relayJson } from "@/lib/assistant-proxy";

export const dynamic = "force-dynamic";

/** Records to mention with "@": customers, invoices and subscriptions of one business. */
export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  const q = new URLSearchParams({ business: p.get("business") ?? "", q: p.get("q") ?? "" });
  return relayJson(`/mentions?${q.toString()}`);
}
