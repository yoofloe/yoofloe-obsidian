export interface ViewBounds { top: number; bottom: number; left: number; right: number }
/** Work in viewport CSS pixels, including partially overlapping host chrome. */
export function availableViewHeight(pane: ViewBounds, parentBottom: number, viewportBottom: number, overlays: ViewBounds[], gap = 8): number {
  let bottom = Math.min(parentBottom, viewportBottom);
  for (const overlay of overlays) {
    if (overlay.bottom > overlay.top && overlay.right > pane.left && overlay.left < pane.right && overlay.bottom > pane.top && overlay.top < bottom) bottom = Math.max(pane.top, overlay.top - gap);
  }
  return Math.max(0, bottom - pane.top);
}
