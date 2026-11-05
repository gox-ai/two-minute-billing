"use client";

import * as React from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { useNavPending } from "@/components/navigation/nav-pending";

/**
 * A link that changes the page's own search params. A plain click navigates inside the page's
 * pending transition, so the body shows its skeleton; modified clicks stay native.
 *
 * While this link is the one loading, a spinner replaces `icon`, or trails the label.
 */
export function PendingLink({
  href,
  source,
  icon,
  scroll = false,
  className,
  title,
  "aria-current": ariaCurrent,
  children,
}: {
  href: string;
  source: string;
  icon?: React.ReactNode;
  scroll?: boolean;
  className?: string;
  title?: string;
  "aria-current"?: React.AriaAttributes["aria-current"];
  children: React.ReactNode;
}) {
  const { navigate, pendingFrom, target } = useNavPending();
  const pending = pendingFrom(source) && (target == null || target === href);
  const spinner = <Loader2 className="size-3.5 animate-spin text-muted-foreground" aria-hidden />;
  return (
    <Link
      href={href}
      scroll={scroll}
      title={title}
      aria-current={ariaCurrent}
      className={className}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
        e.preventDefault();
        navigate(href, { source, target: href, scroll });
      }}
    >
      {icon != null ? (pending ? spinner : icon) : null}
      {children}
      {icon == null && pending ? (
        <Loader2
          className="ml-1.5 inline size-3.5 animate-spin align-[-2px] text-muted-foreground"
          aria-hidden
        />
      ) : null}
    </Link>
  );
}
