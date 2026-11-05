/** [x, y, w, h] in source pixels. */
export type ShotCrop = [number, number, number, number];

/**
 * The page area of a 1920×1080 dashboard capture, without the sidebar, so marketing crops
 * start at the page's own top-left corner. Organization captures have a wider sidebar and a
 * test-mode banner above the page.
 */
export function dashboardCrop(src: string): ShotCrop {
  return /\/org-[\w-]+$/.test(src) ? [318, 40, 1602, 1040] : [280, 16, 1640, 1064];
}
