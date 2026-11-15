import { PRESS, pressDelay } from "@/lib/gestures";

/**
 * Press highlight for clickable table rows (`TableRow` with an `onClick` is
 * `data-pressable`) and `DataTable`'s phone rows (`list-row`). One set of document
 * listeners for every row:
 * - touch and pen light the row after a short delay, so a scroll or flick never flashes it;
 *   the browser's `pointercancel` (it took the gesture for a scroll) clears it unseen;
 * - a mouse lights it at once;
 * - a tap shorter than the delay still lights it briefly on release;
 * - moving past the slop (a text selection) or any scroll clears it.
 * The colour and the fade out are in globals.css (`[data-pressed]`).
 */

/** Inner controls answer the press themselves; the row stays dark. */
const INNER =
  "a, button, input, select, textarea, label, [role=button], [role=checkbox], [role=menuitem], [role=switch]";

let installed = false;

export function installRowPress() {
  if (installed || typeof document === "undefined") return;
  installed = true;

  let row: HTMLElement | null = null;
  let timer = 0;
  let shown = false;
  let x0 = 0;
  let y0 = 0;

  const light = () => {
    timer = 0;
    if (!row) return;
    shown = true;
    row.dataset.pressed = "";
  };
  const drop = (r: HTMLElement | null) => {
    if (r) delete r.dataset.pressed;
  };
  const cancel = () => {
    window.clearTimeout(timer);
    timer = 0;
    drop(row);
    row = null;
    shown = false;
  };

  document.addEventListener(
    "pointerdown",
    (e) => {
      cancel();
      if (!e.isPrimary || e.button !== 0) return;
      const target = e.target as Element | null;
      const r = target?.closest<HTMLElement>(
        '[data-slot="table-row"][data-pressable], [data-slot="list-row"][data-pressable]',
      );
      if (!r) return;
      const inner = target?.closest(INNER);
      if (inner && r.contains(inner)) return;
      row = r;
      x0 = e.clientX;
      y0 = e.clientY;
      const delay = pressDelay(e.pointerType);
      if (delay === 0) light();
      else timer = window.setTimeout(light, delay);
    },
    { capture: true, passive: true },
  );

  document.addEventListener(
    "pointermove",
    (e) => {
      if (row && Math.hypot(e.clientX - x0, e.clientY - y0) > PRESS.slop) cancel();
    },
    { capture: true, passive: true },
  );

  document.addEventListener(
    "pointerup",
    () => {
      const r = row;
      if (!r) return;
      if (shown) return cancel();
      // A quick tap: light it now, and let it fade after a beat.
      window.clearTimeout(timer);
      timer = 0;
      row = null;
      r.dataset.pressed = "";
      window.setTimeout(() => drop(r), PRESS.flashMs);
    },
    { capture: true, passive: true },
  );

  document.addEventListener("pointercancel", cancel, { capture: true, passive: true });
  document.addEventListener("scroll", cancel, { capture: true, passive: true });
  document.addEventListener("dragstart", cancel, { capture: true, passive: true });
  window.addEventListener("blur", cancel);
}
