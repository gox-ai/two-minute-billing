import { NextResponse } from 'next/server'
import { getSubdivisions } from '@/lib/api/geo'

/**
 * Subdivisions for one country, for the address form.
 *
 * The country picker is server-rendered with the full list, but the subdivisions
 * cannot be: they depend on which country the user picks, which is only known in the
 * browser. Fetching all 5042 of them up front to avoid this round trip would ship a
 * ~500KB payload to render one dropdown.
 *
 * It goes through a route handler rather than straight to the engine so the org API
 * key stays on the server, exactly like `app/api/lists/[entity]`. The data itself is
 * public reference data, so the response is cacheable.
 */
export const dynamic = 'force-dynamic'

export async function GET(_req: Request, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params
  if (!/^[A-Za-z]{2}$/.test(code)) {
    return NextResponse.json({ error: 'Expected an ISO 3166-1 alpha-2 country code' }, { status: 400 })
  }
  try {
    const list = await getSubdivisions(code)
    return NextResponse.json(list, {
      // Reference data — it changes when a country reorganises its states.
      headers: { 'cache-control': 'private, max-age=3600' },
    })
  } catch {
    // An empty list degrades to a free-text region field, which is the same
    // behaviour as a country that genuinely has no subdivisions. Better than a
    // dropdown stuck on a spinner.
    return NextResponse.json({ data: [], aliases: {} }, { status: 200 })
  }
}
