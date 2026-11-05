import * as React from "react";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert } from "@/components/ui/alert";

/** Centered empty state with an icon, title, optional body + call to action. */
export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: React.ReactNode;
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        // No border. An EmptyState is always rendered INSIDE a card or a ruled
        // section, so the dashed box this used to draw produced a second border
        // nested in the first — visible on the invoice and subscription detail
        // pages. Space does the separating.
        // whitespace-normal: list tables render this in a nowrap cell, where the
        // description overflowed its max-w-sm box and sat off-centre to the right.
        "flex flex-col items-center justify-center gap-2 px-6 py-10 text-center whitespace-normal",
        className,
      )}
    >
      {icon ? <div className="text-muted-foreground [&_svg]:size-8">{icon}</div> : null}
      <h3 className="text-sm font-semibold">{title}</h3>
      {description ? <p className="max-w-sm text-sm text-muted-foreground">{description}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

/**
 * Inline error panel — for failed fetches / actions.
 *
 * Delegates to `Alert` rather than drawing its own box: this and the 26
 * copy-pasted page banners were three renderings of the same thing, which is how
 * they drifted apart in the first place.
 */
export function ErrorState({
  title = "Something went wrong",
  description,
  action,
  className,
}: {
  title?: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <Alert tone="error" title={title} className={className}>
      {description}
      {action ? <div className="mt-2">{action}</div> : null}
    </Alert>
  );
}

/** Table loading skeleton — N rows of shimmer matching a data-table layout. */
export function TableSkeleton({ rows = 5, cols = 4 }: { rows?: number; cols?: number }) {
  return (
    <div className="space-y-2" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex gap-3">
          {Array.from({ length: cols }).map((_, c) => (
            <Skeleton key={c} className="h-9 flex-1" />
          ))}
        </div>
      ))}
    </div>
  );
}
