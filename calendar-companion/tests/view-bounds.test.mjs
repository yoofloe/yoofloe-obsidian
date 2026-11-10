import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
const { build } = createRequire(new URL('../../package.json', import.meta.url))('esbuild');
const bundle = await build({ absWorkingDir: fileURLToPath(new URL('../', import.meta.url)), entryPoints: ['src/view-bounds.ts'], write: false, bundle: true, format: 'cjs', platform: 'browser' });
const context = { module: { exports: {} }, exports: {} }; vm.runInNewContext(bundle.outputFiles[0].text, context);
const { availableViewHeight } = context.module.exports;
const pane = { top: 40, bottom: 1032, left: 1500, right: 1920 }, status = { top: 1005, bottom: 1032, left: 1603, right: 1920 };
test('desktop status bar reserves the full dock above a partial horizontal overlap', () => {
  assert.equal(availableViewHeight(pane, 1032, 1032, [status]), 957);
  assert.equal(availableViewHeight(pane, 1032, 1032, [{ ...status, left: 1920, right: 2200 }]), 992);
  assert.equal(availableViewHeight(pane, 1032, 1032, [{ ...status, left: 0, right: 1500 }]), 992);
});
test('split panes, hidden bars and keyboard viewports cannot force content outside the visible pane', () => {
  assert.equal(availableViewHeight(pane, 600, 1032, [status]), 560);
  assert.equal(availableViewHeight(pane, 1032, 400, [status]), 360);
  assert.equal(availableViewHeight(pane, 1032, 30, []), 0);
  assert.equal(availableViewHeight(pane, 1032, 1032, [{ ...status, bottom: status.top }]), 992);
  assert.equal(availableViewHeight(pane, 1032, 400, [{ top: 350, bottom: 400, left: 0, right: 1920 }, status]), 302);
});
