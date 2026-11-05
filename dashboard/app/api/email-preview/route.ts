import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/lib/session";
import { previewEmailTemplate, type EmailPreview, type EmailTemplateDraft } from "@/lib/api/emails";

export const dynamic = "force-dynamic";

/**
 * Render a template DRAFT without saving it, so the editor can preview what is being
 * typed rather than what is stored.
 *
 * This exists as a route handler rather than a server action because an action's return
 * shape (`ActionResult`) carries only a message and field errors — it cannot carry the
 * rendered HTML back. Going through here also keeps the org API key server-side, same
 * reason as /api/lists.
 *
 * Rendering happens in the ENGINE, never here: a preview produced by different code from
 * the send path is a preview of something that will never be sent.
 */
export async function POST(req: NextRequest) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  let payload: { biz?: string; type?: string } & Partial<EmailTemplateDraft>;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const { biz, type, subject, heading, body, footer, cta_label, show_facts, block_order } = payload;
  if (!biz || !type)
    return NextResponse.json({ error: "biz and type are required" }, { status: 400 });

  const res = await previewEmailTemplate(biz, type, {
    subject,
    heading,
    body,
    footer,
    cta_label,
    show_facts,
    block_order,
  });
  if (!res.ok)
    return NextResponse.json(
      { error: res.error ?? "We could not make the preview." },
      { status: res.status },
    );
  return NextResponse.json(res.data as EmailPreview);
}
