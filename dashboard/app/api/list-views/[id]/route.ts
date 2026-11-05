import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/lib/session";
import {
  deleteListView,
  duplicateListView,
  updateListView,
  type ListViewDraft,
} from "@/lib/api/list-views";

export const dynamic = "force-dynamic";

/**
 * Edit / duplicate / delete one saved view. See `../route.ts` for why the owner is the
 * engine's business and never this proxy's.
 *
 * Only the view's owner may PATCH or DELETE it — the engine enforces that and answers
 * 404 for someone else's view, which is also the answer for one that does not exist
 * (distinguishing them would disclose that a colleague holds a private view by that id).
 */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const { id } = await ctx.params;
  const body = (await req.json().catch(() => null)) as Partial<ListViewDraft> | null;
  if (!body) return NextResponse.json({ error: "body is required" }, { status: 400 });

  const res = await updateListView(id, body);
  if (!res.ok)
    return NextResponse.json(
      { error: res.error ?? "We could not update the view." },
      { status: res.status },
    );
  return NextResponse.json(res.data);
}

/** `POST /api/list-views/<id>` duplicates it — the copy is private and owned by the caller. */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as { name?: string };

  const res = await duplicateListView(id, body?.name);
  if (!res.ok)
    return NextResponse.json(
      { error: res.error ?? "We could not duplicate the view." },
      { status: res.status },
    );
  return NextResponse.json(res.data, { status: 201 });
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const { id } = await ctx.params;
  const res = await deleteListView(id);
  if (!res.ok)
    return NextResponse.json(
      { error: res.error ?? "We could not delete the view." },
      { status: res.status },
    );
  // 204 has no body, and `NextResponse.json(null, …)` would send "null" with a JSON
  // content-type — which `fetch(...).json()` on the client then tries to parse.
  return new NextResponse(null, { status: 204 });
}
