import { Modal, Notice } from "obsidian";
import type { App } from "obsidian";

type ModalWindow = Window;

class YoofloeFocusModal extends Modal {
  private textareaEl!: HTMLTextAreaElement;
  private settled = false;

  constructor(
    app: App,
    private readonly titleText: string,
    private readonly onResolve: (value: string | null) => void
  ) {
    super(app);
  }

  onOpen() {
    const modalWindow = activeWindow as ModalWindow;
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("div", { cls: "yoofloe-focus-title", text: this.titleText });
    contentEl.createEl("p", {
      text: "Enter the theme, concern, or question you want the deep dive to focus on."
    });

    this.textareaEl = contentEl.createEl("textarea");
    this.textareaEl.addClass("yoofloe-focus-textarea");
    this.textareaEl.rows = 8;
    this.textareaEl.placeholder = "Example: focus on cash flow pressure, energy dips, and whether my schedule supports recovery.";

    const actions = contentEl.createDiv({ cls: "yoofloe-focus-actions" });
    const cancelButton = actions.createEl("button", { text: "Cancel" });
    const generateButton = actions.createEl("button", { text: "Generate" });
    generateButton.addClass("mod-cta");

    cancelButton.addEventListener("click", () => this.close());
    generateButton.addEventListener("click", () => {
      const value = this.textareaEl.value.trim();
      if (!value) {
        new Notice("Add a focus instruction before generating the deep dive.");
        this.textareaEl.focus();
        return;
      }

      this.settled = true;
      this.onResolve(value);
      this.close();
    });

    modalWindow.setTimeout(() => this.textareaEl.focus(), 0);
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
    if (!this.settled) {
      this.onResolve(null);
    }
  }
}

export function requestDeepDiveFocusInstruction(app: App) {
  return new Promise<string | null>((resolve) => {
    const modal = new YoofloeFocusModal(app, "Deep dive focus", resolve);
    modal.open();
  });
}
