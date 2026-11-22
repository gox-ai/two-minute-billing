import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import { getNotificationPreferences, listNotificationDestinations } from "@/lib/api/notifications";
import { SettingsPage } from "@/components/settings/settings-layout";
import { ErrorState } from "@/components/states";
import { DestinationForm } from "@/components/notifications/destination-form";

export const dynamic = "force-dynamic";

/** One Google Chat space or outside address: its businesses, events, limits and summaries. */
export default async function DestinationPage({ params }: { params: Promise<{ id: string }> }) {
  const me = await requireUser();
  if (me.role !== "owner" && me.role !== "admin") notFound();
  const { id } = await params;
  const crumbs = [
    { label: "Settings", href: "/settings" },
    { label: "Team notifications", href: "/settings/notifications" },
  ];
  let data: [
    Awaited<ReturnType<typeof listNotificationDestinations>>,
    Awaited<ReturnType<typeof getNotificationPreferences>>,
  ];
  try {
    data = await Promise.all([listNotificationDestinations(), getNotificationPreferences()]);
  } catch (e) {
    return (
      <SettingsPage title="Team notifications" crumbs={crumbs}>
        <ErrorState title="We could not load this destination" error={e} retry />
      </SettingsPage>
    );
  }
  const [dests, prefs] = data;
  const d = dests.data.find((x) => x.id === id);
  if (!d) notFound();
  const title = d.type === "chat" ? d.name : (d.email ?? d.name);
  return (
    <SettingsPage
      title={title}
      description={
        d.type === "chat"
          ? "A Google Chat space. Select the businesses and events it gets."
          : "An email address outside the organization. Select the businesses and events it gets."
      }
      crumbs={[...crumbs, { label: title }]}
    >
      <DestinationForm
        destination={d}
        businesses={prefs.businesses}
        catalogue={prefs.catalogue}
        currencies={prefs.currencies}
      />
    </SettingsPage>
  );
}
