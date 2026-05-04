import { getAiDocumentDefinition } from "./ai/prompts";
import { YOOFLOE_AI_DOCUMENT_TYPES } from "./types";
import type { YoofloeAiDocumentType } from "./types";

export const AGENT_DIRECT_GUIDE_URL = "https://github.com/yoofloe/yoofloe-obsidian/blob/main/docs/agent-direct.md";

export type AgentGuidanceOptions = {
  pluginVersion: string;
  saveFolder?: string;
  functionsBaseUrl?: string;
};

const MCP_SERVER_PATH_EXAMPLE = "C:/absolute/path/to/mcp-server.js";
const VAULT_PATH_EXAMPLE = "C:/Users/you/Documents/Obsidian Vault";

const DOCUMENT_TYPE_SUMMARIES: Record<YoofloeAiDocumentType, string> = {
  "insight-brief": "Strongest signals, tensions, opportunities, risks, and suggested questions.",
  "decision-memo": "Situation framing, tradeoffs, recommended direction, evidence, and open questions.",
  "action-plan": "Priorities, recommended sequence, dependencies, blockers, watchouts, and evidence notes.",
  "deep-dive": "Focused analysis on one theme or concern. Requires a non-empty focusInstruction."
};

function normalizeSaveFolder(saveFolder?: string) {
  const normalized = (saveFolder || "Yoofloe").replace(/\\/g, "/").trim();
  return normalized || "Yoofloe";
}

export function buildCodexPrompt(options: AgentGuidanceOptions) {
  const saveFolder = normalizeSaveFolder(options.saveFolder);
  return [
    "Use the yoofloe MCP server.",
    "Call yoofloe_ai_document_context for documentType insight-brief with domains schedule, life, wellness, finance, business, journal, and garden over 1M.",
    "Use the returned prompt scaffold to draft a grounded AI insight brief.",
    "Keep evidence, interpretation, recommendations, and open questions clearly separated.",
    "Then call yoofloe_write_ai_document to save the result into the configured vault folder.",
    `The target folder is ${saveFolder}.`,
    "Do not overwrite existing files."
  ].join("\n");
}

export function buildClaudeCodePrompt(options: AgentGuidanceOptions) {
  const saveFolder = normalizeSaveFolder(options.saveFolder);
  return [
    "Use the yoofloe MCP tools.",
    "Start with yoofloe_ai_document_context for documentType action-plan with domains finance, business, wellness, and schedule over 1M.",
    "Use the returned prompt scaffold to draft a grounded AI action plan.",
    "Keep evidence notes separate from recommendations and sequence the actions realistically.",
    "Save the final result with yoofloe_write_ai_document.",
    `Write into the configured ${saveFolder} folder only.`,
    "Do not overwrite existing files."
  ].join("\n");
}

export function buildMcpConfigSnippet(options: AgentGuidanceOptions) {
  return JSON.stringify({
    mcpServers: {
      yoofloe: {
        type: "stdio",
        command: "node",
        args: [MCP_SERVER_PATH_EXAMPLE],
        env: {
          YOOFLOE_PAT: "pat_yfl_...",
          YOOFLOE_VAULT_PATH: VAULT_PATH_EXAMPLE,
          YOOFLOE_FUNCTIONS_BASE_URL: options.functionsBaseUrl?.trim() || "https://hhiyerojemcujzcmlzao.supabase.co/functions/v1",
          YOOFLOE_SAVE_FOLDER: normalizeSaveFolder(options.saveFolder)
        }
      }
    }
  }, null, 2);
}

