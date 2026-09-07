import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, dirname, basename, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const directory = await mkdtemp(join(process.cwd(), '.test-build-'));
try {
  await build({
    entryPoints: ['tests/subjects.ts'], outfile: join(directory, 'subjects.cjs'),
    bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent',
    alias: { obsidian: './tests/obsidian-mock.ts' }
  });
  const result = spawnSync(process.execPath, ['--test', 'tests/compatibility.test.mjs'], {
    stdio: 'inherit', env: { ...process.env, YOOFLOE_TEST_SUBJECT: join(directory, 'subjects.cjs') }
  });
  process.exitCode = result.status ?? 1;
} finally {
  if (dirname(resolve(directory)) !== resolve(process.cwd()) || !basename(directory).startsWith('.test-build-')) {
    throw new Error('Refusing to remove a test directory outside this workspace.');
  }
  await rm(directory, { recursive: true, force: true });
}
