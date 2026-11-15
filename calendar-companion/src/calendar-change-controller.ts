import { containsCredential } from "./agent-policy";
import { readCalendarChangeDraft, type CalendarChangeAction, type CalendarChangeDraft, type CalendarChangeReply } from "./calendar-change";
import type { CalendarChangeSession } from "./calendar-change-session";
import { assertId, shape } from "./protocol";

export type CalendarChangeStatus = CalendarChangeReply["status"] | "draft" | "waiting";
export interface CalendarChangeState {
  draft: CalendarChangeDraft;
  titles: Record<string, string>;
  status: CalendarChangeStatus;
  datasetId: string | null;
  applied: boolean;
}

const statuses: readonly CalendarChangeStatus[] = ["draft", "waiting", "applied", "cancelled", "conflict", "not_found", "undone", "rejected"];
const resultMessages: Record<CalendarChangeReply["status"], string> = {
  applied: "Calendar confirmed that the changes were applied.",
  cancelled: "Calendar cancelled this request.",
  conflict: "Calendar found a changed record or workspace. Review the current records there.",
  not_found: "Calendar did not find a matching saved result in the current workspace.",
  undone: "Calendar confirmed that the changes were undone.",
  rejected: "Calendar rejected this request. Review the proposal and the app's supported actions.",
};

/** Owns local proposal state. Android owns approval, writes and undo. */
export class CalendarChangeController {
  state: CalendarChangeState | null = null;
  enabled = false;
  busy = false;
  message = "";
  lastReply: CalendarChangeReply | null = null;
  private session: CalendarChangeSession | null = null;
  constructor(private readonly options: {
    session(): CalendarChangeSession;
    current(): boolean;
    vaultId(): Promise<string>;
    inboxHint(): string;
    save(): Promise<void>;
    changed(): void;
    draftingChanged(): void;
  }) {}

  get requestId() { return this.session?.requestId ?? null; }
  get canDraft() { return this.options.current() && !this.busy && !this.state; }

