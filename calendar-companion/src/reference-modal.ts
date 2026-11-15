import { Modal, setIcon, type App } from "obsidian";
import type { AiWorkspace } from "./workspace";
import { selectionLabel, type ReferenceSnapshot, type SelectionReference } from "./selection-reference";
import { selectionImages } from "./selection-image";
import { MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES } from "./attachments";

/** This preview reads local text. Provider work starts from the composer. */
export class ReferenceModal extends Modal {
  private alive = true;
  private imageUrls: string[] = [];
  constructor(app: App, private readonly work: AiWorkspace, private readonly reference: SelectionReference, private readonly followUp = false, private readonly snapshot?: ReferenceSnapshot) { super(app); }
  onOpen(): void {
    this.titleEl.setText("Reference");
    this.contentEl.addClass("y-ai-reference-preview");
    this.contentEl.createEl("p", { text: selectionLabel(this.reference), cls: "y-ai-reference-label" });
    const state = this.contentEl.createEl("p", { text: "Loading reference…", cls: "y-ai-hint", attr: { role: "status" } });
    const text = this.contentEl.createEl("pre", { cls: "y-ai-reference-text", attr: { tabindex: "0", "aria-label": "Reference text" } });
    const actions = this.contentEl.createDiv({ cls: "y-ai-reference-actions" });
    const gallery = this.contentEl.createDiv({ cls: "y-ai-reference-images" });
    const open = actions.createEl("button", { text: "Open note" });
    open.addEventListener("click", () => { this.close(); void this.app.workspace.openLinkText(this.reference.path, ""); });
    if (this.snapshot) {
      text.setText(this.snapshot.text);
      state.setText(this.snapshot.partial ? "Saved preview of the opening passage." : "Saved reference from this message.");
      const close = actions.createEl("button", { text: "Close" });
      close.addEventListener("click", () => this.close());
      return;
    }
    const whole = actions.createEl("button", { text: "Use whole note" });
    whole.disabled = !this.work.canChangeReference || this.reference.wholeNote === true;
    whole.addEventListener("click", () => {
      whole.disabled = true;
      void this.work.useWholeNoteReference(this.reference).then(changed => { if (changed) this.close(); })
        .catch(error => { if (this.alive) state.setText(error instanceof Error ? error.message : "The reference could not be updated."); })
        .finally(() => { whole.disabled = !this.work.canChangeReference; });
    });
    if (this.work.reference?.id !== this.reference.id) {
      const use = actions.createEl("button", { text: "Use reference" });
      use.disabled = !this.work.canChangeReference;
      use.addEventListener("click", () => { if (this.work.setReference(this.reference)) this.close(); });
    }
    const createImage = actions.createEl("button", { text: "Create image" });
    createImage.disabled = this.work.reference?.id !== this.reference.id || this.reference.needsReview === true || !this.work.canChangeReference;
    createImage.addEventListener("click", () => {
      createImage.disabled = true;
      const current = () => this.alive && this.work.current && this.work.reference?.id === this.reference.id;
      state.setText("Preparing image preview on this device…");
      void this.work.readReference(this.reference).then(async value => {
        const available = MAX_ATTACHMENTS - (this.followUp ? this.work.followUpAttachments : this.work.attachments).length;
        const files = await selectionImages(this.app, this.contentEl, value, this.reference.path, current, available);
        if (!current()) return;
        for (const url of this.imageUrls) URL.revokeObjectURL(url);
        this.imageUrls = []; gallery.empty();
        for (const [index, file] of files.entries()) {
          const url = URL.createObjectURL(file); this.imageUrls.push(url);
          gallery.createEl("img", { attr: { src: url, alt: `Reference image page ${index + 1}` } });
        }
        state.setText(`${files.length} image ${files.length === 1 ? "page" : "pages"}. Review the preview, then attach. Images use additional input tokens.`);
        const attach = gallery.createEl("button", { text: files.length === 1 ? "Attach image" : "Attach images", cls: "mod-cta" });
        attach.addEventListener("click", () => {
          if (!current()) return;
          const existing = this.followUp ? this.work.followUpAttachments : this.work.attachments;
          if (existing.length + files.length > MAX_ATTACHMENTS ||
              [...existing, ...files].reduce((total, file) => total + ("size" in file ? file.size : file.bytes), 0) > MAX_ATTACHMENT_BYTES) {
            state.setText("These pages exceed the attachment limit. Remove an attachment or choose a smaller passage.");
            return;
          }
          attach.disabled = true;
          void this.work.addAttachments(files, undefined, this.reference.id, this.followUp).then(() => {
            const attached = this.followUp ? this.work.followUpAttachments : this.work.attachments;
            if (current() && files.every(page => attached.some(file => file.referenceId === this.reference.id && file.name === page.name))) this.close();
            else if (this.alive) { state.setText(this.work.message); attach.disabled = false; }
          });
        });
      }).catch(error => { if (this.alive) state.setText(error instanceof Error ? error.message : "The image could not be prepared."); })
        .finally(() => { createImage.disabled = !current(); });
    });
    const close = actions.createEl("button", { attr: { "aria-label": "Close reference preview" }, cls: "clickable-icon" });
    setIcon(close, "x"); close.addEventListener("click", () => this.close());
    void this.work.readReference(this.reference).then(value => {
      if (!this.alive) return;
      text.setText(value);
      state.setText(`${value.length.toLocaleString()} characters · Reference material. Access settings control permitted edits.`);
    }).catch(error => { if (this.alive) state.setText(error instanceof Error ? error.message : "This reference is unavailable. Select it again in the note."); });
  }
  onClose(): void {
    this.alive = false;
    for (const url of this.imageUrls) URL.revokeObjectURL(url);
    this.imageUrls = []; this.contentEl.empty();
  }
}
