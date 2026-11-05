import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/lib/session";
import { MAX_UPLOAD_BYTES, uploadBodyRefusal } from "@/lib/upload-limit";
import {
  uploadBrandImage,
  uploadOrganizationBrandImage,
  type BrandAsset,
} from "@/lib/api/brand-images";

export const dynamic = "force-dynamic";

const ASSETS: BrandAsset[] = ["logo", "icon", "favicon", "signature"];

/**
 * Browser → engine proxy for a brand image upload.
 *
 * It exists because `lib/api.ts` is server-only: it authenticates by forwarding the
 * operator's HttpOnly session cookie, which page script cannot read (0198). So the file
 * picker posts here as ordinary multipart, and this converts it to the base64 JSON the
 * engine's route takes. With no `biz` the upload is the ORGANIZATION's logo (`icon` only).
 *
 * The engine is still the authority on everything that matters — it re-reads the leading
 * bytes, re-checks the size, and owns the allowed-type list. The checks here are only to
 * fail fast on the obvious cases rather than to be trusted: a 20 MB file should not be
 * base64-encoded into memory and shipped across a loopback socket to be refused.
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
  const asset = form.get("asset");
  const file = form.get("file");

  const forOrg = biz == null || biz === "";
  if (!forOrg && typeof biz !== "string")
    return NextResponse.json({ error: "biz must be a business id" }, { status: 400 });
  if (forOrg && asset !== "icon")
    return NextResponse.json({ error: "An organization has only an icon." }, { status: 400 });
  if (typeof asset !== "string" || !ASSETS.includes(asset as BrandAsset))
    return NextResponse.json(
      { error: "asset must be one of " + ASSETS.join(", ") },
      { status: 400 },
    );
  if (!(file instanceof File) || file.size === 0)
    return NextResponse.json({ error: "Select a file to upload." }, { status: 400 });
  if (file.size > MAX_UPLOAD_BYTES)
    return NextResponse.json(
      { error: "That image is too large. The maximum size is 5 MB." },
      { status: 413 },
    );

  const data = Buffer.from(await file.arrayBuffer()).toString("base64");
  // Forwarded so the ENGINE can log a mismatch against what the bytes say. It is not
  // used to decide anything, here or there.
  const declared = file.type ? { content_type: file.type } : {};
  const res = forOrg
    ? await uploadOrganizationBrandImage({ asset: "icon", data, ...declared })
    : await uploadBrandImage(biz as string, { asset: asset as BrandAsset, data, ...declared });

  // The engine's status and sentence are forwarded rather than flattened: "not a
  // supported image" (400) and "uploads are not enabled on this deployment" (503) send
  // the reader to two completely different places, and only one of them is their file.
  if (!res.ok)
    return NextResponse.json(
      { error: res.error ?? "We could not upload the image." },
      { status: res.status },
    );
  return NextResponse.json(res.data, { status: 201 });
}
