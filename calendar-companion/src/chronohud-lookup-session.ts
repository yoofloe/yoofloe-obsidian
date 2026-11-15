import {
  assertChronoHudRequestLive, CHRONOHUD_INBOX, CHRONOHUD_REPLY_BYTES, chronohudLaunchUrl,
  createChronoHudRequest, openChronoHudReply,
  type ChronoHudDelivery, type ChronoHudQuery, type ChronoHudRequest,
} from "./chronohud-protocol";
import type { TransferStore } from "./session";

interface VaultOwner {
  readonly name: string;
  readonly identity: object | string;
}
interface TransferFile {
  readonly name: string;
  readonly contents: string;
}
interface LookupTransfer {
  readonly owner: VaultOwner;
  readonly request: ChronoHudRequest;
  marker: string | null;
  delivery: ChronoHudDelivery | null;
}
const encoder = new TextEncoder();

/** One pending ChronoHUD lookup, owned by the vault that launched it. Construction performs no I/O. */
export class ChronoHudLookupSession {
  private pending: LookupTransfer | null = null;
  private live = true;
  private busy = false;
  private lostOwner = false;

  constructor(private readonly options: {
    store: TransferStore;
    vaultName: () => string;
    vaultIdentity?: () => object | string;
    allowed: () => boolean;
    canClean?: () => boolean;
    now?: () => number;
    wait?: (milliseconds: number) => Promise<void>;
  }) {}

  get requestId(): string | null { return this.pending?.request.requestId ?? null; }
  get expiresAt(): number | null { return this.pending?.request.expiresAt ?? null; }
  get isBusy(): boolean { return this.busy; }

  private now(): number { return (this.options.now ?? Date.now)(); }
  private owner(): VaultOwner {
    const name = this.options.vaultName();
    return { name, identity: this.options.vaultIdentity?.() ?? name };
  }
  private sameVault(owner: VaultOwner): boolean {
    const current = this.owner();
    if (owner.identity !== current.identity || owner.name !== current.name) this.lostOwner = true;
    return !this.lostOwner;
  }
  private guard(transfer: LookupTransfer): void {
    if (!this.sameVault(transfer.owner) || !this.options.allowed()) this.live = false;
    if (!this.live || this.pending !== transfer) throw Error("This vault session changed. Open ChronoHUD from the active vault.");
    assertChronoHudRequestLive(transfer.request, this.now());
  }
  private fileName(transfer: LookupTransfer, role: "request" | "reply"): string {
    return transfer.request.requestId + "." + role + ".json";
  }
  private path(transfer: LookupTransfer, role: "request" | "reply"): string {
    return CHRONOHUD_INBOX + "/" + this.fileName(transfer, role);
  }

  /** On explicit user action, create one marker and return the native routing URL. */
  async start(options: { query: ChronoHudQuery; vaultId: string; inboxHint?: string }): Promise<string> {
    if (!this.live || !this.options.allowed()) throw Error("Open ChronoHUD from the active vault.");
    if (this.busy || this.pending) throw Error("Finish the current ChronoHUD lookup before starting another.");
    const owner = this.owner();
    const request = createChronoHudRequest(owner.name, options.vaultId, options.query, this.now());
    const transfer: LookupTransfer = { owner, request, marker: null, delivery: null };
    const launchUrl = chronohudLaunchUrl(request, options.inboxHint);
    const marker = JSON.stringify(request);
    const markerBytes = encoder.encode(marker).byteLength;
    const store = this.options.store;
    const path = this.path(transfer, "request");
    this.pending = transfer;
    this.busy = true;
    try {
      this.guard(transfer);
      if (!await store.exists(CHRONOHUD_INBOX)) {
        this.guard(transfer);
        await store.mkdir(CHRONOHUD_INBOX);
      }
      this.guard(transfer);
      if (await store.exists(path)) throw Error("The ChronoHUD transfer path is already in use.");
      this.guard(transfer);
      if (await store.exists(this.path(transfer, "reply"))) throw Error("The ChronoHUD transfer path is already in use.");
      this.guard(transfer);
      transfer.marker = marker;
      await store.write(path, marker);

      // A vault adapter can report pre-write metadata briefly. Verify without writing again.
      const wait = this.options.wait ?? (milliseconds => new Promise<void>(resolve => window.setTimeout(resolve, milliseconds)));
      for (const delay of [0, 50, 150, 300]) {
        this.guard(transfer);
        if (delay) {
          await wait(delay);
          this.guard(transfer);
        }
        if (await store.size(path) !== markerBytes) continue;
        this.guard(transfer);
        if (await store.read(path) !== marker) continue;
        this.guard(transfer);
        return launchUrl;
      }
      throw Error("The ChronoHUD lookup marker could not be verified.");
    } catch (error) {
      await this.release(transfer);
      throw error;
    } finally {
      this.busy = false;
    }
  }

