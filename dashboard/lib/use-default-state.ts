"use client";

import * as React from "react";

/**
 * Uncontrolled form state that RE-SEEDS when the server sends a different default.
 *
 * ── The bug this exists to kill ────────────────────────────────────────────────
 * Every styled control in this app is uncontrolled in a server-action form: the
 * caller passes `defaultValue` / `defaultChecked` from server data, the component
 * keeps the live value in state, and a hidden input posts it. All nine of them
 * seeded that state with a bare `useState(defaultValue)` — which runs ONCE, on
 * mount.
 *
 * `ActionForm` calls `router.refresh()` after a successful save, so the server
 * component re-renders with the newly-saved data and hands the control a NEW
 * `defaultValue`. The control ignored it and kept showing the old one. Two
 * consequences, and the second is the serious one:
 *
 *   1. cosmetic — the form shows pre-save values after saving.
 *   2. WRONG DATA — the hidden input still carries the stale value, so the next
 *      submit posts it back and silently reverts whatever else changed the row.
 *
 * Native controls are build failures here (`pnpm verify:ui`), so this was every
 * select, combobox, checkbox, radio, switch, money, datetime and timezone field
 * in the dashboard.
 *
 * ── Why this shape ─────────────────────────────────────────────────────────────
 * React's documented "adjusting state when a prop changes": compare against the
 * previously-seen prop DURING render and reset there. No effect, so there is no
 * flash of the old value and no extra commit — React re-runs this component
 * before touching the DOM.
 *
 * It re-seeds only when the incoming default ACTUALLY changes, which is what
 * makes it safe: a refresh triggered by some other form on the page leaves an
 * edit in progress alone, because that control's default did not move.
 *
 * @param incoming the default from server data, already mapped to the shape the
 *   control stores (`!!defaultChecked`, `String(major)`, `toLocalValue(iso)`, …)
 * @param compareBy for a default that is a fresh array/object every render, the
 *   primitive to compare instead of identity. Without it such a default looks
 *   different on every render and would clobber the user's edit on each one.
 */
export function useDefaultState<T>(
  incoming: T,
  compareBy: (value: T) => unknown = (value) => value,
): [T, React.Dispatch<React.SetStateAction<T>>] {
  const [value, setValue] = React.useState(incoming);
  const [seen, setSeen] = React.useState(() => compareBy(incoming));

  const token = compareBy(incoming);
  if (!Object.is(token, seen)) {
    setSeen(token);
    setValue(incoming);
  }

  return [value, setValue];
}

/**
 * Re-assert a control's value after React resets its form.
 *
 * ── The reported bug, and it is not what it looks like ─────────────────────────
 * "When I hit save, sometimes I see old data." The save works; the server even
 * renders the new value. Then the control puts the OLD one back.
 *
 * **React 19 automatically resets a `<form>` once its action completes**
 * (`recursivelyResetForms` in react-dom). A Radix control answers that `reset`
 * event by restoring the value it had when it MOUNTED — the pre-save one — and
 * tells us through `onCheckedChange` / `onValueChange`, so our own state follows
 * it backwards. Caught from the stack:
 *
 *     at HTMLFormElement.reset       (radix)
 *     at recursivelyResetForms       (react-dom)
 *
 * `useDefaultState` cannot save us here: by then the incoming prop ALREADY holds
 * the saved value, so nothing has "changed" and there is nothing to re-sync from.
 * The state is simply dragged away from a prop that never moved.
 *
 * "Sometimes" is the reset racing the re-render: land it before the new props and
 * the mismatch is invisible, land it after and the value visibly reverts.
 *
 * So: listen for the same event and re-apply the current default. A microtask,
 * not a direct call, because Radix's own listener runs off this event too and we
 * must land AFTER it rather than race it.
 *
 * Returns `isResetting()`: true while that reset event is being dispatched. Radix
 * reports its restore synchronously from inside it, so a change handler that checks
 * this can drop the restore — which is the only fix for a CONTROLLED control, whose
 * parent state would otherwise be dragged back to the mount-time value.
 */
export function useFormResetSync(
  ref: React.RefObject<HTMLElement | null>,
  reapply: () => void,
): () => boolean {
  // Kept in a ref so the listener below is registered once per form rather than
  // re-subscribed on every render, without going stale.
  const latest = React.useRef(reapply);
  React.useEffect(() => {
    latest.current = reapply;
  });
  const resetting = React.useRef(false);

  React.useEffect(() => {
    const form = ref.current?.closest("form");
    if (!form) return;
    // Capture phase: at the target, capture listeners run before Radix's bubble one.
    const onResetStart = () => {
      resetting.current = true;
    };
    const onReset = () =>
      queueMicrotask(() => {
        resetting.current = false;
        latest.current();
      });
    form.addEventListener("reset", onResetStart, true);
    form.addEventListener("reset", onReset);
    return () => {
      form.removeEventListener("reset", onResetStart, true);
      form.removeEventListener("reset", onReset);
    };
  }, [ref]);

  return React.useCallback(() => resetting.current, []);
}
