import { containsCredential, sharedConversationPath, SHARED_CONVERSATIONS_PATH, vaultPath } from "./agent-policy";
import { readChat, validChatId, type ChatTurn } from "./chat-history";
import { conversationName, turnConversation, type SharedConversationBinding } from "./conversation-library";
import { inputDigest } from "./question-input";
import { validContextScope } from "./conversation-context";
import { diagnoseLocal, type DiagnosticReason, type DiagnosticRun } from "./diagnostics";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const MAX_REVISION_BYTES = 2 * 1024 * 1024;
const MAX_MESSAGE_BYTES = 6 * 1024 * 1024;
const PART_BYTES = 256 * 1024;
const MAX_PARTS = MAX_MESSAGE_BYTES / PART_BYTES;
const MARKER = "<!-- Yoofloe conversation sync v1 -->\n";
const STOP = MARKER + "stopped\n";
const encoder = new TextEncoder();

type TurnReference = [id: string, digest: string, parts: number];
type Terminal = "completed" | "stopped" | "failed";
type SharedScope = NonNullable<ChatTurn["sharedContext"]>;

interface SharedMessage {
  id: string;
  request: string;
  answer: string;
  status: Terminal;
  startedAt: number | null;
  sourceMode: "expanded" | "provided";
  sourcePath: string;
  actions: ChatTurn["actions"];
  steers: NonNullable<ChatTurn["steers"]>;
  scope?: SharedScope;
}

export interface SharedRevision {
  version: 1;
  id: string;
  parent: string | null;
  title: string;
  at: number;
  refs: TurnReference[];
  lastRequest: string;
}

export interface SharedVersionChoice {
  revision: string;
  title: string;
  at: number;
  messages: number;
  lastRequest: string;
  ready: boolean;
}

export interface SharedConversationSummary {
  id: string;
  versions: SharedVersionChoice[];
  problem: "waiting" | "invalid" | null;
}

interface RevisionSet {
  revisions: Map<string, SharedRevision>;
  files: Set<string>;
  invalid: boolean;
  stopped: boolean;
}

export interface SharedConversationFiles {
  current(): boolean;
  read(path: string, limit: number): Promise<string | null>;
  list(path: string): Promise<{ files: string[]; folders: string[] }>;
  mkdir(path: string): Promise<void>;
  create(path: string, text: string): Promise<void>;
  remove(path: string, expected: string): Promise<void>;
}

function folder(id: string): string {
  if (!UUID.test(id)) throw Error("The shared conversation identifier is invalid.");
  return SHARED_CONVERSATIONS_PATH + "/" + id;
}

function revisionFile(revision: string): string {
  if (!HASH.test(revision)) throw Error("The synced version identifier is invalid.");
  return "revision-" + revision + ".md";
}

function partFile(digest: string, part: number): string {
  return "message-" + digest + "-" + part + ".md";
}

function noteLink(value: string | undefined): string {
  if (typeof value !== "string" || !value || containsCredential(value) || sharedConversationPath(value)) return "";
  try { return vaultPath(value); } catch { return ""; }
}

function terminal(status: ChatTurn["status"]): status is Terminal {
  return status === "completed" || status === "stopped" || status === "failed";
}

function portableMessage(turn: ChatTurn): SharedMessage | null {
  if (!terminal(turn.status)) return null;
  if (turn.requestTruncated || turn.answerTruncated || turn.workDetailsTruncated)
    throw Error("Load the full saved messages before syncing this conversation.");
  const scope = turn.sharedContext ?? (validContextScope(turn.contextScope)
    ? { conversationId: turnConversation(turn.conversationId), scope: turn.contextScope } : undefined);
  const actions = turn.actions.flatMap(action => {
    const path = noteLink(action.path), target = noteLink(action.target);
    return path ? [{ kind: action.kind, path, ...(target ? { target } : {}) }] : [];
  });
  const message: SharedMessage = {
    id: turn.sharedMessageId ?? turn.id,
    request: turn.request, answer: turn.answer, status: turn.status,
    startedAt: turn.startedAt, sourceMode: turn.sourceMode === "expanded" ? "expanded" : "provided",
    sourcePath: noteLink(turn.sourcePath), actions,
    steers: (turn.steers ?? []).map(({ id, text }) => ({ id, text })),
    ...(scope ? { scope } : {}),
  };
  if (!validChatId(message.id) || containsCredential(JSON.stringify(message)))
    throw Error("A saved message contains an invalid identifier or a credential. Its device copy is kept.");
  return message;
}

