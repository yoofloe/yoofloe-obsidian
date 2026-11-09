import { createRequire } from 'node:module';
import { mkdir, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const require = createRequire(new URL('../package.json', import.meta.url));
const { build } = require('esbuild');
const test = process.argv.includes('--test');
await mkdir(new URL('dist/', import.meta.url), { recursive: true });
await build({ absWorkingDir: fileURLToPath(new URL('.', import.meta.url)),
  entryPoints: test ? ['src/protocol.ts','src/session.ts','src/notes.ts','src/openai.ts','src/ai-preferences.ts','src/openai-models.ts','src/gemini.ts','src/gemini-models.ts','src/ai-session.ts','src/ai-models.ts','src/modal-inputs.ts','src/record-types.ts','src/question-query.ts','src/question-input.ts','src/note-context.ts','src/note-work.ts'] : ['src/main.ts'],
  outdir: 'dist', bundle: true, platform: 'browser', format: test ? 'esm' : 'cjs', external: ['obsidian'],
  target: 'es2022', minify: !test, logLevel: 'warning' });
if (!test) for (const name of ['manifest.json','styles.css']) await copyFile(new URL(name, import.meta.url),new URL(`dist/${name}`, import.meta.url));
