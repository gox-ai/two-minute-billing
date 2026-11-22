"use client";

import { X } from "lucide-react";
import { useTransition } from "react";
import { Button } from "@/components/ui/button";
import { hideSetupChecklistAction } from "./setup-checklist-actions";

export function SetupChecklistClose({ biz }: { biz: string }) {
  const [pending, start] = useTransition();
  return (
    <Button
      size="icon"
      variant="ghost"
      aria-label="Close setup steps"
      disabled={pending}
      onClick={() => start(() => hideSetupChecklistAction(biz))}
    >
      <X className="size-4" />
    </Button>
  );
}
