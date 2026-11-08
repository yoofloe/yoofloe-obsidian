/** Keep editable fields above overlaid mobile keyboards without reading their contents. */
export function keepModalInputsVisible(content: HTMLElement, current: () => boolean): () => void {
  const win = content.ownerDocument?.defaultView;
  if (!win) return () => {};
  const viewport = win.visualViewport, originalPadding = content.style.paddingBottom;
  let live = true, frame = 0, settle = 0;
  const reset = () => { content.style.paddingBottom = originalPadding; };
  const reveal = () => {
    if (!live || !current()) return;
    const input = content.ownerDocument.activeElement;
    if (!input || !content.contains(input) || !input.matches("input, textarea")) { reset(); return; }
    const height = viewport?.height || win.innerHeight;
    // Extra scroll room also covers hosts whose layout/visual viewport does not shrink with the IME.
    content.style.paddingBottom = `${Math.ceil(height)}px`;
    input.scrollIntoView({ behavior: "auto", block: "start", inline: "nearest" });
  };
  const schedule = () => {
    if (!live) return;
    win.cancelAnimationFrame(frame); win.clearTimeout(settle);
    frame = win.requestAnimationFrame(reveal);
    // One bounded follow-up accounts for the native keyboard opening animation.
    settle = win.setTimeout(reveal, 350);
  };
  content.addEventListener("focusin", schedule); content.addEventListener("focusout", schedule);
  win.addEventListener("resize", schedule); viewport?.addEventListener("resize", schedule);
  return () => {
    live = false; win.cancelAnimationFrame(frame); win.clearTimeout(settle);
    content.removeEventListener("focusin", schedule); content.removeEventListener("focusout", schedule);
    win.removeEventListener("resize", schedule); viewport?.removeEventListener("resize", schedule); reset();
  };
}
