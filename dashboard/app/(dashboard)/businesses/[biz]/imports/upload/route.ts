import { NextRequest, NextResponse } from "next/server";
import { allows, currentUser } from "@/lib/session";
import { createImportRun, IMPORT_ENTITIES, type ImportEntity } from "@/lib/api/imports";
import { MAX_IMPORT_UPLOAD_BYTES, importUploadRefusal } from "@/lib/import-upload";

export const dynamic = "force-dynamic";

/**
 * Browser → engine proxy for an import upload: one multipart part per section, named by its
 * entity (`plans`, `customers`, … or `json`), turned into the JSON body the engine takes.
 * `lib/api.ts` is server-only (it forwards the HttpOnly session), so the page posts here.
 * The engine parses and checks every row; this only refuses what cannot be sent.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ biz: string }> }) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (!allows(user, "imports:manage", "admin"))
    return NextResponse.json(
      { error: "You do not have permission to import data." },
      { status: 403 },
    );

  const tooBig = importUploadRefusal(req.headers.get("content-length"));
  if (tooBig) return NextResponse.json({ error: tooBig }, { status: 413 });

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Expected a file upload." }, { status: 400 });
  }

  const files: Array<{ entity: ImportEntity | "json"; filename: string; content: string }> = [];
  let total = 0;
  for (const key of [...IMPORT_ENTITIES, "json"] as const) {
    const f = form.get(key);
    if (f == null) continue;
    if (!(f instanceof File) || f.size === 0)
      return NextResponse.json({ error: `The ${key} file is empty.` }, { status: 400 });
    total += f.size;
    if (total > MAX_IMPORT_UPLOAD_BYTES)
      return NextResponse.json(
        { error: importUploadRefusal(String(total + 1)) ?? "The files are too large." },
        { status: 413 },
      );
    files.push({ entity: key, filename: f.name || `${key}.csv`, content: await f.text() });
  }
  if (!files.length)
    return NextResponse.json({ error: "Upload at least one file." }, { status: 400 });

  const options = {
    skip_invalid_rows: form.get("skip_invalid_rows") === "true",
    exclude_renewing_within_24h: form.get("exclude_renewing_within_24h") === "true",
  };

  const { biz } = await ctx.params;
  const res = await createImportRun(biz, { files, options });
  if (!res.ok)
    return NextResponse.json(
      { error: res.error ?? "We could not upload the files." },
      { status: res.status },
    );
  return NextResponse.json(res.data, { status: 201 });
}