function encodePart(bytes: Uint8Array): string {
  const pieces: string[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += 0x4000)
    pieces.push(String.fromCharCode(...bytes.subarray(offset, offset + 0x4000)));
  return MARKER + btoa(pieces.join("")) + "\n";
}

function decodePart(raw: string): Uint8Array {
  if (!raw.startsWith(MARKER)) throw Error("A synced message part has an invalid format.");
  const encoded = raw.slice(MARKER.length).trimEnd();
  if (!encoded || encoded.length > Math.ceil(PART_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded))
    throw Error("A synced message part has an invalid format.");
  return Uint8Array.from(atob(encoded), char => char.charCodeAt(0));
}

function parseRevision(raw: string, id: string): SharedRevision {
  if (!raw.startsWith(MARKER)) throw Error("The synced conversation format is invalid.");
  const value = JSON.parse(raw.slice(MARKER.length)) as Partial<SharedRevision> | null;
  if (!value || value.version !== 1 || value.id !== id ||
    !(value.parent === null || typeof value.parent === "string" && HASH.test(value.parent)) ||
    typeof value.title !== "string" || conversationName(value.title) !== value.title || !value.title ||
    typeof value.at !== "number" || !Number.isSafeInteger(value.at) || value.at < 0 ||
    typeof value.lastRequest !== "string" || value.lastRequest.length > 160 ||
    containsCredential(value.title + "\n" + value.lastRequest) || !Array.isArray(value.refs))
    throw Error("The synced conversation metadata is invalid.");
  const seen = new Set<string>();
  for (const ref of value.refs) {
    if (!Array.isArray(ref) || ref.length !== 3 || typeof ref[0] !== "string" || !validChatId(ref[0]) ||
      typeof ref[1] !== "string" || !HASH.test(ref[1]) || !Number.isInteger(ref[2]) || ref[2] < 1 || ref[2] > MAX_PARTS ||
      seen.has(ref[0])) throw Error("A synced message reference is invalid.");
    seen.add(ref[0]);
  }
  return { version: 1, id, parent: value.parent, title: value.title, at: value.at, refs: value.refs, lastRequest: value.lastRequest };
}

function parseMessage(raw: string, expectedId: string): ChatTurn {
  if (containsCredential(raw)) throw Error("A synced message contains a credential.");
  const source = JSON.parse(raw) as Partial<SharedMessage> | null;
  if (!source || source.id !== expectedId || !terminal(source.status as ChatTurn["status"]) ||
    !["expanded", "provided"].includes(String(source.sourceMode)) || !Array.isArray(source.steers) ||
    !Array.isArray(source.actions)) throw Error("The synced message is invalid.");
  const sourceScope = source.scope;
  if (sourceScope !== undefined && (!sourceScope || typeof sourceScope.conversationId !== "string" ||
    !validChatId(sourceScope.conversationId) || !validContextScope(sourceScope.scope)))
    throw Error("A synced message has an invalid access scope.");
  // The portable format cannot restore approvals, attachments, runnable state, or a provider checkpoint.
  const turn = readChat({
    id: source.id, request: source.request, answer: source.answer, status: source.status, startedAt: source.startedAt,
    sourcePath: noteLink(source.sourcePath), sourceMode: source.sourceMode,
    actions: source.actions.flatMap(action => {
      if (!action || typeof action.kind !== "string" || typeof action.path !== "string") return [];
      const path = noteLink(action.path), target = noteLink(typeof action.target === "string" ? action.target : undefined);
      return path ? [{ kind: action.kind, path, ...(target ? { target } : {}) }] : [];
    }),
    steers: source.steers.map(steer => steer && ({ id: steer.id, text: steer.text })),
    sharedMessageId: expectedId, sharedContext: sourceScope,
  });
  if (!turn) throw Error("The synced message is invalid.");
  return turn;
}

