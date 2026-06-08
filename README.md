# Yoofloe for Obsidian

Yoofloe turns your Yoofloe data into grounded AI documents inside Obsidian.

Public install guides and setup notes also live in the Yoofloe docs hub:

- `https://www.yoofloe.com/docs/external-tools`

## Install

### Community Plugin Store

1. Open `Settings -> Community plugins -> Browse` in Obsidian.
2. Search for `Yoofloe`.
3. Install and enable the `Yoofloe` plugin.

### Manual fallback

1. Download the latest release assets from `https://github.com/yoofloe/yoofloe-obsidian/releases`.
2. Copy `main.js`, `manifest.json`, and `styles.css` into `.obsidian/plugins/yoofloe/`.
3. Enable `Yoofloe` in Obsidian Community Plugins.

### Yoofloe Obsidian MCP

Yoofloe Obsidian MCP is included for Free and Pro users through the same `pat_yfl_...` token flow. It is for MCP-capable agents such as Codex or Claude Code, and the connected agent calls its own model provider or API. Yoofloe does not provide the model for this wrapper.

1. Download `yoofloe-obsidian-mcp-wrapper.zip` from the latest GitHub release.
2. Unzip it somewhere local to the agent runtime.
3. Configure the MCP client with `node`, the unzipped `mcp-server.js`, `YOOFLOE_PAT`, and `YOOFLOE_VAULT_PATH`.
4. Keep real PAT values out of committed `.mcp.json`, shell profiles, logs, and prompts.

See `docs/mcp-wrapper.md` and `docs/agent-direct.md` for full setup notes.

## Review notes

For Obsidian Community Plugin review, the submission target is the `yoofloe` plugin itself:

- `main.js`
- `manifest.json`
- `styles.css`

Reviewer-facing disclosures:

- desktop-only plugin
- requires a Yoofloe `pat_yfl_...` token
- available to Yoofloe Free and Pro accounts
- calls Yoofloe API and Google Gemini endpoints
- writes Markdown files locally into the vault
- uses direct-provider Gemini calls with the user's own Google credentials
- ships a separate GitHub release asset, `yoofloe-obsidian-mcp-wrapper.zip`, for MCP-capable agents; this wrapper is not part of the Obsidian Community Plugin Store payload

## Quick start

1. Install the plugin from the Community Plugin Store or copy the latest release files into `.obsidian/plugins/yoofloe/`.
2. Open `Settings -> Yoofloe`.
3. Save your `pat_yfl_...` token and click `Verify token`.
4. Choose a Gemini setup and save each required field in `Settings -> Yoofloe`.
5. Run `AI Insight Brief`.

Recommended first AI choice:

- `Gemini (Google AI)` for most users
- `Gemini (Vertex AI)` only if you specifically want your own Vertex setup

## Yoofloe access

Yoofloe for Obsidian is included with Free and Pro accounts.

The plugin uses a Yoofloe Personal Access Token to fetch read-only, personal-only Yoofloe context. The token does not include couple/shared exports and cannot decrypt v2 zero-knowledge ciphertext by itself.

Yoofloe does not provide the AI model for plugin generation. Obsidian calls your selected Google Gemini setup directly with your own Google credentials and project.

Yoofloe Obsidian MCP uses the same PAT class for MCP-capable agents. The connected agent chooses and calls its own model path; Yoofloe provides bounded tools, access control, and vault-safe write boundaries.

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

## Security & privacy

- Vault content is not uploaded to Yoofloe.
- All network traffic uses Obsidian `requestUrl`.
- The plugin pulls read-only Yoofloe data and writes Markdown files locally in your vault.
- A Yoofloe Personal Access Token is required.
- The plugin is desktop-only.
- Yoofloe requires Obsidian `1.11.5+` and stores your PAT, Google OAuth client secret, and Google OAuth refresh token in Obsidian secure storage instead of `data.json`.
- Google access tokens are kept in memory only and refreshed from secure storage when needed.
- Google OAuth credentials are used only for Gemini requests. They are not sent to Yoofloe backend.
- External providers may process content under their own terms and privacy practices when you choose to use them.

## Data flow

1. Obsidian sends a read-only request to Yoofloe Edge Functions.
2. Yoofloe returns a deterministic bundle for the selected domains and range.
3. The plugin optionally fetches a deterministic gardener brief to compress signals.
4. AI document commands build prompts locally from the bundle and gardener brief, call your selected Gemini setup with `requestUrl`, then save the result into your vault.

The `life` domain includes Activity Log entries, Habit Tracker definitions, habit date check-ins, goals, and study evidence.

## Domains contacted

- `https://hhiyerojemcujzcmlzao.supabase.co/functions/v1/obsidian-data-api`
- `https://hhiyerojemcujzcmlzao.supabase.co/functions/v1/obsidian-gardener-api`
- `https://accounts.google.com` during Google OAuth connection
- `https://oauth2.googleapis.com` for Google OAuth token exchange and refresh
- `https://generativelanguage.googleapis.com` when you use `Gemini (Google AI)`
- `https://*.aiplatform.googleapis.com` when you use `Gemini (Vertex AI)`

## Token storage

- Tokens are generated in Yoofloe web app Settings.
- Tokens use the `pat_yfl_` prefix.
- Tokens expire after 90 days unless regenerated sooner.

## AI providers

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

## AI document commands

- `AI Insight Brief`
- `AI Decision Memo`
- `AI Action Plan`
- `AI Deep Dive`

All four commands pull the full Yoofloe domain bundle by default. `AI Deep Dive` additionally asks for a focus instruction before generation.
