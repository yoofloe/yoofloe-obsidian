# Yoofloe AI — privacy and data flow

Updated 10 November 2026. Applies to the standalone plugin beginning with 0.7.0.
The plugin ID is `yoofloe`; historical cloud/MCP releases have different behavior.

## What leaves the device

**Yoofloe AI has no Yoofloe-operated server, relay or cloud database. Yoofloe does not receive or store your notes, prompts or answers through this plugin.**
The plugin keeps working data on your device, and optional AI sends selected material directly to OpenAI.
Local storage and OpenAI processing are separate from Yoofloe receiving that content.

AI is optional and starts only when you choose **Send**. With your OpenAI API key,
the plugin sends requests directly to `https://api.openai.com/v1/responses`:

- Your task prompt, attached note or selected text, and bounded prior task context.
- Relevant note excerpts, outlines, titles and vault-relative paths returned by permitted search/read tools.
- The optional Calendar excerpts and search totals you added, including their dates and coverage.
- Requested file operations, their results, model/effort settings and conversation/reasoning state needed to continue the task.

One task may make multiple requests up to its selected finite maximum, or without a plugin request-count cap when you explicitly choose that option. Additional excerpts can be sent during that task,
within the data scope you selected. **Preview data**, inside the data/permissions section, previews the initial input locally without an API call; it cannot predict every later tool read.
Activity shows requested tools and source reads. Changing the data/edit scope requires your action in the workspace.
No-count mode can accumulate API charges; provider context/rate/credit restrictions still apply. Exact no-progress loops
and repeated blocked steps stop locally. A finite pause resumes only after your explicit Continue action with a higher
total limit or no count cap, retaining the original model and scopes. No continuation request is replayed automatically after app restart.
The API key goes in the authorization header, never in a prompt or URL. Do not put credentials in notes or prompts.

No OpenAI request is made by opening the plugin, selecting a model, saving a key or looking up Calendar records locally.
There are no background AI jobs, automatic retries, paid search planners, embedding uploads or Yoofloe telemetry.
Yoofloe operates no relay or database for this plugin. External store/help links open only when you choose them;
Obsidian's own updates and other plugins have their own network behavior.

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
- Draft prompts, the latest answer and bounded prior turns are stored in the plugin configuration's `workspace.json`.
- Conversation previews for the most recent 50 tasks are kept there for efficient display. Full request/answer records and
  confirmed operation summaries are stored under `plugins/yoofloe/chats/` in the configuration directory. Loading an
  archived conversation is local only; a new task sends limited recent context rather than the whole chat archive.
- Original Markdown backups are stored under `Yoofloe AI/Backups/`; task journals list changed paths/digests under
  the configuration directory's `plugins/yoofloe/tasks/`. Old panel layout state is backed up there before consolidation.
- Optional Calendar handoffs use the existing local Inbox and authenticated encrypted replies. Exact session files
  are cleaned up only when safe; independently changed or uncertain files are preserved.

These local files can contain personal or confidential information. Vault sync, backup software and other trusted
plugins may access or copy them. The plugin's scope guard is not an operating-system isolation boundary.
Recovery files are excluded from AI search. No backup retention/deletion schedule runs automatically.
You control local removal; verify your work first, then remove unneeded backups, task history and workspace state yourself.
Removing the plugin alone may leave vault notes, backups, sync copies and Obsidian secrets behind.
Use **Remove saved key** to remove that plugin's current vault-bound key from local secret storage.

To remove local conversation state, first finish or stop the task, use **Remove saved key** if you also want to remove
the key, and disable Yoofloe AI. You can then remove `.obsidian/plugins/yoofloe/workspace.json` to clear the saved
draft, latest answer, conversation previews and recent context. Remove `plugins/yoofloe/chats/` in that configuration
directory as well if you want to remove full archived conversations. Older chat files are not purged automatically when
their previews leave the recent 50-task display. For a custom configuration directory, substitute that directory for `.obsidian`.
Task journals are under `plugins/yoofloe/tasks/` in that same configuration directory; original backups are ordinary
vault files under `Yoofloe AI/Backups/`. Delete those only when you no longer need recovery. Removing a backup can make
Undo unavailable. Other sync/backup copies and provider-side retention are managed separately.

## Scope, safety and your choices

Read and edit permissions are separate. Configuration/hidden files, excluded folders and recovery files are blocked.
**All actions** enables every supported action, including creation, editing, properties, renaming, moving and folder
organization, within the read and change scopes you choose. It does not silently change those scopes.
Credential-pattern detection blocks recognized keys in outgoing material but cannot identify every secret or personal detail.
Write/edit modes can make real changes in their selected scope, including several files. Version checks,
original backups, task records and conflict-aware Undo reduce mistakes; they cannot guarantee perfect model behavior.
Trash requires your separate choice. Calendar data is read-only. Review facts and rights before publishing AI-assisted work.

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
