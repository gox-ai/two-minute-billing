"use client";

import * as React from "react";
import { Field } from "@/components/form/field";
import { Textarea } from "@/components/ui/textarea";
import { checkMetadata } from "@/lib/metadata-form";

const HELP =
  "A JSON object of your own keys. We store it but never interpret it. Up to 50 keys. Leave it empty to remove it.";

/**
 * Raw JSON metadata, validated as you type. Uncontrolled (`defaultValue`) so a form
 * reset restores it; the invalid state is also set on the textarea itself, which stops
 * a native form submit until it is fixed. `onTextChange` is for callers that build
 * their own payload.
 */
export function MetadataJsonField({
  name = "metadata",
  metadata,
  onTextChange,
  help = HELP,
}: {
  name?: string;
  metadata: Record<string, unknown> | null | undefined;
  onTextChange?: (text: string, valid: boolean) => void;
  help?: React.ReactNode;
}) {
  const ref = React.useRef<HTMLTextAreaElement>(null);
  const [error, setError] = React.useState<string | null>(null);
  const initial = metadata && Object.keys(metadata).length ? JSON.stringify(metadata, null, 2) : "";

  const validate = (text: string) => {
    const r = checkMetadata(text);
    const message = r.ok ? null : r.error;
    setError(message);
    ref.current?.setCustomValidity(message ?? "");
    onTextChange?.(text, r.ok);
  };

  // A reset puts the stored value back, which is valid by construction.
  React.useEffect(() => {
    const form = ref.current?.form;
    if (!form) return;
    const onReset = () => {
      setError(null);
      ref.current?.setCustomValidity("");
    };
    form.addEventListener("reset", onReset);
    return () => form.removeEventListener("reset", onReset);
  }, []);

  return (
    <Field name={name} label="Metadata" help={help} error={error ?? undefined}>
      <Textarea
        ref={ref}
        name={name}
        rows={6}
        spellCheck={false}
        className="font-mono text-xs"
        placeholder={'{\n  "crm_id": "A-1024"\n}'}
        defaultValue={initial}
        onChange={(e) => validate(e.currentTarget.value)}
      />
    </Field>
  );
}
