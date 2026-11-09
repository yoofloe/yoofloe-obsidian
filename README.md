# Yoofloe Calendar Companion

Bring selected Yoofloe Calendar records into your Obsidian vault as Markdown.
Keep plans, study notes, project context and focus history together, then
optionally turn a selection into an AI draft with your own OpenAI key.

**Direct connection works on Android phones and tablets only.** Install
**Yoofloe Calendar 1.8.4 or later** and **Obsidian 1.11.5 or later** on the same
device and Android user profile. Desktop, iPhone and iPad cannot connect directly;
imported Markdown remains readable and editable wherever you use your vault.

[Get Yoofloe Calendar for Android](https://play.google.com/store/apps/details?id=com.yoofloe.calendar)
to keep your plans, notes, study and project progress together, with a quiet
place to focus. The same link is available directly in this plugin's settings.

## Connect Calendar

1. Open **Settings → Yoofloe Calendar Companion → Connect Calendar**.
2. In Calendar, choose the **Yoofloe Calendar Inbox** folder inside your vault,
   load records, select what to share and approve the transfer.
3. Back in Obsidian, review the snapshots and choose **Save Markdown notes**.

Use a vault in local shared device storage, such as Documents. Android cannot
grant Calendar access to an app-private vault. Calendar receives access to the
selected inbox directory, rather than your whole vault. Requests expire after
ten minutes; **Check reply** is available if the return callback was missed.

Notes, Calendar tasks/events, Study, Project, Garden and Flow records are
supported, including their relationships and attachment references. Choose up
to 50 snapshots per transfer, with title search and grouped record types.
Trash is excluded unless explicitly included. Changing a page or filter clears
the selection so you can review the new set.

Each snapshot is saved as a new Markdown note under
`Yoofloe Calendar/Snapshots v2/`. Identical imports are skipped. Notes you have
edited are preserved. Editing imported Markdown does not modify Calendar or
award Flow points. Original media files stay in Calendar; this transfers their
metadata and references, rather than making a full media backup.

## Optional AI drafts

Calendar import requires no model provider or paid service. AI starts off after
every plugin load.

1. Open **AI settings** and choose an OpenAI model.
   **Custom** accepts an exact API model ID; examples appear beside the field.
2. Save your own provider key locally, then enable AI for this session.
3. In a Calendar preview, choose **Draft from selected records**. Select records,
   enter your request and review the exact content and destination.
4. Approve the transmission and possible API charges, then generate once.
   Review the result before saving it as a new note in
   `Yoofloe Calendar/AI drafts/`.

Your key is stored through Obsidian secret storage with a vault-bound ID,
outside this plugin's vault files. The model choice is a
local setting; the enable switch is not persisted. Other trusted Obsidian plugins
share Obsidian's trust boundary.

Only the explicit generation action contacts a provider. Settings, model
selection, local key storage, imports and saving notes make no provider calls.
There are no automatic key checks, model-list requests or retries. A request
already sent may still be billed if the connection fails or a window closes.
The plugin sends no output-token cap; provider limits still apply, and longer
responses or reasoning can cost more. Input is bounded to 50 records and 1 MiB.

The curated model lists were checked on **2026-11-08**. Availability, quotas,
prices and data handling depend on your provider account:

- [OpenAI models](https://developers.openai.com/api/docs/models),
  [pricing](https://developers.openai.com/api/docs/pricing) and
  [data controls](https://developers.openai.com/api/docs/guides/your-data).
## Privacy and network use

Ordinary Calendar import needs no Yoofloe account, server database, cloud relay
or AI provider. Loading this plugin performs no transfer reads, secret reads or
network requests. Only approved records are exported from Calendar. Calendar's
app lock, Android folder approval and record approval remain in place.

A transfer uses a one-use key and an authenticated encrypted reply in the vault
inbox. The plugin verifies the current vault, request, expiry, format and bounds
before permitting create-only writes. Your own vault sync tools may copy those
temporary files. Processes and trusted plugins that already have vault access
are not isolated by this exchange. Imported source text and saved AI output are
rendered literally, without executable HTML, remote images or active embeds.

Optional generation sends only the reviewed prompt and selected snapshot
content directly to the chosen provider, without the vault name or a Yoofloe
relay. Related-record IDs inside selected snapshots are included in the review.
OpenAI uses `https://api.openai.com/v1/responses` with `store: false`; that setting
does not promise zero retention under every OpenAI policy. Keys are sent in request headers, never URLs. The plugin does not execute model
tool calls or modify source records from an AI response.

## Development

```text
npm ci
npm run check
npm run lint
npm test
npm run build
```

Release assets are `main.js`, `manifest.json` and `styles.css` from the committed
root build. The plugin uses the existing community ID `yoofloe`.

[Report an issue](https://github.com/yoofloe/yoofloe-obsidian/issues) ·
[MIT license](LICENSE)
