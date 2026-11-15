export function renderCompanionStep(parent: HTMLElement, title: string, instruction: string): void {
  const step = parent.createDiv({ cls: "y-ai-companion-step" });
  step.createEl("strong", { text: title });
  step.createEl("p", { cls: "y-ai-hint", text: instruction });
}
