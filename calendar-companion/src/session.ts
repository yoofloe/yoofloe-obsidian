import { assertLive, createRequest, createQuestionRequest, INBOX, launchUrl, MAX_REPLY_BYTES, openReply, type Delivery, type Request } from "./protocol";
import { QUERY_REPLY_BYTES, type QuestionQuery } from "./question-query";

export interface TransferStore {
  exists(path: string): Promise<boolean>; mkdir(path: string): Promise<void>;
  write(path: string, content: string): Promise<void>; read(path: string): Promise<string>;
  size(path: string): Promise<number | null>; remove(path: string): Promise<void>;
}

/** A vault-scoped, one-use transfer; constructing it performs no I/O. */
export class CalendarSession {
  private pending: Request | null = null;
  private delivery: Delivery | null = null;
  private replyText: string | null = null;
  private live = true;
  private busy = false;
  private owner: string | null = null;
  constructor(private readonly options: { store: TransferStore; vaultName: () => string; allowed: () => boolean; now?: () => number }) {}
  private now() { return (this.options.now ?? Date.now)(); }
  private guard(request?: Request) {
    if (!this.options.allowed() || (this.owner !== null && this.owner !== this.options.vaultName())) this.live = false;
    if (!this.live || (request && request !== this.pending)) throw Error("This vault session changed. Start a new connection.");
    if (request) assertLive(request, this.now());
  }
  private path(request: Request, reply: boolean) { return `${INBOX}/${request.requestId}.${reply ? "reply" : "request"}.json`; }
  get requestId() { return this.pending?.requestId ?? null; }
  get preview() { return this.delivery; }

  /** The caller must invoke this from an explicit Android user action. */
  async start(question?: { vaultId: string; query: QuestionQuery; inboxHint?: string }): Promise<string> {
    this.guard();
    if (this.busy || this.pending) throw Error("Cancel the current request before starting another.");
    const owner = this.options.vaultName(), request = question ? createQuestionRequest(owner, question.vaultId, question.query, this.now()) : createRequest(owner, this.now());
    this.busy = true; this.owner = owner; this.pending = request;
    try {
      const store = this.options.store;
      if (!await store.exists(INBOX)) { this.guard(request); await store.mkdir(INBOX); }
      this.guard(request);
      if (await store.exists(this.path(request, false)) || await store.exists(this.path(request, true))) throw Error("The request path is already in use.");
      this.guard(request); await store.write(this.path(request, false), JSON.stringify(request)); this.guard(request);
      return launchUrl(request, question?.inboxHint);
    } catch (error) { await this.cancel(); throw error; }
    finally { this.busy = false; }
  }

  /** A callback is only a hint; matching request, key, expiry and payload are checked again. */
  async receive(requestId: string): Promise<Delivery> {
    const request = this.pending; this.guard(request ?? undefined);
    if (!request || requestId !== request.requestId || this.busy || this.delivery) throw Error("No matching pending Calendar request.");
    this.busy = true;
    try {
      this.guard(request);
      const path = this.path(request, true), size = await this.options.store.size(path);
      this.guard(request);
      if (size === null) throw Error("No reply yet. Install or update Calendar, approve the transfer, then retry.");
      if (size > (request.version === 3 ? QUERY_REPLY_BYTES : MAX_REPLY_BYTES)) throw Error("This transfer is too large.");
      const raw = await this.options.store.read(path); this.guard(request);
      const result = await openReply(raw, request, this.now()); this.guard(request);
      this.replyText = raw; this.delivery = result; return result;
    } finally { this.busy = false; }
  }

  /** Recheck the current vault and expiry immediately before note writes. */
  assertCanSave(delivery: Delivery): void {
    const request = this.pending; this.guard(request ?? undefined);
    if (!request || this.delivery !== delivery || this.busy) throw Error("Review a current Calendar transfer first.");
  }

  /** Remove only this session's exact request marker. Replies are encrypted and retained on uncertain outcomes. */
  async cancel(): Promise<void> {
    const request = this.pending;
    const replyText = this.replyText;
    this.pending = null; this.delivery = null; this.replyText = null;
    if (!request) return;
    try {
      const path = this.path(request, false);
      if (this.owner === this.options.vaultName() && await this.options.store.exists(path) && await this.options.store.read(path) === JSON.stringify(request)) await this.options.store.remove(path);
      const replyPath = this.path(request, true);
      if (replyText !== null && this.owner === this.options.vaultName() && await this.options.store.exists(replyPath) && await this.options.store.read(replyPath) === replyText) await this.options.store.remove(replyPath);
    } catch { /* Best-effort cleanup never deletes an independently changed file. */ }
    finally { request.key = ""; }
  }

  /** Closing a vault prevents every late callback from writing notes. */
  async dispose(): Promise<void> { this.live = false; await this.cancel(); }
}
