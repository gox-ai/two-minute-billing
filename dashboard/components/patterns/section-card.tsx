import * as React from "react";
import { cn } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";
import { CARD_HEAD_ACTIONS, CARD_HEAD_GROW } from "@/components/patterns/record-page";

/**
 * Detail section: small bold heading OUTSIDE the card, then a card body. Give it
 * an `id` so a TabRail anchor can jump to it.
 */
export function SectionCard({
  id,
  title,
  actions,
  children,
  className,
  contentClassName,
  layout = "section",
}: {
  id?: string;
  title?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  contentClassName?: string;
  /** `card`: the title sits inside the card, in a header row — the record-page style. */
  layout?: "section" | "card";
}) {
  if (layout === "card") {
    return (
      <section
        id={id}
        className={cn(
          "anim-rise scroll-mt-24 overflow-hidden rounded-xl border bg-card",
          className,
        )}
      >
        {title || actions ? (
          // On a phone the title keeps its line; actions that do not fit wrap under it.
          <div className="flex items-center gap-3 border-b px-5 py-3.5 max-sm:flex-wrap max-sm:gap-y-2">
            {title ? (
              <h2 className={cn("text-base font-medium", CARD_HEAD_GROW)}>{title}</h2>
            ) : null}
            {actions ? (
              <div className={cn(CARD_HEAD_ACTIONS, !title && "ml-auto")}>{actions}</div>
            ) : null}
          </div>
        ) : null}
        <div className={cn("px-5 py-4", contentClassName)}>{children}</div>
      </section>
    );
  }
  return (
    <section id={id} className={cn("anim-rise scroll-mt-24 space-y-2", className)}>
      {title || actions ? (
        <div className="flex items-center justify-between gap-2">
          {title ? <h2 className="text-sm font-semibold text-foreground/80">{title}</h2> : <span />}
          {actions}
        </div>
      ) : null}
      <Card className="hoverable">
        <CardContent className={cn("p-4", contentClassName)}>{children}</CardContent>
      </Card>
    </section>
  );
}

/** Dashed summary box ("Upcoming invoice of $X will be raised on DATE"). */
export function SummaryBox({
  title,
  children,
  className,
}: {
  title?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  // A filled well, not a dashed outline. SummaryBox is always rendered inside a
  // SectionCard, so a dashed border drew a second border nested in the first. In
  // this system a recessed surface marks "this is derived/secondary".
  return (
    <div className={cn("rounded-xl bg-muted/50 px-4 py-3 text-sm", className)}>
      {title ? <div className="mb-1 font-medium">{title}</div> : null}
      <div className="text-foreground/80">{children}</div>
    </div>
  );
}
