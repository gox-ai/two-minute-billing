import * as React from "react";
import Link from "next/link";
import { ADVERTISED_API_URL, advertisedApiReachable } from "@/lib/api";
import { SettingsPage } from "@/components/settings/settings-layout";
import { CopyButton } from "@/components/patterns/copy-button";
import { Alert } from "@/components/ui/alert";
import { SEGMENT_TRACK, segmentItem } from "@/components/ui/segmented";
import { SegmentIndicator } from "@/components/ui/segment-indicator";

export type DeveloperTab = "api-keys" | "webhooks" | "events" | "connected-apps";

const TABS: Array<{ id: DeveloperTab; label: string; href: string }> = [
  { id: "api-keys", label: "API keys", href: "/developer" },
  { id: "webhooks", label: "Webhooks", href: "/developer/webhooks" },
  { id: "events", label: "Events", href: "/developer/events" },
  { id: "connected-apps", label: "Connected apps", href: "/developer/connected-apps" },
];

/**
 * The Developer page frame: header, the API address strip, then one tab per sub-route.
 * Each tab is its own route, as on Team, so a link opens it and Back works.
 */
export function DeveloperShell({
  active,
  tz,
  actions,
  children,
}: {
  active: DeveloperTab;
  /** The organization display zone every date on these tabs uses. */
  tz: string;
  /** The tab's primary action. */
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  const tab = TABS.find((t) => t.id === active)!;
  return (
    <SettingsPage
      title="Developer"
      crumbs={
        active === "api-keys"
          ? [{ label: "Overview", href: "/" }, { label: "Developer" }]
          : [
              { label: "Overview", href: "/" },
              { label: "Developer", href: "/developer" },
              { label: tab.label },
            ]
      }
      description={`API keys, webhooks and events for this organization. Times are in ${tz}.`}
      actions={actions}
    >
      {/* The only BROWSER-facing URLs here, so they come from ADVERTISED_API_URL, never
          API_URL (the server-to-server address). Without a public URL we say so rather
          than render a dead link. */}
      <Alert tone="neutral" className="py-2.5">
        {advertisedApiReachable ? (
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>API base URL:</span>
            <span className="inline-flex min-w-0 items-center gap-1">
              <code className="font-mono text-xs break-all">{ADVERTISED_API_URL}</code>
              <CopyButton value={ADVERTISED_API_URL} what="API base URL" />
            </span>
            <a
              href={`${ADVERTISED_API_URL}/docs`}
              target="_blank"
              rel="noreferrer"
              className="font-medium text-primary hover:underline"
            >
              API reference
            </a>
            <a
              href={`${ADVERTISED_API_URL}/openapi.json`}
              target="_blank"
              rel="noreferrer"
              className="font-medium text-primary hover:underline"
            >
              openapi.json
            </a>
          </span>
        ) : (
          <span className="text-muted-foreground">
            The API base URL is not available on this server. Ask the person who runs this server to
            set it.
          </span>
        )}
      </Alert>

      <nav aria-label="Developer" className={SEGMENT_TRACK}>
        <SegmentIndicator />
        {TABS.map((t) => (
          <Link
            key={t.id}
            href={t.href}
            aria-current={t.id === active ? "page" : undefined}
            className={segmentItem(t.id === active)}
          >
            {t.label}
          </Link>
        ))}
      </nav>

      {children}
    </SettingsPage>
  );
}

/** The short fact line under a tab card's header. */
export function CardNote({ children }: { children: React.ReactNode }) {
  return <p className="m-0 border-b px-5 py-2.5 text-xs text-muted-foreground">{children}</p>;
}
