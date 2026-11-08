# Yoofloe Calendar Companion - development preview

Android phones and tablets only. Obsidian and a matching Calendar build with
Obsidian Companion support must be installed in the same Android user profile
on the same device. Direct connection is unavailable on desktop, iPhone and
iPad. Created notes are ordinary Markdown and remain usable without the plugin.

This is a separate plugin (`yoofloe-calendar-companion`), not an update that
replaces the existing cloud-based `yoofloe` plugin or its MCP wrapper. This
preview is not a Community Plugin or Play Store release.

## Requirements and use

- Obsidian 1.11.5 or later and the matching transport-v2 Calendar development candidate.
- A vault in local device/shared storage, such as Documents. Android cannot
  grant the Calendar app access to an app-private vault through this workflow.
- Explicit approval for the vault's `Yoofloe Calendar Inbox` directory and the
  particular records being shared. The whole vault is not granted to Calendar.

1. Open the companion and choose **Connect Calendar**.
2. In Calendar, choose this vault's **Yoofloe Calendar Inbox** folder using the
   Android folder picker. Choose **All records** or a type in the grouped menu,
   optionally search titles, then **Load records**.
3. Browse bounded pages and select up to 50 snapshots, then **Approve and send**.
   Changing a type, query or page clears selection. Trash is excluded unless
   **Include records in Trash** is explicitly checked.
4. Back in Obsidian, review the full snapshots and choose **Save Markdown notes**.
   **Check reply** is available if the app callback was missed.

Requests expire after ten minutes. Missing responses can mean a missing or old
Calendar build, cancellation, an incorrect folder, or an expired request; they
are not evidence that the app is definitely uninstalled.

The preview makes read-only text/metadata snapshots. Editing a note does not
update Calendar tasks or award Flow points. Recurrence, reminder definitions,
rich source text and related-record identifiers are literal data; importing
does not schedule reminders or execute markup. Attachment metadata and source
references are included, while original binary media remains in Calendar.
Snapshots use dataset/kind/record/revision identities. Identical snapshots are
skipped; independently edited destination files are preserved.

### Workspace coverage

The closed catalog contains 36 content types:

| Workspace | Records |
| --- | --- |
| Notes | Notes and folders, full text, tags, dates, pin/color and attachment references |
| Calendar | Tasks/folders/checklists, events, D-Days, templates and planner metadata |
| Study | Sessions, folders, semesters, lectures, plans and milestones |
| Project | Folders, projects, stages, income, expenses and exchange-rate entries |
| Garden | Focus/break history, recorded durations and background reference |
| Flow | Avatar/environment, characters/pets, places, assignments, bindings, progress, point history, owned content IDs and careers |
| Relationships / media | Planner note links, Study/Project links, focus contexts/bindings and managed attachment metadata |

Non-UUID native keys receive stable namespaced UUIDs, with the original source
ID retained as quoted metadata. Sources without a revision get a stable content
fingerprint that changes when their projection changes. Operational authority,
keys, receipt secrets, internal outboxes and device execution markers are not
content exports. Source values remain in the app.

Transport v2 requires both matching preview builds. New Markdown goes under
`Yoofloe Calendar/Snapshots v2/<dataset>/`; old preview files are retained. The
new namespace prevents richer projections from overwriting older imports with
the same source revision. This is not a full binary-media backup.

## Data and trust boundaries

Ordinary Calendar import uses no Yoofloe account, PAT, cloud service, model
provider or hosted relay. Loading the plugin performs no transfer reads,
secret reads or network requests. Unsupported
platforms expose guidance, not the Android transport.

A user-started request creates a random one-use AES-256 key in the selected
vault inbox. The launch URI contains only version, request ID and encoded vault
name. Calendar opens a prompt; an external URI never reads records by itself.
Calendar respects app lock and requires a matching request file, local folder
approval and record approval before it writes an AES-GCM authenticated reply.
Obsidian checks the current vault, request ID, expiry, authentication tag, closed
record schema and bounds before allowing create-only Markdown writes. Incoming
text is rendered literally, without executable HTML, remote images or embeds.

The key and encrypted reply are temporary vault files. Your own vault sync
tools may copy them; this companion does not upload them. Their protection is
bounded by the existing vault trust boundary: another plugin or process already
allowed to read/write the vault is not isolated by this design. This is not
publisher attestation or a persistent paired-device authentication protocol.

Cancellation removes only an unchanged request marker owned by the current
session. After a verified import, unchanged authenticated reply files are also
removed. Modified or uncertain files are preserved rather than deleted.

## Optional OpenAI

