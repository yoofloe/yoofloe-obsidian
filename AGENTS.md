# AGENTS.md - Yoofloe Obsidian Plugin

This repository follows the shared Yoofloe environment and release policy from the app repo:

- `C:\Users\MinisForum\Documents\hyunseo\Dev_Yoofloe\Project A_Yoofloe App\Yoofloe\AGENTS.md`
- `C:\Users\MinisForum\Documents\hyunseo\Dev_Yoofloe\Project A_Yoofloe App\Yoofloe\.agent\ops\runbooks\dev-prod-change-management.md`
- `C:\Users\MinisForum\Documents\hyunseo\Dev_Yoofloe\Project A_Yoofloe App\Yoofloe\.agent\ops\runbooks\skill-system-v2.md`

Plugin-specific rules:

- The Obsidian plugin and the MCP wrapper are one release family in this repo.
- Release verification must check both deliverables:
  - community plugin payload
  - `yoofloe-obsidian-mcp-wrapper.zip`
- Runtime verification stays split:
  - plugin mode
  - wrapper mode
- Use clean worktrees for release and reconciliation work.
- External access and PAT-related changes are environment-backed and must be classified before implementation.

Preferred skill entrypoints:

- `yoofloe-obsidian-release`
- `yoofloe-obsidian-plugin-verify`
- `yoofloe-obsidian-wrapper-verify`
- `yoofloe-mcp-verify`
- `yoofloe-external-access-verify`
- `yoofloe-git-governance`
- `yoofloe-env-governance`
