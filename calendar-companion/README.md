# Yoofloe AI implementation

The plugin is a standalone Obsidian Markdown AI workspace for desktop and mobile.
Yoofloe Calendar and ChronoHUD support optional device-local connections in Obsidian on Android.

See the current [user guide](../README.md), [privacy/data flow notice](../PRIVACY.md),
and native protocol modules/tests. Plugin ID `yoofloe`, Inbox, v2/v3 and local secret IDs remain stable.
Gemini and the historical cloud/MCP plugin are inactive. Do not bundle or revive them implicitly.

Build from the repository root: `npm run build`.
Run `npm run check`, `npm run lint`, `npm test` before releasing all three payload files together.

## Calendar workspaces

Use **Workspace settings → App context → Yoofloe Calendar** and **Check Calendar connection**. Share capabilities in Calendar,
return to Obsidian to choose workspaces and record types, then approve the lookup in Calendar. Date and folder filters narrow the search. Archive, Trash, financial records and attachment metadata each have a separate switch. The local summary lists its sources and identifies partial coverage.

Choose which approved excerpts to include before sending a message. **Draft workspace changes** uses the connected Calendar build's supported actions. Review and apply the batch in Calendar. Use **Revert in Calendar** for the matching proposal.

Use **Quick Calendar lookup** for the original lookup and one-off event and task proposal controls.

## ChronoHUD data

Choose **ChronoHUD** in Workspace settings to request date cards, timeline text, Mandalart goals or Eisenhower tasks.
ChronoHUD shows the approved export and calculates its dates and metrics locally. Select the returned excerpts for your
next message. Each excerpt keeps its original H reference.

Choose **Open ChronoHUD to approve**, select the vault’s **ChronoHUD Inbox**, and review the excerpts. Choose
**Approve and return to Obsidian** to open the approved results.