  /** Provide a copy of the verified marker for a user-initiated Desktop save. */
  exportPending(): TransferFile | null {
    const transfer = this.pending;
    if (!transfer || this.busy || transfer.marker === null) return null;
    try { this.guard(transfer); }
    catch { return null; }
    return { name: this.fileName(transfer, "request"), contents: transfer.marker };
  }

  /** Authenticate a same-vault reply or an explicitly picked Desktop file. */
  async receive(requestId: string, imported?: TransferFile): Promise<ChronoHudDelivery> {
    const transfer = this.pending;
    if (!transfer || this.busy || transfer.delivery || transfer.request.requestId !== requestId)
      throw Error("No matching pending ChronoHUD lookup.");
    this.guard(transfer);
    const store = this.options.store;
    this.busy = true;
    let authenticatedReply: string | undefined;
    try {
      let raw: string;
      if (imported !== undefined) {
        if (!imported || imported.name !== this.fileName(transfer, "reply")) throw Error("Choose the ChronoHUD reply file for this lookup.");
        raw = imported.contents;
        if (typeof raw !== "string" || !raw || raw.length > CHRONOHUD_REPLY_BYTES || encoder.encode(raw).byteLength > CHRONOHUD_REPLY_BYTES)
          throw Error("The ChronoHUD reply is empty or too large.");
      } else {
        const path = this.path(transfer, "reply");
        const size = await store.size(path);
        this.guard(transfer);
        if (size === null) throw Error("No ChronoHUD reply yet. Approve the lookup in ChronoHUD, then try again.");
        if (!Number.isSafeInteger(size) || size < 1 || size > CHRONOHUD_REPLY_BYTES)
          throw Error("The ChronoHUD reply is empty or too large.");
        raw = await store.read(path);
      }
      this.guard(transfer);
      const delivery = await openChronoHudReply(raw, transfer.request, this.now(), imported !== undefined).catch(() => {
        throw Error("The ChronoHUD reply could not be verified. Approve the same lookup in ChronoHUD and retry.");
      });
      if (imported === undefined) authenticatedReply = raw;
      this.guard(transfer);
      await this.clean(transfer, authenticatedReply);
      this.guard(transfer);
      transfer.delivery = delivery;
      return delivery;
    } finally {
      if (!this.live && this.pending === transfer) await this.release(transfer, authenticatedReply);
      this.busy = false;
    }
  }

  /** Verify the exact approved delivery immediately before attaching any excerpts. */
  assertCanUse(delivery: ChronoHudDelivery): void {
    const transfer = this.pending;
    if (!transfer || this.busy || transfer.delivery !== delivery) throw Error("Review a current ChronoHUD lookup first.");
    this.guard(transfer);
  }

  /** Discard the pending lookup and clean only the verified marker. */
  async cancel(): Promise<void> {
    if (this.busy) throw Error("Wait for the current ChronoHUD check to finish.");
    const transfer = this.pending;
    if (!transfer) return;
    this.busy = true;
    try { await this.release(transfer); }
    finally { this.busy = false; }
  }

  /** Close this vault session; in-flight operations stop at their next guard. */
  async dispose(): Promise<void> {
    this.live = false;
    if (!this.busy) await this.cancel();
  }

  private async release(transfer: LookupTransfer, authenticatedReply?: string): Promise<void> {
    if (this.pending === transfer) this.pending = null;
    transfer.delivery = null;
    await this.clean(transfer, authenticatedReply);
  }

  private async clean(transfer: LookupTransfer, authenticatedReply?: string): Promise<void> {
    const store = this.options.store;
    const canClean = () => this.sameVault(transfer.owner) && (this.options.canClean ?? this.options.allowed)();
    const removeExact = async (path: string, expected: string) => {
      if (!canClean()) return;
      const size = await store.size(path);
      if (size !== encoder.encode(expected).byteLength || size > CHRONOHUD_REPLY_BYTES || !canClean()) return;
      if (await store.read(path) === expected && canClean()) await store.remove(path);
    };
    try {
      if (transfer.marker !== null) await removeExact(this.path(transfer, "request"), transfer.marker).catch(() => {});
      if (authenticatedReply !== undefined) await removeExact(this.path(transfer, "reply"), authenticatedReply).catch(() => {});
    } finally {
      transfer.marker = null;
      transfer.request.key = "";
    }
  }
}
