"use client";

import * as React from "react";
import { Upload } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/form/field";
import type { BrandAsset, BrandImageSupport } from "@/lib/api/brand-images";

/**
 * A brand image: the URL that gets saved, plus an upload button when this deployment can
 * store one.
 *
 * ── Why the URL field never goes away ───────────────────────────────────────
 * The stored value is a URL in both paths — uploading just produces one. That is what
 * lets the field stay scheme-restricted end to end, and it means a merchant who already
 * hosts their logo does not have to re-upload it to change anything else on the page.
 *
 * ── The upload button is conditional, and that is the rule not a nicety ─────
 * Object storage is optional deployment configuration. `upload` comes from the engine's
 * capability endpoint, and when `uploadEnabled` is false NO picker renders — CLAUDE.md
 * rule 0: a control that cannot work must not be drawn. The field alone is a complete way
 * to set the value, so nothing is lost.
 *
 * The accepted formats come from that same response rather than being restated here, so
 * the picker's filter cannot drift from what the API will take — and they differ per asset
 * (a logo is embedded in the invoice PDF, which cannot carry GIF or WebP).
 *
 * `biz` null stores the image as the ORGANIZATION's (its sidebar logo; `icon` only).
 *
 * Fully controlled: the parent owns the value, because on the brand screen it also drives
 * the live preview and two copies of one string is how a preview starts lying.
 */
export function BrandImageField({
  biz,
  asset,
  name,
  label,
  help,
  value,
  onValueChange,
  upload,
  placeholder,
  className,
}: {
  /** The owning business, or null for the organization's own image. */
  biz: string | null;
  asset: BrandAsset;
  /** The form field name — this is what posts, and it posts a URL. */
  name: string;
  label: React.ReactNode;
  help?: React.ReactNode;
  value: string;
  onValueChange: (value: string) => void;
  upload: BrandImageSupport;
  placeholder?: string;
  className?: string;
}) {
  const fileRef = React.useRef<HTMLInputElement>(null);
  const accepts = upload.accepts[asset];
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function store(file: File) {
    setBusy(true);
    setError(null);
    try {
      const fd = new FormData();
      if (biz) fd.set("biz", biz);
      fd.set("asset", asset);
      fd.set("file", file);
      const res = await fetch("/api/brand-images", { method: "POST", body: fd });
      const json = (await res.json().catch(() => null)) as { url?: string; error?: string } | null;
      if (!res.ok || !json?.url) {
        // The server's own sentence, not a generic one: it distinguishes a file we cannot
        // accept from storage that is not configured, and those are different problems.
        setError(json?.error ?? `We could not upload the file (${res.status}).`);
        return;
      }
      // The URL lands in the field the merchant can still see and edit. Uploading is a way
      // to fill this in, not a hidden second channel — and the value is not saved until
      // they submit the form, like every other field here.
      onValueChange(json.url);
    } catch {
      setError("We could not connect to the server. Check your connection. Then try again.");
    } finally {
      setBusy(false);
      // Cleared so choosing the SAME file again still fires a change event.
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  return (
    <Field name={name} label={label} help={help} error={error ?? undefined} className={className}>
      {/* An explicit id so `Field` does not clone one onto this wrapper — the label must
          point at the text input, not at the group. */}
      <div id={`${name}-group`} className="flex items-center gap-2">
        <Input
          id={name}
          name={name}
          type="url"
          value={value}
          onChange={(e) => onValueChange(e.target.value)}
          maxLength={2000}
          placeholder={placeholder}
        />
        {upload.uploadEnabled ? (
          <>
            {/* Hidden native file input driven by the styled Button: `verify:ui` bans a
                native select/checkbox/radio, and a file input has no primitive — this is
                the standard way to keep the visible control a Button. */}
            <input
              ref={fileRef}
              type="file"
              accept={accepts.join(",")}
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void store(file);
              }}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => fileRef.current?.click()}
            >
              <Upload className="size-3.5" aria-hidden />
              {busy ? "Uploading…" : "Upload"}
            </Button>
          </>
        ) : null}
      </div>
    </Field>
  );
}
