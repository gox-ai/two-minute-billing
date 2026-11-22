import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { ASSISTANT_NAME } from "@/lib/assistant";
import { SEGMENT_TRACK, segmentItem } from "@/components/ui/segmented";

export type OrgSettingsPageKey = "general" | "legal" | "reporting" | "security" | "notifications";

interface NavItem {
  key: string;
  label: string;
  href: string;
  /** Leaves the settings section. */
  external?: boolean;
  note?: string;
}

/**
 * The organization settings side list: a grouped list beside the page from a 52rem column,
 * one wrapping segmented strip above it below that (the URL tab navs' phone rule). Server-safe: the page passes the active key.
 * Model prices, the assistant and Billing are their own full-width pages; they are listed
 * here so every organization setting has one entry point.
 */
export function OrgSettingsNav({
  active,
  billing,
  teamNotifications = false,
}: {
  active: OrgSettingsPageKey;
  /** Owners and admins: the Team notifications page. */
  teamNotifications?: boolean;
  /** Shown when the edition bills organizations; `note` reads the live access state. */
  billing: { note?: string } | null;
}) {
  const groups: Array<{ title: string; items: NavItem[] }> = [
    {
      title: "Organization",
      items: [
        { key: "general", label: "General", href: "/settings" },
        { key: "legal", label: "Legal entity", href: "/settings/legal" },
        { key: "reporting", label: "Reporting", href: "/settings/reporting" },
        { key: "security", label: "Security", href: "/settings/security" },
        ...(teamNotifications
          ? [{ key: "notifications", label: "Team notifications", href: "/settings/notifications" }]
          : []),
      ],
    },
    {
      title: "AI",
      items: [
        { key: "model-prices", label: "Model prices", href: "/settings/model-prices" },
        { key: "assistant", label: ASSISTANT_NAME, href: "/settings/assistant" },
      ],
    },
    {
      title: "Account",
      items: [
        ...(billing
          ? [
              {
                key: "billing",
                label: "Plan and billing",
                href: "/settings/billing",
                note: billing.note,
              },
            ]
          : []),
        { key: "account", label: "Your account", href: "/account", external: true },
      ],
    },
  ];
  const all = groups.flatMap((g) => g.items);

  return (
    <nav
      aria-label="Organization settings"
      className="min-w-0 @min-[52rem]/main:sticky @min-[52rem]/main:top-[calc(var(--compact-h,0px)+1rem)] @min-[52rem]/main:self-start"
    >
      <div className="hidden flex-col gap-4 @min-[52rem]/main:flex">
        {groups.map((g) => (
          <div key={g.title} className="flex flex-col gap-0.5">
            <p className="m-0 px-3 pb-1 text-xs font-medium text-muted-foreground">{g.title}</p>
            <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
              {g.items.map((it) => {
                const on = it.key === active;
                return (
                  <li key={it.key}>
                    <Link
                      href={it.href}
                      aria-current={on ? "page" : undefined}
                      className={cn(
                        "flex min-h-9 items-center gap-2 rounded-md px-3 py-1.5 text-sm transition-colors",
                        on
                          ? "bg-raised font-medium text-foreground shadow-xs"
                          : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                      )}
                    >
                      <span className="min-w-0 flex-1">{it.label}</span>
                      {it.note ? (
                        <span className="shrink-0 text-xs text-muted-foreground">{it.note}</span>
                      ) : null}
                      {it.external ? (
                        <ArrowUpRight aria-hidden className="size-3.5 shrink-0" />
                      ) : null}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
      <ul className={cn(SEGMENT_TRACK, "m-0 list-none @min-[52rem]/main:hidden")}>
        {all.map((it) => {
          const on = it.key === active;
          return (
            <li key={it.key}>
              <Link
                href={it.href}
                aria-current={on ? "page" : undefined}
                className={segmentItem(on)}
              >
                {it.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
