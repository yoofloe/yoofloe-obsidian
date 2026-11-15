import {
  assertLiveCalendarWorkspaceChange, calendarWorkspaceChangeLaunchUrl, prepareCalendarWorkspaceChangeRequest, MAX_CALENDAR_WORKSPACE_CHANGE_TRANSFER_BYTES,
  openCalendarWorkspaceChangeReply,
  type CalendarWorkspaceChangeAction, type CalendarWorkspaceChangeDraft, type CalendarWorkspaceChangeReply, type CalendarWorkspaceChangeRequest, type CalendarWorkspaceChangeValidator,
} from "./calendar-workspace-change";
import { INBOX } from "./protocol";
import type { TransferStore } from "./session";

export interface CalendarWorkspaceTransferFile {
  readonly name: string;
  readonly contents: string;
}

interface VaultOwner { readonly name: string; readonly identity: object | string }

interface PendingCalendarWorkspaceChange {
  readonly owner: VaultOwner;
  readonly draft: CalendarWorkspaceChangeDraft;
  readonly request: CalendarWorkspaceChangeRequest;
  readonly marker: string;
}

/** A single vault-local change transfer. Constructing it does not read or write files. */
export class CalendarWorkspaceChangeSession {
  private pending: PendingCalendarWorkspaceChange | null = null;
  private busy = false;
  private live = true;

  constructor(private readonly options: {
    store: TransferStore; vaultName: () => string; allowed: () => boolean; now?: () => number;
    validate: CalendarWorkspaceChangeValidator; wait?: (milliseconds: number) => Promise<void>;
    canClean?: () => boolean; vaultIdentity?: () => object | string;
  }) {}

  get requestId(): string | null { return this.pending?.request.requestId ?? null; }
  get action(): CalendarWorkspaceChangeAction | null { return this.pending?.request.action ?? null; }
  get expiresAt(): number | null { return this.pending?.request.expiresAt ?? null; }
  get isBusy(): boolean { return this.busy; }

  private now(): number { return (this.options.now ?? Date.now)(); }
  private owner(): VaultOwner {
    const name = this.options.vaultName();
    return { name, identity: this.options.vaultIdentity?.() ?? name };
  }
  private sameVault(owner: VaultOwner): boolean {
    const active = this.owner();
    return owner.name === active.name && owner.identity === active.identity;
  }
  private owns(owner: VaultOwner): boolean { return this.options.allowed() && this.sameVault(owner); }
  private canClean(owner: VaultOwner): boolean {
    return this.sameVault(owner) && (this.options.canClean ?? this.options.allowed)();
  }
  private guard(owner: VaultOwner, pending?: PendingCalendarWorkspaceChange): void {
    if (!this.live || !this.owns(owner) || (pending && this.pending !== pending))
      throw Error("This vault session changed. Open Calendar from the active vault.");
    if (pending) assertLiveCalendarWorkspaceChange(pending.request, this.now());
  }
  private filename(pending: PendingCalendarWorkspaceChange, reply: boolean): string {
    return `${pending.request.requestId}.change.${reply ? "reply" : "request"}.json`;
  }
  private path(pending: PendingCalendarWorkspaceChange, reply: boolean): string {
    return `${INBOX}/${this.filename(pending, reply)}`;
  }

  /** Start from an explicit app launch or file-transfer action. Calendar reviews every write. */
  async start(draft: CalendarWorkspaceChangeDraft, options: {
    vaultId: string;
    inboxHint?: string;
    action?: CalendarWorkspaceChangeAction;
    datasetId?: string | null;
  }): Promise<string> {
    const owner = this.owner();
    this.guard(owner);
    if (this.busy || this.pending) throw Error("Finish checking the current Calendar change before opening another request.");
    this.busy = true;
    let transfer: PendingCalendarWorkspaceChange | null = null;
    let writing = false;
    try {
      const prepared = await prepareCalendarWorkspaceChangeRequest(draft, {
        ...options, vaultName: owner.name, now: this.now(),
      }, this.options.validate);
      this.guard(owner);
      const { request } = prepared;
      transfer = { owner, draft: prepared.draft, request, marker: JSON.stringify(request) };
      this.pending = transfer;
      const store = this.options.store, path = this.path(transfer, false);
      if (!await store.exists(INBOX)) {
        this.guard(owner, transfer);
        await store.mkdir(INBOX);
      }
      this.guard(owner, transfer);
      if (await store.exists(path) || await store.exists(this.path(transfer, true)))
        throw Error("The Calendar transfer path is already in use.");
      this.guard(owner, transfer);
      writing = true;
      await store.write(path, transfer.marker);
      // The Android vault adapter can report stale metadata just after a write.
      // Check the same file again without rewriting it or issuing another request.
      const wait = this.options.wait ?? (milliseconds => new Promise<void>(resolve => window.setTimeout(resolve, milliseconds)));
      for (const delay of [0, 50, 150, 300]) {
        if (delay) await wait(delay);
        this.guard(owner, transfer);
        if (await store.size(path) !== transfer.marker.length) continue;
        this.guard(owner, transfer);
        if (await store.read(path) !== transfer.marker) continue;
        this.guard(owner, transfer);
        return calendarWorkspaceChangeLaunchUrl(request, options.inboxHint);
      }
      throw Error("The Calendar change marker could not be verified.");
    } catch (error) {
      if (transfer) {
        if (writing) await this.release(transfer);
        else {
          this.pending = null;
          transfer.request.key = "";
        }
      }
      throw error;
    } finally { this.busy = false; }
  }

