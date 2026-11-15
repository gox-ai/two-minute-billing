import * as React from "react";
import { CheckCircle2, Info, TriangleAlert, XCircle } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * Page-level message banner — the "saved successfully" / "that failed" strip that
 * sits under a page title.
 *
 * This existed 26 times as copy-pasted markup: seventeen identical accent-tinted
 * divs plus nine colour variants that pinned Tailwind palette steps, each with its
 * own hand-written `dark:` classes. That is why hardcoded palette colours survived
 * the token migration. `neutral` is the quiet note (a consequence, a cap).
 *
 * Tones map to the semantic tokens, so they follow the theme, and the icon means
 * the tone survives greyscale and colour-blind vision rather than relying on hue.
 */
type Tone = "neutral" | "info" | "success" | "warning" | "error";

const TONE: Record<
  Tone,
  {
    cls: string;
    Icon: React.ComponentType<{ className?: string }>;
    live: "status" | "alert" | "note";
  }
> = {
  // A quiet filled well: "what this value does", a cap, a consequence. Not a live region.
  neutral: { cls: "border-border bg-muted/50 text-foreground/85", Icon: Info, live: "note" },
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
  tone?: Tone;
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
      className={cn(
        "flex items-start gap-2.5 rounded-xl border px-4 py-3 text-sm",
        // On a phone the action takes its own line under the text, so the text keeps the width.
        action && "max-sm:flex-wrap",
        cls,
        className,
      )}
    >
      <Icon
        className={cn("mt-0.5 size-4 shrink-0", tone === "neutral" && "text-muted-foreground")}
        aria-hidden
      />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        {title ? <strong className="font-semibold">{title}</strong> : null}
        {/* Links take the banner's tone: a brand-coloured link on a tinted banner is a second hue.
            `wrap-anywhere` breaks only a token wider than the line (a URL in a gateway's text),
            which otherwise widened the card around it. */}
        {children ? (
          <div className="min-w-0 wrap-anywhere [&_a]:text-current [&_a]:underline">{children}</div>
        ) : null}
      </div>
      {action ? <div className="shrink-0 max-sm:basis-full max-sm:pl-6.5">{action}</div> : null}
    </div>
  );
}

export { Alert };
