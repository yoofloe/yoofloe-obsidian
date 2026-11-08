# AGENTS.md - Yoofloe Obsidian Plugin

This repository follows the shared Yoofloe environment and release policy from the app repo:

- `C:\Users\MinisForum\Documents\hyunseo\Dev_Yoofloe\Project A_Yoofloe App\Yoofloe\AGENTS.md`
- `C:\Users\MinisForum\Documents\hyunseo\Dev_Yoofloe\Project A_Yoofloe App\Yoofloe\.agent\ops\runbooks\dev-prod-change-management.md`
- `C:\Users\MinisForum\Documents\hyunseo\Dev_Yoofloe\Project A_Yoofloe App\Yoofloe\.agent\ops\runbooks\skill-system-v2.md`

Plugin-specific rules:

- The owner requested a complete Calendar Companion pivot for 0.4.0. The public plugin keeps registry ID `yoofloe`.
- Current releases contain the Android Calendar Companion plugin only. The earlier cloud plugin and MCP wrapper remain available in historical tags/releases through 0.3.31; do not silently include or reactivate them in the new payload.
- Public root builds must package the single `calendar-companion/src/main.ts` implementation and match the committed root manifest/styles. `src/main.ts` re-exports the same implementation for tooling.
- Verify local import, create-only vault writes, explicit optional-provider approvals and startup without I/O. No live Gemini test is authorized in this run.
- Actual AI test calls are tracked externally under the owner cumulative limit of 10; call 11 needs fresh prior approval.
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