  /** Export only the verified marker for the current vault's live request. */
  exportPending(): CalendarWorkspaceTransferFile | null {
    const transfer = this.pending;
    if (!transfer || this.busy) return null;
    try {
      this.guard(transfer.owner, transfer);
      return { name: this.filename(transfer, false), contents: transfer.marker };
    } catch { return null; }
  }

  /** Callback and manually selected replies must both authenticate against the active request. */
  async receive(requestId: string, imported?: CalendarWorkspaceTransferFile): Promise<CalendarWorkspaceChangeReply> {
    const transfer = this.pending;
    if (!transfer || this.busy || transfer.request.requestId !== requestId)
      throw Error("No matching pending Calendar change request.");
    this.guard(transfer.owner, transfer);
    this.busy = true;
    try {
      const raw = imported === undefined ? await this.readLocalReply(transfer) : this.readImportedReply(transfer, imported);
      this.guard(transfer.owner, transfer);
      const reply = await openCalendarWorkspaceChangeReply(raw, transfer.request, transfer.draft, this.now());
      this.guard(transfer.owner, transfer);
      await this.release(transfer, imported === undefined ? raw : undefined);
      this.guard(transfer.owner);
      return reply;
    } finally {
      if (!this.live && this.pending === transfer) await this.release(transfer);
      this.busy = false;
    }
  }

  private async readLocalReply(transfer: PendingCalendarWorkspaceChange): Promise<string> {
    const store = this.options.store, path = this.path(transfer, true);
    const size = await store.size(path);
    this.guard(transfer.owner, transfer);
    if (size === null) throw Error("No Calendar reply yet. Finish reviewing in Calendar, then check again.");
    if (!Number.isSafeInteger(size) || size < 1 || size > MAX_CALENDAR_WORKSPACE_CHANGE_TRANSFER_BYTES)
      throw Error("This Calendar change reply is empty or too large.");
    return await store.read(path);
  }

  private readImportedReply(transfer: PendingCalendarWorkspaceChange, imported: CalendarWorkspaceTransferFile): string {
    if (imported?.name !== this.filename(transfer, true)) throw Error("Choose the reply file for this Calendar change.");
    const { contents } = imported;
    if (typeof contents !== "string" || contents.length < 1 || contents.length > MAX_CALENDAR_WORKSPACE_CHANGE_TRANSFER_BYTES)
      throw Error("This Calendar change reply is empty or too large.");
    return contents;
  }

  /** End the local transport. A change may already be applied in Calendar; check its status. */
  async cancel(): Promise<void> {
    if (this.busy) throw Error("Wait for the current Calendar check to finish.");
    const transfer = this.pending;
    if (!transfer) return;
    this.busy = true;
    try { await this.release(transfer); }
    finally { this.busy = false; }
  }

  async dispose(): Promise<void> {
    this.live = false;
    if (!this.busy) await this.cancel();
  }

  private async release(transfer: PendingCalendarWorkspaceChange, authenticatedReply?: string): Promise<void> {
    if (this.pending === transfer) this.pending = null;
    const store = this.options.store;
    const removeExact = async (path: string, expected: string) => {
      if (!this.canClean(transfer.owner)) return;
      const size = await store.size(path);
      // Transfer file headers contain ASCII only, so byte size equals string length.
      if (size !== expected.length || size > MAX_CALENDAR_WORKSPACE_CHANGE_TRANSFER_BYTES || !this.canClean(transfer.owner)) return;
      if (await store.read(path) === expected && this.canClean(transfer.owner)) await store.remove(path);
    };
    try {
      await removeExact(this.path(transfer, false), transfer.marker).catch(() => {});
      if (authenticatedReply !== undefined) await removeExact(this.path(transfer, true), authenticatedReply).catch(() => {});
    } finally { transfer.request.key = ""; }
  }
}