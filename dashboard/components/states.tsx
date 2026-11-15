import * as React from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert } from "@/components/ui/alert";
import { RetryButton } from "@/components/error-state-retry";

/**
 * Centered empty state: title leads, body is muted, ONE action.
 *
 * No border — it always sits inside a card. The icon and action rows are always laid out, so
 * every list's zero state is the same height whether or not it has them (they used to span
 * 219–271px across lists). `compact` is for a card beside other cards on a record page: no
 * height floor, and the icon and action rows only when there is something in them.
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
  compact = false,
  className,
}: {
  icon?: React.ReactNode;
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
  compact?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn(
        // whitespace-normal: list tables render this in a nowrap cell.
        "flex flex-col items-center justify-center gap-2 px-6 text-center whitespace-normal",
        compact ? "py-6" : "min-h-64 py-10",
        className,
      )}
    >
      {compact && !icon ? null : (
        <div
          className={cn(
            "flex items-center text-muted-foreground",
            compact ? "h-6 [&_svg]:size-6" : "h-8 [&_svg]:size-8",
          )}
        >
          {icon}
        </div>
      )}
      <h3 className="text-base font-medium text-foreground">{title}</h3>
      {description ? <p className="max-w-sm text-sm text-muted-foreground">{description}</p> : null}
      {compact && !action ? null : <div className="mt-2 flex min-h-8 items-center">{action}</div>}
    </div>
  );
}

/** The reason line for a failed engine call. Never the path, never the raw status string. */
function apiReason(message: string): string {
  const code = /→ (\d{3})$/.exec(message)?.[1];
  if (code) return `The billing API answered with error ${code}.`;
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|network/i.test(message))
    return "The billing API did not answer.";
  return message;
}

/**
 * Pages pass `(e as Error).message` in a mono span. The message used to read
 * `tmbilling API /v1/… → 404` on screen, so the span is folded into a sentence here.
 */
function scrub(description: React.ReactNode): React.ReactNode {
  if (typeof description === "string") return apiReason(description);
  if (
    React.isValidElement<{ children?: unknown }>(description) &&
    typeof description.props.children === "string" &&
    /tmbilling API /.test(description.props.children)
  ) {
    return apiReason(description.props.children);
  }
  return description;
}

/**
 * Inline error panel for a failed fetch or action: "We could not load this <thing>.
 * <reason>. <next step>." with a retry and a way back.
 *
 * Delegates to `Alert` rather than drawing its own box: this and the 26 copy-pasted page
 * banners were three renderings of the same thing, which is how they drifted apart.
 */
export function ErrorState({
  title,
  description,
  action,
  className,
  thing,
  error,
  back,
  retry = false,
}: {
  title?: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
  /** What failed to load, for the title: "customer", "invoice". */
  thing?: string;
  /** The caught error. Its reason is shown as a sentence; the request path never is. */
  error?: unknown;
  /** The way back: the nearest list. */
  back?: { label: string; href: string };
  /** Offer "Try again" (re-runs the route's fetches in place). */
  retry?: boolean;
}) {
  const heading = title ?? (thing ? `We could not load this ${thing}.` : "Something went wrong");
  const reason =
    error === undefined
      ? scrub(description)
      : apiReason(error instanceof Error ? error.message : String(error));
  const hasActions = action || back || retry;
  return (
    <Alert tone="error" title={heading} className={className}>
      {reason}
      {error !== undefined ? " Try again." : null}
      {hasActions ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {action}
          {retry ? <RetryButton /> : null}
          {back ? (
            <Link href={back.href} className="text-sm font-medium">
              {back.label}
            </Link>
          ) : null}
        </div>
      ) : null}
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
