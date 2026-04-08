# Yoofloe MCP Wrapper

The Yoofloe MCP wrapper is a standalone stdio server in this repository. It lets Codex, Claude Code, Antigravity, or another MCP-capable client fetch Yoofloe AI-document context and write Markdown only into your configured Obsidian vault folder.

This server does not call the Obsidian plugin runtime directly. It uses the same Yoofloe PAT and Edge Function APIs, then writes `.md` files into your vault.

This MCP wrapper does not call Gemini or any other model provider directly. Plugin Gemini generation is a separate feature that exists only inside Obsidian Plugin Mode.

Public install guides for the plugin, wrapper, and CLI surfaces also live in the Yoofloe docs hub:

- `https://www.yoofloe.com/docs/external-tools`

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

## Download and run

Primary public install path:

1. Download the packaged wrapper zip from the latest release:
   - `https://github.com/yoofloe/yoofloe-obsidian/releases/latest/download/yoofloe-obsidian-mcp-wrapper.zip`
2. Unzip it anywhere on your machine.
3. Point your MCP client at the extracted `mcp-server.js`.

The zip contains:

- `mcp-server.js`
- `README-mcp-wrapper.txt`

Start the MCP server directly:

```bash
YOOFLOE_PAT="pat_yfl_..." \
YOOFLOE_VAULT_PATH="/path/to/ObsidianVault" \
node /absolute/path/to/mcp-server.js
```

PowerShell:

```powershell
$env:YOOFLOE_PAT = "pat_yfl_..."
$env:YOOFLOE_VAULT_PATH = "C:\Users\you\Documents\Obsidian Vault"
node C:\absolute\path\to\mcp-server.js
```

## Advanced source build fallback

If you want to rebuild the wrapper from source instead of using the release zip:

```bash
npm install
npm run build
npm run build:mcp
```

## Client setup examples

### Codex / project `.mcp.json`

Use a relative `mcp-server.js` path only when the MCP client launches from the extracted wrapper folder or this repository root.

```json
{
  "mcpServers": {
    "yoofloe": {
      "type": "stdio",
      "command": "node",
      "args": ["mcp-server.js"],
      "env": {
        "YOOFLOE_PAT": "pat_yfl_...",
        "YOOFLOE_VAULT_PATH": "C:/Users/you/Documents/Obsidian Vault"
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

Use an absolute `mcp-server.js` path here. Antigravity does not start inside the plugin repository or the extracted wrapper folder by default, so a bare `mcp-server.js` path will fail.

```json
{
  "mcpServers": {
    "yoofloe": {
      "command": "node",
      "args": ["C:/absolute/path/to/mcp-server.js"],
      "env": {
        "YOOFLOE_PAT": "pat_yfl_...",
        "YOOFLOE_VAULT_PATH": "C:/Users/you/Documents/Obsidian Vault"
      }
    }
  }
}
```

Current Windows example in this workspace:

```json
{
  "mcpServers": {
    "yoofloe": {
      "type": "stdio",
      "command": "node",
      "args": [
        "C:/Users/MinisForum/Documents/hyunseo/Dev_Yoofloe/Project C_Yoofloe Obsidian Plugin/mcp-server.js"
      ],
      "env": {
        "YOOFLOE_PAT": "pat_yfl_...",
        "YOOFLOE_VAULT_PATH": "C:/Users/MinisForum/Documents/Obsidian Vault",
        "YOOFLOE_FUNCTIONS_BASE_URL": "https://hhiyerojemcujzcmlzao.supabase.co/functions/v1",
        "YOOFLOE_SAVE_FOLDER": "Yoofloe"
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

The plugin release assets include:

- `main.js`
- `manifest.json`
- `styles.css`
- `yoofloe-obsidian-mcp-wrapper.zip`

The wrapper zip contains:

- `mcp-server.js`
- `README-mcp-wrapper.txt`

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
