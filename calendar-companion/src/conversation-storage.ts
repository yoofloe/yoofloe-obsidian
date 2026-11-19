import { chatMatches, readChat, searchChatPreview, validChatId, type ChatTurn } from "./chat-history";
import { readLibrary, turnConversation } from "./conversation-library";
import type { DeviceRecords } from "./device-records";
import { validateJournal, type WorkJournal } from "./vault-agent";
import type { WorkspaceStorage } from "./workspace";

const MiB = 1024 * 1024;
const STATE_LIMIT = 8 * MiB;
const CHAT_LIMIT = 6 * MiB;
const JOURNAL_LIMIT = 256 * 1024;
const RETIREMENT_LIMIT = 128;
const ENCODER = new TextEncoder();
const DECODER = new TextDecoder("utf-8", { fatal: true });

export interface LegacyConversationFiles {
  read(name: string, limit: number): Promise<ArrayBuffer | null>;
  list(folder: string): Promise<string[]>;
}

function chatRecord(name: string, expectedId: string, value: unknown): ChatTurn {
  const turn = readChat(value);
  if (!turn || turn.id !== expectedId) throw Error("A saved message could not be verified.");
  if (localChat.exec(name)?.[1] === turnConversation(turn.conversationId) || legacyChat.test(name)) return turn;
  throw Error("A saved message belongs to another conversation.");
}

function stateRecord(value: unknown, conversationId?: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("The saved conversation record is invalid.");
  const state = value as Record<string, unknown>;
  const id = conversationId ?? readLibrary(state.conversationLibrary).active;
  if (state.chat !== undefined && (!Array.isArray(state.chat) || state.chat.some(raw => {
    const turn = readChat(raw);
    return !turn || turnConversation(turn.conversationId) !== id;
  }))) throw Error("Saved messages could not be matched to their conversation.");
  return state;
}

function chatName(conversationId: string, turnId: string): string {
  if (!validChatId(conversationId) || !validChatId(turnId)) throw Error("The conversation or message identifier is invalid.");
  return "chats/" + conversationId + "/" + turnId + ".json";
}

function retirementName(id: string): string {
  if (!validChatId(id)) throw Error("The conversation identifier is invalid.");
  return "retired/" + id;
}

function conversationName(id: string): string {
  if (!validChatId(id)) throw Error("The conversation identifier is invalid.");
  return "conversations/" + id + ".json";
}

const localChat = /^chats\/([A-Za-z0-9_-]{1,80})\/([A-Za-z0-9_-]{1,80})\.json$/;
const legacyChat = /^chats\/([A-Za-z0-9_-]{1,80})\.json$/;
const journalName = /^tasks\/([a-f0-9-]{36})\.json$/;

export class ConversationStorage implements WorkspaceStorage {
  private writes: Promise<unknown> = Promise.resolve();
  private retired = new Set<string>();
  private migration: Promise<{ retained: number; unavailable: number }> | undefined;

  constructor(private readonly device: DeviceRecords, private readonly legacy: LegacyConversationFiles,
    private readonly current: () => boolean) {}

  private serialize<T>(save: () => Promise<T>): Promise<T> {
    const next = this.writes.then(save);
    this.writes = next.catch(() => {});
    return next;
  }

  private bytes(value: unknown, limit: number): ArrayBuffer {
    const bytes = ENCODER.encode(JSON.stringify(value));
    if (bytes.byteLength > limit) throw Error("The saved conversation exceeds its device size limit.");
    return bytes.buffer;
  }

  private json(bytes: ArrayBuffer): unknown { return JSON.parse(DECODER.decode(bytes)) as unknown; }

  private async isRetired(id: string): Promise<boolean> {
    if (this.retired.has(id)) return true;
    const stored = await this.device.read(retirementName(id), RETIREMENT_LIMIT);
    if (stored === null) return false;
    if (this.json(stored) !== true) throw Error("A conversation deletion record is invalid.");
    this.retired.add(id);
    return true;
  }

  private async migrate(name: string, bytes: ArrayBuffer, limit: number, conversationId?: string): Promise<ArrayBuffer> {
    await this.device.write(new Map([[name, bytes]]), true, conversationId ? { unlessPresent: retirementName(conversationId) } : undefined);
    const opened = await this.device.read(name, limit);
    if (!opened) throw Error("The migrated conversation could not be read back.");
    // A simultaneous save may have installed a newer authenticated record.
    return opened;
  }

  private async state(name: string, id?: string): Promise<Record<string, unknown> | null> {
    if (id && await this.isRetired(id)) return null;
    const bytes = await this.device.read(name, STATE_LIMIT);
    if (bytes !== null) return stateRecord(this.json(bytes), id);
    const source = await this.legacy.read(name, STATE_LIMIT);
    if (source === null) return null;
    stateRecord(this.json(source), id);
    return stateRecord(this.json(await this.migrate(name, source, STATE_LIMIT, id)), id);
  }

