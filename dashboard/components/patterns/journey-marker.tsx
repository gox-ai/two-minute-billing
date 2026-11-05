import * as React from "react";
import { Check, Clock, FileText, X } from "lucide-react";
import { cn } from "@/lib/utils";

export type MarkKind =
  | "paid"
  | "failed"
  | "refused"
  | "pending"
  | "invoiced"
  | "event"
  | "next"
  | "neutral";

const DISC: Partial<Record<MarkKind, [string, React.ComponentType<{ className?: string }>]>> = {
  paid: ["border-success/25 bg-success-soft text-success", Check],
  failed: ["border-destructive/25 bg-destructive-soft text-destructive", X],
  // Nothing reached the gateway: the same cross, without the alarm.
  refused: ["border-muted-foreground/35 bg-card text-muted-foreground", X],
  pending: ["border-warning/25 bg-warning-soft text-warning", Clock],
  invoiced: ["border-muted-foreground/35 bg-card text-muted-foreground", FileText],
};

/**
 * The one marker vocabulary for an invoice's payments and dunning, shared by the payments
 * card (`md`) and the timeline strip (`sm`): a disc with an icon for an attempt or the
 * invoice itself, a small dot for an event, an open ring for what is still to come.
 */
export function JourneyMarker({
  kind,
  size = "md",
  className,
}: {
  kind: MarkKind;
  size?: "sm" | "md";
  className?: string;
}) {
  const md = size === "md";
  const disc = DISC[kind];
  if (disc) {
    const [tone, Icon] = disc;
    return (
      <span
        aria-hidden
        className={cn(
          "flex shrink-0 items-center justify-center rounded-full border",
          md ? "size-6.5" : "size-6",
          tone,
          className,
        )}
      >
        <Icon className="size-3.5" />
      </span>
    );
  }
  return (
    <span
      aria-hidden
      className={cn("flex shrink-0 items-center justify-center", md ? "size-6.5" : "size-6")}
    >
      <span
        className={cn(
          "rounded-full",
          kind === "next"
            ? cn("border-[1.5px] border-muted-foreground/40 bg-card", md ? "size-4" : "size-3.5")
            : kind === "event"
              ? cn("border border-muted-foreground/40 bg-muted", md ? "size-3.5" : "size-2.5")
              : cn("bg-muted-foreground/40", md ? "size-3.5" : "size-2.5"),
          className,
        )}
      />
    </span>
  );
}
