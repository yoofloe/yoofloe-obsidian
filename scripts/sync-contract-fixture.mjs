import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { runInNewContext } from 'node:vm';
import { execFileSync } from 'node:child_process';

const appRoot = process.argv[2];
if (!appRoot) throw new Error('Usage: node scripts/sync-contract-fixture.mjs <app-root> [--check]');
const source = resolve(appRoot, 'supabase/functions/_shared/external-access.ts');
const built = await build({
  entryPoints: [source], bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent'
});
const module = { exports: {} };
runInNewContext(built.outputFiles[0].text, { module, exports: module.exports });
const fixture = JSON.stringify({
  source: 'supabase/functions/_shared/external-access.ts',
  sourceCommit: execFileSync('git', ['-C', appRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  sourceSha256: createHash('sha256').update(readFileSync(source)).digest('hex'),
  security: module.exports.buildExternalAccessSecurityContract()
}, null, 2) + '\n';
const target = resolve('tests/fixtures/external-access-v3.json');
if (process.argv.includes('--check')) {
  const existing = JSON.parse(readFileSync(target, 'utf8'));
  const current = JSON.parse(fixture);
  if (JSON.stringify(existing.security) !== JSON.stringify(current.security)) throw new Error('App security contract changed; review and regenerate the fixture.');
  console.log('App security contract fixture matches.');
} else {
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, fixture);
  console.log('Generated app security contract fixture.');
}
