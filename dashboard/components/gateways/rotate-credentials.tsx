"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CredentialFields } from "@/components/gateways/credential-fields";
import type { CredentialFieldMeta } from "@/components/gateways/gateway-meta";
import type { ActionResult } from "@/lib/action-result";

/**
 * Rotate credentials. Not a form: the page's one Save form wraps this card, so the inputs
 * are unnamed and Rotate posts its own FormData.
 */
export function RotateCredentials({
  biz,
  gwa,
  gatewayKey,
  fields,
  rotate,
}: {
  biz: string;
  gwa: string;
  gatewayKey: string;
  fields: CredentialFieldMeta[];
  rotate: (prev: ActionResult | null, fd: FormData) => Promise<ActionResult>;
}) {
  const router = useRouter();
  const [values, setValues] = React.useState<Record<string, string>>({});
  const [busy, start] = React.useTransition();
  const filled = Object.values(values).some((v) => v.trim());

  function submit() {
    const fd = new FormData();
    fd.set("biz", biz);
    fd.set("gwa", gwa);
    fd.set("gateway_key", gatewayKey);
    for (const [k, v] of Object.entries(values)) if (v.trim()) fd.set(`cred_${k}`, v);
    start(async () => {
      const res = await rotate(null, fd);
      if (res.ok) {
        setValues({});
        toast.success(res.message ?? "Credentials rotated.");
        router.refresh();
      } else {
        toast.error(res.message ?? "We could not rotate the credentials.");
      }
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <CredentialFields
        fields={fields}
        values={values}
        onValueChange={(k, v) => setValues((s) => ({ ...s, [k]: v }))}
      />
      <div>
        <Button type="button" variant="outline" onClick={submit} disabled={busy || !filled}>
          {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
          Rotate credentials
        </Button>
      </div>
    </div>
  );
}
