"use client";

import * as React from "react";
import { LayoutGrid } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { ModeBand } from "@/components/analytics/board/mode-band";
import { BoardGrid, type BoardTile } from "@/components/analytics/board/board-grid";
import { sameUnits, type TileUnits } from "@/components/analytics/board/span";
import { PendingContent } from "@/components/navigation/nav-pending";

interface MutationResult {
  ok: boolean;
  error?: string;
}

/** What the operator has rearranged but not yet saved. */
interface Draft {
  /** The server state this draft was built on — it retires itself when that moves. */
  from: string;
  order: string[];
  units: Record<string, TileUnits>;
  removed: string[];
}

const signature = (tiles: BoardTile[]) =>
  tiles.map((t) => `${t.id}:${t.width_units}x${t.height_units}`).join(",");

/**
 * How an add tells the draft it is coming.
 *
 * Adding a widget cannot go into the draft: a tile has to exist server-side before it can
 * carry a figure, and a placeholder would be a made-up number. So the add commits, and the
 * draft REBASES onto the answer that comes back instead of retiring — otherwise arranging
 * would throw away every move made before the add.
 */
const RebaseContext = React.createContext<() => void>(() => {});

export function useDraftRebase(): () => void {
  return React.useContext(RebaseContext);
}

const ArrangingContext = React.createContext(false);

/** Whether the board is in its editing mode — for controls that live in both places. */
export function useArranging(): boolean {
  return React.useContext(ArrangingContext);
}

/**
 * The board, and the mode it can be in.
 *
 * At rest the page is the numbers. Arranging is entered deliberately, and every move made
 * inside it lands HERE, in a draft — the server sees nothing until Save layout, so Discard
 * really does restore. A draft is stamped with the server state it was built on, so it
 * retires itself when the revalidated props arrive rather than flashing back mid-round-trip.
 *
 * The page header belongs to the ROUTE, not here: this owns only the chrome the mode owns —
 * the tab strip and control row, the mode band, the draft, the footer. `tabs`, `controls`
 * and `download` step aside while arranging, because switching what you are looking at
 * mid-arrangement would throw the draft away. `addWidget` does NOT: adding a tile is part
 * of arranging.
 */
