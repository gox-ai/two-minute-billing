import * as React from "react";
import Link from "next/link";

/**
 * A section title on the organization overview, in the zone heading's type, with its
 * qualifier beside it and one way out at the end.
 */
export function SectionHeading({
  id,
  title,
  meta,
  action,
}: {
  id: string;
  title: string;
  meta?: React.ReactNode;
  action?: { href: string; label: string };
}) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <h2 id={id} className="text-xl font-medium tracking-[-0.01em]">
        {title}
      </h2>
      {meta ? <span className="text-sm text-muted-foreground">{meta}</span> : null}
      {action ? (
        <Link
          href={action.href}
          className="ms-auto text-sm font-medium text-primary hover:underline"
        >
          {action.label}
        </Link>
      ) : null}
    </div>
  );
}
