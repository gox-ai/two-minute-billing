import { API_URL, authHeaders } from "@/lib/api";
import { requirePermission } from "@/lib/session";

/**
 * BFF proxy for a report's CSV.
 *
 * The engine renders it from the SAME resolver that answers the screen, so a downloaded
 * report and the page it came from cannot disagree — which is the whole reason the export
 * is not built here from the JSON.
 *
 * Authenticated as the signed-in operator by forwarding their session, exactly as the
 * invoice PDF proxy does; the upstream endpoint is not reachable from the browser.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ biz: string; key: string }> },
) {
  await requirePermission("reports:view", "ops");
  const { biz, key } = await params;
  const incoming = new URL(req.url).searchParams;
  const qs = new URLSearchParams({ format: "csv" });
  for (const name of ["range", "currency", "granularity", "group_by"]) {
    const v = incoming.get(name);
    if (v) qs.set(name, v);
  }
  const res = await fetch(`${API_URL}/v1/businesses/${biz}/reports/${key}?${qs.toString()}`, {
    headers: await authHeaders(),
    cache: "no-store",
  });
  if (!res.ok) {
    return new Response(`We could not export the report (${res.status}).`, { status: res.status });
  }
  return new Response(await res.text(), {
    headers: {
      // Tenant financial data: never kept by a browser or shared cache.
      "cache-control": "no-store",
      "content-type": "text/csv; charset=utf-8",
      "content-disposition":
        res.headers.get("content-disposition") ?? `attachment; filename="${key}.csv"`,
    },
  });
}