  load(): Promise<unknown> { return this.state("workspace.json"); }

  save(value: unknown): Promise<void> {
    const state = stateRecord(value);
    const active = readLibrary(state.conversationLibrary).active;
    return this.serialize(() => this.device.write(new Map([["workspace.json", this.bytes(state, STATE_LIMIT)]]),
      false, { unlessPresent: retirementName(active) }));
  }

  async deleteConversation(id: string, value: unknown): Promise<void> {
    const state = stateRecord(value);
    if (readLibrary(state.conversationLibrary).conversations.some(item => item.id === id))
      throw Error("The conversation is still present in the saved library.");
    const tombstone = retirementName(id);
    const records = new Map([
      ["workspace.json", this.bytes(state, STATE_LIMIT)],
      [tombstone, this.bytes(true, RETIREMENT_LIMIT)],
    ]);
    await this.serialize(async () => {
      await this.device.write(records, false, {
        remove: [conversationName(id)],
        removePrefixes: ["chats/" + id + "/"],
      });
      this.retired.add(id);
    });
  }

  loadConversation(id: string): Promise<unknown> { return this.state(conversationName(id), id); }

  saveConversation(id: string, value: unknown): Promise<void> {
    return this.serialize(() => this.device.write(new Map([[conversationName(id), this.bytes(stateRecord(value, id), STATE_LIMIT)]]),
      false, { unlessPresent: retirementName(id) }));
  }

  private chatBytes(turn: ChatTurn): ArrayBuffer {
    if (turn.requestTruncated || turn.answerTruncated || turn.generatedTruncated || turn.workDetailsTruncated)
      throw Error("Load the full conversation before updating its archive.");
    return this.bytes(turn, CHAT_LIMIT);
  }

  saveChat(turn: ChatTurn): Promise<void> {
    const id = turnConversation(turn.conversationId), key = chatName(id, turn.id);
    const record = this.chatBytes(turn);
    return this.serialize(() => this.device.write(new Map([[key, record]]), false, { unlessPresent: retirementName(id) }));
  }

  private async archivedChat(name: string): Promise<{ turn: ChatTurn; bytes: number } | "retired" | null> {
    const key = localChat.exec(name), old = legacyChat.exec(name);
    if (!key && !old) return null;
    if (key) {
      if (await this.isRetired(key[1])) return "retired";
      const sealed = await this.device.read(name, CHAT_LIMIT);
      return sealed ? { turn: chatRecord(name, key[2], this.json(sealed)), bytes: sealed.byteLength } : null;
    }
    const source = await this.legacy.read(name, CHAT_LIMIT);
    if (source === null || !old) return null;
    const migrated = chatRecord(name, old[1], this.json(source));
    const owner = turnConversation(migrated.conversationId);
    if (await this.isRetired(owner)) return "retired";
    const destination = chatName(owner, migrated.id);
    try {
      const opened = await this.migrate(destination, source, CHAT_LIMIT, owner);
      return { turn: chatRecord(destination, migrated.id, this.json(opened)), bytes: opened.byteLength };
    } catch (error) {
      if (await this.isRetired(owner)) return "retired";
      throw error;
    }
  }

  async loadChat(id: string, conversationId = "inbox"): Promise<ChatTurn> {
    const record = await this.archivedChat(chatName(conversationId, id)) ?? await this.archivedChat("chats/" + id + ".json");
    if (!record || record === "retired" || turnConversation(record.turn.conversationId) !== conversationId || !this.current())
      throw Error("The full saved message is unavailable for this conversation.");
    return record.turn;
  }

  private async archiveNames(): Promise<string[]> {
    const names = (await this.device.keys("chats/")).filter(name => localChat.test(name));
    const migrated = new Set(names.map(name => localChat.exec(name)![2]));
    const legacy = (await this.legacy.list("chats")).filter(name => {
      const match = legacyChat.exec(name);
      return !!match && !migrated.has(match[1]);
    });
    // Sort by the original message ID so migrating a file never moves a pagination boundary.
    return [...names, ...legacy].sort((a, b) => b.split("/").at(-1)!.localeCompare(a.split("/").at(-1)!));
  }

  async searchChats(query: string, offset: number, conversationId?: string, strict = false, knownIds?: ReadonlySet<string>) {
    const turns: ChatTurn[] = [];
    if (!this.current() || !query.trim() && !conversationId || conversationId && !validChatId(conversationId) ||
      query.length > 200 || !Number.isSafeInteger(offset) || offset < 0) return { turns, nextOffset: null };
    const names = await this.archiveNames();
    let index = offset, bytes = 0, unavailable = 0;
    for (; index < Math.min(names.length, offset + 20) && this.current(); index++) {
      const key = localChat.exec(names[index]);
      if (key && (conversationId && key[1] !== conversationId || knownIds && !knownIds.has(key[1]))) continue;
      try {
        const record = await this.archivedChat(names[index]);
        if (record === "retired") continue;
        if (!record) throw Error("A saved message is unavailable.");
        const { turn } = record;
        if (bytes && bytes + record.bytes > STATE_LIMIT) break;
        bytes += record.bytes;
        const owner = turnConversation(turn.conversationId);
        if ((!conversationId || owner === conversationId) && (!knownIds || knownIds.has(owner)) && (!query || chatMatches(turn, query)))
          turns.push(query ? searchChatPreview(turn, query) : turn);
      } catch {
        if (strict) throw Error("A saved message could not be verified. Its stored copy is kept.");
        unavailable++;
      }
    }
    return { turns, nextOffset: index < names.length ? index : null, unavailable };
  }

