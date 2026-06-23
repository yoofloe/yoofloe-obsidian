# Yoofloe for Obsidian

Yoofloe turns your Yoofloe data into grounded AI documents inside Obsidian and can safely capture approved personal notes or tasks back to Yoofloe.

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

- works in Obsidian desktop, tablet, and mobile for Yoofloe-hosted AI Writer and Capture
- requires a Yoofloe `pat_yfl_...` token
- available to Yoofloe Free and Pro accounts
- calls Yoofloe API endpoints, including the hosted AI Writer and Capture preview/execute endpoints
- writes Markdown files locally into the vault
- can write approved personal memo, journal, and schedule-task actions back to Yoofloe after a read-write pairing approval
- uses Yoofloe-hosted AI Writer by default
- optionally uses direct-provider Gemini calls with the user's own Google credentials when Advanced BYOK is enabled on desktop
- ships a separate GitHub release asset, `yoofloe-obsidian-mcp-wrapper.zip`, for desktop MCP-capable agents; this wrapper is not part of the Obsidian Community Plugin Store payload

## Quick start

1. Install the plugin from the Community Plugin Store or copy the latest release files into `.obsidian/plugins/yoofloe/`.
2. Open `Settings -> Yoofloe`.
3. Click `Connect with Yoofloe web`, approve the pairing request, and return to Obsidian.
4. Click `Open AI Writer`.
5. Choose a preset such as `Daily review`, then click `Generate note`.
6. Optional: click `Open Yoofloe Capture`, preview a memo/task/journal card, then approve selected cards after reconnecting with write access.

Recommended first AI choice:

- `Yoofloe hosted` for most users
- `Gemini BYOK` only if you specifically want your own Google setup

## Yoofloe access

Yoofloe for Obsidian is included with Free and Pro accounts.

Yoofloe-hosted AI Writer and Yoofloe Capture are available in Obsidian desktop, tablet, and mobile. Advanced Google BYOK setup remains desktop-only because it uses Google OAuth with a local callback.

The plugin uses a Yoofloe Personal Access Token to fetch read-only, personal-only Yoofloe context. Capture writeback asks you to reconnect with a capability-scoped read-write token before applying anything to Yoofloe. Tokens do not include couple/shared exports and cannot decrypt v2 zero-knowledge ciphertext by themselves.

Yoofloe-hosted AI Writer is the default generation path. It uses Yoofloe's hosted AI service with your PAT-protected, personal-only context and returns Markdown plus source and provider metadata.

Yoofloe Capture is a separate preview-first writeback path. It can create personal Journal/Memo records, create or complete personal Schedule tasks, and move directly approved recent items to the Yoofloe Recycle Bin. It does not expose Finance, Business, folders, bulk mutation, hard delete, or couple/shared writeback in v1.

Advanced BYOK remains available on desktop. In that mode, Obsidian calls your selected Google Gemini setup directly with your own Google credentials and project.

Yoofloe Obsidian MCP uses the same PAT class for MCP-capable agents. The connected agent chooses and calls its own model path; Yoofloe provides bounded tools, access control, and vault-safe write boundaries.

## Choose your AI setup

### Yoofloe hosted

- Default for most users
- Requires only Yoofloe connection
- Creates Markdown through `Yoofloe: Open AI Writer` or the AI document commands
- Uses Yoofloe's server-managed model path. The BYOK model dropdown does not affect hosted generation.
- Includes source, unavailable-data, and provider metadata in generated results when enabled by the writer output settings.

### Gemini (Google AI)

- Advanced BYOK option
- Desktop-only in this version
- Uses Google OAuth in your browser
- Requires:
  - a Desktop App OAuth client ID from your own Google Cloud project
  - a Google Cloud Project ID
  - a Gemini BYOK model such as `gemini-3.5-flash`
- Recommended model options include `gemini-3.5-flash`, `gemini-3.1-flash-lite`, and `gemini-3.1-pro-preview`. Compatibility options such as `gemini-2.5-flash`, `gemini-2.5-flash-lite`, and `gemini-2.5-pro` remain available.

### Gemini (Vertex AI)

- Advanced Google Cloud option
- Desktop-only in this version
- Uses Google OAuth in your browser
- Requires:
  - a Desktop App OAuth client ID from your own Google Cloud project
  - a Google Cloud Project ID
  - a Vertex BYOK model such as `gemini-3.5-flash`
