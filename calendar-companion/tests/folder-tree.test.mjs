import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
const { build } = createRequire(new URL('../../package.json', import.meta.url))('esbuild');
const bundle = await build({ absWorkingDir: fileURLToPath(new URL('../', import.meta.url)), entryPoints: ['src/folder-tree.ts'], write: false, bundle: true, format: 'cjs', platform: 'browser' });
const context = { module: { exports: {} }, exports: {} }; vm.runInNewContext(bundle.outputFiles[0].text, context);
const { folderRows } = context.module.exports;
const paths=['','Development',...Array.from({length:180},(_,i)=>`Development/Audit ${i}`),'Logistics','Logistics/Inbound','Study','Study/폴란드어 어휘','Study/폴란드어 어휘/동사'];
test('hundreds of Development children never hide Logistics or Study in the initial tree',()=>{
 const initial=[...folderRows(paths,new Set())];assert.deepEqual(initial.map(x=>x.path),['','Development','Logistics','Study']);
 assert.equal(initial.find(x=>x.path==='Development').hasChildren,true);
 const opened=[...folderRows(paths,new Set(['Study','Study/폴란드어 어휘']))];assert(opened.some(x=>x.path==='Logistics'));assert(opened.some(x=>x.path==='Study/폴란드어 어휘/동사'&&x.depth===2));assert(!opened.some(x=>x.path.startsWith('Development/')));
 const expanded=[...folderRows(paths,new Set(['Development']))];assert.equal(expanded.length,184);assert(expanded.some(x=>x.path==='Study'));
});
test('search reaches every collapsed folder beyond the old 100-result cutoff and supports Korean paths',()=>{
 const matches=[...folderRows(paths,new Set(),'development audit')];assert.equal(matches.length,180);assert(matches.some(x=>x.path==='Development/Audit 179'));
 assert.deepEqual([...folderRows(paths,new Set(),'study 동사')].map(x=>x.path),['Study/폴란드어 어휘/동사']);
 assert.equal(folderRows(paths,new Set(),'not present').length,0);
});
