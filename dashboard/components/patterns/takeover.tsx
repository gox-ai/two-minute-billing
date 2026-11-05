import * as React from "react";
import Link from "next/link";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TabRail, type TabRailItem } from "@/components/patterns/tab-rail";
import { TakeoverModeChip } from "@/components/patterns/takeover-mode-chip";

/**
 * Full-screen create/edit takeover: covers the app shell with
 * a slim header (brand chip + context, Dismiss + primary action) and an
 * optional left anchor rail. Render the page's <form> AROUND this component
 * (the primary action is usually a SubmitButton passed via `actions`).
 */
export function Takeover({
  context,
  dismissHref,
  actions,
  railItems,
  wide = false,
  children,
}: {
  /** Small context text next to the brand (e.g. business name). */
  context?: React.ReactNode;
  dismissHref: string;
  /** Right side of the header — typically <SubmitButton>Create</SubmitButton>. */
  actions?: React.ReactNode;
  railItems?: TabRailItem[];
  /**
   * Let the content run to the shell's full width instead of the 1280px default.
   *
   * The default suits a takeover that is only fields — the design system's ~720px
   * measure then falls out of the rail + content + side-panel split. A takeover
   * whose main content is a TABLE is the exception the same rules already carve
   * out ("tables run to the available width and must never truncate"): at 1280 the
   * subscription-change line-items grid needed 732px in a 688px column, so it
   * overflowed the card edge. Field widths are capped per-field, so widening the
   * container does not stretch any input.
   */
  wide?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="anim-pop fixed inset-0 z-40 flex flex-col overflow-hidden bg-background">
      <header className="flex shrink-0 items-center justify-between border-b bg-card px-6 py-2.5">
        <div className="flex items-center gap-3">
          {/* Resolved from the business being edited. Was hardcoded to "Test", which
              made this header lie on every live business — and a takeover hides both
              of the shell's other mode signals while it is open. */}
          <TakeoverModeChip />
          {context ? (
            <span className="truncate text-sm font-semibold text-foreground">{context}</span>
          ) : null}
        </div>
        <div className="flex items-center gap-3">
          <Button
            asChild
            variant="outline"
            size="sm"
            className="h-8 border-border text-xs font-medium"
          >
            <Link href={dismissHref}>Close</Link>
          </Button>
          {actions}
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div
          className={`mx-auto flex w-full gap-8 px-8 py-8 ${wide ? "max-w-[1600px]" : "max-w-7xl"}`}
        >
          {railItems && railItems.length > 0 ? (
            <TabRail items={railItems} className="top-4" />
          ) : null}
          <div className="min-w-0 flex-1">{children}</div>
        </div>
      </div>
    </div>
  );
}
