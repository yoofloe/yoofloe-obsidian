# Yoofloe for Obsidian

Yoofloe turns your Yoofloe data into grounded AI documents inside Obsidian.

Public install guides, release links, and cross-product setup notes also live in the Yoofloe docs hub:

- `https://www.yoofloe.com/docs/external-tools`

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

## Community Plugin submission notes

For Obsidian Community Plugin review, the submission target is the `yoofloe` plugin itself:

- `main.js`
- `manifest.json`
- `styles.css`

The packaged `yoofloe-obsidian-mcp-wrapper.zip` release asset is a companion download for external MCP clients. It is not the Community Plugin payload.

Reviewer-facing disclosures:

- desktop-only plugin
- requires a Yoofloe `pat_yfl_...` token
- requires Yoofloe Pro / External AI Access
- calls Yoofloe API and Google Gemini endpoints
- writes Markdown files locally into the vault

## Quick start

1. Install the plugin from BRAT or copy the latest release files into `.obsidian/plugins/yoofloe/`.
2. Open `Settings -> Yoofloe`.
3. Save your `pat_yfl_...` token and click `Verify token`.
4. Choose a Gemini setup and save each required field in `Settings -> Yoofloe`.
5. Run `Yoofloe: AI Insight Brief`.

Recommended first AI choice:

- `Gemini (Google AI)` for most users
- `Gemini (Vertex AI)` only if you specifically want your own Vertex setup

## Choose your AI setup

### Gemini (Google AI)

- Best default for most users
- Uses Google OAuth in your browser
- Requires:
  - a Desktop App OAuth client ID from your own Google Cloud project
  - a Google Cloud Project ID
  - a Gemini model such as `gemini-2.5-flash-lite`

### Gemini (Vertex AI)

- Advanced Google Cloud option
- Uses Google OAuth in your browser
- Requires:
  - a Desktop App OAuth client ID from your own Google Cloud project
  - a Google Cloud Project ID
  - a Vertex model such as `gemini-2.5-flash-lite`
- Optional:
  - Vertex location, default `us-central1`

## Common errors

- `Yoofloe API token is missing`
  - Save your `pat_yfl_...` token in `Settings -> Yoofloe`
- `Connect your Google account`
  - Click `Connect Google` in `Settings -> Yoofloe`
- `Add your Google Cloud Project ID`
  - Use your Project ID, not the numeric project number
- `Reconnect Google`
  - Your Google session expired or was revoked; connect again from Settings

## Modes

- Plugin Mode: generate grounded AI documents inside Obsidian with Gemini.
- Agent Direct Mode: let Codex, Claude Code, Antigravity, or another filesystem-capable agent fetch Yoofloe context and write AI documents directly into your vault.
- MCP Wrapper Mode: run the standalone stdio MCP server from this repo so external coding agents can fetch Yoofloe AI context and write notes only into your configured vault folder.

Agent Direct Mode does not call the plugin runtime directly. It uses the same Yoofloe PAT and API contract, then writes files into your vault so Obsidian picks them up automatically.

## External AI Access

Yoofloe treats external AI surfaces as one Pro feature:

- Yoofloe Obsidian Plugin
- Yoofloe Obsidian MCP wrapper
- Yoofloe CLI
- Yoofloe CLI MCP

Auth stays product-specific:

- Obsidian Plugin and Obsidian MCP wrapper use a `pat_yfl_...` token
- Yoofloe CLI and Yoofloe CLI MCP use Yoofloe app login

Operator validation for cross-product entitlement changes should follow the shared runbook in the Yoofloe app repo:

- `docs/ai/external-access-smoke-test.md`

See [docs/agent-direct.md](docs/agent-direct.md) for the direct agent workflow, curl examples, and recommended file conventions.
See [docs/mcp-wrapper.md](docs/mcp-wrapper.md) for the MCP wrapper setup, supported tools, packaged zip install path, and Windows/PowerShell examples.

## Security & Privacy

- Vault content is not uploaded to Yoofloe.
- All network traffic uses Obsidian `requestUrl`.
- The plugin pulls read-only Yoofloe data and writes Markdown files locally in your vault.
- A Yoofloe Personal Access Token is required.
- The plugin is desktop-only.
- Yoofloe requires Obsidian `1.11.5+` and stores your PAT, Google OAuth client secret, and Google OAuth refresh token in Obsidian secure storage instead of `data.json`.
- Google access tokens are kept in memory only and refreshed from secure storage when needed.
- Google OAuth credentials are used only for Gemini requests. They are not sent to Yoofloe backend.