  async *conversationTurns(id: string): AsyncGenerator<ChatTurn> {
    if (!validChatId(id)) throw Error("The conversation identifier is invalid.");
    for (const name of await this.archiveNames()) {
      const key = localChat.exec(name);
      if (key && key[1] !== id) continue;
      const record = await this.archivedChat(name);
      if (record === "retired") continue;
      if (!record || !this.current()) throw Error("A saved message could not be verified.");
      if (turnConversation(record.turn.conversationId) === id) yield record.turn;
    }
  }

  async importMessages(conversationId: string, messages: AsyncIterable<ChatTurn>): Promise<void> {
    const encode = (turn: ChatTurn) => this.chatBytes(turn);
    const records = async function* (): AsyncGenerator<[string, ArrayBuffer]> {
      for await (const turn of messages) {
        if (turnConversation(turn.conversationId) !== conversationId) throw Error("A synced message belongs to another conversation.");
        yield [chatName(conversationId, turn.id), encode(turn)];
      }
    };
    await this.serialize(async () => {
      if (await this.isRetired(conversationId)) throw Error("This conversation was deleted from this device.");
      await this.device.import(records());
    });
  }

  async history(): Promise<WorkJournal[]> {
    const names = new Set([...(await this.device.keys("tasks/")), ...(await this.legacy.list("tasks"))]);
    const journals: WorkJournal[] = [];
    for (const name of [...names].sort().reverse().slice(0, 200)) {
      if (!journalName.test(name)) continue;
      try {
        const journal = await this.journal(name);
        if (journal) journals.push(journal);
      } catch { /* Keep unreadable recovery records for recovery on the original device. */ }
    }
    return journals.sort((a, b) => b.createdAt - a.createdAt).slice(0, 30);
  }

  private async journal(name: string): Promise<WorkJournal | null> {
    const validate = (value: unknown): WorkJournal => {
      validateJournal(value);
      if (name !== "tasks/" + value.id + ".json") throw Error("A saved recovery record could not be verified.");
      return value;
    };
    const stored = await this.device.read(name, JOURNAL_LIMIT);
    if (stored) return validate(this.json(stored));
    const source = await this.legacy.read(name, JOURNAL_LIMIT);
    if (!source) return null;
    validate(this.json(source));
    return validate(this.json(await this.migrate(name, source, JOURNAL_LIMIT)));
  }

  saveJournal(journal: WorkJournal): Promise<void> {
    validateJournal(journal);
    const name = "tasks/" + journal.id + ".json", bytes = this.bytes(journal, JOURNAL_LIMIT);
    return this.serialize(() => this.device.write(new Map([[name, bytes]])));
  }

  async readBlob(name: string, limit: number): Promise<ArrayBuffer | null> {
    const stored = await this.device.read(name, limit);
    if (stored) return stored;
    const source = await this.legacy.read(name, limit);
    return source ? await this.migrate(name, source, limit) : null;
  }

  async saveBlob(name: string, bytes: ArrayBuffer, limit: number): Promise<void> {
    if (bytes.byteLength > limit) throw Error("The private cache file exceeds its size limit.");
    await this.serialize(() => this.device.write(new Map([[name, bytes]])));
  }

  migrateLegacy(): Promise<{ retained: number; unavailable: number }> {
    return this.migration ??= this.copyLegacy();
  }

  private async copyLegacy(): Promise<{ retained: number; unavailable: number }> {
    const conversations = (await this.legacy.list("conversations")).filter(name => /^conversations\/[A-Za-z0-9_-]{1,80}\.json$/.test(name));
    const chats = (await this.legacy.list("chats")).filter(name => legacyChat.test(name));
    const journals = (await this.legacy.list("tasks")).filter(name => journalName.test(name));
    let unavailable = 0;
    for (const name of [...conversations, ...chats, ...journals]) {
      if (!this.current()) break;
      try {
        if (legacyChat.test(name)) await this.archivedChat(name);
        else if (journalName.test(name)) await this.journal(name);
        else await this.state(name, name.slice("conversations/".length, -5));
      } catch { unavailable++; }
    }
    const workspace = await this.legacy.read("workspace.json", STATE_LIMIT);
    return { retained: conversations.length + chats.length + journals.length + Number(workspace !== null), unavailable };
  }
}
