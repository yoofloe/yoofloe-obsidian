# Yoofloe for Obsidian

Read-only Yoofloe reports inside Obsidian.

## Beta install

Before Community Plugin submission, use BRAT or manual installation from this repository.

## Modes

- Plugin Mode: run Yoofloe commands inside Obsidian to generate local Markdown notes.
- Agent Direct Mode: let Codex, Claude Code, Antigravity, or another filesystem-capable agent call Yoofloe APIs and write `.md` files directly into your vault.

Agent Direct Mode does not call the plugin runtime directly. It uses the same Yoofloe PAT and API contract, then writes files into your vault so Obsidian picks them up automatically.

See [docs/agent-direct.md](docs/agent-direct.md) for the direct agent workflow, curl examples, and recommended file conventions.

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
