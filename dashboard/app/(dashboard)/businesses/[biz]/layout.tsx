import { listBusinesses } from '@/lib/api'
import { BusinessTzProvider } from '@/components/business-tz'

/**
 * Business-scoped layout: publishes the business timezone so client components
 * render dates in it rather than UTC (see `components/business-tz.tsx`).
 *
 * This used to also render a "Test business" alert above every page. It was
 * removed as redundant: sandbox context is already signalled twice — by the
 * global "Test mode" bar at the top of the shell (app/(dashboard)/layout.tsx)
 * and by the TEST chip on the business itself in the sidebar
 * (components/AppNav.tsx). A third copy on every page cost a banner's worth of
 * vertical space above the page title and taught operators to ignore it.
 */
export default async function BusinessLayout({
  children,
  params,
}: {
  children: React.ReactNode
  params: Promise<{ biz: string }>
}) {
  const { biz } = await params
  let tz: string | null = null
  try {
    const businesses = await listBusinesses()
    tz = businesses.data.find((b) => b.id === biz)?.timezone ?? null
  } catch {
    // If the lookup fails the page itself will surface the error.
  }

  return <BusinessTzProvider tz={tz}>{children}</BusinessTzProvider>
}
