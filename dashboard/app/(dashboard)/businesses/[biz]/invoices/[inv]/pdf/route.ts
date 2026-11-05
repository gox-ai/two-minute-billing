import { API_URL, authHeaders } from "@/lib/api";
import { requirePermission } from "@/lib/session";

// BFF proxy for the invoice PDF. The upstream endpoint is authenticated, so the browser
// can't hit it directly — this route fetches it as the signed-in operator and streams the
// application/pdf bytes back.
//
// It authenticates the same way every other dashboard call does (0198): by forwarding the
// operator's session cookie. It used to send `Bearer ${TMBILLING_API_KEY}` — the org-bound
// credential the rest of the dashboard stopped using — which made this route the last place
// where the org served came from env rather than from the login, and rendered nothing at all
// on a setup that never ran `--write-env`.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ biz: string; inv: string }> },
) {
  await requirePermission("invoices:view", "ops");
  const { biz, inv } = await params;
  const res = await fetch(`${API_URL}/v1/businesses/${biz}/invoices/${inv}/pdf`, {
    headers: await authHeaders(),
    cache: "no-store",
  });
  if (!res.ok) {
    return new Response(`We could not render the invoice (${res.status}).`, { status: res.status });
  }
  const body = await res.arrayBuffer();
  return new Response(body, {
    headers: {
      // Tenant financial data: never kept by a browser or shared cache.
      "cache-control": "no-store",
      "content-type": res.headers.get("content-type") ?? "application/pdf",
      "content-disposition":
        res.headers.get("content-disposition") ?? `attachment; filename="invoice-${inv}.pdf"`,
    },
  });
}
