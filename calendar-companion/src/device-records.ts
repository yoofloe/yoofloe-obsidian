const VERSION = 1;
const TAG_BYTES = 16;
const PROOF = "Yoofloe device conversation storage";
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export interface SealedRecord {
  version: number;
  iv: ArrayBuffer;
  ciphertext: ArrayBuffer;
}

interface RecordChanges {
  remove?: readonly string[];
  removePrefixes?: readonly string[];
  unlessPresent?: string;
}

export interface RecordDatabase {
  read(key: string): Promise<SealedRecord | undefined>;
  keys(prefix: string): Promise<string[]>;
  write(records: ReadonlyMap<string, SealedRecord>, keepExisting?: boolean, changes?: RecordChanges): Promise<void>;
  promote(staged: ReadonlyMap<string, string>): Promise<void>;
  discard(keys: Iterable<string>): Promise<void>;
}

interface DeviceSecrets {
  getSecret(id: string): string | null;
  setSecret(id: string, value: string): void;
}

export function indexedRecordDatabase(factory: IDBFactory): RecordDatabase {
  let opening: Promise<IDBDatabase> | undefined;
  const open = () => opening ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open("yoofloe-device-records", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("records");
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => { database.close(); opening = undefined; };
      resolve(database);
    };
    request.onerror = () => reject(Error("The device conversation database could not be opened."));
    request.onblocked = () => reject(Error("Close other Yoofloe windows and reopen this vault."));
  }).catch(error => { opening = undefined; throw error; });

  async function read<T>(operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const database = await open();
    return await new Promise<T>((resolve, reject) => {
      const transaction = database.transaction("records", "readonly");
      const request = operation(transaction.objectStore("records"));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onabort = () => reject(Error("The device conversation record could not be read."));
    });
  }

  async function write(operation: (store: IDBObjectStore, transaction: IDBTransaction) => void): Promise<void> {
    const database = await open();
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction("records", "readwrite");
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(Error("Device saving could not be confirmed. Check the available storage."));
      operation(transaction.objectStore("records"), transaction);
    });
  }

  return {
    read: key => read(store => store.get(key) as IDBRequest<SealedRecord | undefined>),
    keys: async prefix => (await read(store =>
      store.getAllKeys(IDBKeyRange.bound(prefix, prefix + "\uffff")))).filter((key): key is string => typeof key === "string"),
    write: (records, keepExisting = false, changes) =>
      write((store, transaction) => {
        const apply = () => {
          for (const key of changes?.remove ?? []) store.delete(key);
          for (const prefix of changes?.removePrefixes ?? [])
            store.delete(IDBKeyRange.bound(prefix, prefix + "\uffff"));
          for (const [name, record] of records) {
            if (keepExisting) {
              const previous = store.getKey(name);
              previous.onsuccess = () => { if (previous.result === undefined) store.add(record, name); };
            } else {
              store.put(record, name);
            }
          }
        };
        if (!changes?.unlessPresent) { apply(); return; }
        const guard = store.getKey(changes.unlessPresent);
        guard.onsuccess = () => {
          if (guard.result === undefined) apply();
          else transaction.abort();
        };
      }),
    promote: staged => write((store, transaction) => {
      const entries = staged.entries();
      const next = () => {
        const entry = entries.next();
        if (entry.done) return;
        const [temporary, destination] = entry.value;
        const request = store.get(temporary) as IDBRequest<SealedRecord | undefined>;
        request.onsuccess = () => {
          const record = request.result;
          if (!record) { transaction.abort(); return; }
          const previous = store.getKey(destination);
          previous.onsuccess = () => {
            if (previous.result === undefined) store.add(record, destination);
            store.delete(temporary);
            next();
          };
        };
      };
      next();
    }),
    discard: keys => write(store => { for (const key of keys) store.delete(key); }),
  };
}

export class DeviceRecords {
  private keyState: { secret: string; key: Promise<CryptoKey> } | null = null;

  constructor(private readonly options: {
    database: RecordDatabase;
    vaultId(): string;
    secrets(): DeviceSecrets | null;
    current(): boolean;
  }) {}

  private guard(): void {
    if (!this.options.current()) throw Error("The vault changed.");
  }

  private prefix(): string {
    this.guard();
    const id = this.options.vaultId();
    if (!/^[a-f0-9-]{36}$/.test(id)) throw Error("The device vault identifier is invalid.");
    return id + "/";
  }

  private async key(prefix: string, create: boolean): Promise<CryptoKey> {
    this.guard();
    const secrets = this.options.secrets();
    if (!secrets) throw Error("Obsidian Keychain is unavailable. Existing conversation records are kept.");
    const id = "yoofloe-chat-" + prefix.slice(0, -1);
    let secret = secrets.getSecret(id);
    if (!secret && create) {
      const existing = await this.options.database.keys(prefix);
      this.guard();
      secret = secrets.getSecret(id);
      if (!secret && !existing.length) {
        secret = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
        secrets.setSecret(id, secret);
        if (secrets.getSecret(id) !== secret) throw Error("The device conversation key could not be saved.");
      }
    }
    if (!secret) throw Error("The device conversation key is missing. Existing records are kept.");
    if (this.keyState?.secret === secret) return this.keyState.key;

    const pending = this.verifyKey(prefix, secret, create);
    this.keyState = { secret, key: pending };
    try { return await pending; }
    catch (error) {
      if (this.keyState?.key === pending) this.keyState = null;
      throw error;
    }
  }

