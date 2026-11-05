import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { currentUser } from "@/lib/session";
import { SESSION_COOKIE } from "@/lib/auth-cookies";
import { forwardedFor } from "@/lib/forwarded-for";
import { MAX_UPLOAD_BYTES, uploadBodyRefusal } from "@/lib/upload-limit";

export const dynamic = "force-dynamic";

const BASE = process.env.TMBILLING_API_URL ?? "http://localhost:4000";

/**
 * Browser → engine proxy for the profile photo, like `/api/brand-images`: the picker posts
 * multipart here and this forwards base64 JSON as the signed-in person. The engine re-checks
 * the bytes and the size; nothing here is trusted beyond failing fast.
 */
export async function POST(req: NextRequest) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const tooBig = uploadBodyRefusal(req.headers.get("content-length"), "photo");
  if (tooBig) return NextResponse.json({ error: tooBig }, { status: 413 });

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Expected a file upload" }, { status: 400 });
  }
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0)
    return NextResponse.json({ error: "Select a photo to upload." }, { status: 400 });
  if (file.size > MAX_UPLOAD_BYTES)
    return NextResponse.json(
      { error: "The photo is too large. The maximum size is 5 MB." },
      { status: 413 },
    );

  const res = await fetch(`${BASE}/auth/me/avatar`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      cookie: `${SESSION_COOKIE}=${token}`,
      ...(await forwardedFor()),
    },
    body: JSON.stringify({
      data: Buffer.from(await file.arrayBuffer()).toString("base64"),
      ...(file.type ? { content_type: file.type } : {}),
    }),
    cache: "no-store",
  });
  const json = (await res.json().catch(() => ({}))) as {
    avatar_url?: string;
    error?: { message?: string };
  };
  // Forwarded, not flattened: "not a supported image" (400) and "uploads are off" (503)
  // send the reader to different places.
  if (!res.ok)
    return NextResponse.json(
      { error: json.error?.message ?? "We could not upload the photo." },
      { status: res.status },
    );
  return NextResponse.json({ avatar_url: json.avatar_url ?? null }, { status: 201 });
}
