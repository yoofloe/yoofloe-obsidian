# Yoofloe Calendar Companion - development preview

Android phones and tablets only. Obsidian and a matching Calendar build with
Obsidian Companion support must be installed in the same Android user profile
on the same device. Direct connection is unavailable on desktop, iPhone and
iPad. Created notes are ordinary Markdown and remain usable without the plugin.

This is a separate plugin (`yoofloe-calendar-companion`), not an update that
replaces the existing cloud-based `yoofloe` plugin or its MCP wrapper. This
preview is not a Community Plugin or Play Store release.

## Requirements and use

- Obsidian 1.11.5 or later and the matching Calendar development candidate.
- A vault in local device/shared storage, such as Documents. Android cannot
  grant the Calendar app access to an app-private vault through this workflow.
- Explicit approval for the vault's `Yoofloe Calendar Inbox` directory and the
  particular records being shared. The whole vault is not granted to Calendar.

1. Open the companion and choose **Connect Calendar**.
2. In Calendar, choose this vault's **Yoofloe Calendar Inbox** folder using the
   Android folder picker. Choose Notes, Tasks or Events, then **Load records**.
3. Select up to 50 text snapshots and choose **Approve and send**.
4. Back in Obsidian, review the full snapshots and choose **Save Markdown notes**.
   **Check reply** is available if the app callback was missed.

Requests expire after ten minutes. Missing responses can mean a missing or old
Calendar build, cancellation, an incorrect folder, or an expired request; they
are not evidence that the app is definitely uninstalled.

The preview makes read-only snapshots. Editing a note does not update Calendar
tasks or award Flow points. Photos, rich formatting, reminders and recurrence
remain in Calendar. Notes use dataset/kind/record/revision identities. Identical
snapshots are skipped; independently edited destination files are preserved.

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
Calendar snapshot preview. Enter a Responses API text model ID and your own
OpenAI API key. The plugin does not fetch a model list or verify keys remotely.
The key is stored through Obsidian secret storage, outside this plugin's vault
files. This is not a promise of an operating-system keystore or isolation from
other trusted Obsidian plugins. Model ID and output limit are local settings;
the enable switch is never persisted.

To use it later:

1. Save the model and key locally, then enable OpenAI for this session.
2. In a current Calendar preview, choose **Draft from selected records**.
3. Select 1–10 snapshots (none are preselected), write a prompt, and review the
   exact prompt and record text. Vault name and source IDs are omitted.
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

Input is bounded to 16 KiB. Maximum output defaults to 512 tokens and can be set
to 128–4096. This includes reasoning tokens and is **not a monetary spending
cap**. Model availability, price and account limits remain with OpenAI. The
request uses `store: false`, which does not mean zero retention under every
OpenAI data policy. See the official
[Responses API](https://developers.openai.com/api/reference/typescript/resources/responses/methods/create)
and [data controls](https://developers.openai.com/api/docs/guides/your-data).

The OpenAI path is tested only with synthetic keys, injected mock responses and
local UI fixtures. No real model/API request or charge was made during this
implementation; live authentication and model behavior remain unverified.

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
