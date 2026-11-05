"use client";

import * as React from "react";
import { toast } from "sonner";
import { recordVisit, type RecentKind } from "@/lib/recent-records";
import { noteSlowRecordVisit, openPalette, paletteKeys } from "@/lib/palette-hints";

/** Notes a detail-page visit for the ⌘K palette's Recent group, and its one-time tip. Renders nothing. */
export function RecordVisit({
  biz,
  kind,
  id,
  label,
  detail,
}: {
  biz: string;
  kind: RecentKind;
  id: string;
  label: string;
  detail: string;
}) {
  React.useEffect(() => {
    recordVisit(biz, { kind, id, label, detail });
  }, [biz, kind, id, label, detail]);

  // A record reached without the palette counts toward a tip shown once, ever.
  React.useEffect(() => {
    if (!noteSlowRecordVisit(id)) return;
    toast("Open records faster", {
      description: `Press ${paletteKeys() ?? "Ctrl K"} or / on any page. Then type a name, an email or an ID.`,
      duration: 12_000,
      action: { label: "Open search", onClick: openPalette },
    });
  }, [id]);
  return null;
}
