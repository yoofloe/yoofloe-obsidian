import test from 'node:test';
import assert from 'node:assert/strict';
import { DeviceRecords } from '../dist/device-records.js';
import { ConversationStorage } from '../dist/conversation-storage.js';
import { SharedConversations } from '../dist/shared-conversations.js';
import { AiWorkspace } from '../dist/workspace.js';
import { chatPreview } from '../dist/chat-history.js';
import { collectConversationForCopy, formatCopiedConversation } from '../dist/chat-copy.js';
import { allowedPath } from '../dist/agent-policy.js';
import { Diagnostics } from '../dist/diagnostics.js';
import { environment, exportedReport } from './fixtures/diagnostics.mjs';

const encode = value => new TextEncoder().encode(JSON.stringify(value)).buffer;

function disk() {
  const rows = new Map(), secrets = new Map(), legacy = new Map();
  const namespace = crypto.randomUUID();
  const database = {
    read: async key => structuredClone(rows.get(key)),
    keys: async prefix => [...rows.keys()].filter(key => key.startsWith(prefix)),
    write: async (records, keep = false, changes) => {
      if (changes?.unlessPresent && rows.has(changes.unlessPresent)) throw Error("Blocked write");
      for (const key of changes?.remove ?? []) rows.delete(key);
      for (const prefix of changes?.removePrefixes ?? [])
        for (const key of rows.keys()) if (key.startsWith(prefix)) rows.delete(key);
      for (const [key, record] of records) if (!keep || !rows.has(key)) rows.set(key, structuredClone(record));
    },
    promote: async staged => {
      for (const key of staged.keys()) assert(rows.has(key));
      for (const [key, destination] of staged) {
        if (!rows.has(destination)) rows.set(destination, rows.get(key));
        rows.delete(key);
      }
    },
    discard: async keys => { for (const key of keys) rows.delete(key); },
  };
  const secretStorage = { getSecret: key => secrets.get(key) ?? null, setSecret: (key, value) => secrets.set(key, value) };
  const device = new DeviceRecords({ database, vaultId: () => namespace, secrets: () => secretStorage, current: () => true });
  const source = {
    read: async (key, limit) => {
      const bytes = legacy.get(key);
      if (bytes && bytes.byteLength > limit) throw Error('The fixture exceeds its size limit.');
      return bytes?.slice(0) ?? null;
    },
    list: async prefix => [...legacy.keys()].filter(key => key.startsWith(prefix + '/')),
  };
  return { rows, secrets, legacy, database, device, namespace, storage: new ConversationStorage(device, source, () => true) };
}

function vault() {
  const files = new Map(), folders = new Set();
  const child = (name, parent) => name.startsWith(parent + '/') && !name.slice(parent.length + 1).includes('/');
  return {
    files, folders,
    host: {
      current: () => true,
      read: async (path, limit) => {
        const value = files.get(path);
        if (value && Buffer.byteLength(value) > limit) throw Error('The fixture exceeds its size limit.');
        return value ?? null;
      },
      list: async path => ({
        files: [...files.keys()].filter(name => child(name, path)),
        folders: [...folders].filter(name => child(name, path)),
      }),
      mkdir: async path => {
        const parts = path.split('/');
        for (let index = 1; index <= parts.length; index++) folders.add(parts.slice(0, index).join('/'));
      },
      create: async (path, text) => {
        if (files.has(path)) throw Error('The fixture file exists.');
        files.set(path, text);
      },
      remove: async (path, expected) => {
        assert.equal(files.get(path), expected);
        files.delete(path);
      },
    },
    receive(other) {
      for (const folder of other.folders) folders.add(folder);
      for (const [path, data] of other.files) files.set(path, data);
    },
  };
}

