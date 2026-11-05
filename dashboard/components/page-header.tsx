import * as React from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";

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
        <nav className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          {breadcrumbs.map((c, i) => (
            <React.Fragment key={i}>
              {i > 0 ? <span className="text-muted-foreground/50">/</span> : null}
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
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h1 className="text-2xl font-medium tracking-[-0.02em]">{title}</h1>
            {count != null ? (
              <span className="rounded-full border bg-card px-2.5 py-0.5 text-sm text-foreground/80 tabular-nums">
                {count}
              </span>
            ) : null}
          </div>
          {description ? <div className="text-sm text-muted-foreground">{description}</div> : null}
        </div>
        {actions ? (
          // Shrinkable and wrapping — including a caller's own wrapper div — so a row of
          // controls folds onto a second line on a narrow screen instead of running off it.
          <div className="flex min-w-0 flex-wrap items-center gap-2 lg:justify-end [&>div]:flex-wrap">
            {actions}
          </div>
        ) : null}
      </div>
    </div>
  );
}
