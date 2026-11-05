import { portalInvoicePdfResponse } from "@/lib/portal-api";
import { readStorefrontToken } from "@/lib/storefront-session";

/**
 * Server-side PDF passthrough (#10c). The buyer's browser hits this route; we
 * read the portal bearer token from the session cookie and attach it server-side,
 * then stream the upstream PDF back. The token therefore never leaves the server, and
 * the backend still enforces that the invoice belongs to this portal session's
 * customer.
 *
 * The token used to arrive as a path segment on this very URL (W1). That made the PDF
 * link the worst offender on the surface: a buyer saving or forwarding it — which is
 * the entire point of a "Download PDF" button — handed over their whole session along
 * with the invoice.
 */
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ inv: string }> }) {
  const { inv } = await params;
  const token = await readStorefrontToken("portal");
  if (!token) return new Response("Invoice not available", { status: 401 });
  const upstream = await portalInvoicePdfResponse(token, inv);
  if (!upstream.ok || !upstream.body) {
    return new Response("Invoice not available", { status: upstream.status === 404 ? 404 : 502 });
  }
  return new Response(upstream.body, {
    status: 200,
    headers: {
      "content-type": "application/pdf",
      "content-disposition":
        upstream.headers.get("content-disposition") ?? `attachment; filename="invoice-${inv}.pdf"`,
      "cache-control": "no-store",
    },
  });
}
