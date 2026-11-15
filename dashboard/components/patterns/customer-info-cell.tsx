import { InfoCell } from "@/components/patterns/list-cells";
import { cn } from "@/lib/utils";

const LINE = "block max-w-80 wrap-anywhere text-xs text-muted-foreground";

/**
 * The customer column of a non-customer list: name in full, else email, else the id
 * in mono; the second line is the email (or the id) unless it would repeat the title.
 */
export function CustomerInfoCell({
  id,
  name,
  email,
  href,
}: {
  id: string;
  name?: string | null;
  email?: string | null;
  href?: string;
}) {
  const title = name || email || id;
  const titleIsId = title === id;
  // A list may pass the email as the name (the engine's fallback): treat that as no name.
  const sub = name && name !== email ? email || id : email ? id : null;
  return (
    <InfoCell
      title={
        <span className={cn("block max-w-80 wrap-anywhere", titleIsId && "font-mono")}>
          {title}
        </span>
      }
      href={href}
      sub={sub ? <span className={cn(LINE, sub === id && "font-mono")}>{sub}</span> : undefined}
    />
  );
}
