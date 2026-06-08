# Yoofloe Agent Direct

Agent Direct is the workflow where Codex, Claude Code, or another MCP-capable agent brings its own model path and uses Yoofloe Obsidian MCP for grounded context and vault-safe writes.

Yoofloe does not provide the model for Agent Direct. The connected agent or API you choose handles model execution and billing.

## Recommended workflow

1. Start the Yoofloe MCP server from your agent.
2. Call `yoofloe_mcp_session_status` to check PAT presence, vault path, personal-only scope, and ZK readiness.
3. Call `yoofloe_ai_document_context` with a supported document type, domains, range, and optional focus instruction.
4. Use your own model path to draft the final Markdown from the returned scaffold and context.
5. Call `yoofloe_write_ai_document` to save the final document into the configured vault folder.

## Supported document types

- `insight-brief`
- `decision-memo`
- `action-plan`
- `deep-dive`

`deep-dive` requires a non-empty focus instruction.

## Important boundaries

- Agent Direct does not reuse the plugin's Gemini OAuth setup or secrets.
- Keep PAT values local and out of committed config.
- The wrapper is personal-only by design.
- Existing files are never overwritten.
