import { builtinModules, createRequire } from 'node:module';
import { mkdir, copyFile, readFile } from 'node:fs/promises';
import { watch } from 'node:fs';
import { fileURLToPath } from 'node:url';
const require = createRequire(new URL('../package.json', import.meta.url));
const { build, context, transform } = require('esbuild');
const test = process.argv.includes('--test');
await mkdir(new URL('dist/', import.meta.url), { recursive: true });
const options = { absWorkingDir: fileURLToPath(new URL('.', import.meta.url)),
  entryPoints: test ? ['src/protocol.ts','src/session.ts','src/notes.ts','src/openai.ts','src/ai-preferences.ts','src/openai-models.ts','src/gemini.ts','src/gemini-models.ts','src/ai-session.ts','src/ai-models.ts','src/modal-inputs.ts','src/record-types.ts','src/question-query.ts','src/question-input.ts','src/note-context.ts','src/note-work.ts','src/note-workspace.ts','src/effort.ts','src/agent-policy.ts','src/agent-protocol.ts','src/agent-task.ts','src/responses-socket.ts','src/work-activity.ts','src/vault-agent.ts','src/workspace.ts','src/request-limit.ts','src/chat-history.ts','src/conversation-library.ts','src/conversation-context.ts','src/research.ts','src/generated-files.ts','src/attachments.ts','src/provider-files.ts'] : ['src/main.ts'],
  outdir: 'dist', bundle: true, platform: 'browser', format: test ? 'esm' : 'cjs', external: ['obsidian', 'node:*', ...builtinModules, 'bufferutil', 'utf-8-validate'],
  // Keep the Node WebSocket entry behind the desktop-only dynamic import.
  alias: { ws: require.resolve('ws') },
  target: 'es2022', minify: !test, logLevel: 'warning' };
const copyPayload = async () => {
  if (test) return;
  const css = await transform(await readFile(new URL('styles.css', import.meta.url), 'utf8'), { loader: 'css', minify: true, logLevel: 'silent' });
  if (/!\s*important\b/i.test(css.code)) throw Error('Directory CSS check failed: replace !important with scoped selector specificity.');
  if (/\bdisplay:contents\b/i.test(css.code)) throw Error('Directory CSS check failed: use an explicit layout container instead of partially supported display:contents.');
  for (const name of ['manifest.json','styles.css']) await copyFile(new URL(name, import.meta.url),new URL(`dist/${name}`, import.meta.url));
};
if (process.argv.includes('--watch') && !test) {
  const ctx = await context({ ...options, plugins: [{ name: 'copy-payload', setup(builder) { builder.onEnd(async result => { if (!result.errors.length) await copyPayload(); }); } }] });
  await ctx.watch();
  const watchers = ['manifest.json', 'styles.css'].map(name => watch(new URL(name, import.meta.url), () => { void copyPayload().catch(() => process.stderr.write('Could not copy the local payload. Rebuild before installing.\n')); }));
  const stop = () => { for (const watcher of watchers) watcher.close(); void ctx.dispose().then(() => process.exit(0)); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
} else { await build(options); await copyPayload(); }