- Optional:
  - Vertex location, default `us-central1`
- Vertex model availability can vary by Google Cloud project and location. Use the custom model field only after confirming your Vertex region supports that model.

## Common errors

- `Yoofloe API token is missing`
  - Click `Connect with Yoofloe web` in `Settings -> Yoofloe`, or use the manual token section
- `Reconnect Yoofloe`
  - Your PAT expired, was revoked, or failed verification. Connect Yoofloe again from Settings.
- `Connect your Google account`
  - You are using Advanced BYOK. Click `Connect Google` in `Settings -> Yoofloe`
- `Add your Google Cloud Project ID`
  - You are using Advanced BYOK. Use your Project ID, not the numeric project number
- `Reconnect Google`
  - Your Advanced BYOK Google session expired or was revoked; connect again from Settings

## Security & privacy

- Vault content is not uploaded to Yoofloe unless you explicitly type Capture text, choose `Use selected text`, or opt into current-note context in the AI Writer.
- All network traffic uses Obsidian `requestUrl`.
- The plugin pulls read-only Yoofloe data and writes Markdown files locally in your vault. Capture writeback requires a separate read-write pairing approval.
- A Yoofloe Personal Access Token is required.
- The Yoofloe-hosted AI Writer and Capture flows support Obsidian desktop, tablet, and mobile.
- Yoofloe requires Obsidian `1.11.5+` and stores your PAT, Google OAuth client secret, and Google OAuth refresh token in Obsidian secure storage instead of `data.json`.
- Google access tokens are kept in memory only and refreshed from secure storage when needed.
- Google OAuth credentials are used only for Advanced BYOK Gemini requests. They are not sent to Yoofloe backend.
- Yoofloe-hosted AI Writer may process selected Yoofloe context through Yoofloe's hosted AI service according to Yoofloe AI terms.
- Yoofloe Capture sends only the typed capture text or explicitly selected text for preview, and applies only candidate cards you approve.
- External providers may process content under their own terms and privacy practices when you choose Advanced BYOK.

## Data flow

1. Obsidian sends a PAT-authenticated request to Yoofloe Edge Functions.
2. For the default AI Writer, Yoofloe applies entitlement, AI terms consent, rate limit, budget guardrail, and personal-only filters, then returns Markdown with source metadata.
3. For Advanced BYOK commands, the plugin can still fetch a deterministic data bundle and gardener brief, call your selected Gemini setup with `requestUrl`, then save the result into your vault.
4. For Capture, Obsidian first calls `obsidian-write-preview`, receives server-issued candidate IDs, then calls `obsidian-write-execute` only with the approved candidates and edited fields.

The `life` domain includes Activity Log entries, Habit Tracker definitions, habit date check-ins, goals, and study evidence.

## Domains contacted

- `https://hhiyerojemcujzcmlzao.supabase.co/functions/v1/obsidian-data-api`
- `https://hhiyerojemcujzcmlzao.supabase.co/functions/v1/obsidian-gardener-api`
- `https://hhiyerojemcujzcmlzao.supabase.co/functions/v1/obsidian-ai-writer-api`
- `https://hhiyerojemcujzcmlzao.supabase.co/functions/v1/obsidian-write-preview`
- `https://hhiyerojemcujzcmlzao.supabase.co/functions/v1/obsidian-write-execute`
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

- Yoofloe hosted
- Gemini (Google AI)
- Gemini (Vertex AI)

Yoofloe hosted is the default and needs no Google setup.

Google providers share one Google OAuth desktop connection and your own Google Cloud project. They are desktop-only in this version:

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

- `Yoofloe: Open AI Writer`
- `Yoofloe: Open Yoofloe Capture`
- `Create first Yoofloe AI note`
- `Create MCP setup note`
- `AI Insight Brief`
- `AI Decision Memo`
- `AI Action Plan`
- `AI Deep Dive`

The AI Writer offers presets for `Daily review`, `Weekly plan`, `Decision memo`, `Wellness check`, `Finance snapshot`, and `Free prompt`. Finance and Business sources are marked sensitive and stay off by default unless selected.

The classic AI document commands use Yoofloe hosted by default. If you switch to Advanced BYOK, they use the existing Gemini flow. `AI Deep Dive` additionally asks for a focus instruction before generation.
