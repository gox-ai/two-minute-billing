import { NextRequest, NextResponse } from "next/server";
import { allows, currentUser } from "@/lib/session";
import { API_URL, authHeaders } from "@/lib/api";
import { IMPORT_ENTITIES, type ImportEntity } from "@/lib/api/imports";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * CSV downloads for the import page, passed through from the engine:
 * `?template=<entity>` is the template with an example row; `?run=<id>&entity=<entity>` is
 * that file of a run with its result and error columns.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ biz: string }> }) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (!allows(user, "imports:view", "admin"))
    return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const { biz } = await ctx.params;
  const sp = req.nextUrl.searchParams;
  const template = sp.get("template");
  const run = sp.get("run");
  const entity = sp.get("entity") ?? template;
  if (!entity || !IMPORT_ENTITIES.includes(entity as ImportEntity))
    return NextResponse.json({ error: "Unknown file." }, { status: 400 });
  if (!template && (!run || !UUID.test(run)))
    return NextResponse.json({ error: "Unknown import." }, { status: 400 });

  const base = `/v1/businesses/${encodeURIComponent(biz)}/imports`;
  const path = template ? `${base}/templates/${entity}` : `${base}/${run}/files/${entity}`;
  const res = await fetch(`${API_URL}${path}`, { headers: await authHeaders(), cache: "no-store" });
  if (!res.ok || !res.body)
    return NextResponse.json({ error: "We could not get the file." }, { status: res.status });
  return new NextResponse(res.body, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition":
        res.headers.get("content-disposition") ?? `attachment; filename="${entity}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
