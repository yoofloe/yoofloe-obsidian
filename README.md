# Yoofloe AI

Research, write and organize your Obsidian Markdown with your own OpenAI API key.
Visit [www.yoofloe.com](https://www.yoofloe.com) for Yoofloe apps and support.
Use one workspace from the sparkle ribbon, note header, note menu, or **Yoofloe AI: Open** command.
Yoofloe Calendar is optional: the plugin is useful on its own, including when no note is open.

Requires Obsidian **1.11.5+**. The same implementation runs on desktop and mobile.
The 0.7.0 release was verified in Windows Obsidian and on a physical Android phone;
iOS and physical tablet verification are not included in that evidence.

## Start

1. Install **Yoofloe AI**, plugin ID `yoofloe`, and open its sparkle workspace.
2. Open settings, choose a model, enter **your own OpenAI key**, and choose **Save** once.
   The same button stores model/thinking settings and the new key together. An empty key field keeps the existing key.
   The UI confirms local storage; it does not make a paid key-validation call.
3. Describe the task. Attach the current note or use **+** to add images, documents and audio.
   **Expanded** is the default; choose **Provided only** when factual evidence must stay within supplied material.
4. Check **Allowed actions**, **Notes AI can read**, **Notes AI can change**, the working/output folder,
   model, thinking depth and maximum requests. **Preview data** previews the initial input locally.
5. **Send** starts the task and authorizes its permitted reads and changes. The same fixed-size button becomes **Stop** during work.
   A task can make several paid API requests. Choose **1 request**, **Custom…**, or **No limit**.
   **No limit** is the new default; explicitly saved limits remain available as Custom. No-limit mode continues until completion, Stop or a technical stopping condition;
   API charges can accumulate. It does not remove provider context/rate/credit limits. There are no automatic retries.

At a finite boundary the task pauses. Increase the **total** limit or choose no count limit, then **Continue** using
the same model, original scopes, tool results and cumulative usage. Completed writes are not replayed. **Finish here**
ends continuation without sending another request. Continuation is available while the current vault session stays open;
closing/restarting the app keeps saved answers and completed changes but does not automatically resume requests.

The conversation stays above the settings with a fixed-height, independently scrolling message area.
Model and permission cards sit below it; Calendar, activity, privacy and recovery remain compact.
Conversation search is local: it searches saved requests, answers and attachment names, highlights matches,
and pages through older archived conversations without an AI request. Previews remain bounded for mobile performance.
The conversation shows user requests, assistant answers, actual confirmed operations, sources and returned files.

The task reads relevant excerpts as needed within your chosen data scope; it does not upload the whole vault upfront.
The model control shows the full GPT version/name and the exact selected API model ID.
Images use GPT-Image-2.6 Flare. Image planning uses Low for Fast/Light or Model default, Medium for Balanced, and High for deeper settings. This separate image setting keeps Fast text responses compatible with image generation; image rendering can still incur tool charges.
Choose **Working / output folder** to browse a collapsible folder tree like the file explorer, including the vault root.
Search reaches every existing subfolder; larger search results have an explicit **Show more** control.
This picker uses local folder names only. It cannot choose an external computer/device folder, and cancelling keeps your previous choice.
Folder scope includes subfolders while exclusions continue to apply. Selecting an output folder does not expand Current note scope.
**All actions** offers every supported action while retaining the separate data and change scopes you choose.
**Preview data** is inside the data/permissions section and makes no API request. It previews initial input, rather than predicting every later tool read.

Yoofloe AI has no server or cloud database. Yoofloe does not receive your notes, prompts or answers.
When you choose Send, task data goes directly to OpenAI using your API key; API charges apply.
Drafts, answers, recent context and recovery records remain on your device and may be copied by vault sync.
See [privacy and local data controls](PRIVACY.md) for OpenAI retention, local removal and scope details.
Note titles and vault-relative paths returned by search can also go to OpenAI. Selection scope sends the selected passage,
not the whole note. Open editor text, including unsaved changes, is used. A changed selection must be selected again.

## Sources and attachments

**Expanded** uses permitted notes, supplied attachments, general knowledge and live web research as needed.
Current-news/search requests perform a real search, and saved research notes include clickable sources.
**Provided only** omits web search and excludes prior expanded-mode answers from new-task context. It still
supports writing, translation, calculation and analysis of supplied facts. It uses OpenAI and is not offline AI.
Switching source modes never expands note read/write permissions.

Use **+** to select up to 10 files, 20 MiB combined. Files are copied to a protected local plugin cache;
selection makes no provider request. **Send** authorizes sharing the selected files with OpenAI.
Supported inputs include PNG/JPEG/WebP, PDF, Office documents/spreadsheets, text/code and recorded audio
(MP3, M4A, MP4, WAV, MPEG/MPGA and WebM). Unsupported or oversized files show an error before upload.
Audio uses `gpt-transcribe`; each new transcription counts toward the API request limit and has an audio charge.
Completed transcripts are cached and reused on continuation. Removing a chip excludes that file from the next
request; it does not erase the original file. Completed attachments remain visible in the conversation; **Attach again** explicitly selects them for a follow-up.
The composer clears its attachment selection when that task finishes. A paused task keeps its original attachments.

Office inputs expose extracted text, not embedded images; use PDF to preserve document charts/images.
Spreadsheet previews may cover only the first 1,000 rows per sheet. The uploaded file is also available to the
analysis container so the model can perform full-file calculations rather than claiming complete coverage from a preview.

Uploaded file objects are requested with a one-hour expiry and deleted after the task finishes or stops when possible.
Pausing retains them for continuation within that expiry. This is separate from OpenAI abuse-monitoring retention.
Generated images, charts and documents are cached locally with type/size/hash checks. **Save attachment** or the
permitted file tool copies a verified result into the chosen output folder without overwriting existing files.
Per-file generated downloads are streamed with a 12 MiB cap, including when OpenAI reports an unknown file size. File transfer and cleanup calls do not consume the model/transcription request count. Recovery keeps newer human edits.

Model response/transcription requests and built-in search/analysis/image calls have separate counters and optional limits, both defaulting
to **No limit**. Hosted tools and transcription can add charges beyond text tokens; a request count is not a price cap.
Read [OpenAI pricing](https://developers.openai.com/api/docs/pricing) before choosing a large task.

## What it can do

- **Ask only:** explain, summarize, translate and search permitted notes without modifying files.
- **Write and edit:** create documents, rewrite or append text, update requested properties, link notes and rename the current document within its folder.
  Document title changes use the Markdown filename/tab title; body headings are separate. Moving between folders requires an organizing mode.
- **Organize notes:** also create folders, rename/move notes and propose Trash operations. Moving notes
  does not silently rewrite backlinks; link updates are separate, version-checked edits within your scope.
- Write ordinary Markdown: headings, lists, tasks, tables, internal links, blockquotes, LaTeX math,
  Mermaid flowcharts, sequences, mindmaps, timelines, pie charts and numerical charts.
  Charts must use supplied or verified retrieved data; the model is instructed not to invent measurements.

The model requests typed tools; local code checks permissions, paths, note versions and recovery before performing them.
Expanded mode adds OpenAI-hosted web search, Python analysis and image generation when needed. The analysis
container has network disabled. No code is executed on the user's computer or phone. Hidden/configuration files and
Calendar writes remain blocked. Active HTML, remote embeds, executable plugin blocks and unsafe Mermaid features
are made inert. Verified generated local image attachments can be embedded in notes.
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
Local lint now checks both manifests and the published package metadata with zero warnings allowed. The build validates CSS and rejects `!important`. Settings use the searchable 1.13+ definitions and keep the same rows as a 1.11.5–1.12 fallback.

The default root build uses `calendar-companion/src/main.ts` and publishes only **main.js, manifest.json, styles.css**.
No additional runtime dependencies, embedding service, planner model or Yoofloe backend is required.
Tests with synthetic providers do not prove live API/device behavior; release notes distinguish those results.

Issues: [GitHub issue tracker](https://github.com/yoofloe/yoofloe-obsidian/issues).
Do not post keys, personal note content or private Calendar records in public issues.
