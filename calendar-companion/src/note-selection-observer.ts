interface SelectionSample<T> { key: string; value: T }

/**
 * Observe completed gestures on the note's text, including native mobile
 * selection handles, without depending on CodeMirror's internal DOM state.
 */
export function observeNoteSelection<T>(
  root: HTMLElement,
  sample: () => SelectionSample<T> | null,
  attach: (value: T, generation: number) => void,
  supersede: () => number,
): () => void {
  const doc = root.ownerDocument;
  const win = doc.defaultView;
  if (!win) return () => {};
  let pointer: { id: number; x: number; y: number } | null = null;
  let timer: number | null = null;
  let gestureEnded = false;
  let deliberate = false;
  let pendingSample: SelectionSample<T> | null = null;
  let pendingGeneration: number | null = null;
  let previousKey: string | null = null;

  const inText = (target: EventTarget | null) => {
    const node = target as Node | null;
    const element = node?.nodeType === 1 ? node as Element : node?.parentElement;
    return !!element && root.contains(element) &&
      !!element.closest(".cm-content, .markdown-preview-view") &&
      !element.closest(".metadata-container, .inline-title, button, input, textarea, select");
  };
  function cancelTimer() {
    if (timer !== null) win!.clearTimeout(timer);
    timer = null; gestureEnded = false; deliberate = false; pendingSample = null; pendingGeneration = null;
  }
  function queue(ended = false, fresh = false, observed?: SelectionSample<T>, generation?: number) {
    gestureEnded ||= ended; deliberate ||= fresh;
    if (observed) pendingSample = observed;
    if (generation !== undefined) pendingGeneration = generation;
    if (timer !== null) win!.clearTimeout(timer);
    timer = win!.setTimeout(() => {
      const completed = gestureEnded, intentional = deliberate;
      const fallback = pendingSample;
      const generation = pendingGeneration;
      cancelTimer();
      const selected = completed ? sample() ?? fallback : fallback;
      if (!selected) {
        if (completed) previousKey = null;
        return;
      }
      // The composer can move focus without changing the highlighted text.
      // Keep its explicit removal until a new selection gesture.
      if (!intentional && selected.key === previousKey) return;
      previousKey = selected.key;
      if (generation !== null) attach(selected.value, generation);
    }, gestureEnded ? 0 : 120);
  }
  const start = (event: PointerEvent) => {
    if (event.isPrimary === false || event.button !== 0 || !inText(event.target)) return;
    cancelTimer();
    pointer = { id: event.pointerId, x: event.clientX, y: event.clientY };
    supersede();
  };
  const end = (event: PointerEvent) => {
    if (pointer?.id !== event.pointerId) return;
    const moved = Math.abs(event.clientX - pointer.x) + Math.abs(event.clientY - pointer.y) >= 4;
    pointer = null;
    queue(true, event.type === "pointerup" && moved, undefined, supersede());
  };
  const changed = () => {
    if (pointer) return;
    const selection = doc.getSelection();
    if (!selection || selection.isCollapsed || !inText(selection.anchorNode) || !inText(selection.focusNode)) return;
    const selected = sample();
    if (!selected) return;
    if (!gestureEnded && selected.key === previousKey) {
      if (pendingSample && pendingSample.key !== selected.key) { cancelTimer(); supersede(); }
      return;
    }
    const generation = selected.key !== (pendingSample?.key ?? previousKey) ? supersede() : undefined;
    // Retain the selected range when mobile selection handles move and the
    // composer receives focus before the debounce expires.
    queue(false, false, selected, generation);
  };
  const keyboard = (event: KeyboardEvent) => {
    if (event.shiftKey && /^(Arrow(Up|Down|Left|Right)|Home|End|Page(Up|Down))$/.test(event.key) && inText(event.target)) {
      queue(true, true, undefined, supersede());
    }
  };

  root.addEventListener("pointerdown", start, true);
  doc.addEventListener("pointerup", end, true);
  doc.addEventListener("pointercancel", end, true);
  doc.addEventListener("selectionchange", changed);
  root.addEventListener("keyup", keyboard);
  return () => {
    cancelTimer();
    root.removeEventListener("pointerdown", start, true);
    doc.removeEventListener("pointerup", end, true);
    doc.removeEventListener("pointercancel", end, true);
    doc.removeEventListener("selectionchange", changed);
    root.removeEventListener("keyup", keyboard);
  };
}
