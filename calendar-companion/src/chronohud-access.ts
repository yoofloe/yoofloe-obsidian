
import type { CalendarTransferFile } from "./calendar-workspace-file";
import type { ChronoHudLookupSession } from "./chronohud-lookup-session";
import type { DiagnosticRun } from "./diagnostics";
import { replyFailure, verifiedReply, waitForReply, type BeginCompanionDiagnostics } from "./companion-diagnostics";
import {
  CHRONOHUD_MAX_RECORDS, CHRONOHUD_MAX_TEXT_BYTES, chronohudExcerptReference, chronohudSearchTerms,
  type ChronoHudArea, type ChronoHudDelivery, type ChronoHudQuery,
} from "./chronohud-protocol";

export interface ChronoHudSelection {
  areas: readonly ChronoHudArea[];
  terms: string;
}

function defaultSelection(): ChronoHudSelection {
  return { areas: ["dashboard"], terms: "" };
}

export class ChronoHudAccess {
  draft = defaultSelection();
  pending = false;
  busy = false;
  message = "";
  delivery: ChronoHudDelivery | null = null;
  includedIndices: ReadonlySet<number> = new Set();
  excerptsEnabled = false;
  private session: ChronoHudLookupSession | null = null;
  private selectionVersion = 0;
  private approvedVersion = -1;
  private diagnostic: DiagnosticRun | undefined;

  constructor(private readonly options: {
    current(): boolean; session(): ChronoHudLookupSession; vaultId(): Promise<string>; inboxHint(): string; changed(): void;
    diagnostics?: BeginCompanionDiagnostics;
  }) {}

  get requestId() { return this.pending ? this.session?.requestId ?? null : null; }

  updateDraft(patch: Partial<ChronoHudSelection>): void {
    if (this.pending || this.busy || !this.options.current()) return;
    this.draft = { ...this.draft, ...patch };
    this.selectionVersion++;
    this.excerptsEnabled = false;
    this.options.changed();
  }

  async open(): Promise<string | null> {
    if (this.pending || this.busy || !this.options.current() || !this.draft.areas.length) return null;
    const query: ChronoHudQuery = { areas: [...this.draft.areas], terms: chronohudSearchTerms(this.draft.terms),
      maxRecords: CHRONOHUD_MAX_RECORDS, maxTextBytes: CHRONOHUD_MAX_TEXT_BYTES };
    const diagnostic = this.diagnostic = this.options.diagnostics?.("lookup");
    diagnostic?.event("transfer_write", "started", { transport: "app_handoff" });
    this.busy = true;
    this.options.changed();
    try {
      await this.session?.dispose();
      this.delivery = null;
      this.includedIndices = new Set();
      this.excerptsEnabled = false;
      const vaultId = await this.options.vaultId();
      if (!this.options.current()) return null;
      const session = this.options.session();
      this.session = session;
      const url = await session.start({ query, vaultId, inboxHint: this.options.inboxHint() });
      if (!this.options.current() || this.session !== session) return null;
      this.pending = true;
      this.message = "";
      waitForReply(diagnostic);
      return url;
    } catch (error) {
      diagnostic?.event("transfer_write", "failed", { reason: "unknown", transport: "app_handoff" });
      diagnostic?.finish("failed", "review");
      this.message = error instanceof Error ? error.message : "ChronoHUD could not be opened.";
      return null;
    } finally {
      this.busy = false;
      this.options.changed();
    }
  }

  exportPending(): CalendarTransferFile | null {
    return this.pending ? this.session?.exportPending() ?? null : null;
  }

  async receive(id: string, imported?: CalendarTransferFile): Promise<void> {
    const session = this.session;
    if (!id || id !== this.requestId || !session || this.busy || !this.options.current()) return;
    const diagnostic = this.diagnostic;
    diagnostic?.event("reply_read", "started", { action: imported ? "manual_import" : undefined });
    this.busy = true;
    try {
      const delivery = await session.receive(id, imported);
      if (this.session !== session || !this.options.current()) return;
      this.delivery = delivery;
      this.approvedVersion = this.selectionVersion;
      this.pending = false;
      this.excerptsEnabled = false;
      this.includedIndices = new Set(delivery.records.map((_, i) => i));
      this.message = "";
      verifiedReply(diagnostic, { count: delivery.records.length });
      diagnostic?.event("approval", "ok", { evidence: "verified_reply" });
      diagnostic?.finish("completed", "none");
    } catch (error) {
      replyFailure(diagnostic, error);
      this.message = "No verified ChronoHUD reply yet. Finish approving the request in ChronoHUD.";
    } finally {
      this.busy = false;
      this.options.changed();
    }
  }

  setIncluded(index: number, included: boolean): void {
    if (!this.delivery?.records[index] || this.pending || this.busy || !this.options.current()) return;
    const selection = new Set(this.includedIndices);
    if (included) selection.add(index);
    else selection.delete(index);
    this.includedIndices = selection;
    this.excerptsEnabled = false;
    this.options.changed();
  }

  useExcerpts(enabled: boolean): void {
    if (!this.options.current() || this.pending || this.busy) return;
    try {
      if (enabled) {
        const delivery = this.currentDelivery();
        if (!delivery.records.some((_, index) => this.includedIndices.has(index))) throw Error("Select at least one ChronoHUD excerpt.");
      }
      this.excerptsEnabled = enabled;
    } catch (error) {
      this.excerptsEnabled = false;
      this.message = error instanceof Error ? error.message : "Find fresh ChronoHUD excerpts.";
    }
    this.options.changed();
  }

  private currentDelivery(): ChronoHudDelivery {
    if (!this.delivery || !this.session || this.pending || !this.options.current())
      throw Error("Check the current ChronoHUD lookup.");
    if (this.approvedVersion !== this.selectionVersion) throw Error("Look up the updated ChronoHUD scope first.");
    this.session.assertCanUse(this.delivery);
    return this.delivery;
  }

  modelContext(): Record<string, unknown> {
    const delivery = this.currentDelivery();
    const records = delivery.records.flatMap((record, index) => this.includedIndices.has(index) ?
      [{ reference: chronohudExcerptReference(index), area: record.area, title: record.title, text: record.text, date: record.date }] : []);
    const withheld = delivery.records.length - records.length;
    return {
      scope: { areas: delivery.query.areas, zone: delivery.context.zone, as_of: new Date(delivery.exportedAt).toISOString(),
        partial: delivery.context.partial || withheld > 0, selected_excerpts: records.length, withheld_excerpts: withheld },
      records,
      meaning: "ChronoHUD calculated the displayed metrics using its local time snapshot. Cite the H references when describing these excerpts.",
    };
  }

  selectionIdentity(): string | null {
    return this.delivery ? JSON.stringify([this.delivery.requestId, this.excerptsEnabled, [...this.includedIndices]]) : null;
  }

  async clear(resetSelection = false): Promise<void> {
    if (this.pending) this.diagnostic?.finish("stopped", "review", { action: "clear", reason: "user_action" });
    this.diagnostic = undefined;
    const session = this.session;
    this.session = null;
    this.pending = false;
    this.delivery = null;
    this.excerptsEnabled = false;
    this.includedIndices = new Set();
    this.message = "";
    if (resetSelection) this.draft = defaultSelection();
    await session?.dispose();
    this.options.changed();
  }

  dispose(): void { void this.clear().catch(() => {}); }
}
