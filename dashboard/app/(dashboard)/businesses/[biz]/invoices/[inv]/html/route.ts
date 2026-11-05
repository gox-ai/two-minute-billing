import { API_URL, authHeaders } from "@/lib/api";
import { requirePermission } from "@/lib/session";

// BFF proxy for the printable invoice HTML view (in-browser preview / print-to-PDF).
// Authenticates as the signed-in operator by forwarding their session cookie, same as the
// PDF proxy — see that file for why the org-bound API key had to go.
export async function GET(
  req: Request,
  { params }: { params: Promise<{ biz: string; inv: string }> },
) {
  await requirePermission("invoices:view", "ops");
  const { biz, inv } = await params;
  // `?print=1` is forwarded verbatim: upstream decides whether to wrap the document
  // in the print-mode chrome (paper sheet, toolbar, auto print dialog). Only that one
  // flag crosses over — the query string is not passed through wholesale.
  const print = new URL(req.url).searchParams.get("print");
  const qs = print === "1" || print === "true" ? "?print=1" : "";
  const res = await fetch(`${API_URL}/v1/businesses/${biz}/invoices/${inv}/html${qs}`, {
    headers: await authHeaders(),
    cache: "no-store",
  });
  if (!res.ok) {
    return new Response(`We could not render the invoice (${res.status}).`, { status: res.status });
  }
  const html = await res.text();
  return new Response(html, {
    headers: {
      // Tenant financial data: never kept by a browser or shared cache.
      "cache-control": "no-store",
      "content-type": "text/html; charset=utf-8",
    },
  });
}