  private async verifyKey(prefix: string, secret: string, create: boolean): Promise<CryptoKey> {
    if (!/^[A-Za-z0-9+/]{43}=$/.test(secret)) throw Error("The device conversation key is invalid.");
    const raw = Uint8Array.from(atob(secret), char => char.charCodeAt(0));
    const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
    raw.fill(0);
    const proofName = prefix + "key-proof";
    const database = this.options.database;
    let proof = await database.read(proofName);
    if (!proof && create && !(await database.keys(prefix)).length) {
      const sealed = await this.seal(proofName, encoder.encode(PROOF).buffer, key);
      this.guard();
      await database.write(new Map([[proofName, sealed]]), true);
      proof = await database.read(proofName);
    }
    if (!proof || decoder.decode(await this.open(proofName, proof, 128, key)) !== PROOF)
      throw Error("The device conversation key could not be verified. Existing records are kept.");
    return key;
  }

  private async seal(name: string, bytes: ArrayBuffer, key: CryptoKey): Promise<SealedRecord> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({
      name: "AES-GCM", iv, additionalData: encoder.encode("Yoofloe/v1/" + name), tagLength: 128,
    }, key, bytes);
    return { version: VERSION, iv: iv.buffer, ciphertext };
  }

  private async open(name: string, record: SealedRecord, limit: number, key: CryptoKey): Promise<ArrayBuffer> {
    if (record?.version !== VERSION || !(record.iv instanceof ArrayBuffer) || record.iv.byteLength !== 12 ||
      !(record.ciphertext instanceof ArrayBuffer) || record.ciphertext.byteLength < TAG_BYTES ||
      record.ciphertext.byteLength > limit + TAG_BYTES) throw Error("The encrypted conversation record is invalid.");
    try {
      return await crypto.subtle.decrypt({
        name: "AES-GCM", iv: record.iv, additionalData: encoder.encode("Yoofloe/v1/" + name), tagLength: 128,
      }, key, record.ciphertext);
    } catch { throw Error("The encrypted conversation record could not be authenticated. The stored copy is kept."); }
  }

  async keys(prefix: string): Promise<string[]> {
    const scope = this.prefix();
    const names = await this.options.database.keys(scope + prefix);
    this.guard();
    return names.map(name => name.slice(scope.length));
  }

  async read(name: string, limit: number): Promise<ArrayBuffer | null> {
    const scope = this.prefix(), fullName = scope + name;
    const record = await this.options.database.read(fullName);
    this.guard();
    if (record === undefined) return null;
    const bytes = await this.open(fullName, record, limit, await this.key(scope, false));
    this.guard();
    return bytes;
  }

  async write(records: ReadonlyMap<string, ArrayBuffer>, keepExisting = false, changes?: RecordChanges): Promise<void> {
    if (!records.size) return;
    const scope = this.prefix(), key = await this.key(scope, true);
    const sealed = new Map<string, SealedRecord>();
    for (const [name, bytes] of records) {
      const fullName = scope + name;
      const existing = await this.options.database.read(fullName);
      if (existing !== undefined) {
        // Authenticate the previous record before replacing it.
        const limit = existing.ciphertext?.byteLength || 0;
        await this.open(fullName, existing, limit, key);
        if (keepExisting) continue;
      }
      sealed.set(fullName, await this.seal(fullName, bytes, key));
    }
    this.guard();
    await this.options.database.write(sealed, keepExisting, changes && {
      remove: changes.remove?.map(name => scope + name),
      removePrefixes: changes.removePrefixes?.map(prefix => scope + prefix),
      unlessPresent: changes.unlessPresent ? scope + changes.unlessPresent : undefined,
    });
    this.guard();
  }

  async import(entries: AsyncIterable<[string, ArrayBuffer]>): Promise<void> {
    const scope = this.prefix(), database = this.options.database;
    const transaction = scope + "staged/" + crypto.randomUUID() + "/";
    const staged = new Map<string, string>();
    let key: CryptoKey | undefined;
    try {
      for await (const [name, bytes] of entries) {
        this.guard();
        key ??= await this.key(scope, true);
        const destination = scope + name;
        const existing = await database.read(destination);
        if (existing) {
          const saved = new Uint8Array(await this.open(destination, existing, bytes.byteLength, key));
          const incoming = new Uint8Array(bytes);
          if (saved.length !== incoming.length || saved.some((byte, index) => byte !== incoming[index]))
            throw Error("A saved message conflicts with the vault copy.");
          continue;
        }
        const temporary = transaction + name;
        const sealed = await this.seal(destination, bytes, key);
        this.guard();
        staged.set(temporary, destination);
        await database.write(new Map([[temporary, sealed]]), true);
      }
      this.guard();
      if (staged.size) await database.promote(staged);
      this.guard();
    } catch (error) {
      if (staged.size && this.options.current()) await database.discard(staged.keys()).catch(() => {});
      throw error;
    }
  }
}
