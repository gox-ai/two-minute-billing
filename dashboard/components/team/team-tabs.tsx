import Link from "next/link";
import { SEGMENT_TRACK, segmentItem } from "@/components/ui/segmented";

/** Members | Roles above the Team screens. Links, so the tab is in the URL. */
export function TeamTabs({
  active,
  showRoles,
}: {
  active: "members" | "roles";
  showRoles: boolean;
}) {
  if (!showRoles) return null;
  const tab = (id: "members" | "roles", href: string, label: string) => (
    <Link
      key={id}
      href={href}
      aria-current={active === id ? "page" : undefined}
      className={segmentItem(active === id)}
    >
      {label}
    </Link>
  );
  return (
    <nav aria-label="Team" className={SEGMENT_TRACK}>
      {tab("members", "/team", "Members")}
      {tab("roles", "/team/roles", "Roles")}
    </nav>
  );
}