export function buildAgentDirectGuidePayload(options: AgentGuidanceOptions) {
  const documentTypeDefinitions = Object.fromEntries(
    YOOFLOE_AI_DOCUMENT_TYPES.map((documentType) => {
      const definition = getAiDocumentDefinition(documentType);
      return [
        documentType,
        {
          title: definition.title,
          type: definition.type,
          surface: definition.surface,
          requiresFocusInstruction: !!definition.requiresFocusInstruction,
          description: DOCUMENT_TYPE_SUMMARIES[documentType]
        }
      ];
    })
  ) as Record<YoofloeAiDocumentType, {
    title: string;
    type: string;
    surface: string;
    requiresFocusInstruction: boolean;
    description: string;
  }>;

  return {
    guideUrl: AGENT_DIRECT_GUIDE_URL,
    recommendedWorkflow: [
      "Call yoofloe_agent_direct_guide if you need the current workflow contract and examples.",
      "Call yoofloe_ai_document_context with the target documentType, domains, range, and optional focusInstruction.",
      "Use your own model path to draft the final Markdown from the returned prompt scaffold and bundle.",
      "Call yoofloe_write_ai_document to save the final AI document into the configured Yoofloe folder."
    ],
    supportedDocumentTypes: [...YOOFLOE_AI_DOCUMENT_TYPES],
    documentTypeDefinitions,
    requiresFocusInstructionFor: ["deep-dive"],
    outputConventions: {
      folder: normalizeSaveFolder(options.saveFolder),
      fileName: "YYYY-MM-DD__<surface>.md",
      overwrite: false,
      collision: "numeric suffix (__2, __3, ...)",
      frontmatterFields: [
        "source",
        "plugin_id",
        "plugin_version",
        "type",
        "domains",
        "range",
        "scope",
        "generated_at",
        "provider",
        "tags"
      ]
    },
    preferredTools: [
      "yoofloe_mcp_session_status",
      "yoofloe_agent_direct_guide",
      "yoofloe_ai_document_context",
      "yoofloe_write_ai_document"
    ],
    deprecatedTools: [
      "yoofloe_generate_report"
    ],
    examplePrompts: {
      codex: buildCodexPrompt(options),
      claudeCode: buildClaudeCodePrompt(options),
      mcpConfig: buildMcpConfigSnippet(options)
    }
  };
}

export function buildAgentSetupNoteMarkdown(options: AgentGuidanceOptions) {
  const guide = buildAgentDirectGuidePayload(options);
  const documentTypeLines = guide.supportedDocumentTypes
    .map((documentType) => `- \`${documentType}\`: ${guide.documentTypeDefinitions[documentType].description}`)
    .join("\n");
  const workflowLines = guide.recommendedWorkflow
    .map((step, index) => `${index + 1}. ${step}`)
    .join("\n");
  const frontmatterLines = guide.outputConventions.frontmatterFields
    .map((field) => `- \`${field}\``)
    .join("\n");

  return [
    "# Yoofloe Agent Direct Setup",
    "",
    "Yoofloe supports Agent Direct: external AI agents use their own model path and write grounded AI documents into your vault.",
    "",
    "## Choose The Right Path",
    "",
    "- Use Plugin AI for one-click generation inside Obsidian with Gemini.",
    "- Use Agent Direct when Codex, Claude Code, or another external agent should bring its own model and workflow.",
    "- Agent Direct does not reuse the plugin's Gemini OAuth setup or secrets.",
    "",
    "## Recommended MCP Workflow",
    "",
    workflowLines,
    "",
    "## Supported AI Document Types",
    "",
    documentTypeLines,
    "",
    "## Important Rules",
    "",
    "- Antigravity/Gemini-style MCP configs should use an absolute path to `mcp-server.js`.",
    "- `YOOFLOE_VAULT_PATH` must point to your vault root, not the Yoofloe subfolder inside it.",
    "- Treat `YOOFLOE_PAT` as a local secret. Do not commit `.mcp.json`, shell profiles, logs, or prompts containing a real PAT.",
    "- Do not place raw Yoofloe encryption keys or recovery keys in `.mcp.json`; PAT access alone cannot decrypt v2 zero-knowledge content.",
    "- Run `yoofloe_mcp_session_status` before fetching data when you need the current scope and ZK readiness contract.",
    "- Business playbook context may include planning, success, setback, and learning categories. Treat planning as the idea-and-plan lane, and summarize it in terms of hypothesis, success signals, first steps, and risks.",
    "- `deep-dive` requires a non-empty `focusInstruction`.",
    "- Existing files are never overwritten; collisions use numeric suffixes.",
    `- The configured save folder is \`${guide.outputConventions.folder}\`.`,
    "",
    "## Output Conventions",
    "",
    `- Folder: \`${guide.outputConventions.folder}\``,
    `- File name: \`${guide.outputConventions.fileName}\``,
    "- Frontmatter fields:",
    frontmatterLines,
    "",
    "## Codex Prompt",
    "",
    "```text",
    guide.examplePrompts.codex,
    "```",
    "",
    "## Claude Code Prompt",
    "",
    "```text",
    guide.examplePrompts.claudeCode,
    "```",
    "",
    "## MCP Config Snippet",
    "",
    "Use an absolute `mcp-server.js` path for Antigravity/Gemini-style clients. Relative `mcp-server.js` only works when the MCP client starts inside this repository root. The PAT value below is a placeholder; do not commit a real PAT.",
    "",
    "```json",
    guide.examplePrompts.mcpConfig,
    "```",
    "",
    "## Reference",
    "",
    `- Agent Direct guide: ${guide.guideUrl}`,
    `- Plugin version: ${options.pluginVersion}`
  ].join("\n");
}
