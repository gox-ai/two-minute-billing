"use client";

import * as React from "react";
import { Check, Copy } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

/** Tiny inline copy-to-clipboard affordance for ids/secrets. `what` names the object in the toast ("ID copied."). */
export function CopyButton({
  value,
  what,
  className,
}: {
  value: string;
  what?: string;
  className?: string;
}) {
  const [copied, setCopied] = React.useState(false);
  return (
    <button
      type="button"
      aria-label={`Copy ${value}`}
      className={cn(
        "inline-flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
        className,
      )}
      onClick={async (e) => {
        e.preventDefault();
        e.stopPropagation();
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          toast.success(what ? `${what} copied.` : "Copied.");
          setTimeout(() => setCopied(false), 1500);
        } catch {
          toast.error("We could not copy the text.");
        }
      }}
    >
      {copied ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
    </button>
  );
}
