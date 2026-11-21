import test from 'node:test';
import assert from 'node:assert/strict';
import { sizeComposerInput, submitComposerShortcut } from '../dist/composer-input.js';

test('only a single eligible Ctrl+Enter or Command+Enter in the focused composer submits', () => {
  const field = { ownerDocument: { activeElement: null } };
  field.ownerDocument.activeElement = field;
  let submissions = 0, composing = false;
  const button = { hidden: false, disabled: false, click: () => { submissions++; } };
  let action = button;
  const press = options => {
    const event = Object.assign(new Event('keydown', { cancelable: true }), { key: 'Enter', ctrlKey: false, metaKey: false }, options);
    return submitComposerShortcut(event, field, composing, action) === false;
  };

  assert.equal(press({}), false);
  assert.equal(press({ ctrlKey: true, shiftKey: true }), false);
  assert.equal(press({ metaKey: true, altKey: true }), false);
  assert.equal(press({ ctrlKey: true, isComposing: true }), false);
  composing = true;
  assert.equal(press({ ctrlKey: true }), false);
  composing = false;
  field.ownerDocument.activeElement = null;
  assert.equal(press({ metaKey: true }), false);
  field.ownerDocument.activeElement = field;
  assert.equal(press({ ctrlKey: true, repeat: true }), true);
  button.disabled = true;
  press({ ctrlKey: true });
  button.disabled = false;
  button.hidden = true;
  press({ metaKey: true });
  button.hidden = false;
  action = null;
  press({ ctrlKey: true });
  assert.equal(submissions, 0);

  action = button;
  assert.equal(press({ ctrlKey: true }), true);
  assert.equal(press({ metaKey: true }), true);
  assert.equal(submissions, 2);
});

test('each composer respects its minimum rows and scrolls after the third line', () => {
  const style = { lineHeight: '20px', paddingTop: '4px', paddingBottom: '4px' };
  let height, overflow;
  const input = {
    ownerDocument: { defaultView: { getComputedStyle: () => style } },
    rows: 2, offsetWidth: 280, offsetHeight: 50, clientHeight: 48, scrollHeight: 28, scrollTop: 0,
    style: { removeProperty() {} }, classList: { remove() {}, toggle(_name, active) { overflow = active; } },
    setCssProps(props) { height = props.height; },
  };
  sizeComposerInput(input);
  assert.deepEqual([height, overflow], ['50px', false]);
  input.scrollHeight = 68;
  sizeComposerInput(input);
  assert.deepEqual([height, overflow], ['70px', false]);
  input.scrollHeight = 88;
  sizeComposerInput(input);
  assert.deepEqual([height, overflow], ['70px', true]);
  input.rows = 1;
  input.scrollHeight = 28;
  sizeComposerInput(input);
  assert.deepEqual([height, overflow], ['30px', false]);
});
