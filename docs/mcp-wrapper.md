# Yoofloe MCP Wrapper

The Yoofloe MCP wrapper is a standalone stdio server in this repository. It lets Codex, Claude Code, Antigravity, or another MCP-capable client fetch Yoofloe AI-document context and write Markdown only into your configured Obsidian vault folder.

This server does not call the Obsidian plugin runtime directly. It uses the same Yoofloe PAT and Edge Function APIs, then writes `.md` files into your vault.

This MCP wrapper does not call Gemini or any other model provider directly. Plugin Gemini generation is a separate feature that exists only inside Obsidian Plugin Mode.

## Recommended tools

- `yoofloe_agent_direct_guide`
- `yoofloe_ai_document_context`
- `yoofloe_write_ai_document`
- `yoofloe_data_bundle`
- `yoofloe_gardener_brief`
- `yoofloe_write_note`
- `yoofloe_vault_status`
- `yoofloe_test_token`

Deprecated compatibility tool:

- `yoofloe_generate_report`

## Required environment variables

- `YOOFLOE_PAT`
- `YOOFLOE_VAULT_PATH`

Optional environment variables:

- `YOOFLOE_FUNCTIONS_BASE_URL`
  - default: `https://hhiyerojemcujzcmlzao.supabase.co/functions/v1`
- `YOOFLOE_SAVE_FOLDER`
  - default: `Yoofloe`
- `YOOFLOE_DATE_FORMAT`
  - default: `YYYY-MM-DD`

If `YOOFLOE_VAULT_PATH` is missing, the server exits immediately with:

```text
YOOFLOE_VAULT_PATH environment variable is required and must point to your Obsidian vault root.
```

## Safety policy

- `YOOFLOE_VAULT_PATH` must point to an existing vault root directory.
- `YOOFLOE_SAVE_FOLDER` must be a relative path inside that vault.
- `..`, absolute paths, drive-hop escapes, and symlink escapes are rejected.
- Writes are limited to the configured save folder.
- Existing files are never overwritten.
- Collisions use `__2`, `__3`, and so on.

## Build and run

Install dependencies:

```bash
npm install
```

Build the plugin and MCP server separately:

```bash
npm run build
npm run build:mcp
```

Start the MCP server:

```bash
YOOFLOE_PAT="pat_yfl_..." \
YOOFLOE_VAULT_PATH="/path/to/ObsidianVault" \
node mcp-server.js
```

PowerShell:

```powershell
$env:YOOFLOE_PAT = "pat_yfl_..."
$env:YOOFLOE_VAULT_PATH = "C:\Users\you\Documents\ObsidianVault"
node .\mcp-server.js
```

## Client setup examples

### Codex / project `.mcp.json`

```json
{
  "mcpServers": {
    "yoofloe": {
      "type": "stdio",
      "command": "node",
      "args": ["mcp-server.js"],
      "env": {
        "YOOFLOE_PAT": "pat_yfl_...",
        "YOOFLOE_VAULT_PATH": "C:/Users/you/Documents/ObsidianVault"
      }
    }
  }
}
```

### Claude Code

```bash
claude mcp add yoofloe -- node /absolute/path/to/mcp-server.js
```

If Claude Code supports environment variables in your setup, provide at least:

- `YOOFLOE_PAT`
- `YOOFLOE_VAULT_PATH`

### Antigravity / Gemini-style `settings.json`

```json
{
  "mcpServers": {
    "yoofloe": {
      "command": "node",
      "args": ["C:/absolute/path/to/mcp-server.js"],
      "env": {
        "YOOFLOE_PAT": "pat_yfl_...",
        "YOOFLOE_VAULT_PATH": "C:/Users/you/Documents/ObsidianVault"
      }
    }
  }
}
```

## Expected output conventions

- Folder: `Yoofloe/`
- File name: `YYYY-MM-DD__<surface>.md`
- Overwrite: `false`
- Frontmatter:

```yaml
source: yoofloe
plugin_id: yoofloe
plugin_version: 0.3.0
type: ai-insight-brief
domains:
  - finance
  - business
range: 1M
scope: personal
generated_at: 2026-04-05T11:45:00.000Z
provider: codex
tags:
  - yoofloe
  - yoofloe/finance
```

## Verification

```bash
npm run check
npm run build
npm run build:mcp
```

The plugin release assets remain unchanged:

- `main.js`
- `manifest.json`
- `styles.css`

`mcp-server.js` is a separate local/server artifact and is not part of the plugin release asset set.

## AI document workflow

The recommended Codex workflow is:

1. Optionally call `yoofloe_agent_direct_guide` to fetch the current workflow contract, prompts, and output conventions.
2. Call `yoofloe_ai_document_context` with a `documentType`, domains, range, and optional `focusInstruction`.
3. Use the returned canonical bundle, gardener brief, and prompt scaffold with the client's own model.
4. Call `yoofloe_write_ai_document` to save the final AI document into the configured `Yoofloe/` folder.

Example:

```text
Use yoofloe_ai_document_context for documentType action-plan with domains finance, business, wellness, and schedule over 1M.
Use the returned prompt scaffold to draft a grounded AI Action Plan.
Keep evidence notes separate from recommendations.
Save the result with yoofloe_write_ai_document.
```

Advanced users can still combine `yoofloe_data_bundle`, `yoofloe_gardener_brief`, and `yoofloe_write_note` manually, but the AI-document workflow above is the intended path.
