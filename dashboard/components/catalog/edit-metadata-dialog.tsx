"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Alert } from "@/components/ui/alert";
import { ActionForm } from "@/components/form/action-form";
import { actionError, type ActionResult } from "@/lib/action-result";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from "@/components/ui/dialog";
/**
 * Edit a record's JSON metadata — the "metadata" link on an item detail.
 *
 * The PATCH routes behind this REPLACE the whole object rather than merging, so a raw
 * JSON editor is the honest affordance: what you see is what gets stored. Blank clears
 * it (`metadata: null`).
 *
 * Parsing happens twice on purpose — here so the reader gets the error next to the field
 * they typed in, and again in the server action, because an editable textarea is not a
 * trusted input.
 *
 * `action` + `hidden` are props because two resources use this now (products and
 * coupons) and their routes take different path parameters. Adding a third is a call
 * site, not a copy of this file.
 */
export function EditMetadataDialog({
  action,
  hidden,
  metadata,
}: {
  action: (prev: ActionResult | null, formData: FormData) => Promise<ActionResult>;
  /** Path parameters the action needs, posted as hidden inputs. */
  hidden: Record<string, string>;
  metadata: Record<string, unknown> | null | undefined;
}) {
  const [open, setOpen] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const initial = metadata && Object.keys(metadata).length ? JSON.stringify(metadata, null, 2) : "";

  // Controlled, and re-seeded on each open: it starts from what is stored rather than an
  // abandoned edit, and React's post-action form reset cannot wipe a draft the server refused.
  const [draft, setDraft] = React.useState(initial);
  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) {
      setError(null);
      setDraft(initial);
    }
  };

  // Refuse bad JSON before the round trip; the server repeats the check.
  const submit = async (prev: ActionResult | null, formData: FormData) => {
    const raw = String(formData.get("metadata") ?? "").trim();
    if (raw) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        setError((err as Error).message);
        return actionError("Metadata is not valid JSON");
      }
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        const message = 'Metadata must be a JSON object. For example, {"tier":"gold"}.';
        setError(message);
        return actionError(message);
      }
    }
    const result = await action(prev, formData);
    setError(result.ok ? null : (result.message ?? "We could not save the metadata."));
    return result;
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        {/* Not a bare "Edit": the item header already has one (the quick-edit dialog), and
            two identically-labelled controls in the same card are ambiguous to a reader
            and to a screen reader. */}
        <button
          type="button"
          className="rounded-md px-1.5 py-0.5 text-xs text-primary hover:underline"
        >
          {initial ? "Edit metadata" : "Add metadata"}
        </button>
      </DialogTrigger>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>Edit JSON metadata</DialogTitle>
          <DialogDescription>
            Your own key/value pairs. This record keeps them and the API returns them. Save replaces
            the whole object. To clear the metadata, leave the field empty.
          </DialogDescription>
        </DialogHeader>
        <ActionForm action={submit} onSuccess={() => setOpen(false)} className="space-y-4">
          {Object.entries(hidden).map(([k, v]) => (
            <input key={k} type="hidden" name={k} value={v} />
          ))}
          {error ? <Alert tone="error">{error}</Alert> : null}
          <Textarea
            name="metadata"
            rows={10}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            spellCheck={false}
            aria-label="JSON metadata"
            placeholder={'{\n  "key": "value"\n}'}
            className="font-mono text-xs"
          />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit">Save metadata</Button>
          </div>
        </ActionForm>
      </DialogContent>
    </Dialog>
  );
}
