import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
const { build } = createRequire(new URL('../../package.json', import.meta.url))('esbuild');
const bundle = await build({ absWorkingDir: fileURLToPath(new URL('../', import.meta.url)), entryPoints: ['src/folder-picker.ts'], write: false, bundle: true, format: 'cjs', platform: 'browser', external: ['obsidian'] });
test('folder picker is lazy, offers vault folders only and rechecks authority on selection', () => {
  let enumerations = 0, current = true, excluded = ['Private']; const selected = [], notices = [];
  const folders = ['/', 'Study/폴란드어 어휘', 'Other', 'Private', '.obsidian', 'Yoofloe AI/Backups', 'Yoofloe Calendar/Inbox', 'A/../B', 'C:/outside'].map(path => ({ path }));
  const app = { vault: { configDir: '.obsidian', getAllFolders: includeRoot => { assert.equal(includeRoot, true); enumerations++; return folders; }, getRoot: () => folders[0], getAbstractFileByPath: path => folders.find(folder => folder.path === path) } };
  class Modal { constructor(app) { this.app = app; } setPlaceholder() {} setInstructions() {} }
  const context = { module: { exports: {} }, exports: {}, require: () => ({ FuzzySuggestModal: Modal, Notice: class { constructor(message) { notices.push(message); } } }) };
  vm.runInNewContext(bundle.outputFiles[0].text, context);
  const picker = new context.module.exports.VaultFolderPicker(app, () => current, () => excluded, path => selected.push(path));
  assert.equal(enumerations, 0); assert.deepEqual([...picker.getItems()].map(folder => folder.path).sort(), ['/', 'Other', 'Study/폴란드어 어휘']);
  assert.equal(picker.getItemText(folders[0]), 'Vault root · /'); assert.equal(selected.length, 0);
  picker.onChooseItem(folders[1]); picker.onChooseItem(folders[0]); assert.deepEqual(selected, ['Study/폴란드어 어휘', '']);
  excluded = ['Other']; picker.onChooseItem(folders[2]); assert.equal(selected.length, 2);
  const removed = folders.splice(1, 1)[0]; picker.onChooseItem(removed); assert.equal(selected.length, 2);
  current = false; assert.equal(picker.getItems().length, 0); picker.onChooseItem(folders[0]); assert.equal(selected.length, 2); assert.equal(notices.length, 3);
});
