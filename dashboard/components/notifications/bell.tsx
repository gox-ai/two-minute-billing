"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  AlertTriangle,
  Bell,
  CalendarClock,
  CreditCard,
  Gauge,
  Repeat,
  Scale,
  ShieldAlert,
  Webhook,
  type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { SelectField } from "@/components/ui/select-field";
import { SEGMENT_TRACK, segmentItem } from "@/components/ui/segmented";
import { Chip } from "@/components/patterns/chip";
import { EmptyState } from "@/components/states";
import { NavBadge } from "@/components/SideNav";
import { NAV_FOCUS, RailTip } from "@/components/rail-tip";
import { useDisplayTz } from "@/components/business-tz";
import { groupByDay, timeOfDay } from "@/lib/notifications-view";
import type { Notification, NotificationPage } from "@/lib/api/notifications";
import {
  markAllNotificationsReadAction,
  markNotificationReadAction,
} from "@/app/(dashboard)/notifications/actions";
import { OPEN_EVENT, countText, refreshUnread, setUnread, useUnread } from "./unread-store";

export interface BellBusiness {
  id: string;
  name: string;
  timezone: string | null;
  live: boolean;
}

const SETTINGS_HREF = "/account/notifications";

/** Severity, never category: the tile's tone comes from the row (catalogue Tone column). */
const TILE: Record<Notification["tone"], string> = {
  destructive: "bg-destructive-soft text-destructive",
  warning: "bg-warning-soft text-warning",
  neutral: "bg-muted text-muted-foreground",
};

const KIND_ICON: Array<[RegExp, LucideIcon]> = [
  [/^dispute/, Scale],
  [/fraud/, ShieldAlert],
  [/^(payment|refund|late_payment|retries|invoice|auto_topup)/, CreditCard],
  [/^(subscription|cancellation|trial|customer_portal|new_revenue)/, Repeat],
  [/^large_renewal/, CalendarClock],
  [/^(spend_limit|usage|large_credit)/, Gauge],
  [/^webhook/, Webhook],
  [/^gateway/, AlertTriangle],
];
const iconOf = (kind: string): LucideIcon => KIND_ICON.find(([re]) => re.test(kind))?.[1] ?? Bell;

function badgeLabel(count: number) {
  return count === 0 ? "Notifications" : `Notifications, ${countText(count)} unread`;
}

/** The rail row under What's new: same shape, so the two counts read as a pair. */
export function NotificationsRow({ businesses }: { businesses: BellBusiness[] }) {
  const unread = useUnread();
  const [open, setOpen] = React.useState(false);
  const path = usePathname();
  const active = path === SETTINGS_HREF;
  const count = unread?.count ?? 0;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <RailTip label={badgeLabel(count)}>
        <PopoverTrigger asChild>
          <button
            type="button"
            data-nav-label="Notifications"
            aria-label={badgeLabel(count)}
            onClick={(e) => {
              // In the phone drawer the panel is a full-height sheet, not a popover off-screen.
              if (window.matchMedia("(width < 48rem)").matches) {
                e.preventDefault();
                delete document.documentElement.dataset.mobileNav;
                window.dispatchEvent(new Event(OPEN_EVENT));
              }
            }}
            className={cn(
              NAV_FOCUS,
              "nav-row relative flex h-9 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-sm transition-colors",
              active || open
                ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                : "text-sidebar-foreground/80 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground",
            )}
          >
            <Bell
              aria-hidden
              className={cn("size-4 shrink-0", active ? "text-sidebar-primary" : "opacity-80")}
            />
            <span className="nav-label">Notifications</span>
            {count ? (
              <NavBadge
                count={count}
                tone={unread?.destructive ? "attention" : "news"}
                label={`${countText(count)} unread`}
              />
            ) : null}
          </button>
        </PopoverTrigger>
      </RailTip>
      <PopoverContent
        side="right"
        align="end"
        sideOffset={12}
        aria-label="Notifications"
        className="flex max-h-[min(640px,calc(100dvh-2rem))] w-96 flex-col overflow-hidden p-0"
      >
        {open ? <NotificationPanel businesses={businesses} onDone={() => setOpen(false)} /> : null}
      </PopoverContent>
    </Popover>
  );
}

