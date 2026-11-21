import { type App, Modal, Notice } from "obsidian";
import type { Diagnostics } from "./diagnostics";

type DiagnosticSelection = { id?: string; conversation?: string; turn?: string };
const names = { assistant: "AI task", conversation_sync: "Conversation sync", calendar: "Yoofloe Calendar", chronohud: "ChronoHUD" };

export async function copyDiagnostics(app: App, diagnostics: Diagnostics, document: Document, selection: DiagnosticSelection): Promise<void> {
  const text = await diagnostics.copyReport(selection);
  if (!text) { new Notice("No diagnostic report is available for this selection on this device."); return; }
  try {
    await document.defaultView!.navigator.clipboard.writeText(text);
    new Notice("Diagnostics copied.");
  } catch {
    const modal = new Modal(app);
    modal.setTitle("Diagnostics");
    modal.contentEl.createEl("p", { text: "Select and copy the report." });
    const output = modal.contentEl.createEl("textarea", { attr: { "aria-label": "Diagnostic report", readonly: "", rows: "14" } });
    output.classList.add("y-ai-diagnostic-report");
    output.value = text;
    modal.open();
    output.focus();
    output.select();
  }
}

export class RecentIssuesModal extends Modal {
  private generation = 0;
  constructor(app: App, private readonly diagnostics: Diagnostics) { super(app); }

  async onOpen(): Promise<void> {
    const generation = ++this.generation;
    this.setTitle("Recent issues");
    this.contentEl.empty();
    const status = this.contentEl.createEl("p", { text: "Loading diagnostics…", attr: { role: "status" } });
    const { reports, storageUnconfirmed } = await this.diagnostics.recentIssues();
    if (this.generation !== generation) return;
    status.setText(storageUnconfirmed ? "Some device diagnostics could not be loaded." :
      reports.length ? "Diagnostic reports on this device from the last 7 days." : "No recent issues on this device.");
    for (const report of reports) {
      const row = this.contentEl.createDiv({ cls: "y-ai-diagnostic-row" });
      const label = row.createDiv();
      label.createEl("strong", { text: names[report.area] });
      const issue = report.lastFailure;
      label.createDiv({ text: [new Date(report.startedAt).toLocaleString(), issue?.stage.replaceAll("_", " "),
        issue?.reason?.replaceAll("_", " ") ?? report.outcome].filter(Boolean).join(" · ") });
      const copy = row.createEl("button", { text: "Copy diagnostics", attr: { type: "button" } });
      copy.addEventListener("click", () => void copyDiagnostics(this.app, this.diagnostics, row.ownerDocument, { id: report.id }));
    }
  }

  onClose(): void { this.generation++; this.contentEl.empty(); }
}
