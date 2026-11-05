import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/lib/session";
import { createListView, listListViews, type ListViewDraft } from "@/lib/api/list-views";

export const dynamic = "force-dynamic";

/**
 * Saved list views for the browser — `ListPage`'s Views dropdown reads and writes
 * through here so the org API key never reaches the client.
 *
 * The engine attributes a view to the SIGNED-IN OPERATOR (its `owner` comes from the
 * request's actor, which `authenticate` resolves from the session), so this proxy
 * deliberately passes no owner of its own. Sending one from here would let the browser
 * choose whose views it reads — see the "dashboard key is org-bound" note in
 * `.claude/MEMORY.md` for the class of bug that is.
 *
 * `business` is absent for the two org-level lists (the `/audit` activity log and the
 * billing clock); the engine stores NULL for those rather than guessing a business.
 */
export async function GET(req: NextRequest) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const entity = req.nextUrl.searchParams.get("entity");
  if (!entity) return NextResponse.json({ error: "entity is required" }, { status: 400 });
  const biz = req.nextUrl.searchParams.get("business") ?? undefined;

  try {
    return NextResponse.json(await listListViews(entity, biz));
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}

export async function POST(req: NextRequest) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as
    | ({ entity?: string; business?: string } & ListViewDraft)
    | null;
  if (!body?.entity || !body.name) {
    return NextResponse.json({ error: "entity and name are required" }, { status: 400 });
  }
  const { entity, business, ...draft } = body;

  const res = await createListView(entity, business, draft);
  // The engine's own status and message are forwarded rather than flattened to 502: a
  // duplicate name is a 409 the dialog shows inline, and a rejected filter is a 400
  // whose sentence names the field. Collapsing both to "could not save" is how a fixable
  // mistake becomes a mystery.
  if (!res.ok)
    return NextResponse.json(
      { error: res.error ?? "We could not save the view." },
      { status: res.status },
    );
  return NextResponse.json(res.data, { status: 201 });
}
