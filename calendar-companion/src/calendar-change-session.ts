import {
  assertLiveCalendarChange, calendarChangeLaunchUrl, createCalendarChangeRequest, MAX_CALENDAR_CHANGE_TRANSFER_BYTES,
  openCalendarChangeReply, readCalendarChangeDraft,
  type CalendarChangeAction, type CalendarChangeDraft, type CalendarChangeReply, type CalendarChangeRequest,
} from "./calendar-change";
import { INBOX } from "./protocol";
import type { TransferStore } from "./session";

interface PendingCalendarChange {
  readonly owner: string;
  readonly draft: CalendarChangeDraft;
  readonly request: CalendarChangeRequest;
  readonly marker: string;
}

/** A single vault-local change transfer. Constructing it does not read or write files. */
export class CalendarChangeSession {
  private pending: PendingCalendarChange | null = null;
  private busy = false;
  private live = true;

  constructor(private readonly options: {
    store: TransferStore; vaultName: () => string; allowed: () => boolean; now?: () => number;
    wait?: (milliseconds: number) => Promise<void>;
    canClean?: () => boolean;
  }) {}

  get requestId(): string | null { return this.pending?.request.requestId ?? null; }
  get expiresAt(): number | null { return this.pending?.request.expiresAt ?? null; }
  get isBusy(): boolean { return this.busy; }

  private now(): number { return (this.options.now ?? Date.now)(); }
  private owns(owner: string): boolean { return this.options.allowed() && owner === this.options.vaultName(); }
  private canClean(owner: string): boolean {
    return this.options.vaultName() === owner && (this.options.canClean ?? this.options.allowed)();
  }
  private guard(owner: string, pending?: PendingCalendarChange): void {
    if (!this.live || !this.owns(owner) || (pending && this.pending !== pending))
      throw Error("This vault session changed. Open Calendar from the active vault.");
    if (pending) assertLiveCalendarChange(pending.request, this.now());
  }
  private path(pending: PendingCalendarChange, reply: boolean): string {
    return `${INBOX}/${pending.request.requestId}.change.${reply ? "reply" : "request"}.json`;
  }

  /** Call from an explicit Android user action. Native review still controls all writes. */
  async start(draft: CalendarChangeDraft, options: {
    vaultId: string;
    inboxHint?: string;
    action?: CalendarChangeAction;
    datasetId?: string | null;
  }): Promise<string> {
    const owner = this.options.vaultName();
    this.guard(owner);
    if (this.busy || this.pending) throw Error("Finish checking the current Calendar change before opening another request.");
    this.busy = true;
    let transfer: PendingCalendarChange | null = null;
    let writing = false;
    try {
      const prepared = await readCalendarChangeDraft(draft);
      this.guard(owner);
      const request = await createCalendarChangeRequest(prepared, { ...options, vaultName: owner, now: this.now() });
      this.guard(owner);
      transfer = { owner, draft: prepared, request, marker: JSON.stringify(request) };
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
        return calendarChangeLaunchUrl(request, options.inboxHint);
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

  /** Treat a callback as a hint. Only an authenticated matching reply records an outcome. */
  async receive(requestId: string): Promise<CalendarChangeReply> {
    const transfer = this.pending;
    if (!transfer || this.busy || transfer.request.requestId !== requestId)
      throw Error("No matching pending Calendar change request.");
    this.guard(transfer.owner, transfer);
    this.busy = true;
    try {
      const store = this.options.store, path = this.path(transfer, true);
      const size = await store.size(path);
      this.guard(transfer.owner, transfer);
      if (size === null) throw Error("No Calendar reply yet. Finish reviewing in Calendar, then check again.");
      if (!Number.isSafeInteger(size) || size < 1 || size > MAX_CALENDAR_CHANGE_TRANSFER_BYTES)
        throw Error("This Calendar change reply is empty or too large.");
      const raw = await store.read(path);
      this.guard(transfer.owner, transfer);
      const reply = await openCalendarChangeReply(raw, transfer.request, transfer.draft, this.now());
      this.guard(transfer.owner, transfer);
      await this.release(transfer, raw);
      this.guard(transfer.owner);
      return reply;
    } finally {
      if (!this.live && this.pending === transfer) await this.release(transfer);
      this.busy = false;
    }
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

  private async release(transfer: PendingCalendarChange, authenticatedReply?: string): Promise<void> {
    if (this.pending === transfer) this.pending = null;
    const store = this.options.store;
    const removeExact = async (path: string, expected: string) => {
      if (!this.canClean(transfer.owner)) return;
      const size = await store.size(path);
      // Transfer file headers contain ASCII only, so byte size equals string length.
      if (size !== expected.length || size > MAX_CALENDAR_CHANGE_TRANSFER_BYTES || !this.canClean(transfer.owner)) return;
      if (await store.read(path) === expected && this.canClean(transfer.owner)) await store.remove(path);
    };
    try {
      await removeExact(this.path(transfer, false), transfer.marker).catch(() => {});
      if (authenticatedReply !== undefined) await removeExact(this.path(transfer, true), authenticatedReply).catch(() => {});
    } finally { transfer.request.key = ""; }
  }
}
