"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Upload } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { removeAvatarAction } from "@/app/(dashboard)/account/actions";
import { initials } from "@/components/patterns/record-page";

/**
 * The profile photo: preview, Upload, Remove. Uploading stores and saves in one step — there is
 * nothing else on the photo to confirm. With no object storage the picker is not drawn.
 * A photo from the Google account has no Remove: we do not own it, and an upload replaces it.
 */
export function ProfilePhoto({
  avatarUrl,
  avatarSource,
  name,
  email,
  uploadEnabled,
  accepts,
}: {
  avatarUrl: string | null;
  avatarSource: "upload" | "google" | null;
  name: string | null;
  email: string;
  uploadEnabled: boolean;
  accepts: string[];
}) {
  const router = useRouter();
  const fileRef = React.useRef<HTMLInputElement>(null);
  const [busy, setBusy] = React.useState<"upload" | "remove" | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const uploaded = avatarSource === "upload";
  const formats = accepts.map((t) => t.replace("image/", "").toUpperCase()).join(", ");

  async function upload(file: File) {
    setBusy("upload");
    setError(null);
    try {
      const fd = new FormData();
      fd.set("file", file);
      const res = await fetch("/api/account/avatar", { method: "POST", body: fd });
      const json = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) {
        setError(json?.error ?? `The upload did not complete (${res.status}).`);
        return;
      }
      toast.success("Photo updated");
      router.refresh();
    } catch {
      setError("We could not connect to the server. Check your connection. Then try again.");
    } finally {
      setBusy(null);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function remove() {
    setBusy("remove");
    setError(null);
    const r = await removeAvatarAction();
    setBusy(null);
    if (!r.ok) return setError(r.message ?? "We could not remove your photo.");
    toast.success(r.message ?? "Photo removed");
    router.refresh();
  }

  return (
    <div className="flex items-center gap-4">
      <Avatar className="size-16">
        {avatarUrl ? <AvatarImage src={avatarUrl} alt="" /> : null}
        <AvatarFallback className="text-lg">
          {name ? initials(name) : (email[0] ?? "?").toUpperCase()}
        </AvatarFallback>
      </Avatar>
      <div className="flex min-w-0 flex-col gap-1.5">
        <p className="m-0 text-sm font-semibold">Profile photo</p>
        {uploadEnabled ? (
          <>
            <div className="flex flex-wrap gap-2">
              {/* Hidden native file input driven by a Button: a file input has no primitive. */}
              <input
                ref={fileRef}
                type="file"
                accept={accepts.join(",")}
                className="hidden"
                aria-label="Profile photo file"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void upload(file);
                }}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy !== null}
                onClick={() => fileRef.current?.click()}
              >
                <Upload className="size-3.5" aria-hidden />
                {busy === "upload" ? "Uploading…" : "Upload"}
              </Button>
              {uploaded ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={busy !== null}
                  onClick={() => void remove()}
                >
                  {busy === "remove" ? "Removing…" : "Remove"}
                </Button>
              ) : null}
            </div>
            <p className="m-0 text-xs text-muted-foreground">{formats} · max 5 MB</p>
          </>
        ) : (
          <>
            {/* No object storage on this deployment: nothing could store a new photo. */}
            <p className="m-0 text-xs text-muted-foreground">
              Photo uploads are not available on this deployment.
            </p>
            {uploaded ? (
              <div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={busy !== null}
                  onClick={() => void remove()}
                >
                  Remove
                </Button>
              </div>
            ) : null}
          </>
        )}
        {avatarSource === "google" ? (
          <p className="m-0 text-xs text-muted-foreground">
            This photo is from your Google account.
            {uploadEnabled ? " Upload a photo to replace it." : null}
          </p>
        ) : null}
        {error ? <p className="m-0 text-xs text-destructive">{error}</p> : null}
      </div>
    </div>
  );
}
