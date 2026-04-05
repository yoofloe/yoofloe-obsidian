# Yoofloe for Obsidian

Read-only Yoofloe reports inside Obsidian.

## Beta install

Before Community Plugin submission, install the beta from this public repository instead of the Community Plugin store.

BRAT path:

1. Install the BRAT plugin in Obsidian.
2. Open `BRAT -> Add a beta plugin`.
3. Paste `https://github.com/yoofloe/yoofloe-obsidian`.
4. Install the latest beta release from that repository.

Manual path:

1. Download the latest release assets from `https://github.com/yoofloe/yoofloe-obsidian/releases`.
2. Copy `main.js`, `manifest.json`, and `styles.css` into `.obsidian/plugins/yoofloe/`.
3. Enable `Yoofloe` in Obsidian Community Plugins.

## Modes

- Plugin Mode: run Yoofloe commands inside Obsidian to generate local Markdown notes.
- Agent Direct Mode: let Codex, Claude Code, Antigravity, or another filesystem-capable agent call Yoofloe APIs and write `.md` files directly into your vault.
- MCP Wrapper Mode: run the standalone stdio MCP server from this repo so external coding agents can call Yoofloe tools and write notes only into your configured vault folder.

Agent Direct Mode does not call the plugin runtime directly. It uses the same Yoofloe PAT and API contract, then writes files into your vault so Obsidian picks them up automatically.

See [docs/agent-direct.md](docs/agent-direct.md) for the direct agent workflow, curl examples, and recommended file conventions.
See [docs/mcp-wrapper.md](docs/mcp-wrapper.md) for the MCP wrapper setup, supported tools, and Windows/PowerShell examples.

## Security & Privacy

- Vault content is not uploaded to Yoofloe.
- All network traffic uses Obsidian `requestUrl`.
- The plugin pulls read-only Yoofloe data and writes Markdown files locally in your vault.
- A Yoofloe Personal Access Token is required.
- PAT and any optional provider keys are stored locally in the plugin settings and may be present in plain text inside `.obsidian/plugins/yoofloe/data.json`.

## Data Flow

1. Obsidian sends a read-only request to Yoofloe Edge Functions.
2. Yoofloe returns a deterministic bundle for the selected domains and range.
3. The plugin writes Markdown into your vault.

## Domains Contacted

- `https://hhiyerojemcujzcmlzao.supabase.co/functions/v1/obsidian-data-api`
- `https://hhiyerojemcujzcmlzao.supabase.co/functions/v1/obsidian-gardener-api`

## Token Storage

- Tokens are generated in Yoofloe web app Settings.
- Tokens use the `pat_yfl_` prefix.
- Tokens expire after 90 days unless regenerated sooner.

## Pro Requirement

Yoofloe Obsidian access requires an active Pro-eligible Yoofloe account.

## External AI Providers

BYOK providers are not enabled in this MVP. The current plugin ships read-only report generation only.
