import type { ComponentType } from "react";
import Link from "next/link";
import {
  ChevronRight,
  FileClock,
  FileWarning,
  MailWarning,
  Package,
  Plug,
  ReceiptText,
  Scale,
  ShieldAlert,
} from "lucide-react";
import { InfoTip } from "@/components/analytics/info-tip";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { AttentionKind, AttentionRow } from "@/components/overview/attention";

/** Rows shown before the rest are counted; the list stays short enough to read at a glance. */
const SHOWN = 6;

const ICON: Record<AttentionKind, ComponentType<{ className?: string }>> = {
  unpaid: FileWarning,
  dispute: Scale,
  receivables: ReceiptText,
  pending: FileClock,
  email: MailWarning,
  gateway: Plug,
  catalog: Package,
  security: ShieldAlert,
};

/** One card, one row per thing to do, each with links to the screens where it is done. */
export function AttentionList({ rows }: { rows: AttentionRow[] }) {
  const shown = rows.slice(0, SHOWN);
  const more = rows.length - shown.length;
  return (
    <Card className="anim-rise gap-0 overflow-hidden py-0">
      <ul className="divide-y">
        {shown.map((r) => {
          const Icon = ICON[r.kind];
          return (
            <li
              key={r.key}
              className="flex flex-wrap items-start gap-x-3 gap-y-1.5 px-4 py-3 sm:flex-nowrap sm:items-center sm:px-5"
            >
              <Icon
                className={cn(
                  "mt-0.5 size-4 shrink-0 sm:mt-0",
                  r.tone === "attention" ? "text-destructive" : "text-warning",
                )}
                aria-hidden
              />
              <span className="flex min-w-0 flex-[1_1_14rem] flex-col gap-0.5">
                <span className="flex items-center gap-1 text-sm font-medium">
                  {r.title}
                  {r.info ? <InfoTip label={r.title} info={r.info} /> : null}
                </span>
                {r.business || r.detail ? (
                  <span className="text-sm text-muted-foreground">
                    {r.business ? (
                      <span className="font-medium text-foreground/80">{r.business}</span>
                    ) : null}
                    {r.business && r.detail ? " · " : null}
                    {r.detail}
                  </span>
                ) : null}
              </span>
              {/* On a phone the actions take their own line, under the text. */}
              <span className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 ps-7 sm:ps-0">
                {r.actions.map((a) => (
                  <Link
                    key={a.href}
                    href={a.href}
                    className="flex items-center gap-1 text-sm font-medium whitespace-nowrap text-primary hover:underline"
                  >
                    {a.label}
                    <ChevronRight className="size-3.5" aria-hidden />
                  </Link>
                ))}
              </span>
            </li>
          );
        })}
      </ul>
      {more > 0 ? (
        <p className="border-t px-4 py-3 text-sm text-muted-foreground sm:px-5">
          {more} more {more === 1 ? "item" : "items"}. Select a business below to view them.
        </p>
      ) : null}
    </Card>
  );
}
