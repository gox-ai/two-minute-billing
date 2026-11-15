import * as React from "react";
import { SettingsPage } from "@/components/settings/settings-layout";
import { accountBillingEnabled } from "@/lib/account-billing";
import { OrgSettingsNav, type OrgSettingsPageKey } from "./org-settings-nav";

const TITLES: Record<OrgSettingsPageKey, string> = {
  general: "General",
  legal: "Legal entity",
  reporting: "Reporting",
  security: "Security",
};

/**
 * One organization settings page: the header, then the side list beside the page's form.
 * The 2.5rem gap equals the Save bar's start bleed (`md:-mx-10`), so the bar meets the
 * side list's edge instead of running under it.
 */
export function OrgSettingsFrame({
  page,
  description,
  liveAccessLocked,
  children,
}: {
  page: OrgSettingsPageKey;
  description?: React.ReactNode;
  liveAccessLocked?: boolean;
  children: React.ReactNode;
}) {
  const title = TITLES[page];
  return (
    <SettingsPage
      title={title}
      description={description}
      crumbs={[{ label: "Settings", href: "/settings" }, { label: title }]}
    >
      {/* `grow` + a 1fr row: the shell grows a form holding the Save bar to main's foot
          (layout.tsx), and the grid must pass that height down to it. */}
      <div className="grid grow grid-rows-[auto_1fr] gap-5 @min-[52rem]/main:grid-cols-[12rem_minmax(0,1fr)] @min-[52rem]/main:grid-rows-1 @min-[52rem]/main:gap-10">
        <OrgSettingsNav
          active={page}
          billing={
            accountBillingEnabled()
              ? { note: liveAccessLocked ? "Live mode off" : undefined }
              : null
          }
        />
        <div className="flex min-w-0 flex-col gap-5">{children}</div>
      </div>
    </SettingsPage>
  );
}