  async restore(saved: unknown): Promise<void> {
    this.enabled = false;
    this.message = "";
    this.lastReply = null;
    if (saved === null || saved === undefined) { this.state = null; return; }
    shape(saved, ["draft", "titles", "status", "datasetId", "applied"]);
    const draft = await readCalendarChangeDraft(saved.draft);
    const dataset = saved.datasetId;
    if (dataset !== null) assertId(dataset);
    if (!statuses.includes(saved.status as CalendarChangeStatus) || typeof saved.applied !== "boolean" ||
        draft.datasetId !== null && draft.datasetId !== dataset || saved.applied && !dataset ||
        saved.status === "applied" && !saved.applied || saved.status === "undone" && saved.applied)
      throw Error("The saved Calendar proposal could not be verified.");
    if (!saved.titles || typeof saved.titles !== "object" || Array.isArray(saved.titles))
      throw Error("The saved Calendar proposal titles could not be verified.");
    const raw = saved.titles as Record<string, unknown>;
    const titles: Record<string, string> = {};
    for (const operation of draft.operations) {
      const value = raw[operation.opId];
      if (typeof value === "string" && value.length <= 4096 && !containsCredential(value)) titles[operation.opId] = value;
    }
    this.state = { draft, titles, status: saved.status as CalendarChangeStatus, datasetId: dataset, applied: saved.applied };
    if (saved.status === "waiting") this.message = "Check the saved result in Calendar before submitting another proposal.";
  }

  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled || enabled && !this.canDraft) return;
    this.enabled = enabled;
    this.options.draftingChanged();
    this.options.changed();
  }

  async stage(draft: CalendarChangeDraft, titles: Record<string, string>, current: () => boolean): Promise<void> {
    if (!current() || !this.canDraft) throw Error("Finish or clear the current Calendar proposal first.");
    const state: CalendarChangeState = { draft, titles, status: "draft", datasetId: draft.datasetId, applied: false };
    this.state = state;
    this.enabled = false;
    try { await this.options.save(); }
    catch (error) {
      if (this.state === state) this.state = null;
      throw error;
    }
    if (current()) {
      this.message = "Proposal ready. Choose Review in Calendar to inspect and apply it there.";
      this.options.changed();
    }
  }

  canOpen(action: CalendarChangeAction): boolean {
    const state = this.state;
    if (!state || !this.options.current() || this.busy) return false;
    if (action === "review") return !this.requestId && !state.applied && (state.status === "draft" || state.status === "cancelled");
    if (action === "undo") return !this.requestId && state.applied && state.datasetId !== null && state.status !== "waiting";
    return state.status !== "draft";
  }

  async open(action: CalendarChangeAction): Promise<string | null> {
    const state = this.state;
    if (!state || !this.canOpen(action)) return null;
    const waiting: CalendarChangeState = { ...state, status: "waiting" };
    this.busy = true;
    this.options.changed();
    try {
      const vaultId = await this.options.vaultId();
      if (this.state !== state || !this.options.current()) return null;
      if (action === "status" && this.session) {
        await this.session.dispose();
        this.session = null;
      }
      if (!this.options.current()) return null;
      const session = this.session ??= this.options.session();
      // Preserve the proposal before starting a transfer so a missing reply can
      // always be reconciled via a new, read-only status request.
      this.state = waiting;
      await this.options.save();
      const url = await session.start(state.draft, {
        vaultId, inboxHint: this.options.inboxHint(), action,
        datasetId: action === "review" ? state.draft.datasetId : state.datasetId,
      });
      this.message = action === "review" ? "Review the proposal in the Calendar app." :
        action === "undo" ? "Confirm undo in the Calendar app." : "Check the saved result in the Calendar app.";
      return url;
    } catch (error) {
      // No link was returned. Keep the previous result and allow another explicit attempt.
      this.message = error instanceof Error ? error.message : "The Calendar connection could not be confirmed.";
      if (this.state === waiting && this.options.current() && !this.requestId) {
        this.state = state;
        try { await this.options.save(); }
        catch { this.message += " The previous local status could not be saved. Check status in Calendar after reopening."; }
      }
      return null;
    } finally { this.busy = false; this.options.changed(); }
  }

  async receive(requestId: string): Promise<boolean> {
    const state = this.state, session = this.session;
    if (!state || !session || requestId !== session.requestId || !this.options.current() || this.busy) return false;
    const action = session.action;
    this.busy = true;
    try {
      const reply = await session.receive(requestId);
      if (this.state !== state || !this.options.current()) return false;
      this.lastReply = reply;
      const confirmed = reply.status === "applied" || reply.status === "undone";
      const missingInKnownDataset = reply.status === "not_found" && state.datasetId !== null && state.datasetId === reply.datasetId && !state.applied;
      const unresolved = action === "status" && !confirmed && !missingInKnownDataset;
      const applied = reply.status === "applied" || state.applied && reply.status !== "undone";
      this.state = { ...state, status: unresolved ? "waiting" : missingInKnownDataset ? "draft" : reply.status, applied,
        datasetId: confirmed ? reply.datasetId : state.datasetId };
      this.message = unresolved ? "Calendar could not confirm the saved result in this workspace. Check the workspace where you reviewed this proposal." :
        missingInKnownDataset ? "Calendar found no saved result in this workspace. You can review the same proposal." : resultMessages[reply.status];
      try { await this.options.save(); }
      catch { this.message += " The local result could not be saved. Check status in Calendar again."; }
      return true;
    } catch (error) {
      this.message = error instanceof Error ? error.message : "No verified response yet. Check in Calendar and retry.";
      return false;
    } finally { this.busy = false; this.options.changed(); }
  }

  async disconnect(): Promise<void> {
    if (this.busy || !this.session) return;
    this.busy = true;
    try { await this.session.dispose(); this.session = null; }
    finally {
      this.busy = false;
      if (this.state?.status === "waiting") this.message = "Connection closed. Check the saved result in Calendar.";
      this.options.changed();
    }
  }

  async clear(): Promise<void> {
    if (!this.state || this.state.status === "waiting" || this.busy || this.requestId) return;
    const previous = this.state;
    this.state = null;
    try { await this.options.save(); this.lastReply = null; this.message = "Calendar proposal cleared from this conversation."; }
    catch { this.state = previous; this.message = "The proposal could not be cleared locally."; }
    finally { this.options.changed(); }
  }

  dispose(): void { void this.session?.dispose(); this.session = null; }
}
