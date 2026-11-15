"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { openTestModeAction } from "@/app/actions";
import { useDashboardMode } from "@/components/mode-provider";
import { FlaskConical, Radio } from "lucide-react";
import { useNavCollapse } from "@/components/nav-collapse";
import { NAV_FOCUS, RailTip } from "@/components/rail-tip";
import { cn } from "@/lib/utils";

/**
 * Live/Test at the foot of the rail, inside a business: switches to the same section of
 * the business's other mode. A record page lands on its list, because the record belongs
 * to the mode you left.
 *
 * A live business created before test modes existed has no test twin yet — the switch
 * then posts `openTestModeAction`, which creates it. At org level, and on a standalone
 * test business, there is no other mode and this renders nothing.
 */
export function ModeToggle() {
  const { collapsed } = useNavCollapse();
  const path = usePathname();
  const state = useDashboardMode();
  const b = state?.business;
  if (!b) return null;
  const otherId = b.livemode === "live" ? b.testBusinessId : b.liveBusinessId;
  if (b.livemode === "test" && !otherId) return null;

  const mode = b.livemode;
  const other = mode === "test" ? "live" : "test";
  const section = path.split("/")[3];
  const label = `Mode: ${mode}. Switch to ${other} mode`;
  // One row at nav height: the label says what it is, and the lit segment carries the
  // state as a dot — the same quiet register as a status chip.
  const pill = (
    <span className="flex items-center rounded-md bg-muted p-0.5 text-xs font-medium">
      {(["live", "test"] as const).map((m) => (
        <span
          key={m}
          className={cn(
            "flex h-6.5 items-center gap-1 rounded-md px-2.5 capitalize transition-colors",
            mode === m ? "bg-raised text-sidebar-foreground shadow-xs" : "text-muted-foreground",
          )}
        >
          {mode === m ? (
            <span
              aria-hidden
              className={cn("size-1.5 rounded-full", m === "test" ? "bg-warning" : "bg-success")}
            />
          ) : null}
          {m}
        </span>
      ))}
    </span>
  );
  const row = cn("flex w-full items-center justify-between px-2.5 py-1", NAV_FOCUS);
  const caption = <span className="text-sm text-muted-foreground">Mode</span>;

  // Collapsed rail: one icon row for the current mode; the tooltip names the switch.
  if (collapsed) {
    const Icon = mode === "test" ? FlaskConical : Radio;
    const icon = (
      <>
        <Icon
          className={cn("size-4 shrink-0", mode === "test" ? "text-warning" : "text-success")}
        />
        <span className="nav-label">{label}</span>
      </>
    );
    const cls = cn(
      "nav-row flex h-9 w-full items-center gap-2.5 rounded-md px-2.5 text-sm text-sidebar-foreground/80 transition-colors hover:bg-sidebar-accent/60",
      NAV_FOCUS,
    );
    return otherId ? (
      <RailTip label={label}>
        <Link
          href={`/businesses/${encodeURIComponent(otherId)}${section ? `/${section}` : ""}`}
          aria-label={label}
          data-nav-label="Mode"
          className={cls}
        >
          {icon}
        </Link>
      </RailTip>
    ) : (
      <form action={openTestModeAction}>
        <input type="hidden" name="biz" value={b.id} />
        <input type="hidden" name="section" value={section ?? ""} />
        <RailTip label={label}>
          <button type="submit" aria-label={label} data-nav-label="Mode" className={cls}>
            {icon}
          </button>
        </RailTip>
      </form>
    );
  }

  if (otherId) {
    return (
      <Link
        href={`/businesses/${encodeURIComponent(otherId)}${section ? `/${section}` : ""}`}
        title={`Switch to ${other} mode`}
        aria-label={label}
        className={row}
      >
        {caption}
        {pill}
      </Link>
    );
  }
  return (
    <form action={openTestModeAction}>
      <input type="hidden" name="biz" value={b.id} />
      <input type="hidden" name="section" value={section ?? ""} />
      <button type="submit" title="Switch to test mode" aria-label={label} className={row}>
        {caption}
        {pill}
      </button>
    </form>
  );
}
