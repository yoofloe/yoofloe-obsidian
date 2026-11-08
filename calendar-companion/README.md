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

No Yoofloe account, PAT, cloud service, model provider or hosted relay is used.
Loading the plugin performs no transfer reads or network requests. Unsupported
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

## Local build and checks

Use the existing parent repository's development dependencies; no new package
or hosted service is needed:

```text
node calendar-companion/build.mjs --test
node --test calendar-companion/tests/companion.test.mjs
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
