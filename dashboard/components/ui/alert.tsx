import * as React from "react";
import { CheckCircle2, Info, TriangleAlert, XCircle } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * Page-level message banner — the "saved successfully" / "that failed" strip that
 * sits under a page title.
 *
 * This existed 26 times as copy-pasted markup: seventeen identical
 * `rounded-lg border border-primary/20 bg-accent px-4 py-3 …` divs plus nine
 * colour variants that pinned Tailwind palette steps (`emerald-500/10`,
 * `rose-700`, `amber-50`) and each needed their own hand-written `dark:` classes.
 * That is why hardcoded palette colours survived the token migration.
 *
 * Tones map to the semantic tokens, so they follow the theme, and the icon means
 * the tone survives greyscale and colour-blind vision rather than relying on hue.
 */
const TONE: Record<
  "info" | "success" | "warning" | "error",
  { cls: string; Icon: React.ComponentType<{ className?: string }>; live: "status" | "alert" }
> = {
  info: { cls: "border-info/25 bg-info-soft text-info", Icon: Info, live: "status" },
  success: {
    cls: "border-success/25 bg-success-soft text-success",
    Icon: CheckCircle2,
    live: "status",
  },
  warning: {
    cls: "border-warning/25 bg-warning-soft text-warning",
    Icon: TriangleAlert,
    live: "status",
  },
  error: {
    cls: "border-destructive/25 bg-destructive-soft text-destructive",
    Icon: XCircle,
    live: "alert",
  },
};

function Alert({
  tone = "info",
  title,
  children,
  action,
  className,
}: {
  tone?: "info" | "success" | "warning" | "error";
  /** Optional bold lead-in. Omit for a single-line banner. */
  title?: React.ReactNode;
  children?: React.ReactNode;
  /** Trailing control, e.g. a retry or "view" link. */
  action?: React.ReactNode;
  className?: string;
}) {
  const { cls, Icon, live } = TONE[tone];
  return (
    <div
      data-slot="alert"
      data-tone={tone}
      role={live}
      className={cn("flex items-start gap-2.5 rounded-lg border px-4 py-3 text-sm", cls, className)}
    >
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        {title ? <strong className="font-semibold">{title}</strong> : null}
        {/* Links take the banner's tone: a brand-coloured link on a tinted banner is a second hue. */}
        {children ? (
          <div className="min-w-0 [&_a]:text-current [&_a]:underline">{children}</div>
        ) : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

export { Alert };
