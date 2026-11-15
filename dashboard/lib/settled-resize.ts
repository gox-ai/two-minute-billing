/**
 * A ResizeObserver for work that redraws (a chart, a measured strip). While Billy's panel
 * moves or its edge is dragged, the page's width changes on every frame: the callback waits
 * and runs once when the page has settled, so the move stays on the compositor's clock.
 */
const BUSY = ["data-billy-moving", "data-billy-resizing"];

export function observeSettledResize(el: Element, cb: () => void): () => void {
  const html = document.documentElement;
  const busy = () => BUSY.some((a) => html.hasAttribute(a));
  let pending = false;
  const ro = new ResizeObserver(() => {
    if (busy()) pending = true;
    else cb();
  });
  ro.observe(el);
  const mo = new MutationObserver(() => {
    if (!pending || busy()) return;
    pending = false;
    cb();
  });
  mo.observe(html, { attributeFilter: BUSY });
  return () => {
    ro.disconnect();
    mo.disconnect();
  };
}