/** The phone top bar's bell: the same panel as a full-height sheet. */
export function MobileBell({ businesses }: { businesses: BellBusiness[] }) {
  const unread = useUnread();
  const [open, setOpen] = React.useState(false);
  React.useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_EVENT, onOpen);
  }, []);
  const count = unread?.count ?? 0;
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={badgeLabel(count)}
        className="relative inline-flex size-9 items-center justify-center rounded-md text-foreground transition-colors hover:bg-muted"
      >
        <Bell aria-hidden className="size-5" />
        {count ? (
          <span
            aria-hidden
            className={cn(
              "absolute top-0.5 right-0 min-w-4.5 rounded-full px-1 text-center text-xs leading-4.5 font-medium tabular-nums",
              unread?.destructive ? "bg-destructive text-white" : "bg-muted text-foreground/80",
            )}
          >
            {countText(count)}
          </span>
        ) : null}
      </button>
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-full">
        <SheetTitle className="sr-only">Notifications</SheetTitle>
        <SheetDescription className="sr-only">
          Notifications from the last 90 days.
        </SheetDescription>
        {open ? (
          <NotificationPanel businesses={businesses} onDone={() => setOpen(false)} sheet />
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

type ListState =
  | { status: "loading" }
  | { status: "error" }
  | {
      status: "ready";
      rows: Notification[];
      cursor: string | null;
      setUp: boolean | null;
    };

/** Header, filters, the day-grouped list, the footer. Fetches when it mounts (panel open). */
export function NotificationPanel({
  businesses,
  onDone,
  sheet = false,
  page = false,
}: {
  businesses: BellBusiness[];
  onDone: () => void;
  sheet?: boolean;
  /** The full /notifications page: the page header names it and the page scrolls. */
  page?: boolean;
}) {
  const orgTz = useDisplayTz();
  const unread = useUnread();
  const [onlyUnread, setOnlyUnread] = React.useState(false);
  const [business, setBusiness] = React.useState("");
  const [list, setList] = React.useState<ListState>({ status: "loading" });
  const [more, setMore] = React.useState(false);
  const live = businesses.filter((b) => b.live);
  const multi = live.length > 1;
  const tzOf = React.useCallback(
    (n: Notification) => businesses.find((b) => b.id === n.business?.id)?.timezone || orgTz,
    [businesses, orgTz],
  );

  const load = React.useCallback(
    async (cursor: string | null) => {
      const q = new URLSearchParams();
      if (onlyUnread) q.set("unread", "1");
      if (business) q.set("business", business);
      if (cursor) q.set("cursor", cursor);
      const res = await fetch(`/api/notifications?${q}`, { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      return (await res.json()) as NotificationPage & { set_up: boolean | null };
    },
    [onlyUnread, business],
  );

  React.useEffect(() => {
    let live = true;
    load(null).then(
      (p) =>
        live && setList({ status: "ready", rows: p.data, cursor: p.next_cursor, setUp: p.set_up }),
      () => live && setList({ status: "error" }),
    );
    return () => {
      live = false;
    };
  }, [load]);

  const showMore = async () => {
    if (list.status !== "ready" || !list.cursor) return;
    setMore(true);
    try {
      const p = await load(list.cursor);
      setList({ ...list, rows: [...list.rows, ...p.data], cursor: p.next_cursor });
    } catch {
      toast.error("We could not load more notifications. Try again.");
    } finally {
      setMore(false);
    }
  };

  const open = (n: Notification) => {
    onDone();
    if (n.read) return;
    setList((l) =>
      l.status === "ready"
        ? { ...l, rows: l.rows.map((r) => (r.id === n.id ? { ...r, read: true } : r)) }
        : l,
    );
    void markNotificationReadAction(n.id).then(() => refreshUnread());
  };

  const markAll = async () => {
    const r = await markAllNotificationsReadAction(business || undefined);
    if (!r.ok) {
      toast.error(r.message);
      return;
    }
    setList((l) =>
      l.status === "ready" ? { ...l, rows: l.rows.map((x) => ({ ...x, read: true })) } : l,
    );
    if (!business) setUnread({ count: 0, destructive: false });
    void refreshUnread();
  };

  const hasUnread =
    list.status === "ready"
      ? list.rows.some((r) => !r.read) || (!business && !!unread?.count)
      : false;

  const markAllButton = hasUnread ? (
    <Button type="button" variant="ghost" size="sm" onClick={markAll}>
      Mark all as read
    </Button>
  ) : null;

  return (
    <div className={cn("flex flex-col", !page && "min-h-0 flex-1")}>
      {page ? null : (
        <div className={cn("flex items-center gap-2 border-b px-4 py-3", sheet && "pr-12")}>
          <h2 className="m-0 flex-1 text-base font-semibold">Notifications</h2>
          {markAllButton}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2.5">
        <div className={SEGMENT_TRACK} role="group" aria-label="Show">
          {[
            { v: false, label: "All" },
            { v: true, label: "Unread" },
          ].map((s) => (
            <button
              key={s.label}
              type="button"
              aria-pressed={onlyUnread === s.v}
              onClick={() => setOnlyUnread(s.v)}
              className={segmentItem(onlyUnread === s.v, "h-7 px-3")}
            >
              {s.label}
            </button>
          ))}
        </div>
        {multi ? (
          <SelectField
            size="sm"
            ariaLabel="Business"
            value={business}
            onValueChange={setBusiness}
            className="ml-auto w-44"
            options={[
              { value: "", label: "All businesses" },
              ...live.map((b) => ({ value: b.id, label: b.name })),
            ]}
          />
        ) : null}
        {page ? <div className={cn(!multi && "ml-auto")}>{markAllButton}</div> : null}
      </div>
      <div className={cn(!page && "min-h-0 flex-1 overflow-y-auto")}>
        {list.status === "loading" ? (
          <div
            aria-busy="true"
            aria-label="Loading notifications"
            className="flex flex-col gap-2 p-4"
          >
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-14 animate-pulse rounded-md bg-muted/60" />
            ))}
          </div>
        ) : list.status === "error" ? (
          <EmptyState
            compact
            title="We could not load notifications"
            description="Close this panel and open it again."
          />
        ) : list.rows.length === 0 ? (
          onlyUnread ? (
            <EmptyState
              compact
              title="No unread notifications."
              action={
                <Button type="button" variant="link" size="sm" onClick={() => setOnlyUnread(false)}>
                  Show all
                </Button>
              }
            />
          ) : list.setUp === false ? (
            <EmptyState
              compact
              title="No notifications"
              description="Select the events you want to know about. We show them here and can also send them to this device."
              action={
                <Button asChild size="sm">
                  <Link href={SETTINGS_HREF} onClick={onDone}>
                    Set up notifications
                  </Link>
                </Button>
              }
            />
          ) : (
            <EmptyState compact title="No notifications in the last 90 days." />
          )
        ) : (
          <>
            {groupByDay(list.rows, tzOf).map((g) => (
              <section key={g.label} aria-label={g.label}>
                <h3
                  className={cn(
                    "m-0 px-4 pt-3 pb-1 text-xs font-medium text-muted-foreground",
                    !page && "sticky top-0 z-1 bg-popover",
                  )}
                >
                  {g.label}
                </h3>
                <ul className="m-0 list-none p-0">
                  {g.rows.map((n) => (
                    <li key={n.id}>
                      <NotificationRow
                        n={n}
                        tz={tzOf(n)}
                        showBusiness={multi}
                        onOpen={() => open(n)}
                      />
                    </li>
                  ))}
                </ul>
              </section>
            ))}
            {list.cursor ? (
              <div className="px-4 py-2">
                <Button type="button" variant="ghost" size="sm" disabled={more} onClick={showMore}>
                  Show more
                </Button>
              </div>
            ) : null}
          </>
        )}
      </div>
      <div className="flex items-center gap-3 border-t px-4 py-2.5 text-xs text-muted-foreground">
        <span className="flex-1">Notifications from the last 90 days</span>
        {page ? null : (
          <Link
            href={SETTINGS_HREF}
            onClick={onDone}
            className="text-sm text-primary hover:underline"
          >
            Notification settings
          </Link>
        )}
      </div>
    </div>
  );
}

/** One bell row: a link in tab order. Opening it marks it read. */
export function NotificationRow({
  n,
  tz,
  showBusiness,
  onOpen,
}: {
  n: Notification;
  tz: string;
  showBusiness: boolean;
  onOpen: () => void;
}) {
  return (
    <Link
      href={n.url || SETTINGS_HREF}
      onClick={onOpen}
      className="flex gap-3 px-4 py-2.5 transition-colors hover:bg-muted/50 focus-visible:bg-muted/50"
    >
      <span
        aria-hidden
        className={cn("mt-0.5 grid size-8 shrink-0 place-items-center rounded-md", TILE[n.tone])}
      >
        {React.createElement(iconOf(n.kind), { className: "size-4" })}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-2">
          <span className={cn("min-w-0 flex-1 text-sm", n.read ? "font-normal" : "font-semibold")}>
            {n.title}
          </span>
          {n.test ? <Chip>Test</Chip> : null}
        </span>
        <span className="text-xs leading-normal text-muted-foreground">{n.body}</span>
        {showBusiness && n.business ? (
          <span className="text-xs text-muted-foreground">{n.business.name}</span>
        ) : null}
      </span>
      <span className="flex shrink-0 flex-col items-end gap-1.5 pt-0.5">
        <span className="text-xs text-muted-foreground tabular-nums">
          {timeOfDay(n.created_at, tz)}
        </span>
        {n.read ? null : (
          <span className="size-2 rounded-full bg-primary" aria-label="Unread" role="img" />
        )}
      </span>
    </Link>
  );
}
