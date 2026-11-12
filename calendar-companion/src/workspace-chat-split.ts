interface SplitElements {
  panel: HTMLElement;
  search: HTMLElement;
  messages: HTMLElement;
  dock: HTMLElement;
  divider: HTMLElement;
  settingsBar: HTMLElement;
}

const MIN_MESSAGES = 48;
const MIN_SETTINGS = 72;
const MIN_TRAVEL = 24;
const HEIGHT_PROP = "--y-ai-chat-height";
const MIN_PROP = "--y-ai-chat-min";
const MAX_PROP = "--y-ai-chat-max";

/** Keeps a vertical split independent of the conversation and its rerenders. */
export class WorkspaceChatSplit {
  private readonly events: AbortController;
  private readonly geometry: ResizeObserver;
  private parts: SplitElements | null = null;
  private bounds: { available: number; min: number; max: number } | null = null;
  private ratio: number | null;
  private drag: { id: number; startY: number; y: number; height: number; original: number | null } | null = null;
  private frame = 0;

  constructor(private readonly root: HTMLElement, private readonly win: Window & typeof globalThis, saved: unknown, private readonly save: (ratio: number | null) => void) {
    this.ratio = typeof saved === "number" && saved > 0 && saved < 1 ? saved : null;
    this.events = new win.AbortController();
    this.geometry = new win.ResizeObserver(() => this.refresh());
    const options = { signal: this.events.signal };
    root.addEventListener("pointerdown", this.onDown, options);
    root.addEventListener("pointermove", this.onMove, options);
    root.addEventListener("pointerup", this.onUp, options);
    root.addEventListener("pointercancel", this.onCancel, options);
    root.addEventListener("lostpointercapture", this.onCancel, options);
    root.addEventListener("keydown", this.onKey, options);
    root.addEventListener("dblclick", this.onReset, options);
  }

  /** Rebind the current controls, keeping pointer capture on the stable view root. */
  connect(parts: SplitElements): void {
    this.geometry.disconnect();
    this.parts = parts;
    for (const el of [parts.search, parts.dock, parts.settingsBar]) this.geometry.observe(el);
    this.refresh();
  }

  /** Refresh the limits after the viewport or the fixed controls change size. */
  refresh(): void {
    const p = this.parts;
    if (!p) return;
    this.bounds = null;
    const singlePane = ["y-ai-keyboard", "y-ai-compact", "y-ai-settings-expanded"].some(cls => this.root.classList.contains(cls));
    if (!singlePane && this.root.clientWidth > 0) {
      const dock = this.win.getComputedStyle(p.dock);
      const dividerHeight = parseFloat(this.win.getComputedStyle(p.divider).getPropertyValue("--y-ai-divider-size"));
      const panelTop = p.panel.getBoundingClientRect().top - this.root.getBoundingClientRect().top - this.root.clientTop + this.root.scrollTop;
      const available = Math.floor(this.root.clientHeight - panelTop - dividerHeight - p.settingsBar.getBoundingClientRect().height);
      const min = Math.ceil(p.search.getBoundingClientRect().height + p.dock.getBoundingClientRect().height + (parseFloat(dock.marginTop) || 0) + (parseFloat(dock.marginBottom) || 0) + MIN_MESSAGES);
      const max = available - MIN_SETTINGS;
      if (max - min >= MIN_TRAVEL) this.bounds = { available, min, max };
    }
    p.divider.hidden = !this.bounds;
    this.root.classList.toggle("y-ai-splittable", !!this.bounds);
    if (!this.bounds) { this.endDrag(false); return; }
    this.root.setCssProps({ [MIN_PROP]: `${this.bounds.min}px`, [MAX_PROP]: `${this.bounds.max}px` });
    p.divider.setAttribute("aria-valuemin", String(this.bounds.min));
    p.divider.setAttribute("aria-valuemax", String(this.bounds.max));
    this.apply();
  }

