# Yoofloe — privacy and data flow

Updated 10 November 2026. Applies to the standalone plugin beginning with 0.7.0.
The plugin ID is `yoofloe`; historical cloud/MCP releases have different behavior.

## What leaves the device

Selected reference passages and their requested image pages are additional user-provided context. Reference chips do not
change the note read/write permissions in Access. Queue retains each message's selected references and attachments.
Local previews and image rendering do not contact OpenAI. After Send, large or multimodal requests can send their input
to OpenAI's input-token counting endpoint before generation. The same selected material and tool definitions are included
in that check. Removing a draft reference affects future messages; already-sent material remains in its saved conversation.

**Yoofloe has no Yoofloe-operated server, relay or cloud database. Yoofloe does not receive or store your notes, prompts or answers through this plugin.**
The plugin keeps working data on your device, and optional AI sends selected material directly to OpenAI.
Local storage and OpenAI processing are separate from Yoofloe receiving that content.

AI is optional and starts only when you choose **Send**. With your OpenAI API key,
the plugin sends requests directly to `https://api.openai.com/v1/responses`:

- Your task prompt, attached note or selected text, selected files/images/audio, and bounded prior task context.
- Relevant note excerpts, outlines, titles and vault-relative paths returned by permitted search/read tools.
- Optional approved Calendar and ChronoHUD excerpts you selected, including their dates and coverage.
- Requested file operations, their results, model/effort settings and conversation/reasoning state needed to continue the task.

One task may make multiple requests up to its selected finite maximum, or without a plugin request-count cap when you explicitly choose that option. Additional excerpts can be sent during that task,
within the data scope you selected. **Preview data**, inside the data/permissions section, previews the initial input locally without an API call; it cannot predict every later tool read.
Activity shows requested tools and source reads. Changing the data/edit scope requires your action in the workspace.
No-limit mode is the default for new settings and can accumulate API charges; provider context/rate/credit restrictions still apply. Exact no-progress loops
and repeated blocked steps stop locally. A finite pause resumes only after your explicit Continue action with a higher
total limit or no count cap, retaining the original model and scopes. No continuation request is replayed automatically after app restart.
The API key goes in the authorization header, never in a prompt or URL. Do not put credentials in notes or prompts.

No OpenAI request is made by opening the plugin, selecting a model, saving a key, selecting attachments, searching local chat history or looking up Calendar or ChronoHUD records locally.
There are no background AI jobs, automatic retries, paid search planners, embedding uploads or Yoofloe telemetry.
Yoofloe operates no relay or database for this plugin. Expanded mode can invoke OpenAI web search when you send a task. Store/help links open only when you choose them;
Obsidian's own updates and other plugins have their own network behavior.

Desktop tasks can use an OpenAI Responses WebSocket. The plugin's HTTP requests handle Responses, input-token
counting, uploads, generated-file downloads, transcription and upload cleanup. Base64 represents bytes in
generated images and Android app transfers.

The copy actions write the selected conversation or draft to the clipboard. The composer accepts clipboard text
when you paste into it.

## Expanded mode and selected files

Expanded mode is the default. OpenAI can use hosted web search, analysis and image tools when useful for your task.
Search queries and relevant context can be processed by OpenAI and its search service providers. Avoid sensitive
material in queries. Web content is untrusted evidence, not new permission to read or modify your vault.
Provided-only mode omits web search and excludes earlier expanded-mode answers from new-task context; the selected
material still goes to OpenAI. Analysis containers have network disabled in both modes. No code runs on your device.

The + picker stores selected files locally first. Send authorizes their upload/processing. Audio is transcribed
through OpenAI `gpt-transcribe`, which adds a paid request; completed transcripts are cached locally to avoid repeated
transcription when continuing the same material. Binary images/documents use Files API objects with a requested
one-hour expiry. The plugin attempts to delete this task's uploads when it finishes or stops. If the app exits, the
key fails, or cleanup cannot complete, the expiry is the fallback; provider abuse-monitoring retention is separate.
No hosted vector store or persistent vault index is created. Long pauses can outlast uploaded-file availability.

Code Interpreter stores generated files temporarily in its container. Results are downloaded only from validated
OpenAI container/file references after identity/metadata checks, with bounded streaming and authenticated redirects disabled.
Generated results use the local `plugins/yoofloe/generated/` cache in the vault configuration folder. Selected input files
and their audio transcripts are saved in encrypted device storage. Older attachment and transcript copies can remain in
the configuration folder for migration. Removing a file chip removes it from the request.

Search, containers, image generation and transcription can incur their own API charges. The interface tracks model
requests, hosted tool calls and transcriptions separately. No limit removes the selected count cap; it does not mean
free usage or remove account/context/rate restrictions. Stop prevents further model/tool actions, but cleanup may
still delete only this task's provider-uploaded copies. Already dispatched processing can finish and be charged.

## OpenAI's processing

API data is not used for model training by default unless the customer opts in.
OpenAI may retain abuse-monitoring content for up to 30 days, subject to exceptions and account controls.
`store: false` disables stored Responses application state; it does not establish Zero Data Retention.
Eligibility for retention controls and data residency depends on the customer's account, endpoint and model.
Review your account's contract, organization settings, region and [OpenAI data controls](https://developers.openai.com/api/docs/guides/your-data).
Removing a local note, key or task record does not recall data already sent to OpenAI.
Requests already in flight may still be processed and charged after Stop.