export function diagnoseSync(error: unknown): DiagnosticReason {
  const message = error instanceof Error ? error.message.slice(0, 220) : "";
  if (/^(?:Waiting for |This synced conversation version is unavailable)/.test(message)) return "revision_unavailable";
  if (/^(?:A synced (?:conversation|message)|The synced (?:conversation|message)|The sync stop record).*(?:invalid|could not be verified)/.test(message)) return "invalid_revision";
  return diagnoseLocal(error, "storage");
}

export class SharedConversations {
  constructor(private readonly files: SharedConversationFiles) {}

  private guard(): void {
    if (!this.files.current()) throw Error("The vault changed.");
  }

  private async put(path: string, text: string): Promise<void> {
    this.guard();
    const limit = encoder.encode(text).byteLength + 32;
    if (await this.files.read(path, limit) === text) return;
    this.guard();
    try { await this.files.create(path, text); }
    catch {
      if (await this.files.read(path, limit) !== text) throw Error("A vault conversation file could not be created.");
    }
    this.guard();
    if (await this.files.read(path, limit) !== text) throw Error("A vault conversation file could not be verified.");
  }

  async stopped(id: string): Promise<boolean> {
    this.guard();
    const marker = await this.files.read(folder(id) + "/stopped.md", 256);
    if (marker !== null && marker.replaceAll("\r\n", "\n") !== STOP) throw Error("The sync stop record is invalid.");
    return marker !== null;
  }

  private async revision(id: string, hash: string): Promise<SharedRevision | null> {
    this.guard();
    const raw = (await this.files.read(folder(id) + "/" + revisionFile(hash), MAX_REVISION_BYTES))?.replaceAll("\r\n", "\n");
    if (raw === undefined) return null;
    if (await inputDigest(raw) !== hash) throw Error("A synced conversation version could not be verified.");
    return parseRevision(raw, id);
  }

  private async revisions(id: string): Promise<RevisionSet> {
    const root = folder(id), revisions = new Map<string, SharedRevision>();
    if (await this.stopped(id)) return { revisions, files: new Set(), invalid: false, stopped: true };
    const { files } = await this.files.list(root);
    const names = new Set(files.filter(path => path.startsWith(root + "/")).map(path => path.slice(root.length + 1)));
    let invalid = false;
    for (const name of names) {
      const hash = /^revision-([a-f0-9]{64})\.md$/.exec(name)?.[1];
      if (!hash) continue;
      try {
        const item = await this.revision(id, hash);
        if (item) revisions.set(hash, item);
      } catch { invalid = true; }
    }
    this.guard();
    return { revisions, files: names, invalid, stopped: false };
  }

