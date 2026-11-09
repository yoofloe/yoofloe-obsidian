# Yoofloe Calendar Companion

Work with the note you have open, or ask about your plans, study, projects and focus history. Note AI can summarize, refine and extract tasks from your selected text or current note using your own OpenAI key. The companion
finds relevant records locally on your Android device, then lets you review
the compact context before optionally generating a draft with your own OpenAI key.

**Note AI works on Android phones and tablets with Obsidian 1.11.5 or later.**
It does not require the Calendar app. To add Calendar context or import records, install
**Yoofloe Calendar 1.8.5 or later** and **Obsidian 1.11.5 or later** on the same
device and Android user profile. Desktop, iPhone and iPad cannot connect directly;
imported Markdown remains readable and editable wherever you use your vault.

[Get Yoofloe Calendar for Android](https://play.google.com/store/apps/details?id=com.yoofloe.calendar)
to keep your plans, notes, study and project progress together, with a quiet
place to focus. The same link is available directly in this plugin's settings.

## AI in your open note

1. Open a Markdown note in editing mode. Select a passage, or leave the cursor
   in the note to use its full text. Tap the note's sparkle action or choose
   **Note AI** in the note menu or command palette. The command can also be
   added to Obsidian's mobile toolbar.
2. Choose **Ask**, **Summarize**, **Refine** or **To-do list**, then adjust the
   request. The source is captured from your editor, including unsaved edits.
   No other notes or folders are read. Notes over 32 KiB require a shorter
   selection or an explicit **Use current section** choice; they are not
   silently shortened and described as a complete-note summary.
3. Review **Exactly what will be sent**, the model and saved-key status.
   **Generate once** approves one paid OpenAI request. Choosing an action,
   opening settings and hiding the sheet never send a request.
4. Review the result. **Add below selection** or **Append to note** keeps the
   original text. If you requested a rewrite, review **Proposed changes** and
   **Review changes**, then explicitly replace the selection, section or complete
   note. Full-note changes first save the exact original in
   `Yoofloe Calendar/AI backups/`. **Undo last AI edit** restores it only if no
   newer edit would be lost. Normal editor insertions also support Obsidian Undo.

You can write an entire document from an empty note, rewrite existing prose,
restructure it, translate it, create tables and task lists, explain math, or add
Mermaid flowcharts, timelines and charts. Use the **Diagram, chart, table…**
selector for starting requests, or describe any writing/editing task yourself.
Diagrams, tables and LaTeX render directly in the draft and remain editable
Markdown when saved. There is no extra rendering service or runtime dependency.

**Related Markdown notes** finds up to four relevant complete notes from local
titles, links and bounded content search. No individual folders need selection.
Check the source previews before generating; local file paths stay on your
device. Search considers at most 2000 metadata entries, reads up to 32 candidates,
and includes only complete notes up to 32 KiB each. The displayed scanned/total
counts make limited coverage explicit. AI backups and hidden folders are excluded.

A response may propose updates to several reviewed notes and new documents.
Choose a proposed file, review its original/draft/diff and apply it individually.
The model only names reviewed references; it never supplies filesystem paths or
executes write tools. New documents are created beside the source using the
reviewed title, and an existing file with that name is preserved. **Continue with
this answer** keeps previous answers, refreshes the source and lets you make
another explicit request. Only bounded excerpts of the last two answers enter
the next API input; all answers remain available in this vault session.

The phone layout keeps the request and Generate action in a compact bottom
sheet. Wider layouts show the source and result in two columns. Hiding the
sheet, rotating or switching notes keeps the request and paid result for the
current vault session. Reopen Note AI to resume it. A different note never
silently receives the previous note's result. Closing the vault, disabling the
plugin or restarting Obsidian ends this temporary in-memory work; save or copy
the result first.

If the source is edited, renamed, closed or deleted, unsafe insertion/replacement
is refused and the result remains available for copying or saving separately.
Generated headings, lists, links, tables, math and safe Mermaid remain Markdown.
Active HTML, embeds, diagram callbacks/configuration and executable plugin
fenced blocks are made inert before insertion. Existing
full-snapshot import formatting is unchanged.

**Add Calendar context (optional)** performs the same bounded local search as
Ask Calendar below. State what you need from Calendar; approve the relevant
excerpts in the app, then review the combined note and Calendar input before
generating. No folder-by-folder setup or AI-powered search planner is used.
The note and request remain here while you switch apps.

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
   switch or record-by-record selection is needed. Note AI also uses a single
   explicit **Generate once** action; for Calendar the **Generate once
   with OpenAI** action approves just the displayed input and model.
   Saving a key confirms a local readback, shows an immediate notification and
   leaves an inline saved status beside the masked field. This is a storage
   confirmation, not an API authorization test; saving makes no provider call.
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
