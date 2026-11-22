import Link from "next/link";
import { requireUser } from "@/lib/session";
import { listBusinesses } from "@/lib/api";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import type { BellBusiness } from "@/components/notifications/bell";
import { NotificationsPageList } from "@/components/notifications/notifications-page-list";

export const dynamic = "force-dynamic";

/** The bell as a page: where a held quiet-hours push and a phone deep link land. */
export default async function NotificationsPage() {
  await requireUser();
  const businesses: BellBusiness[] = await listBusinesses().then(
    (r) =>
      r.data.map((b) => ({
        id: b.id,
        name: b.name,
        timezone: b.timezone ?? null,
        live: b.livemode === "live",
      })),
    () => [],
  );
  return (
    <div className="flex max-w-3xl flex-col gap-5">
      <PageHeader
        title="Notifications"
        description="Instant notifications from the last 90 days, for every business in this organization."
        breadcrumbs={[{ label: "Overview", href: "/" }, { label: "Notifications" }]}
        actions={
          <Button asChild variant="outline">
            <Link href="/account/notifications">Notification settings</Link>
          </Button>
        }
      />
      <NotificationsPageList businesses={businesses} />
    </div>
  );
}
