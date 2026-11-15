import Link from "next/link";
import { Archive } from "lucide-react";
import { cn } from "@/lib/utils";

/** A two-state pill that flips the ?archived= query param to show/hide archived rows. */
export function ShowArchivedToggle({ basePath, showing }: { basePath: string; showing: boolean }) {
  return (
    <Link
      href={showing ? basePath : `${basePath}?archived=1`}
      className={cn(
        "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border px-3 text-sm font-medium transition-colors max-sm:px-2 list-narrow:px-2",
        showing
          ? "border-primary/30 bg-accent text-accent-foreground"
          : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
      )}
    >
      {/* Icon-only on a phone or in a narrow list card (a page header has no list card), so
          the views control keeps its label. */}
      <Archive className="hidden size-4 max-sm:block list-narrow:block" aria-hidden />
      <span className="max-sm:sr-only list-narrow:sr-only">
        {showing ? "Showing archived" : "Show archived"}
      </span>
    </Link>
  );
}