  async catalog(): Promise<SharedConversationSummary[]> {
    this.guard();
    const { folders } = await this.files.list(SHARED_CONVERSATIONS_PATH);
    const summaries: SharedConversationSummary[] = [];
    for (const path of folders) {
      const id = path.slice(SHARED_CONVERSATIONS_PATH.length + 1);
      if (!path.startsWith(SHARED_CONVERSATIONS_PATH + "/") || !UUID.test(id)) continue;
      try {
        const { revisions, files, stopped, invalid } = await this.revisions(id);
        if (stopped) continue;
        const parents = new Set([...revisions.values()].map(item => item.parent));
        const versions = [...revisions].filter(([hash]) => !parents.has(hash)).map(([hash, item]) => ({
          revision: hash, title: item.title, at: item.at, messages: item.refs.length, lastRequest: item.lastRequest,
          ready: !invalid && this.knownLineage(revisions, hash) && item.refs.every(([, digest, parts]) => {
            for (let index = 0; index < parts; index++) if (!files.has(partFile(digest, index))) return false;
            return true;
          }),
        })).sort((a, b) => b.at - a.at || a.revision.localeCompare(b.revision));
        summaries.push({ id, versions, problem: invalid ? "invalid" : !versions.length || versions.some(version => !version.ready) ? "waiting" : null });
      } catch { summaries.push({ id, versions: [], problem: "invalid" }); }
    }
    this.guard();
    return summaries.sort((a, b) => (b.versions[0]?.at ?? 0) - (a.versions[0]?.at ?? 0));
  }

  private knownLineage(revisions: ReadonlyMap<string, SharedRevision>, newest: string, base?: string): boolean {
    const seen = new Set<string>();
    let current: string | null = newest;
    while (current !== null) {
      if (seen.has(current)) return false;
      seen.add(current);
      const item = revisions.get(current);
      if (!item) return false;
      if (current === base) return true;
      current = item.parent;
    }
    return base === undefined;
  }

  async descendant(id: string, newest: string, base: string): Promise<boolean> {
    const { revisions } = await this.revisions(id);
    return this.knownLineage(revisions, newest, base);
  }

  async publish(binding: SharedConversationBinding, title: string, at: number,
    turns: Iterable<ChatTurn> | AsyncIterable<ChatTurn>, diagnostics?: DiagnosticRun): Promise<string> {
    const id = binding.id, root = folder(id), parent = binding.revision;
    title = conversationName(title) || "Conversation";
    if (containsCredential(title)) throw Error("The conversation title contains a credential.");
    const original = parent ? await this.revision(id, parent) : null;
    if (parent && !original) {
      diagnostics?.event("sync_revision", "waiting", { reason: "revision_unavailable" });
      throw Error("Waiting for the previous conversation version to sync.");
    }
    if (original) diagnostics?.event("sync_revision", "ok", { count: original.refs.length, contextReused: true });
    if (await this.stopped(id)) throw Error("Vault sync was turned off for this conversation.");
    await this.files.mkdir(root);
    const refs = new Map<string, TurnReference>(original?.refs.map(ref => [ref[0], ref]));
    const newOrder = new Map<string, { at: number; request: string }>();
    let lastRequest = original?.lastRequest ?? "", changed = !original || original.title !== title;
    diagnostics?.event("sync_message", "started");
    let written = 0;
    for await (const turn of turns) {
      const message = portableMessage(turn);
      if (!message) continue;
      const raw = JSON.stringify(message), bytes = encoder.encode(raw);
      if (bytes.byteLength > MAX_MESSAGE_BYTES) throw Error("A saved message exceeds the conversation sync size limit.");
      const digest = await inputDigest(raw);
      if (refs.get(message.id)?.[1] === digest) continue;
      if (await this.stopped(id)) throw Error("Vault sync was turned off for this conversation.");
      const parts = Math.ceil(bytes.byteLength / PART_BYTES);
      for (let part = 0; part < parts; part++) {
        const content = encodePart(bytes.subarray(part * PART_BYTES, (part + 1) * PART_BYTES));
        await this.put(root + "/" + partFile(digest, part), content);
      }
      changed = true;
      newOrder.set(message.id, { at: message.startedAt ?? 0, request: message.request.replace(/\s+/g, " ").slice(0, 160) });
      refs.set(message.id, [message.id, digest, parts]);
      written++;
      diagnostics?.event("sync_message", "ok", { count: written, dataBytes: bytes.byteLength });
    }
    if (!changed && parent) return parent;
    const ordered = [...refs.values()];
    if (!parent) ordered.sort((a, b) => (newOrder.get(a[0])?.at ?? 0) - (newOrder.get(b[0])?.at ?? 0));
    const newest = ordered.at(-1);
    if (newest) lastRequest = newOrder.get(newest[0])?.request ?? lastRequest;
    const raw = MARKER + JSON.stringify({ version: 1, id, parent, title, at: Math.max(0, Math.trunc(at)), refs: ordered, lastRequest }) + "\n";
    if (encoder.encode(raw).byteLength > MAX_REVISION_BYTES) throw Error("The conversation index exceeds its file size limit.");
    const hash = await inputDigest(raw);
    if (await this.stopped(id)) throw Error("Vault sync was turned off for this conversation.");
    await this.put(root + "/" + revisionFile(hash), raw);
    diagnostics?.event("sync_revision", "ok", { count: ordered.length });
    if (await this.stopped(id)) throw Error("Vault sync was turned off for this conversation.");
    return hash;
  }

