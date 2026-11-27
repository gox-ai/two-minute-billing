import { NextRequest, NextResponse } from "next/server";
import { allows, currentUser } from "@/lib/session";
import { API_URL, authHeaders } from "@/lib/api";
import { IMPORT_ENTITIES, type ImportEntity } from "@/lib/import-entities";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * An export's files, streamed from the engine: `?export=<id>` is the zip; add
 * `&entity=<entity>` for one CSV. A route handler, not a server action: the body streams.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ biz: string }> }) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (!allows(user, "exports:view", "admin"))
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { biz } = await ctx.params;
  const sp = req.nextUrl.searchParams;
  const id = sp.get("export");
  const entity = sp.get("entity");
  if (!id || !UUID.test(id))
    return NextResponse.json({ error: "Unknown export." }, { status: 400 });
  if (entity && !IMPORT_ENTITIES.includes(entity as ImportEntity))
    return NextResponse.json({ error: "Unknown file." }, { status: 400 });
  const base = `/v1/businesses/${encodeURIComponent(biz)}/exports/${id}`;
  const res = await fetch(`${API_URL}${entity ? `${base}/files/${entity}` : `${base}/file`}`, {
    headers: await authHeaders(),
    cache: "no-store",
  });
  if (!res.ok || !res.body) {
    const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    return NextResponse.json(
      { error: body?.error?.message ?? "We could not get the file." },
      { status: res.status },
    );
  }
  const headers: Record<string, string> = {
    "Content-Type": res.headers.get("content-type") ?? "application/octet-stream",
    "Content-Disposition":
      res.headers.get("content-disposition") ??
      `attachment; filename="${entity ? `${entity}.csv` : "export.zip"}"`,
    "Cache-Control": "no-store",
  };
  const length = res.headers.get("content-length");
  if (length) headers["Content-Length"] = length;
  return new NextResponse(res.body, { headers });
}