## Data Flow

1. Obsidian sends a read-only request to Yoofloe Edge Functions.
2. Yoofloe returns a deterministic bundle for the selected domains and range.
3. The plugin optionally fetches a deterministic gardener brief to compress signals.
4. AI document commands build prompts locally from the bundle and gardener brief, call your selected Gemini setup with `requestUrl`, then save the result into your vault.

## Domains Contacted

- `https://hhiyerojemcujzcmlzao.supabase.co/functions/v1/obsidian-data-api`
- `https://hhiyerojemcujzcmlzao.supabase.co/functions/v1/obsidian-gardener-api`
- `https://accounts.google.com` during Google OAuth connection
- `https://oauth2.googleapis.com` for Google OAuth token exchange and refresh
- `https://generativelanguage.googleapis.com` when you use `Gemini (Google AI)`
- `https://*.aiplatform.googleapis.com` when you use `Gemini (Vertex AI)`
## Token Storage

- Tokens are generated in Yoofloe web app Settings.
- Tokens use the `pat_yfl_` prefix.
- Tokens expire after 90 days unless regenerated sooner.

## Pro Requirement

Yoofloe External AI Access requires an active Pro-eligible Yoofloe account.

## Wrapper download

The standalone Yoofloe Obsidian MCP Wrapper is published as a packaged release asset:

- `https://github.com/yoofloe/yoofloe-obsidian/releases/latest/download/yoofloe-obsidian-mcp-wrapper.zip`

That zip contains:

- `mcp-server.js`
- `README-mcp-wrapper.txt`

## AI Providers

Plugin AI providers currently support:

- Gemini (Google AI)
- Gemini (Vertex AI)

Google providers share one Google OAuth desktop connection and your own Google Cloud project:

- `Gemini (Google AI)` calls Gemini Developer API with OAuth
- `Gemini (Vertex AI)` calls Vertex AI Standard with OAuth
- Both require:
  - a Desktop App OAuth client ID from your own Google Cloud project
  - a Google Cloud Project ID
- `Gemini (Vertex AI)` also supports a custom location, default `us-central1`

Google OAuth scopes:

- `https://www.googleapis.com/auth/cloud-platform`
- `https://www.googleapis.com/auth/generative-language.retriever`

Yoofloe uses these scopes only for Gemini and Vertex generation requests. The plugin does not use them for unrelated Google Cloud APIs.

These providers are used only by the plugin AI commands:

- `Yoofloe: AI Insight Brief`
- `Yoofloe: AI Decision Memo`
- `Yoofloe: AI Action Plan`
- `Yoofloe: AI Deep Dive`

The MCP wrapper does not call AI providers. Agent Direct Mode also does not reuse plugin secrets.

## AI Document Commands

- `Yoofloe: AI Insight Brief`
- `Yoofloe: AI Decision Memo`
- `Yoofloe: AI Action Plan`
- `Yoofloe: AI Deep Dive`

All four commands pull the full Yoofloe domain bundle by default. `AI Deep Dive` additionally asks for a focus instruction before generation.

## Agent Direct In The Plugin

Settings now includes a `Use With AI Agents` section with:

- `Copy Codex Prompt`
- `Copy Claude Code Prompt`
- `Copy MCP Config`
- `Open Agent Direct Guide`
- `Write Agent Setup Note`

The command palette also includes `Yoofloe: Write Agent Setup Note` for generating a shareable setup note inside your configured Yoofloe folder.

## Agent MCP Workflow

If you want Codex or another coding agent to create a grounded Yoofloe AI document without using plugin Gemini setup:

1. Run the MCP wrapper from this repo.
2. Optionally call `yoofloe_agent_direct_guide` to fetch the current workflow contract and examples.
3. Call `yoofloe_ai_document_context` to fetch the canonical bundle, optional gardener brief, and the document-specific prompt scaffold.
4. Let the agent use its own model path to draft the final Markdown.
5. Call `yoofloe_write_ai_document` to save the final Markdown into your vault under `Yoofloe/`.

Low-level tools such as `yoofloe_data_bundle` and `yoofloe_write_note` remain available for advanced flows, but the AI-document workflow above is the recommended path.
