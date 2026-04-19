# Agent Direct Mode

Agent Direct Mode lets Codex, Claude Code, Antigravity, or another filesystem-capable agent generate grounded Yoofloe AI documents without calling the plugin runtime directly.

This is separate from plugin Gemini setup. In Agent Direct Mode, the agent uses its own model path and writes Markdown directly into your vault.

The public external-AI notice for this surface is:

- `https://www.yoofloe.com/external-ai-access`

Yoofloe provides PAT-authenticated data access, grounded context, and recommended file conventions. The external agent and its provider remain outside Yoofloe-hosted AI.

Agent Direct is **personal-only by design**. Couple/shared external access is not offered on this surface.

If you use the business domain, playbook entries may include `planning`, `success`, `setback`, and `learning` categories. Treat `planning` as a non-outcome lane for ideas, experiments, and execution plans, and summarize it in terms of hypothesis, success signals, first steps, and risks.

Inside the plugin, `Settings -> Yoofloe -> Use With AI Agents` gives you copyable prompts, an MCP config snippet, the external guide link, and a vault note generator for sharing setup instructions.

The flow is:

1. Generate a Yoofloe `pat_yfl_...` token in the Yoofloe web app.
2. Call `obsidian-data-api` and optionally `obsidian-gardener-api`.
3. Build a document-specific prompt scaffold around the returned data.
4. Let the agent's own model write the final Markdown.
5. Write the result into your Obsidian vault.
6. Obsidian detects the new `.md` file automatically.

## Requirements

- A Yoofloe account with Obsidian access enabled.
- A valid Personal Access Token with the `pat_yfl_` prefix.
- Local access to the target Obsidian vault directory.

## Recommended file conventions

- Folder: `Yoofloe/`
- File name: `YYYY-MM-DD__<surface>.md`
- Conflict handling: add `__2`, `__3`, and so on

Recommended frontmatter fields for AI documents:

```yaml
source: yoofloe
type: ai-insight-brief
domains:
  - finance
  - business
range: 1M
scope: personal
generated_at: 2026-04-05T11:45:00.000Z
provider: codex
tags:
  - yoofloe
  - yoofloe/finance
  - yoofloe/business
```

## Recommended document types

- `ai-insight-brief`
- `ai-decision-memo`
- `ai-action-plan`
- `ai-deep-dive`

Each document should clearly separate evidence, interpretation, recommendations, and open questions.

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

Request a deterministic signal brief:

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
Also call the Yoofloe obsidian-gardener-api brief endpoint for the same domains and range.
Generate an AI Decision Memo grounded only in the returned data.
Separate evidence, interpretation, recommended direction, and open questions.
Write the file into my Obsidian vault under Yoofloe/YYYY-MM-DD__ai-decision-memo.md.
If the file exists, add a numeric suffix.
Do not modify any existing notes.
```

For a focused deep dive:

```text
Use my Yoofloe PAT from the environment variable YOOFLOE_PAT.
Call the Yoofloe obsidian-data-api for schedule, wellness, finance, and business over 1M.
Optionally call the Yoofloe obsidian-gardener-api brief endpoint for the same request.
Generate an AI Deep Dive focused on: "cash flow pressure, low-energy periods, and whether my schedule supports recovery."
Write the file into my Obsidian vault under Yoofloe/YYYY-MM-DD__ai-deep-dive.md.
```

## Security notes

- Do not paste PATs directly into reusable prompts when an environment variable is available.
- Treat the vault path and the PAT as local secrets.
- Prefer writing only into the intended `Yoofloe/` folder instead of giving an agent unrestricted vault write instructions.
- Agent Direct Mode is separate from the plugin runtime. If you want the built-in Gemini UX, use Plugin Mode instead.
- Files the agent writes into your vault remain local copies after access is revoked. Revocation stops future reads and writes, not already-created Markdown files.
