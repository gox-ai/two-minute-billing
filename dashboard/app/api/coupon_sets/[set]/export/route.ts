import { NextRequest, NextResponse } from "next/server";
import { currentUser, allows } from "@/lib/session";
import { listCouponSetCodes } from "@/lib/api";
import { csvRow } from "@/lib/csv";

export const dynamic = "force-dynamic";

/**
 * Every code in a coupon set as CSV — `?biz=<biz>[&status=…]`. The engine returns a
 * set's codes whole (no cursor), so this is one read, streamed out row by row.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ set: string }> }) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (!allows(user, "coupons:view", "manager"))
    return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const { set } = await ctx.params;
  const sp = req.nextUrl.searchParams;
  const biz = sp.get("biz");
  if (!biz) return NextResponse.json({ error: "biz is required" }, { status: 400 });
  const status = sp.get("status");
  if (status && !["not_redeemed", "redeemed", "archived"].includes(status)) {
    return NextResponse.json({ error: "invalid status" }, { status: 400 });
  }

  let codes;
  try {
    codes = await listCouponSetCodes(biz, set, status ?? undefined);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }

  const rows = codes.data;
  const enc = new TextEncoder();
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(enc.encode("code,status,redeemed_at,subscription\r\n"));
    },
    pull(c) {
      const chunk = rows.slice(i, i + 500);
      i += chunk.length;
      if (chunk.length === 0) return c.close();
      c.enqueue(
        enc.encode(
          chunk
            .map((r) => csvRow([r.code, r.status, r.redeemed_at ?? "", r.subscription ?? ""]))
            .join("\r\n") + "\r\n",
        ),
      );
    },
  });

  const name = `coupon-set-${set.replace(/[^\w-]/g, "_")}-codes.csv`;
  return new NextResponse(body, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${name}"`,
      "Cache-Control": "no-store",
    },
  });
}
