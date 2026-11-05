import { portalReceiptPdfResponse } from "@/lib/portal-api";
import { readStorefrontToken } from "@/lib/storefront-session";

/**
 * Receipt PDF passthrough, same shape as invoices/[inv]/pdf: the portal token stays in
 * the HttpOnly cookie and is attached here, server-side. The backend still checks that
 * the receipt belongs to this session's customer.
 */
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ rcpt: string }> }) {
  const { rcpt } = await params;
  const token = await readStorefrontToken("portal");
  if (!token) return new Response("Receipt not available", { status: 401 });
  const upstream = await portalReceiptPdfResponse(token, rcpt);
  if (!upstream.ok || !upstream.body) {
    return new Response("Receipt not available", { status: upstream.status === 404 ? 404 : 502 });
  }
  return new Response(upstream.body, {
    status: 200,
    headers: {
      "content-type": "application/pdf",
      "content-disposition":
        upstream.headers.get("content-disposition") ?? `attachment; filename="receipt-${rcpt}.pdf"`,
      "cache-control": "no-store",
    },
  });
}
