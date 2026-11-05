"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Copy, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CheckboxField } from "@/components/ui/checkbox";
import { acknowledgeRecoveryCodesAction } from "@/app/auth-actions";

/** The downloaded file names the account and the date, so a copy found later says what it unlocks. */
function codesText(codes: readonly string[], email: string): string {
  const date = new Date().toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
  return [
    "Recovery codes",
    `Account: ${email}`,
    `Made: ${date}`,
    "",
    "If you cannot use your authenticator app, use one code to sign in. Each code operates one time only.",
    "When you make new codes, these codes stop operating.",
    "",
    ...codes.map((c, i) => `${String(i + 1).padStart(2, " ")}. ${c}`),
    "",
  ].join("\n");
}

/**
 * Freshly minted recovery codes, shown once. "I've saved them" stays disabled until the box is
 * ticked; it records the acknowledgement and drops the only readable copy.
 */
export function RecoveryCodesReveal({ codes, email }: { codes: string[]; email: string }) {
  const router = useRouter();
  const listRef = React.useRef<HTMLOListElement>(null);
  const [saved, setSaved] = React.useState(false);
  const [pending, startTransition] = React.useTransition();

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(codes.join("\n"));
      toast.success("Recovery codes copied");
    } catch {
      // Clipboard refused (permission, insecure origin): select them so the person can copy.
      const list = listRef.current;
      const sel = window.getSelection();
      if (list && sel) {
        const range = document.createRange();
        range.selectNodeContents(list);
        sel.removeAllRanges();
        sel.addRange(range);
      }
      toast.error("We could not copy the codes. We selected the codes. Copy them yourself.");
    }
  };

  const download = () => {
    const url = URL.createObjectURL(
      new Blob([codesText(codes, email)], { type: "text/plain;charset=utf-8" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = "tmbilling-recovery-codes.txt";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  const finish = () =>
    startTransition(async () => {
      const r = await acknowledgeRecoveryCodesAction();
      if (r.ok) {
        toast.success(r.message ?? "Recovery codes saved");
        router.refresh();
      } else toast.error(r.message ?? "We could not record that you saved the codes.");
    });

  return (
    <div className="space-y-4">
      <div>
        <p className="m-0 text-sm font-semibold">Save your recovery codes</p>
        <p className="m-0 text-sm text-muted-foreground">
          If you cannot use your authenticator app, use one code to sign in. Each code operates one
          time only.{" "}
          <strong className="font-semibold text-foreground">We do not show the codes again.</strong>
        </p>
      </div>
      <ol
        ref={listRef}
        aria-label="Recovery codes"
        className="grid grid-cols-1 gap-x-6 gap-y-1.5 rounded-md bg-muted/50 p-3 font-mono text-sm tabular-nums sm:grid-cols-2"
      >
        {codes.map((c, i) => (
          <li key={c} className="flex gap-2.5">
            <span aria-hidden className="w-5 shrink-0 text-right text-muted-foreground select-none">
              {i + 1}.
            </span>
            <span>{c}</span>
          </li>
        ))}
      </ol>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" size="sm" onClick={copy}>
          <Copy /> Copy
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={download}>
          <Download /> Download .txt
        </Button>
      </div>
      <CheckboxField
        label="I saved my recovery codes in a safe location"
        checked={saved}
        onCheckedChange={setSaved}
      />
      <Button type="button" disabled={!saved || pending} onClick={finish}>
        I saved them
      </Button>
    </div>
  );
}
