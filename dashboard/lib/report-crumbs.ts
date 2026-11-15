import type { Crumb } from "@/components/page-header";

/**
 * Trail for a report page: Business / Reports / <report>. The business drops out while its
 * name is unknown (an error state), so the trail never shows a raw id.
 */
export function reportCrumbs(
  biz: string,
  bizName: string | null | undefined,
  leaf: string,
  via: Crumb[] = [],
): Crumb[] {
  const base = `/businesses/${biz}`;
  return [
    ...(bizName ? [{ label: bizName, href: base }] : []),
    { label: "Reports", href: `${base}/reports` },
    ...via,
    { label: leaf },
  ];
}
