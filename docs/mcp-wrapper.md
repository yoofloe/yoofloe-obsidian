# Yoofloe MCP Wrapper

Yoofloe Obsidian MCP is public for Yoofloe Free and Pro users. It lets MCP-capable agents use Yoofloe context and write grounded AI documents into your Obsidian vault.

The connected MCP client or agent calls its own model provider or API. Yoofloe does not provide the model for this wrapper.

## Install

1. Download `yoofloe-obsidian-mcp-wrapper.zip` from the latest Yoofloe Obsidian GitHub release.
2. Unzip it on the machine where your MCP client runs.
3. Generate a `pat_yfl_...` token in Yoofloe web app Settings.
4. Configure the MCP client with:
   - `command`: `node`
   - `args`: absolute path to the unzipped `mcp-server.js`
   - `YOOFLOE_PAT`: your token
   - `YOOFLOE_VAULT_PATH`: absolute path to your Obsidian vault root
   - `YOOFLOE_SAVE_FOLDER`: optional folder inside the vault, default `Yoofloe`

## Example MCP config

```json
{
  "mcpServers": {
    "yoofloe": {
      "type": "stdio",
      "command": "node",
      "args": ["C:/absolute/path/to/mcp-server.js"],
      "env": {
        "YOOFLOE_PAT": "pat_yfl_...",
        "YOOFLOE_VAULT_PATH": "C:/Users/you/Documents/Obsidian Vault",
        "YOOFLOE_SAVE_FOLDER": "Yoofloe"
      }
    }
  }
}
```

## Safety rules

- Do not commit real PAT values to `.mcp.json`, shell profiles, prompts, logs, or screenshots.
- `YOOFLOE_VAULT_PATH` must point to your vault root, not the output subfolder.
- The wrapper is personal-only by design and does not include couple/shared exports.
- PAT access and MCP config values cannot decrypt Yoofloe v2 zero-knowledge ciphertext by themselves.
- Existing files are not overwritten; filename collisions use numeric suffixes.
