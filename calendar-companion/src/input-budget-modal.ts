import { Modal, type App } from "obsidian";
import { budgetLabel, type InputBudget } from "./input-budget";

export class InputBudgetModal extends Modal {
  constructor(app: App, private readonly budget: InputBudget, private readonly usage: { input: number; output: number }) { super(app); }
  onOpen(): void {
    this.titleEl.setText("Input size");
    this.contentEl.createEl("p", { text: `Next message · ${budgetLabel(this.budget)}` });
    if (this.budget.inputLimit !== null)
      this.contentEl.createEl("p", { text: `Model input budget · ${this.budget.inputLimit.toLocaleString()} tokens, with output and reasoning space reserved.` });
    else this.contentEl.createEl("p", { text: "This custom model's context limit is not in the local catalog." });
    this.contentEl.createEl("p", { text: "The preview is estimated on this device. After you send, large requests, attachments and compacted context are checked with OpenAI before the next model response." });
    if (this.usage.input || this.usage.output)
      this.contentEl.createEl("p", { text: `Current task usage · ${this.usage.input.toLocaleString()} input and ${this.usage.output.toLocaleString()} output tokens across all completed requests.` });
    const close = this.contentEl.createEl("button", { text: "Close" });
    close.addEventListener("click", () => this.close());
  }
  onClose(): void { this.contentEl.empty(); }
}
