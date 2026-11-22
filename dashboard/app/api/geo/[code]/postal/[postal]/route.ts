import { NextResponse } from "next/server";
import { getPostalLookup } from "@/lib/api/geo";

/**
 * City and state for a postal code, for the address forms' autofill.
 *
 * Same shape as `../../subdivisions/route.ts`: it goes through our own server, so the browser
 * never calls another origin and no buyer data leaves for a third party. The lookup reads our
 * own postal table (GeoNames data, CC BY 4.0). An unknown code answers 404, and the form
 * then skips the autofill.
 */
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ code: string; postal: string }> },
) {
  const { code, postal } = await params;
  if (!/^[A-Za-z]{2}$/.test(code) || postal.length > 20) {
    return NextResponse.json({ error: "Invalid country or postal code" }, { status: 400 });
  }
  try {
    const hit = await getPostalLookup(code, postal);
    if (!hit) return NextResponse.json(null, { status: 404 });
    return NextResponse.json(hit, { headers: { "cache-control": "private, max-age=3600" } });
  } catch {
    return NextResponse.json(null, { status: 404 });
  }
}