  private apply(): void {
    if (!this.parts || !this.bounds) return;
    const { messages, divider, panel } = this.parts, { available, min, max } = this.bounds;
    const follow = messages.scrollTop + messages.clientHeight >= messages.scrollHeight - 24;
    const requested = this.ratio === null ? null : Math.max(min, Math.min(max, Math.round(available * this.ratio)));
    if (requested === null) this.root.style.removeProperty(HEIGHT_PROP);
    else this.root.setCssProps({ [HEIGHT_PROP]: `${requested}px` });
    if (follow) messages.scrollTop = messages.scrollHeight;
    const height = requested ?? Math.round(panel.getBoundingClientRect().height);
    divider.setAttribute("aria-valuenow", String(height));
    divider.setAttribute("aria-valuetext", `${Math.round(100 * height / available)}% of space for conversation`);
  }

  private resizeTo(height: number): boolean {
    if (!this.bounds || !this.parts) return false;
    const { min, max, available } = this.bounds;
    const next = Math.max(min, Math.min(max, Math.round(height)));
    if (Math.abs(next - this.parts.panel.getBoundingClientRect().height) < 0.5) return false;
    this.ratio = next / available;
    this.apply();
    return true;
  }

  private onDown = (event: PointerEvent): void => {
    if (!this.parts || event.target !== this.parts.divider || !this.bounds || this.drag || !event.isPrimary || event.button !== 0) return;
    event.preventDefault();
    this.root.setPointerCapture(event.pointerId);
    this.drag = { id: event.pointerId, startY: event.clientY, y: event.clientY, height: this.parts.panel.getBoundingClientRect().height, original: this.ratio };
    this.root.classList.add("y-ai-split-dragging");
  };

  private onMove = (event: PointerEvent): void => {
    const drag = this.drag;
    if (!drag || event.pointerId !== drag.id) return;
    drag.y = event.clientY;
    if (!this.frame) this.frame = this.win.requestAnimationFrame(() => {
      this.frame = 0;
      if (this.drag === drag) this.resizeTo(drag.height + drag.y - drag.startY);
    });
  };

  private onUp = (event: PointerEvent): void => {
    const drag = this.drag;
    if (!drag || event.pointerId !== drag.id) return;
    this.resizeTo(drag.height + event.clientY - drag.startY);
    this.endDrag(true);
  };

  private onCancel = (event: PointerEvent): void => { if (this.drag?.id === event.pointerId) this.endDrag(false); };

  private endDrag(commit: boolean): void {
    const drag = this.drag;
    if (!drag) return;
    this.drag = null;
    this.win.cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.root.classList.remove("y-ai-split-dragging");
    if (this.root.hasPointerCapture(drag.id)) this.root.releasePointerCapture(drag.id);
    if (commit) { if (this.ratio !== drag.original) this.save(this.ratio); }
    else { this.ratio = drag.original; this.apply(); }
  }

  private onKey = (event: KeyboardEvent): void => {
    if (!this.parts || !this.bounds || event.target !== this.parts.divider || this.drag || event.altKey || event.ctrlKey || event.metaKey) return;
    const height = this.parts.panel.getBoundingClientRect().height;
    switch (event.key) {
      case "ArrowUp": if (this.resizeTo(height - 24)) this.save(this.ratio); break;
      case "ArrowDown": if (this.resizeTo(height + 24)) this.save(this.ratio); break;
      case "Home": if (this.resizeTo(this.bounds.min)) this.save(this.ratio); break;
      case "End": if (this.resizeTo(this.bounds.max)) this.save(this.ratio); break;
      case "Enter": this.reset(); break;
      default: return;
    }
    event.preventDefault();
    event.stopPropagation();
  };

  private onReset = (event: MouseEvent): void => {
    const divider = this.parts?.divider;
    if (!this.bounds || !divider) return;
    // Pointer capture can retarget a click to the root.
    if (event.target === divider || event.target === this.root && this.root.ownerDocument.elementFromPoint(event.clientX, event.clientY) === divider) this.reset();
  };

  private reset(): void {
    if (this.drag || this.ratio === null) return;
    this.ratio = null;
    this.apply();
    this.save(null);
  }

  /** Release the gesture and observers before the view is detached. */
  dispose(): void {
    this.bounds = null;
    this.endDrag(false);
    this.events.abort();
    this.geometry.disconnect();
    this.root.classList.remove("y-ai-splittable");
    for (const prop of [HEIGHT_PROP, MIN_PROP, MAX_PROP]) this.root.style.removeProperty(prop);
    this.parts = null;
  }
}
