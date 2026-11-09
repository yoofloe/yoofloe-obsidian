# Yoofloe AI

Write, edit and organize your Obsidian Markdown with your own OpenAI API key.
Use one workspace from the sparkle ribbon, note header, note menu, or **Yoofloe AI: Open** command.
Yoofloe Calendar is optional: the plugin is useful on its own, including when no note is open.

Requires Obsidian **1.11.5+**. The same implementation runs on desktop and mobile.
The 0.7.0 release was verified in Windows Obsidian and on a physical Android phone;
iOS and physical tablet verification are not included in that evidence.

## Start

1. Install **Yoofloe AI**, plugin ID `yoofloe`, and open its sparkle workspace.
2. Open settings, choose a model and save **your own OpenAI key locally**.
   The UI confirms local storage; it does not make a paid key-validation call.
3. Describe the task. Attach the current note or a text selection, or create a new document from scratch.
4. Check **Allowed actions**, **Data sent to OpenAI**, **Notes AI can change**, the working/output folder,
   model, thinking depth and maximum requests. **Review data** previews the initial input locally.
5. **Send to OpenAI** starts the task and authorizes its permitted reads and changes.
   A task can make several paid API requests, up to the displayed limit. There are no automatic retries.

The task reads relevant excerpts as needed within your chosen data scope; it does not upload the whole vault upfront.
Note titles and vault-relative paths returned by search can also go to OpenAI. Selection scope sends the selected passage,
not the whole note. Open editor text, including unsaved changes, is used. A changed selection must be selected again.

## What it can do

- **Ask only:** explain, summarize, translate and search permitted notes without modifying files.
- **Write and edit:** create documents, rewrite or append text, update requested properties and link notes.
- **Organize notes:** also create folders, rename/move notes and propose Trash operations. Moving notes
  does not silently rewrite backlinks; link updates are separate, version-checked edits within your scope.
- Write ordinary Markdown: headings, lists, tasks, tables, internal links, blockquotes, LaTeX math,
  Mermaid flowcharts, sequences, mindmaps, timelines, pie charts and numerical charts.
  Charts must use supplied data; the model is instructed not to invent measurements.

The model requests typed tools; local code checks permissions, paths, note versions and recovery before performing them.
It cannot execute JavaScript, shell commands, arbitrary network tools, hidden/configuration files or Calendar writes.
Active HTML, embeds, executable plugin blocks and unsafe Mermaid features are made inert before insertion.
Other installed plugins can still interpret ordinary Markdown; review generated content in the context of your vault.

### Scope and cost

Data and edit scopes are independent: **Current note**, **Note folder** (including subfolders), or **Vault**.
New documents may be created in the working/output folder, including without an attached source note.
An empty folder means the vault root. Exclude private folders with one vault-relative path per line.
Configuration, hidden folders, AI backups/history and detected credential strings are blocked.
Credential detection is a precaution, not a complete secret scanner.

Search considers at most 2000 permitted metadata entries and reads bounded pages of up to 32 candidates;
the agent can request another page. Note excerpts are at most 32 KiB per read; outlines and line ranges
support long notes. Partial coverage is returned explicitly. Input and device-size safeguards still apply.

Model choices include an economical default and a **Custom** model ID field with examples.
**Thinking depth** offers supported effort values for known models; unknown custom models use the model default.
Higher effort may cost more. Effort does not expand file permissions or control response length.
No plugin output-token cap is sent. OpenAI's own limits still apply.

### Recovery and continued work

Hiding the workspace keeps the task running and retains its answer. **Stop** prevents future requests and file actions;
it cannot recall an in-flight request or its charges. Its returned text is retained.
Drafts, the latest result, and bounded previous answers are saved locally in the plugin's configuration folder.
A new task keeps up to two bounded prior turns as context. Opening another note does not silently retarget a task.

Before content changes, exact originals are verified in **Yoofloe AI/Backups/** and a recovery record is written
in `.obsidian/plugins/yoofloe/tasks/` (or the vault's custom configuration directory).
**Undo this task** only restores files whose current content still matches the recorded version.
Newer user edits, occupied filenames, modified backups and uncertain operations are kept.
Empty folders are retained. Review the changed-file list and use original backups for manual recovery if needed.
**Trash always requires a separate user choice** after reviewing the concrete notes.

Backups, drafts and results can contain private data and consume local/sync storage. No automatic backup deletion is performed.
After checking your work, you can remove unneeded backups and recovery records yourself. They are excluded from AI tools.

Old Writer and Capture panels are consolidated into this one workspace after their saved layout state is backed up locally.
Existing Markdown, plugin settings and secret IDs are preserved. No Yoofloe account, hosted database or migration sign-in is required.
Historical cloud and MCP-wrapper releases through 0.3.31 remain historical; this release does not reactivate or ship them.

## Optional Yoofloe Calendar context

[Yoofloe Calendar for Android](https://play.google.com/store/apps/details?id=com.yoofloe.calendar)
brings together plans, tasks, events, notes, study, projects, Garden focus and Flow.
Use **Add Yoofloe Calendar context** in the same AI workspace when a task needs those records.

Direct lookup requires **both apps on the same Android phone/tablet and Android profile**, Calendar **1.8.5+**,
and a vault in shared device storage. It is unavailable on desktop, iPhone and iPad; Yoofloe AI itself works without it.
Android may require one initial folder grant to **Yoofloe Calendar Inbox** inside the vault; Calendar remembers it.
App-private vaults and unsupported cloud document providers cannot use this local handoff.

Describe what you need. A local planner recognizes common workspace, topic and date phrases in English, Korean and Polish.
Review/adjust the workspaces and dates when needed. An ambiguous workspace search uses bounded matching excerpts across
workspaces, rather than exporting all records. The app asks you to approve the local retrieval.
Back in Obsidian, review excerpts and coverage before sending the task to OpenAI.
Local lookup makes **no AI call**. The native v2/v3 protocol, Inbox name and callback are unchanged.
Sources are read-only: this cannot complete Calendar tasks, alter records, change Flow items or award points.
Full-record Markdown snapshot import without AI remains an advanced setting.

## Data, rights and privacy

**This is online AI. Permitted note text, prompts, selected Calendar context and relevant tool results go directly to OpenAI,
using your key.** Yoofloe does not relay them through a server or collect plugin telemetry.
API billing is separate from ChatGPT subscriptions. Local key storage does not make the model local.

Requests use `store: false`; that is **not a zero-retention guarantee**. Read [Privacy and data flow](PRIVACY.md),
[OpenAI data controls](https://developers.openai.com/api/docs/guides/your-data) and
[OpenAI pricing](https://developers.openai.com/api/docs/pricing) before sending sensitive material.
Use only material you may disclose and edit. AI output can be inaccurate; review facts, citations, rights and changes before relying on or publishing it.
This product does not claim that using BYOK or these controls automatically makes a workflow legally compliant.

## Build and verify

`npm ci`, `npm run check`, `npm run lint`, `npm test`, `npm run build`.
The default root build uses `calendar-companion/src/main.ts` and publishes only **main.js, manifest.json, styles.css**.
No additional runtime dependencies, embedding service, planner model or Yoofloe backend is required.
Tests with synthetic providers do not prove live API/device behavior; release notes distinguish those results.

Issues: [GitHub issue tracker](https://github.com/yoofloe/yoofloe-obsidian/issues).
Do not post keys, personal note content or private Calendar records in public issues.
