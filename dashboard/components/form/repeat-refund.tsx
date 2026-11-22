"use client";

import * as React from "react";
import { Alert } from "@/components/ui/alert";
import { SubmitButton } from "@/components/form/submit-button";
import type { ActionResult } from "@/lib/action-result";

/**
 * A refund the engine took for an accidental repeat (`possible_duplicate`). Pass `onRefused`
 * to `ActionForm`, render `<RepeatRefundNotice>` inside it. "Refund again" posts the same
 * values with `confirm_repeat=true`; any change to the form clears the notice.
 */
export function useRepeatRefund() {
  const [message, setMessage] = React.useState<string | null>(null);
  const onRefused = React.useCallback((r: ActionResult) => {
    setMessage(r.code === "possible_duplicate" ? (r.message ?? null) : null);
  }, []);
  const clear = React.useCallback(() => setMessage(null), []);
  return { message, onRefused, clear };
}

const POSTED = new Set(["confirm_repeat"]);

function snapshot(form: HTMLFormElement): string {
  const rows: string[] = [];
  new FormData(form).forEach((v, k) => {
    if (!POSTED.has(k)) rows.push(`${k}=${typeof v === "string" ? v : ""}`);
  });
  return rows.join("&");
}

export function RepeatRefundNotice({
  message,
  onClear,
}: {
  message: string | null;
  onClear: () => void;
}) {
  const anchor = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    const form = anchor.current?.closest("form");
    if (!message || !form) return;
    const base = snapshot(form);
    const check = () => {
      if (snapshot(form) !== base) onClear();
    };
    // A select posts through a hidden input, so watch its value as well as input events.
    form.addEventListener("input", check);
    form.addEventListener("change", check);
    const mo = new MutationObserver(check);
    mo.observe(form, { subtree: true, attributes: true, attributeFilter: ["value"] });
    return () => {
      form.removeEventListener("input", check);
      form.removeEventListener("change", check);
      mo.disconnect();
    };
  }, [message, onClear]);
  return (
    <div ref={anchor}>
      {message ? (
        <Alert
          tone="warning"
          title="Possible repeat refund"
          action={
            <SubmitButton variant="outline" size="sm" name="confirm_repeat" value="true">
              Refund again
            </SubmitButton>
          }
        >
          {message}
        </Alert>
      ) : null}
    </div>
  );
}
