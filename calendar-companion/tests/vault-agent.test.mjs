import test from 'node:test';
import assert from 'node:assert/strict';
import { VaultAgent, validateJournal } from '../dist/vault-agent.js';

function fixture(initial = { 'Notes/Plan.md': '# Plan\nOriginal', 'Notes/Other.md': '# Other\nRelevant study', 'Private/Key.md': 'sk-proj-' + 'A'.repeat(40) }) {
  const files = new Map(Object.entries(initial).map(([path, text]) => [path, { identity: {}, path, title: path.split('/').at(-1).slice(0, -3), size: text.length, text }]));
  const backups = new Map(), records = [], trace = [];
  const host = {
    files: () => [...files.values()], read: async f => files.get(f.path)?.identity === f.identity ? files.get(f.path).text : null,
    replace: async (f, expected, text) => { assert.equal(files.get(f.path).text, expected); trace.push('write'); files.get(f.path).text = text; },
    create: async (path, text) => { if (files.has(path)) throw Error('Exists'); const f = { identity: {}, path, title: path.slice(0, -3), size: text.length, text }; files.set(path, f); return f; },
    rename: async (f, path) => { if (files.has(path)) throw Error('Exists'); const item = files.get(f.path); files.delete(f.path); item.path = path; f.path = path; files.set(path, item); },
    folder: async () => true, properties: async (f, expected, values) => { assert.equal(f.text, expected); f.text = '---\n' + JSON.stringify(values) + '\n---\n' + f.text; },
    affected: () => [], trash: async f => { files.delete(f.path); },
    backup: async (path, text) => { trace.push('backup'); const p = `Yoofloe AI/Backups/${crypto.randomUUID()}.md`; backups.set(p, text); return p; },
    readBackup: async p => backups.get(p), persist: async j => { records.push(structuredClone(j)); trace.push('journal'); },
  };
  const policy = { sourcePath: 'Notes/Plan.md', folder: 'Notes', readScope: 'folder', writeScope: 'folder', mode: 'organize', configDir: '.obsidian', excluded: [] };
  const agent = new VaultAgent(host, policy, () => true);
  return { agent, host, files, backups, records, trace, policy };
}
test('edits require a read version, verified backup and durable journal before writing; Undo preserves newer user edits', async () => {
  const f = fixture(), original = await f.agent.initialContext();
  await assert.rejects(f.agent.execute('apply_changes', { changes: [{ reference: 'N1', version: 'stale', action: 'replace', markdown: 'Bad' }] }), /changed/);
  assert.equal(f.backups.size, 0);
  await f.agent.execute('apply_changes', { changes: [{ reference: 'N1', version: original.version, action: 'replace', markdown: '# Changed\n```mermaid\ngraph TD; A-->B\n```' }] });
  assert.deepEqual(f.trace.slice(0, 3), ['backup', 'journal', 'write']);
  assert.equal(f.records[0].operations[0].status, 'pending');
  assert.deepEqual(await f.agent.undo(), { restored: 1, kept: 0 });
  assert.equal(f.files.get('Notes/Plan.md').text, '# Plan\nOriginal');
  const g = fixture(), before = await g.agent.initialContext();
  await g.agent.execute('apply_changes', { changes: [{ reference: 'N1', version: before.version, action: 'append', markdown: 'AI text' }] });
  g.files.get('Notes/Plan.md').text += '\nHuman edit';
  assert.deepEqual(await g.agent.undo(), { restored: 0, kept: 1 });
  assert.match(g.files.get('Notes/Plan.md').text, /Human edit/);
});
test('selection stays bounded and a partial excerpt cannot replace an entire document', async () => {
  const f = fixture(); f.policy.selection = { from: 7, to: 15 }; f.policy.readScope = 'current';
  const a = new VaultAgent(f.host, f.policy, () => true), initial = await a.initialContext();
  assert.equal(initial.text, 'Original'); assert.equal(initial.selection_only, true);
  await assert.rejects(a.execute('apply_changes', { changes: [{ reference: 'N1', version: initial.version, action: 'replace', markdown: 'Bad' }] }), /complete/);
  await a.execute('apply_changes', { changes: [{ reference: 'N1', version: initial.version, action: 'replace_selection', markdown: 'Revised' }] });
  assert.equal(f.files.get('Notes/Plan.md').text, '# Plan\nRevised');
  const large = fixture({ 'Notes/Plan.md': 'x'.repeat(40000) });
  assert.equal((await large.agent.initialContext()).partial, true);
});
test('create collision, excluded secrets, corrupted backups and uncertain journals cannot overwrite an original', async () => {
  const f = fixture();
  await assert.rejects(f.agent.execute('create_note', { path: 'Notes/Plan.md', markdown: 'Bad' }), /exists/);
  f.policy.readScope = 'vault';
  const hits = await f.agent.execute('search_notes', { query: 'Key', limit: 4 });
  await assert.rejects(f.agent.execute('read_notes', { notes: [{ reference: hits.notes[0].reference, from_line: 1, through_line: 0 }] }), /possible API key/);
  const original = await f.agent.initialContext();
  await f.agent.execute('apply_changes', { changes: [{ reference: 'N1', version: original.version, action: 'replace', markdown: 'Changed' }] });
  f.backups.set(f.agent.journal.operations[0].backup, 'Corrupted');
  assert.deepEqual(await f.agent.undo(), { restored: 0, kept: 1 });
  assert.equal(f.files.get('Notes/Plan.md').text, 'Changed');
  const malformed = structuredClone(f.agent.journal); malformed.operations[0].backup = '../Private.md';
  assert.throws(() => validateJournal(malformed));
});
test('Trash requires a separate user action; a new file with the same name survives Undo', async () => {
  const f = fixture(); await f.agent.initialContext();
  await f.agent.execute('propose_trash', { references: ['N1'] }); assert.ok(f.files.has('Notes/Plan.md'));
  await f.agent.confirmTrash(); assert.equal(f.files.has('Notes/Plan.md'), false);
  await f.host.create('Notes/Plan.md', 'New user note');
  assert.deepEqual(await f.agent.undo(), { restored: 0, kept: 1 });
  assert.equal(f.files.get('Notes/Plan.md').text, 'New user note');
});
