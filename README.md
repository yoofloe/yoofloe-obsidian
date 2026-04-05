# Yoofloe for Obsidian

Yoofloe reports, recaps, and optional BYOK AI notes inside Obsidian.

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
- Optional BYOK keys are sent only to the provider you select. They are not sent to Yoofloe backend.

## Data Flow

1. Obsidian sends a read-only request to Yoofloe Edge Functions.
2. Yoofloe returns a deterministic bundle for the selected domains and range.
3. Read-only commands render Markdown locally and save it into your vault.
4. Optional AI commands build prompts locally from the same bundle, call your selected BYOK provider with `requestUrl`, then save the result into your vault.

## Domains Contacted

- `https://hhiyerojemcujzcmlzao.supabase.co/functions/v1/obsidian-data-api`
- `https://hhiyerojemcujzcmlzao.supabase.co/functions/v1/obsidian-gardener-api`
- `https://generativelanguage.googleapis.com` when you enable Gemini BYOK in the plugin
- `https://api.openai.com` when you enable OpenAI BYOK in the plugin
- `https://api.anthropic.com` when you enable Anthropic BYOK in the plugin

## Token Storage

- Tokens are generated in Yoofloe web app Settings.
- Tokens use the `pat_yfl_` prefix.
- Tokens expire after 90 days unless regenerated sooner.

## Pro Requirement

Yoofloe Obsidian access requires an active Pro-eligible Yoofloe account.

## External AI Providers

Plugin BYOK is optional and currently supports:

- Gemini
- OpenAI
- Anthropic

These providers are used only by the plugin AI commands:

- `Yoofloe: AI Brief`
- `Yoofloe: AI Action Plan`
- `Yoofloe: AI Prompt Package`

The MCP wrapper does not call AI providers. Agent Direct Mode also does not reuse plugin BYOK keys.