OpenAI is off after every plugin load and is not needed for Calendar import.
On Android, open **OpenAI settings** in the companion's plugin settings or in a
Calendar snapshot preview. Choose a model from the drop-down and enter your own
OpenAI API key. The plugin does not fetch a model list or verify keys remotely.
The key is stored through Obsidian secret storage, outside this plugin's vault
files. This is not a promise of an operating-system keystore or isolation from
other trusted Obsidian plugins. The model choice is a local setting;
the enable switch is never persisted.

To use it later:

1. Choose a model and save the model and key locally, then enable OpenAI for this session.
2. In a current Calendar preview, choose **Draft from selected records**.
3. Select up to 50 snapshots (none are preselected), write a prompt, and review
   the exact content, including any relationship identifiers in the snapshots.
   The vault name is omitted.
4. Explicitly approve transmission and possible OpenAI API charges, then choose
   **Generate once with OpenAI**. This sends one request directly to
   `https://api.openai.com/v1/responses`, with no hosted Yoofloe relay.
5. Review the result and optionally save a new literal Markdown note under
   `Yoofloe Calendar/AI drafts`. It cannot modify Calendar or award Flow points.

Only this generation action invokes the API. Opening settings, saving a key,
enabling the feature, preparing a review, importing notes and saving a draft
make no API calls. Failed requests are never retried automatically. An
already-sent request may still be charged even if the window closes or the
connection fails; do not assume a failure means it was free.

Input is bounded to 1 MiB and 50 selected records. Larger selections can cost
more. The plugin sends **no output-token cap** and ignores
the previous 512/4096-token settings. Output length uses the selected model's
default; OpenAI's own limits still apply. Longer output can increase API charges.
Partial text can be reviewed and saved, without an automatic retry. Bounded
response parsing protects device memory (8 MiB response / 4 MiB text), rather
than imposing an API token limit. Model availability, price and account limits remain with OpenAI. The
request uses `store: false`, which does not mean zero retention under every
OpenAI data policy. See the official
[Responses API](https://developers.openai.com/api/reference/typescript/resources/responses/methods/create)
and [data controls](https://developers.openai.com/api/docs/guides/your-data).

The OpenAI path is tested only with synthetic keys, injected mock responses and
local UI fixtures. No real model/API request or charge was made during this
implementation; live authentication and model behavior remain unverified.

### Model choices and direct entry

The bundled choices were checked against the official
[OpenAI model catalog](https://developers.openai.com/api/docs/models) and
[pricing](https://developers.openai.com/api/docs/pricing) on **2026-11-08**:

| Choice | Model ID | Intended use |
| --- | --- | --- |
| GPT-6 Luna (recommended) | `gpt-6-luna` | Summaries and checklists; lowest cost in this list |
| GPT-6.1 Terra | `gpt-6.1-terra` | Everyday writing and revision |
| GPT-6.1 Sol | `gpt-6.1-sol` | More demanding drafts |
| GPT-6 Astra | `gpt-6-astra` | Most demanding tasks; highest cost in this list |

Luna is suggested for new or previously blank settings. Existing model IDs are
preserved; IDs outside the bundled list appear under **Custom**. This is a
curated list shipped with the plugin, not a live inventory of your account's
access. The checked date and official links are also shown in settings.

Choose **Custom · Enter a model ID** to type an exact API ID, for example
`gpt-6-luna`. Use an API ID rather than a ChatGPT display name. Blank values,
spaces and likely API keys pasted into this field cannot be saved. Model
switching preserves unsaved custom text and the masked key input; model-only
saves do not discard a key that has not yet been saved.

The short-draft request profile uses `reasoning.effort: none` for Luna/Terra and
`low` for Sol/Astra, as supported by the official model catalog. Unrecognized
custom models receive no forced reasoning parameter. There is no plugin output
token limit and no automatic retry to obtain text.

Mobile settings and prompt fields reserve extra scroll space while focused and
scroll the editable field above overlaid keyboards. This also handles hosts
whose viewport does not shrink when the keyboard opens. No field value is read
by the keyboard-visibility helper.

## Local build and checks

Use the existing parent repository's development dependencies; no new package
or hosted service is needed:

```text
node calendar-companion/build.mjs --test
node --test calendar-companion/tests/*.test.mjs
node node_modules/typescript/bin/tsc --noEmit -p calendar-companion/tsconfig.json
node calendar-companion/build.mjs
```

The install payload is `dist/main.js`, `dist/manifest.json`, and `dist/styles.css`.
Set `CALENDAR_INTEROP_VECTOR` to Calendar's generated
`core/build/companion-interop.json` to include the actual Kotlin-to-WebCrypto test.
The new implementation uses the parent repository's MIT license.

Calendar's entry point is disabled by default. The local candidate enables
`-Pcalendar.obsidianCompanion=true`; `-Pcalendar.companionProbe=true` selects a
separate `.companion` debug application and **Calendar Companion Test** label,
preserving the installed Calendar app and database. Publication requires a
separate fixed-candidate security and release review.
