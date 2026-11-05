import { ArrowDown, ArrowUp } from "lucide-react";
import { cn } from "@/lib/utils";

export type DeltaDirection = "up" | "down" | "flat";
export type DeltaTone = "good" | "bad" | "neutral";

const TONE: Record<DeltaTone, string> = {
  good: "border-success/20 bg-success-soft text-success",
  bad: "border-destructive/20 bg-destructive-soft text-destructive",
  neutral: "border-border bg-muted text-muted-foreground",
};

/** The movement pill shared by chart headers and scorecards: arrow + magnitude, toned. */
export function DeltaChip({
  direction,
  tone,
  children,
}: {
  direction: DeltaDirection;
  tone: DeltaTone;
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs font-semibold tabular-nums",
        TONE[tone],
      )}
    >
      {direction === "down" ? (
        <ArrowDown className="size-3" />
      ) : direction === "up" ? (
        <ArrowUp className="size-3" />
      ) : null}
      <span className="sr-only">{direction === "flat" ? "flat " : `${direction} `}</span>
      {children}
    </span>
  );
}
