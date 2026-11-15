import * as React from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { LARGE_TITLE_COLLAPSE } from "@/lib/motion";
import { CompactTitle } from "@/components/large-title";

export interface Crumb {
  label: string;
  href?: string;
}

/** Standard page opener: optional breadcrumbs, large title, muted subtitle, right-aligned actions. */
export function PageHeader({
  title,
  description,
  breadcrumbs,
  actions,
  count,
  className,
}: {
  title: React.ReactNode;
  /** A record count, drawn as a pill beside the title. */
  count?: React.ReactNode;
  description?: React.ReactNode;
  breadcrumbs?: Crumb[];
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    // More room under the opener, and the crumb trail drops to 12px: it is
    // chrome, so it should not compete with the title at the same size.
    <div className={cn("anim-fade mb-8 space-y-2.5", className)}>
      {breadcrumbs && breadcrumbs.length > 0 ? (
        <nav
          aria-label="Breadcrumb"
          className="flex flex-wrap items-center gap-1.5 text-xs text-foreground/70"
        >
          {breadcrumbs.map((c, i) => (
            <React.Fragment key={i}>
              {i > 0 ? (
                <span aria-hidden className="text-muted-foreground/80">
                  /
                </span>
              ) : null}
              {c.href ? (
                <Link href={c.href} className="transition-colors hover:text-foreground">
                  {c.label}
                </Link>
              ) : (
                <span className="text-foreground/80">{c.label}</span>
              )}
            </React.Fragment>
          ))}
        </nav>
      ) : null}
      {/* Side by side only from lg: below it the sidebar leaves too little room for both. */}
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        {/* The title and subtitle: page chrome, never a "Show me" target (the actions are). */}
        <div data-page-title className="min-w-0 space-y-1">
          <div className="relative flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h1 className="text-2xl font-semibold tracking-[-0.02em]">{title}</h1>
            {count != null ? (
              // On the chip scale. Baseline-aligned, its centre sits 3.5px below the title's
              // x-height centre (26px title, 12px count); the lift puts it on that centre.
              <span className="relative -top-[3.5px] inline-flex h-6 items-center rounded-full border bg-card px-2.5 text-xs font-medium text-foreground/80 tabular-nums">
                {count}
              </span>
            ) : null}
            {LARGE_TITLE_COLLAPSE ? <CompactTitle title={title} actions={actions} /> : null}
          </div>
          {description ? <div className="text-sm text-muted-foreground">{description}</div> : null}
        </div>
        {actions ? (
          // Shrinkable and wrapping — including a caller's own wrapper div — so a row of
          // controls folds onto a second line on a narrow screen instead of running off it.
          // Beside the title it keeps its width (up to half the row), so a long description
          // wraps instead of stacking the actions one per line (request logs did).
          <div className="flex min-w-0 flex-wrap items-center gap-2 lg:max-w-1/2 lg:shrink-0 lg:justify-end [&>div]:flex-wrap">
            {actions}
          </div>
        ) : null}
      </div>
    </div>
  );
}
