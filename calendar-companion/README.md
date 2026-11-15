# Yoofloe AI implementation

The plugin is a standalone Obsidian Markdown AI workspace for desktop and mobile.
Yoofloe Calendar supports an optional device-local Android connection and explicit request files from Desktop.

See the current [user guide](../README.md), [privacy/data flow notice](../PRIVACY.md),
and native protocol modules/tests. Plugin ID `yoofloe`, Inbox, v2/v3 and local secret IDs remain stable.
Gemini and the historical cloud/MCP plugin are inactive. Do not bundle or revive them implicitly.

Build from the repository root: `npm run build`.
Run `npm run check`, `npm run lint`, `npm test` before releasing all three payload files together.

## Calendar workspaces

Use **Check Calendar capabilities**, choose workspaces and record types, then approve the lookup in Calendar. Date and folder filters narrow the search. Archive, Trash, financial records and attachment metadata each have a separate switch. The local summary lists its sources and identifies partial coverage.

Choose which approved excerpts to include before sending a message. **Draft workspace changes** uses the connected Calendar build's supported actions. Review and apply the batch in Calendar, and use the matching proposal's Undo action to revert it.

On Android you can open Calendar from the plugin. On Desktop, save the request file, transfer it to the local **Yoofloe Calendar Inbox** on Android and choose it in Calendar. Transfer the reply back and import it in the same conversation before the request expires. Remove the downloaded copy after use. The plugin keeps the pending desktop request in memory and can use a status request to check a saved proposal result after reopening.

Existing Calendar lookups and the first release of event and task proposals use their existing controls.

## ChronoHUD data

Choose **ChronoHUD** in Workspace settings to request date cards, timeline text, Mandalart goals or Eisenhower tasks.
ChronoHUD shows the approved export and calculates its dates and metrics locally. Select the returned excerpts for your
next message. Each excerpt keeps its original H reference.

On Android, open the connection in ChronoHUD and select the vault's **ChronoHUD Inbox**. On Desktop, save a request,
open it on Android and import the matching reply. The request file contains an expiring transfer key. After importing
the reply, remove exported request and reply copies from both devices.
