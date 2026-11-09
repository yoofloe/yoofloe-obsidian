import test from 'node:test';
import assert from 'node:assert/strict';
import { AiWorkspace } from '../dist/workspace.js';
const response = output => ({ status: 200, text: JSON.stringify({ status: 'completed', output }) });
function fixture() {
  let saved, calls = 0, keyReads = 0;
  const files = new Map(), journals = [];
  const host = { files: () => [...files.values()], read: async f => f.text,
    create: async (path, text) => { const f = { identity: {}, path, title: path, size: text.length, text }; files.set(path, f); return f; },
    persist: async j => journals.push(structuredClone(j)), backup: async () => { throw Error('Not expected'); } };
  const model = { model: 'gpt-6-luna', effort: 'low' };
  const options = { current: () => true, preferences: { read: async () => model, hasKey: async () => true, key: async () => { keyReads++; return 'sk-synthetic-agent-key'; }, save: async v => Object.assign(model, v), vaultId: async () => crypto.randomUUID() },
    configDir: '.obsidian', gate: { busy: false }, host: () => host, inboxHint: () => 'content://hint',
    storage: { load: async () => null, save: async v => { saved = structuredClone(v); }, history: async () => [] },
    transport: async request => { calls++; const body = JSON.parse(request.body); assert.equal(body.reasoning.effort, 'low');
      if (calls === 1) return response([{ type: 'function_call', call_id: 'new', name: 'create_note', arguments: JSON.stringify({ path: 'Welcome.md', markdown: '# Welcome\n```mermaid\ngraph TD; A-->B\n```' }) }]);
      assert(body.input.some(item => item.type === 'function_call_output'));
      return response([{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Created [[Welcome]].' }] }]); },
  };
  return { work: new AiWorkspace(options), options, host, files, journals, saved: () => saved, calls: () => calls, keyReads: () => keyReads };
}
test('standalone use without a note or Calendar creates a Markdown document only after explicit start and keeps result after view unsubscribe', async () => {
  const f = fixture(); await f.work.initialize(); assert.equal(f.calls(), 0); assert.equal(f.keyReads(), 0); assert.equal(f.work.source, null);
  f.work.setPrompt('Create a welcome document with a Mermaid diagram');
  await f.work.review(); assert.match(f.work.preview, /No existing note/); assert.equal(f.calls(), 0);
  const unsubscribe = f.work.subscribe(() => {}); unsubscribe();
  await f.work.run(); assert.equal(f.calls(), 2); assert.equal(f.keyReads(), 1); assert.match(f.files.get('Welcome.md').text, /```mermaid/);
  assert.equal(f.work.result, 'Created [[Welcome]].'); assert.equal(f.saved().result, f.work.result); assert.equal(f.work.prompt, '');
  assert.equal(f.journals[0].operations[0].status, 'pending'); assert.equal(f.work.history.length, 1);
});
test('a secret in a prompt is blocked locally before reading the key or calling OpenAI; draft remains', async () => {
  const f = fixture(); await f.work.initialize(); f.work.setPrompt('sk-proj-' + 'Z'.repeat(40));
  await f.work.run(); assert.equal(f.calls(), 0); assert.equal(f.keyReads(), 0); assert.match(f.work.message, /possible API key/); assert.match(f.work.prompt, /sk-proj/);
});
test('draft/result restoration is local, retains existing keys and does not silently retarget work to another note', async () => {
  const f = fixture(); await f.host.create('A.md', 'A'); await f.host.create('B.md', 'B');
  f.options.storage.load = async () => ({ prompt: 'Keep my draft', source: 'A.md', result: 'Existing answer', mode: 'ask' });
  await f.work.initialize(); f.work.bind({ path: 'B.md' }); assert.equal(f.work.source.path, 'A.md'); assert.equal(f.work.nextSource.path, 'B.md');
  assert.equal(f.work.result, 'Existing answer'); assert.equal(f.work.prompt, 'Keep my draft'); assert.equal(f.calls(), 0); assert.equal(f.keyReads(), 0);
  await f.work.newTask(f.work.nextSource); assert.equal(f.work.source.path, 'B.md'); assert.equal(f.work.previous[0].answer, 'Existing answer');
});
