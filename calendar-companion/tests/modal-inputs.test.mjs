import test from 'node:test';
import assert from 'node:assert/strict';
import { keepModalInputsVisible } from '../dist/modal-inputs.js';

function fixture() {
  class Target extends EventTarget {}
  const viewport = Object.assign(new Target(), { height: 900 });
  const frames = new Map(), timers = new Map(); let id = 0, scrolls = 0;
  const win = Object.assign(new Target(), { visualViewport: viewport, innerHeight: 900,
    requestAnimationFrame: cb => { frames.set(++id, cb); return id; }, cancelAnimationFrame: key => frames.delete(key),
    setTimeout: cb => { timers.set(++id, cb); return id; }, clearTimeout: key => timers.delete(key) });
  const input = { type: 'text', matches: selector => selector.startsWith('textarea, input:not(') && !['checkbox','radio','button','submit','range','color','file','hidden'].includes(input.type), scrollIntoView: options => { assert.equal(options.block, 'start'); scrolls++; } };
  Object.defineProperty(input, 'value', { get() { throw Error('Never read protected input contents'); } });
  const doc = { defaultView: win, activeElement: input };
  const content = Object.assign(new Target(), { ownerDocument: doc, style: { paddingBottom: '12px' }, contains: value => value === input });
  const flush = map => { const pending = [...map.values()]; map.clear(); for (const run of pending) run(); };
  return { content, doc, viewport, win, frames, timers, input, scrolls: () => scrolls, frame: () => flush(frames), settle: () => flush(timers) };
}
test('an overlaid keyboard gets scroll room even when the host viewport does not shrink', () => {
  const f = fixture(), dispose = keepModalInputsVisible(f.content, () => true);
  f.content.dispatchEvent(new Event('focusin')); f.frame();
  assert.equal(f.content.style.paddingBottom, '900px'); assert.equal(f.scrolls(), 1);
  f.settle(); assert.equal(f.scrolls(), 2); assert.equal(f.timers.size, 0); dispose();
});
test('keyboard resize keeps the field above the keyboard and blur restores the original spacing', () => {
  const f = fixture(), dispose = keepModalInputsVisible(f.content, () => true);
  f.content.dispatchEvent(new Event('focusin')); f.frame();
  f.viewport.height = 450; f.viewport.dispatchEvent(new Event('resize')); f.frame();
  assert.equal(f.content.style.paddingBottom, '450px'); assert.equal(f.scrolls(), 2);
  f.doc.activeElement = null; f.content.dispatchEvent(new Event('focusout')); f.frame();
  assert.equal(f.content.style.paddingBottom, '12px'); dispose();
});
test('closing the modal cancels pending keyboard animation work and detaches listeners', () => {
  const f = fixture(), dispose = keepModalInputsVisible(f.content, () => true);
  f.content.dispatchEvent(new Event('focusin')); dispose(); f.frame(); f.settle();
  f.content.dispatchEvent(new Event('focusin')); f.win.dispatchEvent(new Event('resize')); f.viewport.dispatchEvent(new Event('resize'));
  assert.equal(f.frames.size, 0); assert.equal(f.timers.size, 0); assert.equal(f.scrolls(), 0); assert.equal(f.content.style.paddingBottom, '12px');
});

for (const type of ['checkbox','radio','button','range','color','file','hidden']) test(`${type} controls do not reserve keyboard space or move the record selection`, () => {
  const f = fixture(); f.input.type = type;
  const dispose = keepModalInputsVisible(f.content, () => true);
  f.content.dispatchEvent(new Event('focusin')); f.frame(); f.settle();
  assert.equal(f.scrolls(), 0); assert.equal(f.content.style.paddingBottom, '12px'); dispose();
});