function peer(sharedVault = vault(), local = disk()) {
  const outgoing = [];
  const sharing = new SharedConversations(sharedVault.host);
  const notes = new Map(['First.md', 'Second.md'].map(path => [path, { path, title: path, identity: {}, size: 10, text: 'Fixture ' + path }]));
  const host = { files: () => [...notes.values()], read: async file => file.text };
  let configured = true;
  const options = {
    current: () => true, gate: { busy: false }, configDir: '.obsidian', host: () => host,
    inboxHint: () => '', storage: local.storage, sharing,
    preferences: { read: async () => ({ model: 'gpt-6-luna', effort: 'low' }), hasKey: async () => configured,
      key: async () => configured ? 'sk-synthetic-agent-key' : null },
    transport: async request => {
      outgoing.push(JSON.parse(request.body));
      return { status: 200, text: JSON.stringify({ status: 'completed',
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Fixture answer.' }] }] }) };
    },
  };
  return { work: new AiWorkspace(options), outgoing, options, local, sharing, sharedVault,
    configure: value => { configured = value; } };
}

function message(conversationId, id, at, text = 'Message ' + id) {
  return {
    id, conversationId, request: text, answer: 'Answer ' + id, startedAt: at, model: 'gpt-6-luna',
    status: 'completed', requests: 1, inputTokens: 10, outputTokens: 10, actions: [], sourceMode: 'provided',
  };
}

async function saveHistory(peer, turns) {
  for (const turn of turns) await peer.local.storage.saveChat(turn);
  peer.work.chat = turns.slice(-50);
  await peer.work.persist();
}

test('concurrent first writes verify the same device encryption proof', async () => {
  const { database, device, namespace, secrets, rows } = disk();
  const diagnostics = new DeviceRecords({ database, current: () => true, vaultId: () => namespace,
    secrets: () => ({ getSecret: key => secrets.get(key) ?? null, setSecret: (key, value) => secrets.set(key, value) }) });
  const read = database.read;
  let overlapped = false;
  database.read = async key => {
    const row = await read(key);
    if (!overlapped && !row && key === namespace + '/key-proof') {
      overlapped = true;
      await diagnostics.write(new Map([['diagnostics/fixture.json', encode({ diagnostic: true })]]));
    }
    return row;
  };
  await device.write(new Map([['workspace.json', encode({ conversation: true })]]));
  assert(overlapped);
  assert.equal(secrets.size, 1);
  assert.equal(rows.size, 3);
  assert.deepEqual(await device.read('diagnostics/fixture.json', 100), encode({ diagnostic: true }));
  assert.deepEqual(await diagnostics.read('workspace.json', 100), encode({ conversation: true }));
});

test('sync import and failure are diagnosable with device-encrypted reports outside the shared vault', async () => {
  const primary = peer();
  const receiver = peer();
  receiver.options.diagnostics = new Diagnostics(receiver.local.device, environment, () => true);
  await primary.work.initialize();
  await saveHistory(primary, [message('inbox', 'private-message-identifier', Date.now(), 'Private synced request')]);
  assert.equal(await primary.work.syncConversation('inbox'), true);
  const binding = primary.work.activeConversation.shared;
  receiver.sharedVault.receive(primary.sharedVault);
  await receiver.work.initialize();
  const previousConversation = receiver.work.activeConversation.id;
  assert.equal(await receiver.work.openSyncedConversation(binding.id, binding.revision), true);
  const destination = receiver.work.activeConversation.id;
  assert.notEqual(destination, previousConversation);
  assert.equal(await receiver.options.diagnostics.copyReport({ conversation: previousConversation }), null);
  const text = await receiver.options.diagnostics.copyReport({ conversation: destination });
  const report = exportedReport(text);
  assert.equal(report.area, 'conversation_sync');
  assert.equal(report.outcome, 'completed');
  assert(report.events.some(event => event.stage === 'sync_message' && event.count === 1));
  assert.doesNotMatch(text, /Private synced request|private-message-identifier/);
  await receiver.options.diagnostics.flush();
  const diagnosticRecords = [...receiver.local.rows].filter(([name]) => name.includes('/diagnostics/'));
  assert(diagnosticRecords.length);
  for (const [name, record] of diagnosticRecords) {
    assert.equal(record.version, 1);
    assert(!Buffer.from(record.ciphertext).toString('utf8').includes('sync_message'));
    const raw = await receiver.local.device.read(name.slice(receiver.local.namespace.length + 1), 65536);
    assert.equal(JSON.parse(new TextDecoder().decode(raw)).area, 'conversation_sync');
  }
  assert(![...receiver.sharedVault.files.keys()].some(name => name.includes('diagnostics')));
  assert.equal(await receiver.work.openSyncedConversation(binding.id, '0'.repeat(64)), false);
  const [failed] = (await receiver.options.diagnostics.recentIssues()).reports;
  assert.equal(failed.lastFailure.reason, 'revision_unavailable');
  receiver.options.diagnostics.dispose();
});

test('legacy conversation and full archive import as authenticated device records while retaining the source', async () => {
  const local = disk();
  const turn = { ...message('inbox', 'long', 100), request: 'draft prompt '.repeat(500), answer: 'original long answer '.repeat(1600) };
  local.legacy.set('workspace.json', encode({ prompt: 'Private draft', chat: [chatPreview(turn)] }));
  local.legacy.set('chats/long.json', encode(turn));
  const original = new Map(local.legacy);
  const work = peer(vault(), local);
  await work.work.initialize();
  await local.storage.migrateLegacy();
  assert.equal(work.work.prompt, 'Private draft');
  assert.equal((await work.work.fullChat('long')).answer, turn.answer);
  assert.equal(local.secrets.size, 1);
  assert.deepEqual(local.legacy, original);
  const name = local.namespace + '/workspace.json';
  const first = structuredClone(local.rows.get(name));
  await work.work.persist();
  const again = structuredClone(local.rows.get(name));
  assert.notDeepEqual(first.iv, again.iv);
  for (const record of local.rows.values()) {
    assert.equal(record.version, 1);
    assert(!Buffer.from(record.ciphertext).includes(Buffer.from('Private draft')));
  }
  local.secrets.clear();
  await assert.rejects(local.storage.load(), /key is missing/);
  await assert.rejects(local.storage.save({ prompt: 'Cannot overwrite' }), /key is missing/);
  assert.deepEqual(local.rows.get(name), again);
  assert.equal(local.secrets.size, 0);
  assert.equal(work.outgoing.length, 0);
});

test('a damaged or swapped record blocks reading and saving the affected conversation', async () => {
  const one = disk();
  const a = 'alpha', b = 'beta';
  await one.storage.saveConversation(a, { prompt: 'alpha draft' });
  await one.storage.saveConversation(b, { prompt: 'beta draft' });
  const keyA = one.namespace + '/conversations/alpha.json';
  const keyB = one.namespace + '/conversations/beta.json';
  const goodB = structuredClone(one.rows.get(keyB));
  one.rows.set(keyB, structuredClone(one.rows.get(keyA)));
  await assert.rejects(one.storage.loadConversation(b), /authenticated/);
  await assert.rejects(one.storage.saveConversation(b, { prompt: 'new beta draft' }), /authenticated/);
  assert.equal((await one.storage.loadConversation(a)).prompt, 'alpha draft');
  one.rows.set(keyB, goodB);
  new Uint8Array(goodB.ciphertext)[4] ^= 0x55;
  await assert.rejects(one.storage.loadConversation(b), /authenticated/);
});

test('only opted-in history arrives and full copy and the next explicit request retain the right context', async () => {
  const shared = vault(), a = peer(shared), b = peer(shared);
  await a.work.initialize();
  const other = a.work.library.active;
  await saveHistory(a, [message(other, 'private', 1, 'Device-only private history')]);
  assert(await a.work.createConversation());
  const id = a.work.library.active;
  const turns = Array.from({ length: 55 }, (_, index) => message(id, 'turn-' + index, index + 1));
  turns[1].answer = 'begin ' + 'pełna odpowiedź '.repeat(2000) + ' END';
  turns[54].request = 'Show Polish number readings in parentheses.';
  turns[54].steers = [{ id: 'steer-one', text: 'Use the short reading style.' }];
  turns[54].sourcePath = 'First.md';
  turns[54].actions = [{ kind: 'edit', path: 'First.md' }];
  await saveHistory(a, turns);
  a.work.setPrompt('Unsent local draft');
  a.work.setFollowUpDraft('Local follow-up draft');
  assert.equal(shared.files.size, 0);
  assert(await a.work.syncConversation(id));
  const binding = a.work.activeConversation.shared;
  assert(binding?.revision);
  assert.equal(a.work.prompt, 'Unsent local draft');

  b.configure(false);
  await b.work.initialize();
  b.work.setPrompt('Keep the receiver draft');
  await b.work.refreshSharedConversations();
  assert.deepEqual(b.work.sharedConversations.map(item => item.id), [binding.id]);
  assert.equal(b.work.library.conversations.length, 1);
  const newest = await b.sharing.describe(binding.id, binding.revision);
  const tailRef = newest.refs.at(-1);
  const missing = [...shared.files.keys()].find(path => path.endsWith('message-' + tailRef[1] + '-0.md'));
  assert(missing);
  const bytes = shared.files.get(missing);
  shared.files.delete(missing);
  await b.work.refreshSharedConversations();
  assert.equal(b.work.sharedConversations[0].versions[0].ready, false);
  assert.equal(await b.work.openSyncedConversation(binding.id, binding.revision), false);
  assert.equal(b.work.library.active, other);
  assert.equal(b.work.prompt, 'Keep the receiver draft');
  assert.equal((await b.local.device.keys('chats/')).length, 0);

  shared.files.set(missing, bytes);
  assert(await b.work.openSyncedConversation(binding.id, binding.revision));
  const receiverId = b.work.library.active;
  assert.notEqual(receiverId, id);
  assert.equal(b.work.chat.length, 50);
  assert.equal(b.work.prompt, '');
  assert.equal(b.work.followUpDraft, '');
  assert.equal(b.work.followUps.length, 0);
  assert(b.work.chat.every(turn => turn.conversationId === receiverId));
  const history = await collectConversationForCopy(b.work.chat, receiverId,
    offset => b.work.searchChats('', offset, receiverId, true), key => b.work.fullChat(key, receiverId), () => true);
  assert.equal(history.length, 55);
  assert.deepEqual(history.map(turn => turn.answer), turns.map(turn => turn.answer));
  assert(formatCopiedConversation(history, [{ turnId: history[1].id, role: 'assistant' }]).includes(turns[1].answer));
  assert.deepEqual((await b.work.searchChats('Device-only private history')).turns, []);
  assert.equal(b.outgoing.length, 0);
  assert.equal(a.outgoing.length, 0);

  b.configure(true);
  await b.work.refreshSettings();
  b.work.mode = 'ask';
  assert(b.work.attachNote({ path: 'Second.md' }));
  b.work.readScope = 'current';
  b.work.setPrompt('Do the same here.');
  await b.work.run();
  assert.equal(b.outgoing.length, 1, b.work.message);
  const request = JSON.parse(b.outgoing[0].input[0].content);
  assert.equal(request.current_note.path, 'Second.md');
  assert.equal(request.permissions.data, 'current');
  assert(request.recent_user_requests.some(entry => entry.request === turns[54].request &&
    entry.corrections.includes('Use the short reading style.')));
  assert(!JSON.stringify(b.outgoing[0]).includes('Unsent local draft'));

  const fastForward = await b.sharing.describe(binding.id, b.work.activeConversation.shared.revision);
  assert.equal(fastForward.refs.length, 56);
  assert(await a.work.openSyncedConversation(binding.id, b.work.activeConversation.shared.revision, id));
  assert.equal(a.work.library.active, id);
  assert.equal(a.work.prompt, 'Unsent local draft');
  assert.equal(a.work.followUpDraft, 'Local follow-up draft');
  assert.equal(a.work.chat.at(-1).request, 'Do the same here.');
});

test('offline branches coexist and Stop syncing preserves unopened versions before removing the shared files', async () => {
  const left = peer(), right = peer();
  await left.work.initialize();
  const leftId = left.work.library.active;
  await saveHistory(left, [message(leftId, 'base-msg', 1, 'Base question')]);
  assert(await left.work.syncConversation(leftId));
  const binding = left.work.activeConversation.shared;
  right.sharedVault.receive(left.sharedVault);
  await right.work.initialize();
  assert(await right.work.openSyncedConversation(binding.id, binding.revision));

  left.work.mode = right.work.mode = 'ask';
  left.work.setPrompt('Left branch question');
  right.work.setPrompt('Right branch question');
  await left.work.run();
  await right.work.run();
  assert.equal(left.outgoing.length, 1, left.work.message);
  assert.equal(right.outgoing.length, 1, right.work.message);
  const leftHead = left.work.activeConversation.shared.revision;
  const rightHead = right.work.activeConversation.shared.revision;
  assert.notEqual(leftHead, rightHead);
  left.sharedVault.receive(right.sharedVault);
  await left.work.refreshSharedConversations();
  assert.deepEqual(new Set(left.work.sharedConversations[0].versions.map(item => item.revision)), new Set([leftHead, rightHead]));
  assert.equal(left.work.chat.at(-1).request, 'Left branch question');
  assert(await left.work.stopConversationSync(leftId));
  assert.equal(left.work.library.conversations.length, 2);
  assert(left.work.library.conversations.every(item => !item.shared));
  const copy = left.work.library.conversations.find(item => item.id !== leftId);
  assert(await left.work.openConversation(copy.id));
  assert.equal(left.work.chat.at(-1).request, 'Right branch question');
  assert.equal([...left.sharedVault.files.keys()].filter(key => key.endsWith('/stopped.md')).length, 1);
  assert.equal(left.sharedVault.files.size, 1);
  right.sharedVault.receive(left.sharedVault);
  await right.work.refreshSharedConversations();
  assert(!right.work.isSharing(right.work.activeConversation));
  assert.equal(right.work.chat.at(-1).request, 'Right branch question');
  await assert.rejects(right.sharing.publish({ id: binding.id, revision: rightHead }, 'Retry the old share', 3, []), /turned off/);
});

test('shared files are blocked even with Vault read and organize permissions', () => {
  const policy = { sourcePath: null, folder: '', readScope: 'vault', writeScope: 'vault', mode: 'all', configDir: '.obsidian', excluded: [] };
  const path = 'YOofloe AI/Shared Conversations/example.md';
  for (const action of ['read', 'edit', 'create', 'organize']) assert.equal(allowedPath(policy, path, action), false);
});

test('encrypted reopen preserves compacted context and reads a long recent answer beyond its preview', async () => {
  const a = peer();
  await a.work.initialize();
  a.work.mode = 'ask';
  a.work.setSourceMode('provided');
  assert(a.work.attachNote({ path: 'First.md' }));
  a.work.readScope = 'current';
  const id = a.work.library.active;
  const scope = await a.work.contextScope(a.work.policy(), 'provided', a.work.model.model, null, false);
  const base = message(id, 'compacted', 1, 'Original task');
  const long = { ...message(id, 'long-recent', 2, 'Use the latest note format.'),
    answer: 'Verified text '.repeat(1310) + ' LONG CONTEXT END', contextScope: scope };
  const checkpoint = { scope, turnId: base.id, at: 3, item: { type: 'compaction', encrypted_content: 'dGVzdC1jb21wYWN0aW9u' } };
  a.work.checkpoint = checkpoint;
  await saveHistory(a, [{ ...base, contextScope: scope }, long]);
  const b = new AiWorkspace(a.options);
  await b.initialize();
  assert.equal(b.chat.at(-1).answer.length, 16000);
  b.setPrompt('Continue the same style.');
  await b.run();
  assert.equal(a.outgoing.length, 1, b.message);
  assert(a.outgoing[0].input.some(item => item.type === 'compaction' &&
    item.encrypted_content === checkpoint.item.encrypted_content));
  assert(a.outgoing[0].input.some(item => item.role === 'assistant' && String(item.content).includes('LONG CONTEXT END')));
});

test('a failed shared-file removal is resumable after reopening the encrypted device copy', async () => {
  const a = peer();
  await a.work.initialize();
  const id = a.work.library.active;
  await saveHistory(a, [message(id, 'kept-turn', 1, 'Keep this answer')]);
  assert(await a.work.syncConversation(id));
  const remove = a.sharedVault.host.remove;
  a.sharedVault.host.remove = () => Promise.reject(Error('Synthetic filesystem interruption'));
  assert.equal(await a.work.stopConversationSync(id), false);
  assert(a.work.activeConversation.shared.stopping);
  assert.equal(a.work.chat[0].request, 'Keep this answer');

  const reopened = new AiWorkspace(a.options);
  await reopened.initialize();
  assert(reopened.activeConversation.shared.stopping);
  assert.equal(await reopened.syncConversation(id), false);
  a.sharedVault.host.remove = remove;
  assert(await reopened.stopConversationSync(id));
  assert.equal(reopened.chat[0].request, 'Keep this answer');
  assert.equal(a.sharedVault.files.size, 1);
});

test('an authenticated workspace with a damaged full message cannot prepare a paid follow-up', async () => {
  const a = peer();
  await a.work.initialize();
  const id = a.work.library.active;
  await saveHistory(a, [{ ...message(id, 'damaged-long', 1), answer: 'Unique long text '.repeat(1500) }]);
  const name = a.local.namespace + '/chats/' + id + '/damaged-long.json';
  const encrypted = a.local.rows.get(name);
  new Uint8Array(encrypted.ciphertext)[8] ^= 0x20;
  const reopened = new AiWorkspace(a.options);
  await reopened.initialize();
  assert.match(reopened.message, /could not be read/i);
  reopened.setPrompt('Could this send?');
  await reopened.run();
  assert.equal(a.outgoing.length, 0);
  assert.equal(a.local.rows.get(name), encrypted);
});

test('Delete removes only the chosen conversation and prevents legacy files from restoring it', async () => {
  const local = disk(), deleted = message('inbox', 'legacy-delete', 1, 'Gone from this device');
  local.legacy.set('workspace.json', encode({ prompt: 'Old device draft', chat: [deleted] }));
  local.legacy.set('chats/legacy-delete.json', encode(deleted));
  const backup = structuredClone(local.legacy.get('chats/legacy-delete.json'));
  const a = peer(vault(), local);
  await a.work.initialize();
  await a.local.storage.migrateLegacy();
  assert(await a.work.createConversation());
  const kept = a.work.library.active;
  await saveHistory(a, [message(kept, 'kept-message', 2, 'Keep this')]);
  a.work.setPrompt('Keep the other draft');
  await a.work.persist();
  assert(await a.work.openConversation('inbox'));
  assert(await a.work.deleteConversation('inbox'));
  assert.equal(a.work.library.active, kept);
  assert.equal(a.work.prompt, 'Keep the other draft');
  assert.equal(a.work.chat[0].request, 'Keep this');
  assert.deepEqual(await local.device.keys('chats/inbox/'), []);
  assert.equal(await local.storage.loadConversation('inbox'), null);
  assert.deepEqual(local.legacy.get('chats/legacy-delete.json'), backup);
  await assert.rejects(local.storage.saveChat(deleted), /Blocked write/);
  assert.deepEqual((await a.work.searchChats('Gone from this device')).turns, []);

  const reopened = new AiWorkspace(a.options);
  await reopened.initialize();
  assert.equal(reopened.library.active, kept);
  assert.equal(reopened.prompt, 'Keep the other draft');
  assert(!reopened.library.conversations.some(item => item.id === 'inbox'));
  assert.equal(await reopened.openConversation('inbox'), false);
});

test('deleting the last conversation leaves a new empty conversation across restart', async () => {
  const a = peer();
  await a.work.initialize();
  const id = a.work.library.active;
  await saveHistory(a, [message(id, 'last-turn', 1)]);
  a.work.setPrompt('Delete this draft too');
  a.work.setFollowUpDraft('Delete this follow-up draft too');
  await a.work.persist();
  assert(await a.work.deleteConversation(id));
  const replacement = a.work.library.active;
  assert.notEqual(replacement, id);
  assert.equal(a.work.library.conversations.length, 1);
  assert.deepEqual(a.work.chat, []);
  assert.deepEqual(a.work.followUps, []);
  assert.equal(a.work.prompt, '');
  assert.equal(a.work.followUpDraft, '');
  const reopened = new AiWorkspace(a.options);
  await reopened.initialize();
  assert.equal(reopened.library.active, replacement);
  assert.deepEqual(await a.local.device.keys('chats/'), []);
});

test('a shared conversation Delete keeps the vault files and hides the removed copy on this device', async () => {
  const shared = vault(), a = peer(shared), b = peer(shared);
  await a.work.initialize();
  const aId = a.work.library.active;
  await saveHistory(a, [message(aId, 'shared-turn', 1)]);
  assert(await a.work.syncConversation(aId));
  const binding = a.work.activeConversation.shared;
  await b.work.initialize();
  assert(await b.work.openSyncedConversation(binding.id, binding.revision));
  const bId = b.work.library.active;
  const filesBefore = new Map(shared.files);

  assert(await b.work.deleteConversation(bId));
  assert.deepEqual(shared.files, filesBefore);
  assert.deepEqual(b.work.library.hiddenShared, [binding.id]);
  assert.deepEqual(await b.local.device.keys('chats/' + bId + '/'), []);
  const reopened = new AiWorkspace(b.options);
  await reopened.initialize();
  assert.deepEqual(reopened.library.hiddenShared, [binding.id]);
  assert.equal(await reopened.openSyncedConversation(binding.id, binding.revision), false);
  assert.equal(a.work.activeConversation.shared.revision, binding.revision);
  assert.equal((await a.work.fullChat('shared-turn')).answer, 'Answer shared-turn');
});

test('a failed Delete transaction preserves the active conversation and draft', async () => {
  const a = peer();
  await a.work.initialize();
  const id = a.work.library.active;
  await saveHistory(a, [message(id, 'still-here', 1)]);
  a.work.setPrompt('Draft survives');
  await a.work.persist();
  const originalWrite = a.local.database.write;
  a.local.database.write = async (records, keepExisting, changes) => {
    if (changes?.removePrefixes?.length) throw Error('Write aborted by fixture');
    await originalWrite(records, keepExisting, changes);
  };
  assert.equal(await a.work.deleteConversation(id), false);
  assert.equal(a.work.library.active, id);
  assert.equal(a.work.prompt, 'Draft survives');
  assert.equal((await a.work.fullChat('still-here')).answer, 'Answer still-here');
  assert.match(a.work.libraryMessage,/saved copy is kept/i);
  assert.deepEqual(await a.local.device.keys('retired/'), []);
});