## What stays in your vault/device

- Provider/model/effort choices and opaque prior plugin settings remain local. Gemini is hidden and inactive.
- Keys use Obsidian secret storage with the existing vault-bound identifier. The UI checks local readback only;
  it does not establish that the key is valid remotely. The key is not written into plugin `data.json`.
- Drafts, full messages, conversation metadata and task journals use AES-256-GCM in Obsidian's device database,
  outside the vault folder. The conversation key is separate from the OpenAI key and is kept in Obsidian Keychain.
  Opening and searching the archive uses the verified local records. A new request uses bounded context and the current Access settings.
- **Sync with this vault** saves that conversation's completed text, user corrections and note links in
  `Yoofloe AI/Shared conversations/`. The folder follows your vault's sync settings. Obsidian Sync provides
  end-to-end encryption when configured for the remote vault. Anyone who can read the local files can read the
  shared messages. Drafts, file bytes, saved keys, OpenAI compaction data and pending actions stay outside this folder.
- Original Markdown backups are stored under `Yoofloe AI/Backups/`. Old panel layout state is backed up in the plugin
  configuration before consolidation.
- Optional Calendar and ChronoHUD handoffs use the chosen vault’s local Inbox on Android and authenticated encrypted replies. Calendar change proposals use a
  separate encrypted payload and a short-lived transfer key in the Inbox request file. Keep the Inbox out of
  cloud sync if possible. Software that can read the Inbox can access its request files. Exact session files are
  cleaned up only when safe; independently changed or uncertain files are preserved.

Vault backups, shared conversations, generated caches and existing configuration files can contain personal
information and may be copied by vault sync or backups. Recovery and shared conversation files are excluded from
Yoofloe's AI note search. **Stop syncing** removes the active vault copies after preserving device copies of received
versions. Other devices, deleted-file history and backups can retain their own copies.

Older plaintext records under the plugin configuration are retained so that other devices can migrate. Check each
device before removing the legacy `workspace.json`, `conversations/`, `chats/`, `attachments/` or `tasks/` files.
Deleting these legacy files does not clear the new encrypted device records. Disabling or removing the plugin can
leave those records and vault backups on the device. **Remove saved key** controls the OpenAI key in Obsidian Keychain.

## Scope, safety and your choices

Read scope and write target are separate. Configuration/hidden files, excluded folders and recovery files are blocked.
Current note permits changes only to the attached note and does not grant AI creation of notes, folders or generated-file copies. New documents is an explicit create-only choice for existing data: only notes created by that task may be read and revised under its creation authority. This authority is bound to the file identity and path and is not restored from saved conversation text.
The output folder does not enable creation under Current note. In Note folder mode it also specifies the boundary for existing-note reads or edits, including subfolders; changing it changes that access boundary. Broader write scope does not bypass narrower read scope. The manual Save attachment button authorizes one selected verified attachment copy without changing the AI write target.
**All actions** enables every supported action, including creation, editing, properties, renaming, moving and folder
organization, within the read and change scopes you choose. It does not silently change those scopes.
Credential-pattern detection blocks recognized keys in outgoing material but cannot identify every secret or personal detail.
Write/edit modes can make real changes in their selected scope, including several files. Version checks,
original backups, task records and conflict-aware recovery reduce mistakes; they cannot guarantee perfect model behavior.
Obsidian Trash requires your separate choice. The Calendar app reviews, applies and undoes approved changes
and keeps the result locally. Its capabilities determine the available Schedule, Study, Project and Notes actions.
The workspace lookup has separate approvals for archive, Trash, financial records and attachment metadata. Sending
an AI message uses the selected approved excerpts.

Review facts and rights before publishing AI-assisted work.

## Personal data and legal responsibilities

For work involving other people's personal data, determine an appropriate legal basis, inform them where required,
minimize what you send, set retention/access controls, and assess any international transfer and processor terms.
Special-category data and confidential third-party material may need additional safeguards. Roles depend on the actual
purpose and contracts; BYOK does not remove controller or processor obligations.
The [GDPR](https://eur-lex.europa.eu/eli/reg/2016/679/oj/eng) addresses transparency, minimization and privacy by design;
a send button is not a substitute for that assessment. Yoofloe cannot inspect or exercise rights over content it never receives.
Manage provider-side requests through your OpenAI account/provider channels. Raise plugin privacy questions through the
[issue tracker](https://github.com/yoofloe/yoofloe-obsidian/issues) without publishing private data.

The interface identifies the assistant and its outputs as AI-assisted. The EU AI Act's transparency and output-marking
requirements need assessment for the actual feature and distribution, including the standard-editing exception.
A label, provenance record or optional metadata alone is not a claim of full compliance.
See the [European Commission's Article 50 guidance](https://digital-strategy.ec.europa.eu/en/faqs/transparency-obligations-under-article-50-ai-act).
Do not remove required disclosures when publishing material for which they apply.

## Local diagnostic reports

Yoofloe records bounded diagnostic metadata for AI tasks, vault conversation sync, Calendar and ChronoHUD in its encrypted device store.
Reports are available for seven days. Yoofloe clears expired records while the workspace is open and caps the archive at 2 MiB. **Copy diagnostics** places a selected report on the device clipboard.
The report uses a fixed set of fields such as versions, timings, request IDs, error codes and confirmed operation counts. Note and file references use local aliases.
