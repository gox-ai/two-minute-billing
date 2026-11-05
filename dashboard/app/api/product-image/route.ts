import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/lib/session";
import { MAX_UPLOAD_BYTES, uploadBodyRefusal } from "@/lib/upload-limit";
import { deleteProductImage, uploadProductImage } from "@/lib/api/product-images";

export const dynamic = "force-dynamic";

/**
 * Browser → engine proxy for a product's image, the product twin of `/api/brand-images`:
 * `lib/api.ts` authenticates with the HttpOnly session cookie, which page script cannot
 * read, and a server action caps its body at 1 MB. The engine stays the authority on the
 * type, the size and the caller's permission; the checks here only fail fast.
 */
export async function POST(req: NextRequest) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const tooBig = uploadBodyRefusal(req.headers.get("content-length"), "image");
  if (tooBig) return NextResponse.json({ error: tooBig }, { status: 413 });

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Expected a file upload" }, { status: 400 });
  }
  const biz = form.get("biz");
  const prod = form.get("prod");
  const file = form.get("file");
  if (typeof biz !== "string" || !biz || typeof prod !== "string" || !prod)
    return NextResponse.json({ error: "biz and prod are required" }, { status: 400 });
  if (!(file instanceof File) || file.size === 0)
    return NextResponse.json({ error: "Select a file to upload." }, { status: 400 });
  if (file.size > MAX_UPLOAD_BYTES)
    return NextResponse.json(
      { error: "That image is too large. The maximum size is 5 MB." },
      { status: 413 },
    );

  const data = Buffer.from(await file.arrayBuffer()).toString("base64");
  const res = await uploadProductImage(biz, prod, {
    data,
    ...(file.type ? { content_type: file.type } : {}),
  });
  // Forwarded, not flattened: "not a supported image" (400) and "uploads are not enabled"
  // (503) send the reader to different places.
  if (!res.ok)
    return NextResponse.json(
      { error: res.error ?? "We could not upload the image." },
      { status: res.status },
    );
  return NextResponse.json(res.data, { status: 200 });
}

export async function DELETE(req: NextRequest) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const biz = req.nextUrl.searchParams.get("biz");
  const prod = req.nextUrl.searchParams.get("prod");
  if (!biz || !prod)
    return NextResponse.json({ error: "biz and prod are required" }, { status: 400 });
  const res = await deleteProductImage(biz, prod);
  if (!res.ok)
    return NextResponse.json(
      { error: res.error ?? "We could not remove the image." },
      { status: res.status },
    );
  return NextResponse.json(res.data, { status: 200 });
}
