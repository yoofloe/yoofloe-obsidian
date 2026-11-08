import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { OpenAiSession } from '../dist/openai.js';
const { build } = createRequire(new URL('../../package.json', import.meta.url))('esbuild');
const bundle = await build({ absWorkingDir: fileURLToPath(new URL('../', import.meta.url)), entryPoints: ['src/ai-modals.ts'], write: false, bundle: true, format: 'cjs', platform: 'browser', external: ['obsidian'], target: 'es2022' });

class Element {
  children = []; settings = []; classList = { add() {} }; value = '';
  empty() { this.children = []; this.settings = []; }
  createEl(tag, options = {}) { const el = new Element(); el.tag = tag; el.text = options.text; this.children.push(el); return el; }
  createDiv() { return this.createEl('div'); }
  setAttribute() {}
  appendText(value) { this.children.push(Object.assign(new Element(), { text: value })); }
  allSettings() { return [...this.settings, ...this.children.flatMap(child => child.allSettings())]; }
  allText() { return [this.text ?? '', ...this.children.map(child => child.allText())].join('\n'); }
}
class Modal {
  constructor(app) { this.app = app; this.contentEl = new Element(); }
  open() { this.onOpen(); } close() { this.onClose(); }
}
class Control {
  inputEl = new Element(); disabled = false; value = false;
  selectEl = new Element(); choices = new Map();
  addOption(value, label) { this.choices.set(value, label); return this; }
  setValue(value) { this.value = value; this.inputEl.value = value; return this; }
  setPlaceholder(value) { this.placeholder = value; return this; } setDisabled(value) { this.disabled = value; return this; }
  setButtonText(value) { this.text = value; return this; } setCta() { return this; }
  onChange(cb) { this.change = cb; return this; } onClick(cb) { this.click = cb; return this; }
  fire(value) { assert(!this.disabled, 'disabled controls cannot dispatch'); if (this.click) return this.click(); this.value = value; this.inputEl.value = value; return this.change(value); }
}
class Setting {
  controls = [];
  constructor(el) { el.settings.push(this); }
  setName(value) { this.name = value; return this; } setDesc(value) { this.desc = value; return this; }
  add(callback) { const control = new Control(); this.controls.push(control); callback(control); return this; }
  addButton(cb) { return this.add(cb); } addText(cb) { return this.add(cb); } addTextArea(cb) { return this.add(cb); } addToggle(cb) { return this.add(cb); } addDropdown(cb) { return this.add(cb); }
}
function modals() {
  const context = { module: { exports: {} }, require: name => { assert.equal(name, 'obsidian'); return { App: class {}, Modal, Setting }; }, crypto, TextEncoder, TextDecoder, Date, Error };
  vm.runInNewContext(bundle.outputFiles[0].text, context); return context.module.exports;
}
const button = (modal, text) => { const found = modal.contentEl.allSettings().flatMap(row => row.controls).find(control => control.text === text); assert(found, `button ${text}`); return found; };
const field = (modal, name) => { const row = modal.contentEl.allSettings().find(row => row.name === name); assert(row, `field ${name}`); return row.controls[0]; };
const settle = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); };
function fixture(initialModel = 'offline-test-model') {
  const calls = [], files = new Map(); let key = null, savedOptions = { model: initialModel };
  const preferences = { read: async () => ({ ...savedOptions }), hasKey: async () => Boolean(key), key: async () => key,
    save: async options => { savedOptions = { ...options }; }, saveKey: async value => { key = value; }, clearKey: async () => { key = null; } };
  const session = new OpenAiSession({ current: () => true, key: preferences.key, transport: async request => { calls.push(request); return { status: 200, text: JSON.stringify({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '<b>A synthetic draft</b>' }] }] }) }; } });
  return { ai: { session, preferences, current: () => true }, calls, files, store: { mkdir: async () => {}, create: async (path, text) => { assert(!files.has(path)); files.set(path, text); } } };
}
test('settings UI loads disabled, stores and removes a synthetic key with zero transport calls', async () => {
  const f = fixture(), { OpenAiSettingsModal } = modals(); let closed = false;
  const modal = new OpenAiSettingsModal({}, f.ai, () => { closed = true; }); modal.open(); await settle();
  assert.equal(field(modal, 'Enable OpenAI for this session').value, false); assert.equal(field(modal, 'Enable OpenAI for this session').disabled, true);
  const input = field(modal, 'No API key saved'); assert.equal(input.inputEl.type, 'password'); assert.equal(input.inputEl.value, '');
  input.inputEl.value = 'sk-offline-fixture-only-never-real'; button(modal, 'Save key locally').fire(); await settle();
  assert.equal(f.calls.length, 0); assert.equal(field(modal, 'API key saved locally').inputEl.value, '');
  field(modal, 'Enable OpenAI for this session').fire(true); assert.equal(f.ai.session.enabled, true); assert.equal(f.calls.length, 0);
  button(modal, 'Remove saved key').fire(); await settle(); assert.equal(f.ai.session.enabled, false); assert.equal(f.calls.length, 0);
  modal.close(); assert.equal(closed, true);
});
test('draft UI requires selection, review and per-request approval before a mock generation, then explicit saving', async () => {
  const f = fixture(), { OpenAiDraftModal } = modals(); await f.ai.preferences.saveKey('sk-offline-fixture-only-never-real'); f.ai.session.enableForSession(true);
  const record = { id: 'not-transmitted-fixture-id', kind: 'task', revision: 1, title: 'Fixture task', text: 'Status: pending', date: '2026-11-09' };
  const modal = new OpenAiDraftModal({}, f.ai, [record], f.store, () => true, () => {}); modal.open(); await settle();
  assert.equal(field(modal, 'Fixture task').value, false); assert.equal(f.calls.length, 0);
  field(modal, 'Your request').fire('Prepare a checklist.'); button(modal, 'Review request').fire();
  assert(modal.contentEl.allText().includes('Choose 1-50')); assert.equal(field(modal, 'Your request').inputEl.value, 'Prepare a checklist.');
  field(modal, 'Fixture task').fire(true); button(modal, 'Review request').fire();
  assert.equal(f.calls.length, 0); assert(modal.contentEl.allText().includes('Status: pending')); assert(!modal.contentEl.allText().includes(record.id));
  assert.equal(button(modal, 'Generate once with OpenAI').disabled, true);
  field(modal, 'I approve this transmission and any OpenAI API charges').fire(true);
  button(modal, 'Generate once with OpenAI').fire(); await settle(); assert.equal(f.calls.length, 1); assert.equal(f.files.size, 0);
  assert(modal.contentEl.allText().includes('<b>A synthetic draft</b>'));
  button(modal, 'Save draft as new note').fire(); await settle(); assert.equal(f.files.size, 1);
  assert([...f.files.values()][0].includes('&lt;b&gt;')); assert.equal(button(modal, 'Draft saved').disabled, true); modal.close();
});
test('returning from review preserves the prompt and selected records without any API call', async () => {
  const f = fixture(), { OpenAiDraftModal } = modals(); f.ai.session.enableForSession(true);
  const modal = new OpenAiDraftModal({}, f.ai, [{ kind: 'note', title: 'Fixture', text: 'Body', date: null }], f.store, () => true, () => {}); modal.open(); await settle();
  field(modal, 'Fixture').fire(true); field(modal, 'Your request').fire('Keep my draft request'); button(modal, 'Review request').fire(); button(modal, 'Back to selection').fire();
  assert.equal(field(modal, 'Your request').inputEl.value, 'Keep my draft request'); assert.equal(field(modal, 'Fixture').value, true); assert.equal(f.calls.length, 0); modal.close();
});

