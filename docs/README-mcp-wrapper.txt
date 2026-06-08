Yoofloe Obsidian MCP

This package is for MCP-capable agents such as Codex, Claude Code, or another local agent runtime.

Yoofloe does not provide the model for this wrapper. Your connected agent or API calls its own model provider and may have its own terms, retention rules, and costs.

Files:

- mcp-server.js
- README.txt

Required environment:

- YOOFLOE_PAT=pat_yfl_...
- YOOFLOE_VAULT_PATH=<absolute path to your Obsidian vault root>

Optional environment:

- YOOFLOE_FUNCTIONS_BASE_URL=https://hhiyerojemcujzcmlzao.supabase.co/functions/v1
- YOOFLOE_SAVE_FOLDER=Yoofloe
- YOOFLOE_DATE_FORMAT=YYYY-MM-DD

Example MCP config:

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

Security notes:

- Do not commit real PAT values into .mcp.json, shell profiles, prompts, logs, or screenshots.
- YOOFLOE_VAULT_PATH must point to your vault root, not the Yoofloe output subfolder.
- The wrapper is personal-only by design and does not include couple/shared exports.
- PAT access cannot decrypt Yoofloe v2 zero-knowledge ciphertext by itself.