export function BoardSurface({
  biz,
  boardId,
  name,
  tiles,
  canEdit,
  tabs,
  controls,
  download,
  footer,
  addWidget,
  pendingSkeleton,
  onReorder,
  onRemove,
  onRetile,
}: {
  biz: string;
  boardId: string;
  name: string;
  tiles: BoardTile[];
  canEdit: boolean;
  /** The dashboard tab strip. */
  tabs?: React.ReactNode;
  /** Period and grain, on the left of the control row. */
  controls?: React.ReactNode;
  /** The whole-board download, first of the actions on the right. */
  download?: React.ReactNode;
  /** The footer's left half (the one-instant line). */
  footer?: React.ReactNode;
  addWidget?: React.ReactNode;
  /** Shown in place of the grid while a toolbar navigation is pending (see `PendingContent`). */
  pendingSkeleton?: React.ReactNode | Record<string, React.ReactNode>;
  onReorder: (tileIds: string[]) => Promise<MutationResult>;
  onRemove: (tile: string) => Promise<MutationResult>;
  onRetile: (tile: string, units: TileUnits) => Promise<MutationResult>;
}) {
  const [arranging, setArranging] = React.useState(false);
  const [raw, setDraft] = React.useState<Draft | null>(null);
  const [selected, setSelected] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // The draft is retired by the props catching up with it, not by an effect: once the
  // revalidated tiles arrive the signature it was built on no longer matches.
  const serverSignature = signature(tiles);
  const draft = raw && raw.from === serverSignature ? raw : null;

  // Before paint, so an add never flashes the server order past the arrangement in hand.
  const rebasing = React.useRef(false);
  React.useLayoutEffect(() => {
    if (!rebasing.current || !raw || raw.from === serverSignature) return;
    rebasing.current = false;
    const ids = tiles.map((t) => t.id);
    const kept = raw.order.filter((id) => ids.includes(id));
    setDraft({
      ...raw,
      from: serverSignature,
      order: [...kept, ...ids.filter((id) => !kept.includes(id))],
    });
  }, [raw, serverSignature, tiles]);

  const shown = React.useMemo(() => {
    if (!draft) return tiles;
    const by = new Map(tiles.map((t) => [t.id, t]));
    const out: BoardTile[] = [];
    const take = (t: BoardTile) => {
      if (!draft.removed.includes(t.id)) {
        const u = draft.units[t.id];
        out.push(u ? { ...t, width_units: u.width, height_units: u.height } : t);
      }
      by.delete(t.id);
    };
    for (const id of draft.order) {
      const t = by.get(id);
      if (t) take(t);
    }
    for (const t of [...by.values()]) take(t);
    return out;
  }, [draft, tiles]);

  const dirty = draft != null && signature(shown) !== serverSignature;

  // An unsaved arrangement must not vanish without a word.
  React.useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const base = (d: Draft | null): Draft =>
    d ?? { from: serverSignature, order: tiles.map((t) => t.id), units: {}, removed: [] };

  const draftReorder = (ids: string[]) => setDraft({ ...base(draft), order: ids });
  const draftResize = (id: string, units: TileUnits) => {
    const b = base(draft);
    setDraft({ ...b, units: { ...b.units, [id]: units } });
  };
  const draftRemove = (id: string) => {
    const b = base(draft);
    setDraft({ ...b, removed: [...b.removed, id] });
  };

  /**
   * A removal only ever lands in the draft: the X exists in editing mode alone, so there is
   * no path that commits one straight away. `onRemove` is still what Save replays the draft
   * through. Keeping an at-rest commit branch here would be a second way to delete a tile
   * that nothing can reach — and one that would bypass Discard.
   */
  const removeTile = async (id: string) => draftRemove(id);

  const noteRebase = React.useCallback(() => {
    rebasing.current = true;
  }, []);

  const discard = () => {
    rebasing.current = false;
    setDraft(null);
    setSelected(null);
    setError(null);
    setArranging(false);
  };

  const save = async () => {
    if (!draft) {
      setArranging(false);
      return;
    }
    rebasing.current = false;
    setSaving(true);
    setError(null);
    const before = new Map(tiles.map((t) => [t.id, t]));

    const fail = (res: MutationResult) => {
      setSaving(false);
      setError(res.error ?? "We could not save that change");
    };

    for (const id of draft.removed) {
      if (!before.has(id)) continue;
      const res = await onRemove(id);
      if (!res.ok) return fail(res);
    }
    for (const tile of shown) {
      const was = before.get(tile.id);
      const now = { width: tile.width_units, height: tile.height_units };
      if (was && !sameUnits({ width: was.width_units, height: was.height_units }, now)) {
        const res = await onRetile(tile.id, now);
        if (!res.ok) return fail(res);
      }
    }
    const ids = shown.map((t) => t.id);
    const kept = tiles.filter((t) => !draft.removed.includes(t.id)).map((t) => t.id);
    if (ids.join() !== kept.join()) {
      const res = await onReorder(ids);
      if (!res.ok) return fail(res);
    }

    setSaving(false);
    setSelected(null);
    setArranging(false);
  };

  const grid = (
    <BoardGrid
      biz={biz}
      tiles={shown}
      arranging={arranging}
      canEdit={canEdit}
      saving={saving}
      selected={selected}
      onSelect={setSelected}
      onReorder={draftReorder}
      onRemove={(id) => void removeTile(id)}
      onResize={draftResize}
    />
  );

  return (
    <RebaseContext.Provider value={noteRebase}>
      <ArrangingContext.Provider value={arranging}>
        {arranging ? (
          <ModeBand
            name={name}
            dirty={dirty}
            saving={saving}
            extra={canEdit ? <React.Fragment key="add">{addWidget}</React.Fragment> : null}
            onSave={() => void save()}
            onDiscard={discard}
          />
        ) : (
          <>
            <React.Fragment key="tabs">{tabs}</React.Fragment>
            <div className="mb-5 flex flex-wrap items-center gap-3">
              {/* A server-rendered element arriving as a prop is not marked as a keyed child,
                  so each is wrapped here rather than sitting bare in this list. */}
              <React.Fragment key="controls">{controls}</React.Fragment>
              <div className="ml-auto flex flex-wrap items-center gap-2">
                <React.Fragment key="download">{download}</React.Fragment>
                {canEdit && tiles.length > 0 ? (
                  <Button
                    variant="outline"
                    size="sm"
                    className="bg-card"
                    onClick={() => setArranging(true)}
                  >
                    <LayoutGrid className="size-3.5" />
                    Edit layout
                  </Button>
                ) : null}
                {canEdit ? <React.Fragment key="add">{addWidget}</React.Fragment> : null}
              </div>
            </div>
          </>
        )}

        {error ? (
          <Alert tone="error" className="mb-4">
            {error}
          </Alert>
        ) : null}

        {pendingSkeleton ? (
          <PendingContent skeleton={pendingSkeleton} current={boardId}>
            {grid}
          </PendingContent>
        ) : (
          grid
        )}

        {arranging ? (
          <p className="mt-4 text-xs text-muted-foreground">
            We do not save your changes until you save the layout. Tiles continue to show live
            figures while you arrange them.
          </p>
        ) : footer || shown.length > 0 ? (
          <div className="mt-4 flex flex-wrap justify-between gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span>{footer}</span>
            {shown.length > 0 ? (
              <span>
                {shown.length} {shown.length === 1 ? "widget" : "widgets"} · board{" "}
                <span className="font-mono">{boardId}</span>
              </span>
            ) : null}
          </div>
        ) : null}
      </ArrangingContext.Provider>
    </RebaseContext.Provider>
  );
}
