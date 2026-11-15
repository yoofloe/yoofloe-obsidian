
import type { CalendarWorkspaceLookupSession } from "./calendar-workspace-lookup-session";
import type { CalendarWorkspacePanelSelection, CalendarWorkspaceSelectionPatch } from "./calendar-workspace-panel";
import { emptyWorkspaceFilters, validateWorkspaceQuery, workspaceKindAllowed, workspaceSearchTerms, type WorkspaceCapabilities, type WorkspaceLookupDelivery, type WorkspaceQuery } from "./calendar-workspace-query";
import { civilDate, validateQuestionQuery } from "./question-query";
import type { CalendarTransferFile } from "./calendar-workspace-file";

function defaultSelection(): CalendarWorkspacePanelSelection {
  return { topic: "", areas: ["calendar"], period: "next_7_days", from: null, through: null,
    kinds: ["event", "task"], includeLinkedNotes: false, filters: emptyWorkspaceFilters() };
}

export class CalendarWorkspaceAccess {
  selection = defaultSelection();
  capabilities: WorkspaceCapabilities | null = null;
  delivery: WorkspaceLookupDelivery | null = null;
  pending: "capabilities" | "records" | null = null;
  message = "";
  busy = false;
  excerptsEnabled = false;
  private session: CalendarWorkspaceLookupSession | null = null;
  private verified: WorkspaceLookupDelivery | null = null;
  private included: Set<number> | null = null;
  private selectionVersion = 0;
  private approvedVersion = -1;

  constructor(private readonly options: {
    session(): CalendarWorkspaceLookupSession; vaultId(): Promise<string>; inboxHint(): string;
    current(): boolean; changed(): void;
  }) {}

  get requestId() { return this.pending ? this.session?.requestId ?? null : null; }
  get datasetId(): string | null {
    try { return this.currentDelivery().datasetId; } catch { return null; }
  }
  get includedIndices(): ReadonlySet<number> | null { return this.included; }
  get canFind() { return !!this.capabilities && !!this.query(); }

  private query(): WorkspaceQuery | null {
    const { topic, areas, period, from, through, kinds, filters, includeLinkedNotes } = this.selection;
    if (!this.capabilities || !areas.length || period === "custom" && (!civilDate(from) || !civilDate(through) || from > through)) return null;
    try {
      const terms = workspaceSearchTerms(topic);
      const profile = filters.includeFinancials && areas.includes("project") ? "budget" : "summary";
      const lookup = validateQuestionQuery({
        areas, period, from: period === "custom" ? from : null, through: period === "custom" ? through : null,
        zone: Intl.DateTimeFormat().resolvedOptions().timeZone, terms, profile, includeLinkedNotes, maxRecords: 20, maxTextBytes: 32768,
      });
      const query: WorkspaceQuery = { mode: "records", lookup, kinds: [...kinds], filters };
      query.kinds = query.kinds.filter(kind => this.capabilities?.readKinds.includes(kind) && workspaceKindAllowed(query, kind));
      return validateWorkspaceQuery(query);
    } catch { return null; }
  }

  updateSelection(patch: CalendarWorkspaceSelectionPatch): void {
    if (this.pending || this.busy || !this.options.current()) return;
    this.selection = { ...this.selection, ...patch, filters: { ...this.selection.filters, ...patch.filters } };
    this.selectionVersion++;
    this.excerptsEnabled = false;
    this.options.changed();
  }

  setIncluded(index: number, included: boolean): void {
    if (this.pending || this.busy || !this.delivery?.records[index] || !this.options.current()) return;
    const set = new Set(this.included ?? this.delivery.records.map((_, i) => i));
    if (included) set.add(index); else set.delete(index);
    this.included = set; this.excerptsEnabled = false; this.options.changed();
  }

  async open(mode: "capabilities" | "records"): Promise<string | null> {
    if (!this.options.current() || this.busy || this.pending) return null;
    const query: WorkspaceQuery | null = mode === "capabilities" ?
      { mode, lookup: null, kinds: [], filters: emptyWorkspaceFilters() } : this.query();
    if (!query) return null;
    this.busy = true;
    this.options.changed();
    try {
      await this.session?.dispose();
      this.verified = null; this.delivery = null; this.excerptsEnabled = false; this.included = null;
      const vaultId = await this.options.vaultId();
      if (!this.options.current()) return null;
      const session = this.options.session();
      this.session = session;
      const url = await session.start({ query, vaultId, inboxHint: this.options.inboxHint() });
      if (!this.options.current() || this.session !== session) return null;
      this.pending = mode;
      this.message = "";
      return url;
    } catch (error) {
      this.message = error instanceof Error ? error.message : "Calendar could not be opened.";
      return null;
    } finally { this.busy = false; this.options.changed(); }
  }

  exportPending(): CalendarTransferFile | null { return this.pending ? this.session?.exportPending() ?? null : null; }

  async receive(id: string, imported?: CalendarTransferFile): Promise<void> {
    if (!id || id !== this.requestId || !this.session || this.busy || !this.options.current()) return;
    const session = this.session;
    this.busy = true;
    try {
      const reply = await session.receive(id, imported);
      if (this.session !== session || !this.options.current()) return;
      this.verified = reply; this.pending = null; this.capabilities = reply.capabilities;
      this.approvedVersion = this.selectionVersion;
      this.delivery = reply.query.mode === "records" ? reply : null;
      this.excerptsEnabled = false; this.included = null;
      this.message = "";
    } catch { this.message = "No verified Calendar reply yet. Finish reviewing in Calendar, then check again."; }
    finally { this.busy = false; this.options.changed(); }
  }

  useExcerpts(enabled: boolean): void {
    if (!this.options.current() || this.busy) return;
    try {
      this.excerptsEnabled = enabled && this.currentDelivery().query.mode === "records";
      if (this.excerptsEnabled && !this.modelDelivery().records.length) throw Error("Select at least one excerpt.");
    } catch (error) {
      this.excerptsEnabled = false;
      if (enabled) this.message = error instanceof Error ? error.message : "Find fresh Calendar records.";
    }
    this.options.changed();
  }

  currentDelivery(): WorkspaceLookupDelivery {
    if (!this.verified || !this.session || this.pending || !this.options.current()) throw Error("Check the Calendar connection first.");
    if (this.verified.query.mode === "records" && this.approvedVersion !== this.selectionVersion) throw Error("Look up records in the updated Calendar scope.");
    this.session.assertCanUse(this.verified);
    return this.verified;
  }

  modelDelivery(): WorkspaceLookupDelivery {
    const full = this.currentDelivery();
    const included = this.included;
    if (!included) return full;
    return {
      ...full, records: full.records.filter((_, i) => included.has(i)), approvedExcerptCount: full.records.length,
      excerptReferences: full.records.map((_, i) => "C" + (i + 1)).filter((_, i) => included.has(i)),
    };
  }
  selectionIdentity(): string | null {
    return this.verified ? JSON.stringify([this.verified.requestId, this.excerptsEnabled, [...this.included ?? []]]) : null;
  }

  async clear(resetSelection = false): Promise<void> {
    if (resetSelection) this.selection = defaultSelection();
    const session = this.session;
    this.session = null; this.pending = null; this.verified = null; this.delivery = null;
    this.capabilities = null; this.excerptsEnabled = false; this.included = null; this.message = "";
    await session?.dispose();
    this.options.changed();
  }

  dispose(): void { void this.clear().catch(() => {}); }
}
