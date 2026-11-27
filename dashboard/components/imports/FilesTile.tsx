import { FileSpreadsheet } from "lucide-react";
import { plural } from "@/lib/labels";

/** The "From" end of an import: the uploaded files. Matches the business tile of a copy. */
export function FilesTile({ count, names }: { count: number; names?: string[] }) {
  return (
    <div className="flex min-w-0 flex-[1_1_16rem] items-center gap-3 rounded-xl border bg-card px-4 py-3 max-sm:px-3 max-sm:py-2">
      <span
        aria-hidden
        className="flex size-10 shrink-0 items-center justify-center rounded-md border bg-muted text-muted-foreground"
      >
        <FileSpreadsheet className="size-5" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="text-xs text-muted-foreground">From</span>
        <span className="min-w-0 text-sm font-medium wrap-break-word">
          {names?.length ? names.join(", ") : count ? plural(count, "file") : "Your files"}
        </span>
      </div>
    </div>
  );
}
