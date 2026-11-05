"use client";

import * as React from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import type { ActionResult } from "@/lib/action-result";
import { archiveDefinitionAction, restoreDefinitionAction } from "./actions";

/** Archive / restore toggle for a custom-field definition row. */
export function RowActions({ biz, id, archived }: { biz: string; id: string; archived: boolean }) {
  const [pending, start] = React.useTransition();
  const run = (fn: (b: string, i: string) => Promise<ActionResult>) =>
    start(async () => {
      const res = await fn(biz, id);
      if (res.ok) toast.success(res.message ?? "Done");
      else toast.error(res.message ?? "We could not change the custom field.");
    });
  return archived ? (
    <Button
      variant="outline"
      size="sm"
      disabled={pending}
      onClick={() => run(restoreDefinitionAction)}
    >
      {pending ? "…" : "Restore"}
    </Button>
  ) : (
    <Button
      variant="ghost"
      size="sm"
      disabled={pending}
      onClick={() => run(archiveDefinitionAction)}
    >
      {pending ? "…" : "Archive"}
    </Button>
  );
}
