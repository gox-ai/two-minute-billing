"use client";

/**
 * The first focusable in the shell. Visible only on keyboard focus; it moves focus into
 * `<main>` (22 Tabs through the rail otherwise). `<main>` is not focusable by itself.
 */
export function SkipLink() {
  return (
    <a
      href="#main"
      className="fixed top-2 left-2 z-60 -translate-y-[200%] rounded-md bg-solid px-3 py-2 text-sm font-medium text-solid-foreground focus:translate-y-0"
      onClick={(e) => {
        const main = document.querySelector<HTMLElement>("main");
        if (!main) return;
        e.preventDefault();
        main.setAttribute("tabindex", "-1");
        main.focus({ preventScroll: true });
      }}
    >
      Skip to content
    </a>
  );
}
