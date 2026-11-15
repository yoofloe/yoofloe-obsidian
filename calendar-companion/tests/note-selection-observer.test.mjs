import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const { build } = createRequire(new URL('../../package.json', import.meta.url))('esbuild');
const bundle = await build({
  absWorkingDir: fileURLToPath(new URL('../', import.meta.url)),
  entryPoints: ['src/note-selection-observer.ts'], write: false,
  bundle: true, format: 'cjs', platform: 'browser',
});
const context = { module: { exports: {} }, exports: {} };
vm.runInNewContext(bundle.outputFiles[0].text, context);
const { observeNoteSelection } = context.module.exports;

class EventSurface {
  listeners = new Map();
  addEventListener(name, fn) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name).add(fn);
  }
  removeEventListener(name, fn) { this.listeners.get(name)?.delete(fn); }
  fire(type, target, details = {}) {
    for (const fn of this.listeners.get(type) ?? []) fn({ type, target, ...details });
  }
}
function fakeDocument() {
  let lastId = 0;
  const timers = new Map();
  const doc = new EventSurface();
  doc.defaultView = {
    setTimeout(fn, ms) { timers.set(++lastId, { fn, ms }); return lastId; },
    clearTimeout(id) { timers.delete(id); },
  };
  doc.getSelection = () => doc.selection;
  doc.flush = () => {
    for (const [id, timer] of [...timers.entries()].sort((a, b) => a[1].ms - b[1].ms || a[0] - b[0])) {
      if (timers.delete(id)) timer.fn();
    }
  };
  return doc;
}
function fakeNote(doc, mode = 'editor') {
  const root = new EventSurface();
  root.ownerDocument = doc;
  root.contains = element => element?.root === root;
  function node(selector) {
    return { nodeType: 1, root, closest: query => query.split(', ').includes(selector) ? root : null };
  }
  const body = node(mode === 'reading' ? '.markdown-preview-view' : '.cm-content');
  const control = node('textarea');
  const text = { nodeType: 3, parentElement: body };
  return { root, body, control, text, select(anchor = text, focus = text) {
    doc.selection = { anchorNode: anchor, focusNode: focus, isCollapsed: false };
    doc.fire('selectionchange', doc);
  } };
}
function start(note, pointerId = 1) {
  note.root.fire('pointerdown', note.body, { pointerId, button: 0, isPrimary: true, clientX: 10, clientY: 10 });
}
function finish(doc, note, pointerId = 1, type = 'pointerup') {
  doc.fire(type, note.body, { pointerId, clientX: 120, clientY: 20 });
}

test('a note drag stages only its final passage, and dismissing the chip keeps an unchanged range removed', () => {
  const doc = fakeDocument(), note = fakeNote(doc);
  let revision = 0, current = 'Interim passage', staged = null;
  const history = [];
  const stop = observeNoteSelection(note.root, () => ({ key: current, value: current }),
    (value, generation) => { if (generation === revision) { staged = value; history.push(value); } },
    () => ++revision);
  start(note);
  note.select();
  doc.flush();
  assert.equal(staged, null);
  current = 'Finished passage';
  finish(doc, note);
  note.select();
  doc.flush();
  assert.deepEqual(history, ['Finished passage']);
  staged = null;
  note.select();
  doc.flush();
  assert.equal(staged, null);
  start(note);
  finish(doc, note);
  doc.flush();
  assert.deepEqual(history, ['Finished passage', 'Finished passage']);
  stop();
});

test('native reading selection handles retain the final range after focus moves to the composer', () => {
  const doc = fakeDocument(), note = fakeNote(doc, 'reading');
  let current = 'First range', latest = 0;
  const seen = [];
  const stop = observeNoteSelection(note.root, () => current ? { key: current, value: current } : null,
    (value, generation) => { if (generation === latest) seen.push(value); }, () => ++latest);
  start(note);
  finish(doc, note, 1, 'pointercancel');
  note.select();
  doc.flush();
  assert.deepEqual(seen, ['First range']);
  current = 'Range after moving handles';
  note.select();
  current = null;
  doc.selection = { isCollapsed: true };
  doc.fire('selectionchange', doc);
  doc.flush();
  assert.deepEqual(seen, ['First range', 'Range after moving handles']);
  stop();
});

test('selection in a form or across another view does not stage text, and closing a note cancels the pending observation', () => {
  const doc = fakeDocument(), note = fakeNote(doc, 'reading'), second = fakeNote(doc, 'reading');
  let latest = 0, samples = 0, staged = 0;
  const stop = observeNoteSelection(note.root, () => { samples++; return { key: 'range', value: 'range' }; },
    () => { staged++; }, () => ++latest);
  note.select(note.control, note.control);
  note.select(note.text, second.text);
  doc.flush();
  assert.equal(samples, 0);
  assert.equal(staged, 0);
  note.select();
  stop();
  doc.flush();
  note.select();
  doc.flush();
  assert.equal(samples, 1);
  assert.equal(staged, 0);
});

test('a delayed selection in an older note can never supersede the most recent note selection', () => {
  const doc = fakeDocument(), first = fakeNote(doc, 'reading'), second = fakeNote(doc, 'reading');
  let latest = 0;
  const seen = [];
  const watch = (note, value) => observeNoteSelection(note.root, () => ({ key: value, value }),
    (captured, generation) => { if (generation === latest) seen.push(captured); }, () => ++latest);
  const stopFirst = watch(first, 'Older');
  const stopSecond = watch(second, 'Newer');
  first.select();
  second.select();
  doc.flush();
  assert.deepEqual(seen, ['Newer']);
  stopFirst();
  stopSecond();
});
