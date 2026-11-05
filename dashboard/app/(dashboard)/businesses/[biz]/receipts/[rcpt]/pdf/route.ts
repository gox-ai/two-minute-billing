import { API_URL, authHeaders } from "@/lib/api";
import { requirePermission } from "@/lib/session";

// BFF proxy for the receipt PDF, same shape as invoices/[inv]/pdf: the upstream endpoint
// is authenticated, so this fetches it as the signed-in operator.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ biz: string; rcpt: string }> },
) {
  await requirePermission("payments:view", "ops");
  const { biz, rcpt } = await params;
  const res = await fetch(`${API_URL}/v1/businesses/${biz}/receipts/${rcpt}/pdf`, {
    headers: await authHeaders(),
    cache: "no-store",
  });
  if (!res.ok) {
    return new Response(`We could not create the receipt PDF (${res.status}).`, {
      status: res.status,
    });
  }
  const body = await res.arrayBuffer();
  return new Response(body, {
    headers: {
      // Tenant financial data: never kept by a browser or shared cache.
      "cache-control": "no-store",
      "content-type": res.headers.get("content-type") ?? "application/pdf",
      "content-disposition":
        res.headers.get("content-disposition") ?? `attachment; filename="receipt-${rcpt}.pdf"`,
    },
  });
}