test('model dropdown offers current presets with an economical default and Custom without any API call', async () => {
  const f = fixture('gpt-6-luna'), { OpenAiSettingsModal } = modals();
  const modal = new OpenAiSettingsModal({}, f.ai, () => {}); modal.open(); await settle();
  const selector = field(modal, 'Model');
  assert.equal(selector.value, 'gpt-6-luna'); assert.equal(selector.choices.size, 5);
  assert(selector.choices.get('gpt-6-luna').includes('recommended')); assert(selector.choices.get('gpt-6-astra').includes('Higher cost'));
  assert(modal.contentEl.allText().includes('2026-11-08')); assert.equal(f.calls.length, 0);
  assert(modal.contentEl.allText().includes('No plugin output-token cap')); assert(!modal.contentEl.allSettings().some(row => row.name === 'Maximum output tokens'));
  selector.fire('gpt-6.1-terra'); button(modal, 'Save model settings').fire(); await settle();
  assert.equal((await f.ai.preferences.read()).model, 'gpt-6.1-terra'); assert.equal(f.ai.session.enabled, false); assert.equal(f.calls.length, 0); modal.close();
});
test('Custom preserves an existing model ID and its draft when switching presets; examples guide validation', async () => {
  const f = fixture('my-account-model-2026'), { OpenAiSettingsModal } = modals();
  const modal = new OpenAiSettingsModal({}, f.ai, () => {}); modal.open(); await settle();
  assert.equal(field(modal, 'Model').value, '__custom__'); assert.equal(field(modal, 'Custom model ID').value, 'my-account-model-2026');
  assert.equal(field(modal, 'Custom model ID').placeholder, 'e.g. gpt-6-luna'); assert(modal.contentEl.allText().includes('not a ChatGPT display name or an API key'));
  field(modal, 'Custom model ID').fire('my-new-model'); field(modal, 'Model').fire('gpt-6-luna'); field(modal, 'Model').fire('__custom__');
  assert.equal(field(modal, 'Custom model ID').value, 'my-new-model');
  field(modal, 'Custom model ID').fire(''); assert.equal(button(modal, 'Save model settings').disabled, true);
  field(modal, 'Custom model ID').fire('GPT 6 Luna'); assert.equal(button(modal, 'Save model settings').disabled, true);
  field(modal, 'Custom model ID').fire('sk-offline-fixture-never-real'); assert.equal(button(modal, 'Save model settings').disabled, true);
  field(modal, 'Custom model ID').fire('ft:gpt-6-luna:fixture:custom'); assert.equal(button(modal, 'Save model settings').disabled, false);
  button(modal, 'Save model settings').fire(); await settle(); assert.equal((await f.ai.preferences.read()).model, 'ft:gpt-6-luna:fixture:custom'); assert.equal(f.calls.length, 0); modal.close();
});
test('selecting and saving a model preserves an unsaved masked key; closing clears it', async () => {
  const f = fixture('gpt-6-luna'), { OpenAiSettingsModal } = modals();
  const modal = new OpenAiSettingsModal({}, f.ai, () => {}); modal.open(); await settle();
  const input = field(modal, 'No API key saved'); input.inputEl.value = 'sk-unsaved-offline-fixture-only';
  field(modal, 'Model').fire('__custom__'); assert.equal(field(modal, 'No API key saved'), input);
  field(modal, 'Custom model ID').fire('custom-fixture-model'); button(modal, 'Save model settings').fire(); await settle();
  const kept = field(modal, 'No API key saved').inputEl; assert.equal(kept.value, 'sk-unsaved-offline-fixture-only');
  assert.equal(kept.type, 'password'); assert.equal(await f.ai.preferences.hasKey(), false); assert.equal(f.calls.length, 0);
  modal.close(); assert.equal(kept.value, '');
});
