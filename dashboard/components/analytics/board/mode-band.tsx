"use client";

import * as React from "react";
import { LayoutGrid } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Arranging is a MODE, and this band is what makes it one: it says so, it says what the
 * controls do, and it holds the only two ways out. Nothing is written until Save layout.
 */
export function ModeBand({
  name,
  dirty,
  saving,
  extra,
  onSave,
  onDiscard,
}: {
  /** The board being arranged, so the band says which. */
  name: string;
  dirty: boolean;
  saving: boolean;
  /** Controls that stay reachable in the mode — adding a widget IS part of arranging. */
  extra?: React.ReactNode;
  onSave: () => void;
  onDiscard: () => void;
}) {
  const [confirming, setConfirming] = React.useState(false);

  return (
    <div className="sticky top-0 z-20 mb-5 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-primary/30 bg-primary/10 px-4 py-2.5">
      <LayoutGrid className="size-4 shrink-0 text-primary" aria-hidden="true" />
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-sm font-semibold text-primary">Editing layout · {name}</span>
        <span className="text-xs text-primary">
          {confirming
            ? "Discard these layout changes? They are not saved yet."
            : "Drag a tile by its handle, or focus a tile and use the arrow keys. To change the size of a tile, drag a side, bottom or corner handle."}
        </span>
      </div>
      <div className="ml-auto flex flex-wrap items-center gap-2">
        {confirming ? null : extra}
        {confirming ? (
          <>
            <Button
              variant="outline"
              size="sm"
              className="bg-card"
              onClick={() => setConfirming(false)}
            >
              Keep arranging
            </Button>
            <Button variant="destructive" size="sm" onClick={onDiscard}>
              Discard changes
            </Button>
          </>
        ) : (
          <>
            <Button
              variant="outline"
              size="sm"
              className="bg-card"
              disabled={saving}
              onClick={() => (dirty ? setConfirming(true) : onDiscard())}
            >
              Discard
            </Button>
            <Button size="sm" disabled={saving || !dirty} onClick={onSave}>
              {saving ? "Saving…" : "Save layout"}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