  async describe(id: string, revision: string, diagnostics?: DiagnosticRun): Promise<SharedRevision> {
    diagnostics?.event("sync_revision", "started");
    try {
      const item = await this.revision(id, revision);
      if (!item || await this.stopped(id)) throw Error("This synced conversation version is unavailable.");
      diagnostics?.event("sync_revision", "ok", { count: item.refs.length });
      return item;
    } catch (error) {
      diagnostics?.event("sync_revision", "failed", { reason: diagnoseSync(error) });
      throw error;
    }
  }

  async *messages(version: SharedRevision, diagnostics?: DiagnosticRun): AsyncGenerator<ChatTurn> {
    const root = folder(version.id);
    diagnostics?.event("sync_message", "started", { count: version.refs.length });
    let read = 0;
    for (const [id, digest, parts] of version.refs) {
      this.guard();
      const text = new TextDecoder("utf-8", { fatal: true });
      let raw = "";
      for (let index = 0; index < parts; index++) {
        const chunk = await this.files.read(root + "/" + partFile(digest, index), Math.ceil(PART_BYTES / 3) * 4 + 128);
        if (chunk === null) {
          diagnostics?.event("sync_message", "unconfirmed", { reason: "revision_unavailable", count: read });
          throw Error("Waiting for the remaining conversation files to sync.");
        }
        const bytes = decodePart(chunk.replaceAll("\r\n", "\n"));
        if (bytes.byteLength > PART_BYTES || index + 1 < parts && bytes.byteLength !== PART_BYTES)
          throw Error("A synced message part has an invalid size.");
        raw += text.decode(bytes, { stream: index + 1 < parts });
      }
      if (encoder.encode(raw).byteLength > MAX_MESSAGE_BYTES || await inputDigest(raw) !== digest)
        throw Error("A synced message could not be verified. Its stored copy is kept.");
      const message = parseMessage(raw, id);
      diagnostics?.event("sync_message", "ok", { count: ++read });
      yield message;
    }
    this.guard();
    if (await this.stopped(version.id)) throw Error("Vault sync was turned off for this conversation.");
  }

  async stop(id: string, diagnostics?: DiagnosticRun): Promise<void> {
    const root = folder(id);
    await this.files.mkdir(root);
    if (!await this.stopped(id)) await this.put(root + "/stopped.md", STOP);
    diagnostics?.event("sync_revision", "ok", { action: "stop" });
    const { files } = await this.files.list(root);
    for (const path of files) {
      const name = path.slice(root.length + 1);
      if (!path.startsWith(root + "/") || !/^(?:revision-[a-f0-9]{64}|message-[a-f0-9]{64}-\d{1,2})\.md$/.test(name)) continue;
      this.guard();
      const source = await this.files.read(path, MAX_REVISION_BYTES);
      if (source?.replaceAll("\r\n", "\n").startsWith(MARKER)) await this.files.remove(path, source);
    }
    this.guard();
  }
}
