# Agent Direct Mode

Agent Direct Mode lets Codex, Claude Code, Antigravity, or another filesystem-capable agent generate Yoofloe Markdown notes without calling the plugin runtime directly.

The flow is:

1. Generate a Yoofloe `pat_yfl_...` token in the Yoofloe web app.
2. Call `obsidian-data-api` or `obsidian-gardener-api`.
3. Render the response into Markdown.
4. Write the result into your Obsidian vault.
5. Obsidian detects the new `.md` file automatically.

## Requirements

- A Yoofloe account with Obsidian access enabled.
- A valid Personal Access Token with the `pat_yfl_` prefix.
- Local access to the target Obsidian vault directory.

## Recommended file conventions

- Folder: `Yoofloe/`
- File name: `YYYY-MM-DD__<surface>.md`
- Conflict handling: add `__2`, `__3`, and so on

Recommended frontmatter fields:

```yaml
source: yoofloe
type: yoofloe-report
domains:
  - finance
  - business
range: 1M
scope: personal
generated_at: 2026-04-05T11:45:00.000Z
provider: yoofloe-api
tags:
  - yoofloe
  - yoofloe/finance
  - yoofloe/business
```

## Data API example

Set your token first:

```bash
export YOOFLOE_PAT="pat_yfl_..."
export YOOFLOE_FUNCTIONS_BASE_URL="https://hhiyerojemcujzcmlzao.supabase.co/functions/v1"
```

Request a bundle:

```bash
curl -X POST "$YOOFLOE_FUNCTIONS_BASE_URL/obsidian-data-api" \
  -H "Authorization: Bearer $YOOFLOE_PAT" \
  -H "Content-Type: application/json" \
  -d '{
    "domains": ["finance", "business"],
    "range": "1M",
    "scope": "personal",
    "includeRaw": false,
    "includeFrontmatterHints": true
  }'
```

## Gardener API example

Request a deterministic action brief:

```bash
curl -X POST "$YOOFLOE_FUNCTIONS_BASE_URL/obsidian-gardener-api" \
  -H "Authorization: Bearer $YOOFLOE_PAT" \
  -H "Content-Type: application/json" \
  -d '{
    "surface": "brief",
    "domains": ["schedule", "business", "finance"],
    "range": "1W",
    "scope": "personal",
    "format": "markdown"
  }'
```

## Example prompts for coding agents

Use a prompt like this with Codex, Claude Code, or Antigravity:

```text
Use my Yoofloe PAT from the environment variable YOOFLOE_PAT.
Call the Yoofloe obsidian-data-api for domains finance and business with range 1M.
Generate a clean Markdown note with Yoofloe frontmatter.
Write the file into my Obsidian vault under Yoofloe/YYYY-MM-DD__finance-business-report.md.
If the file exists, add a numeric suffix.
Do not modify any existing notes.
```

For a Gardener-style document:

```text
Use my Yoofloe PAT from the environment variable YOOFLOE_PAT.
Call the Yoofloe obsidian-gardener-api with surface brief for schedule, business, and finance over 1W.
Save the rendered Markdown into my Obsidian vault under Yoofloe/YYYY-MM-DD__ai-brief.md.
```

## Security notes

- Do not paste PATs directly into reusable prompts when an environment variable is available.
- Treat the vault path and the PAT as local secrets.
- Prefer writing only into the intended `Yoofloe/` folder instead of giving an agent unrestricted vault write instructions.
- Agent Direct Mode is separate from the plugin runtime. If you want the plugin UX, use Plugin Mode instead.
