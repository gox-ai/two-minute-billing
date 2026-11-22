"use client";

import { NotificationPanel, type BellBusiness } from "./bell";

/** The bell's panel in a card, for the /notifications page. */
export function NotificationsPageList({ businesses }: { businesses: BellBusiness[] }) {
  return (
    <div className="overflow-hidden rounded-xl border bg-card">
      <NotificationPanel businesses={businesses} onDone={() => {}} page />
    </div>
  );
}
