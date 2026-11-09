# Yoofloe Calendar Companion

Ask about your plans, notes, study, projects and focus history. The companion
finds relevant records locally on your Android device, then lets you review
the compact context before optionally generating a draft with your own OpenAI key.

**Direct connection works on Android phones and tablets only.** Install
**Yoofloe Calendar 1.8.5 or later** and **Obsidian 1.11.5 or later** on the same
device and Android user profile. Desktop, iPhone and iPad cannot connect directly;
imported Markdown remains readable and editable wherever you use your vault.

[Get Yoofloe Calendar for Android](https://play.google.com/store/apps/details?id=com.yoofloe.calendar)
to keep your plans, notes, study and project progress together, with a quiet
place to focus. The same link is available directly in this plugin's settings.

## Ask Calendar

1. Open **Settings → Yoofloe Calendar Companion → Ask Calendar**.
2. Enter a question, for example **Summarize my study and focus time this week**.
   Check the suggested workspaces, dates and topic. **Adjust search** lets you
   change these when needed; individual folders do not need to be selected.
3. Choose **Find relevant records**. Calendar remembers your approved Inbox.
   Android may require one folder choice on the first connection, or after its
   permission is revoked. Select only **Yoofloe Calendar Inbox** inside this vault.
4. In Calendar, check the scope and choose **Find relevant records** to approve
   reading locally and returning compact matching excerpts to this vault.
5. Back in Obsidian, review the sources and exact outgoing input. Choose
   **Generate once with OpenAI** only if you approve sending that input and
   any OpenAI API charges. Review the answer before saving a new draft note.

Search itself makes no AI call. A small local planner recognizes common
workspace/date phrases in English, Korean and Polish; it is not a general
language model. Ambiguous questions ask for a workspace. The suggested topic
is visible and can be edited or cleared. Empty results suggest changing the
topic or dates, rather than silently reading all records.

Search excludes Trash, unrelated workspaces and whole folder trees. Flow is
included only when requested, and project financial entries only for a budget
question. Linked notes are included only when linked to matching records.
Metadata scanning is bounded to 512 candidates, results to 20 excerpts, and
combined excerpt text to 32 KiB. Dates are anchored to the request's local day.
Results declare partial coverage when capped or shortened. Recorded study time,
measured Garden time and planned durations have different meanings.

Question excerpts never enter the full-snapshot namespace. Existing records,
Markdown files, model choices and vault-bound key IDs are preserved. Editing
the question, scope or model requires a fresh applicable review. Every generation
is one-use; failures are not retried automatically.

## Import complete records manually

1. Open **Settings → Yoofloe Calendar Companion → Import complete records**,
   or choose **Import complete records manually** from the question screen.
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

## Optional AI settings

Calendar import requires no model provider or paid service. AI starts off after
every plugin load.

1. Open **AI settings** and choose an OpenAI model.
   **Custom** accepts an exact API model ID; examples appear beside the field.
2. Save your own provider key locally. For **Ask Calendar**, no separate enable
   switch or record-by-record selection is needed: the explicit **Generate once
   with OpenAI** action approves just the displayed input and model.
3. The advanced full-snapshot importer retains **Draft from selected records**,
   its selection/review flow and session enable switch.
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
responses or reasoning can cost more. The advanced manual flow has a separate
50-record and 1 MiB input bound; question retrieval uses the smaller limits above.

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

Optional generation sends only the reviewed prompt and context directly to
OpenAI, without the vault name or a Yoofloe relay. Question context uses short
source references such as C1 and excludes local source IDs, paths and raw DTOs.
The advanced full-snapshot mode can include related-record IDs, visible in its review.
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
