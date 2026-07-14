# Yoofloe for Obsidian

Yoofloe for Obsidian brings selected, personal Yoofloe context into your Obsidian vault. It can create grounded Markdown notes through **your own Vertex AI project** and can safely capture approved personal notes or tasks back to Yoofloe.

The plugin and the separate Yoofloe Obsidian MCP wrapper are available to Yoofloe Free and Pro users. Neither includes a Yoofloe-provided model or Yoofloe model credits:

- Direct plugin generation calls the Vertex AI project and model that **you** configure. Google Cloud usage and billing remain between you and Google Cloud.
- The MCP wrapper lets a connected agent, such as Codex or Claude Code, use the model path that **you** configure for that agent. The agent provider's terms and billing apply.

Public install guides also live at `https://www.yoofloe.com/docs/external-tools`.

## Install

### Community Plugin Store

1. Open `Settings -> Community plugins -> Browse` in Obsidian.
2. Search for `Yoofloe`.
3. Install and enable the plugin.

### Manual fallback

1. Download the latest release assets from `https://github.com/yoofloe/yoofloe-obsidian/releases`.
2. Copy `main.js`, `manifest.json`, and `styles.css` into `.obsidian/plugins/yoofloe/`.
3. Enable `Yoofloe` in Obsidian Community Plugins.

### Yoofloe Obsidian MCP

1. Download `yoofloe-obsidian-mcp-wrapper.zip` from the latest GitHub release.
2. Unzip it somewhere local to the agent runtime.
3. Configure the MCP client with `node`, the unzipped `mcp-server.js`, `YOOFLOE_PAT`, and `YOOFLOE_VAULT_PATH`.
4. Keep real PAT values out of committed `.mcp.json`, shell profiles, logs, and prompts.

See `docs/mcp-wrapper.md` and `docs/agent-direct.md` for setup notes.

## Quick start

1. Install the plugin and open `Settings -> Yoofloe`.
2. Click `Connect with Yoofloe web`, approve the pairing request, and return to Obsidian.
3. For direct generation on desktop, choose `Your Vertex AI project`, add the desktop OAuth client and secret from **your** Google Cloud project, connect Google, and choose a Vertex model.
4. Open `Yoofloe: Open AI Writer`, select only the Yoofloe sources you want to use, and choose `Generate note`.
5. To use another AI provider, download the MCP wrapper and connect it to an MCP-capable agent that already uses your preferred model.
6. Optional: open `Yoofloe Capture`, preview a memo, journal, or task card, and approve only the personal records you want to write back.

## Direct Vertex AI setup

Direct plugin generation is desktop-only because Google desktop OAuth uses a local callback. It requires:

- a Desktop App OAuth client ID and client secret from your Google Cloud project;
- your Google Cloud project ID;
- a Vertex AI model ID; and
- a Google sign-in that authorizes that project.

The client secret and refresh token are stored in Obsidian secure storage, not in `data.json`. Google access tokens stay in memory only. The plugin sends the selected Yoofloe context directly from Obsidian to your Vertex AI project; it does not send your Google OAuth credentials to Yoofloe.

Vertex AI availability, pricing, retention, and terms depend on your Google Cloud project and configuration. Review those terms before sending private or sensitive content.

## Yoofloe access and boundaries

- Yoofloe uses a `pat_yfl_...` Personal Access Token to fetch read-only, personal-only context. Tokens expire after 90 days unless regenerated sooner.
- Capture writeback requires a separate read-write pairing approval and remains personal-only.
- The plugin and MCP wrapper do not include couple/shared exports and a PAT cannot decrypt Yoofloe v2 zero-knowledge ciphertext by itself.
- Your vault remains local unless you explicitly include selected text or current-note content in a Writer request, or type/select text for Capture.
- Writer generation uses only the Yoofloe sources you choose. Finance and Business sources are marked sensitive and are off by default.
- Yoofloe Capture is preview-first: it can create approved personal Journal/Memo records, create or complete personal Schedule tasks, and make limited soft deletes. It does not expose folders, bulk mutation, hard delete, Finance, Business, or couple/shared writeback in v1.

## MCP model choice

The MCP wrapper supplies PAT-authenticated, bounded Yoofloe tools and vault-safe output boundaries. It does not select or call an AI model. Your MCP client or connected agent selects its own provider, model, credentials, and billing path.

## Common errors

- `Yoofloe API token is missing`: reconnect through `Settings -> Yoofloe`, or use the manual PAT field.
- `Configure your own Vertex AI project`: finish the provider setup in the plugin, or use the MCP wrapper with a compatible agent.
- `Reconnect Google`: the local Google OAuth session expired or was revoked; reconnect from plugin settings.
- `Add your Google Cloud Project ID`: use the project ID, not the numeric project number.
- `Open a Markdown note`: open a Markdown note before choosing `Current note` as the destination.

## Security and privacy

- All network traffic uses Obsidian `requestUrl`.
- A Yoofloe PAT is required for Yoofloe context and writeback endpoints.
- Direct Vertex AI generation uses your own OAuth credentials and provider project. The plugin never sends those credentials to Yoofloe.
- MCP generation uses the provider configured in the agent you choose. That provider is a user-selected third party, not a Yoofloe model provider for this workflow.
- Google Cloud and agent-provider handling, including pricing and retention, are governed by the provider relationship you choose.
- Review Yoofloe's AI Features Notice before enabling an external AI workflow.

## Data flow

1. Obsidian fetches a personal-only Yoofloe context bundle with your PAT.
2. Direct Writer generation sends the selected bundle and optional explicitly enabled current-note context to your Vertex AI project from Obsidian.
3. MCP generation sends context only when your connected agent invokes an MCP tool, then the agent uses its own configured model path.
4. Capture calls `obsidian-write-preview`, shows candidate cards, and calls `obsidian-write-execute` only for cards you approve.

The `life` domain includes Activity Log entries, Habit Tracker definitions, habit date check-ins, goals, and study evidence.

## Domains contacted

- `https://hhiyerojemcujzcmlzao.supabase.co/functions/v1/obsidian-data-api`
- `https://hhiyerojemcujzcmlzao.supabase.co/functions/v1/obsidian-gardener-api`
- `https://hhiyerojemcujzcmlzao.supabase.co/functions/v1/obsidian-write-preview`
- `https://hhiyerojemcujzcmlzao.supabase.co/functions/v1/obsidian-write-execute`
- `https://accounts.google.com` during Google OAuth connection
- `https://oauth2.googleapis.com` for Google OAuth token exchange and refresh
- `https://*.aiplatform.googleapis.com` when you use your Vertex AI project

## Community Plugin review notes

The Community Plugin payload contains only `main.js`, `manifest.json`, and `styles.css`. It:

- works on desktop, tablet, and mobile for pairing and Capture;
- uses desktop-only direct Vertex AI setup for generation;
- requires a Yoofloe `pat_yfl_...` token;
- writes generated Markdown locally into the vault;
- can write only explicitly approved personal Capture actions after a separate read-write pairing approval; and
- ships the MCP wrapper as a separate GitHub release asset, not in the Community Plugin Store payload.

## AI document commands

- `Yoofloe: Open AI Writer`
- `Yoofloe: Open Yoofloe Capture`
- `Create first Yoofloe AI note`
- `Create MCP setup note`
- `AI Insight Brief`
- `AI Decision Memo`
- `AI Action Plan`
- `AI Deep Dive`

The Writer provides `Daily review`, `Weekly plan`, `Decision memo`, `Finance snapshot`, and `Free prompt`. Library is available as a selected personal context source. `AI Deep Dive` asks for a focus instruction before generation.
