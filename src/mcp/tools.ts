import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { buildAgentDirectGuidePayload, buildAgentSetupNoteMarkdown } from "../agent-guidance";
import { buildAiDocumentPrompt, getAiDocumentDefinition } from "../ai/prompts";
import { renderAiNoteMarkdown } from "../generators/ai-note";
import { renderReportMarkdown } from "../generators/markdown";
import {
  type YoofloeAiDocumentType,
  type YoofloeBundle,
  type YoofloeDateFormat,
  type YoofloeDomain,
  YOOFLOE_AI_DOCUMENT_TYPES,
  type YoofloeRange,
  YOOFLOE_DOMAINS,
  YOOFLOE_RANGES
} from "../types";
import { YoofloeMcpHttpClient, defaultFunctionsBaseUrl, type YoofloeMcpConfig } from "./http-client";

const DEFAULT_SAVE_FOLDER = "Yoofloe";
const DEFAULT_DATE_FORMAT: YoofloeDateFormat = "YYYY-MM-DD";
const PAT_ENV_ERROR = "YOOFLOE_PAT environment variable is required and must contain a Yoofloe pat_yfl_ token.";
const VAULT_ENV_ERROR = "YOOFLOE_VAULT_PATH environment variable is required and must point to your Obsidian vault root.";
const DATE_FORMATS: YoofloeDateFormat[] = ["YYYY-MM-DD", "YYYYMMDD", "YYYY.MM.DD"];
const AI_DOCUMENT_TYPES = YOOFLOE_AI_DOCUMENT_TYPES;

type ReportPreset = {
  title: string;
  type: string;
  surface: string;
};

const DOMAIN_PRESETS: Record<YoofloeDomain, ReportPreset> = {
  schedule: { title: "Schedule Overview", type: "schedule-overview", surface: "schedule-overview" },
  life: { title: "Life Overview", type: "life-overview", surface: "life-overview" },
  wellness: { title: "Wellness Report", type: "wellness-report", surface: "wellness-report" },
  finance: { title: "Finance Report", type: "finance-report", surface: "finance-report" },
  business: { title: "Business Overview", type: "business-overview", surface: "business-overview" },
  journal: { title: "Journal Recap", type: "journal-recap", surface: "journal-recap" },
  garden: { title: "Garden Status", type: "garden-status", surface: "garden-status" }
};

function suggestedAiDocumentTitle(documentType: YoofloeAiDocumentType, focusInstruction?: string) {
  const document = getAiDocumentDefinition(documentType);
  if (documentType === "deep-dive" && focusInstruction?.trim()) {
    return `${document.title}: ${focusInstruction.trim()}`;
  }

  return document.title;
}

function comparablePath(value: string) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isInsidePath(rootPath: string, candidatePath: string) {
  const rootComparable = comparablePath(rootPath);
  const candidateComparable = comparablePath(candidatePath);
  return candidateComparable === rootComparable || candidateComparable.startsWith(`${rootComparable}${path.sep}`);
}

function asJsonText(value: unknown) {
  return JSON.stringify(value, null, 2);
}

function buildExternalAccessSecurityContract() {
  return {
    schemaVersion: 2,
    scope: "personal" as const,
    coupleScopeEnabled: false as const,
    encryptionMode: "mixed_legacy_v1_and_zke_v2" as const,
    zkeAtRestMode: "zke_client_decrypt" as const,
    legacyServerDerivedKeyStatus: "migration_only" as const,
    requiresLocalKeyForV2: true as const,
    canReadCiphertext: true as const,
    canReadZkePlaintext: false as const,
    plaintextExportConsentRequired: true as const,
    patCanDecrypt: false as const,
    mcpConfigCanDecrypt: false as const,
    rawKeyStorageAllowed: false as const,
    serverCanDecryptV2: false as const
  };
}

function buildMcpSessionStatus(config: YoofloeMcpConfig) {
  return {
    mode: "obsidian_mcp",
    auth: {
      patConfigured: Boolean(config.pat),
      patCanDecrypt: false,
      entitlementCheck: "use yoofloe_test_token"
    },
    scope: {
      current: "personal",
      coupleScopeEnabled: false,
      coupleScopeReason: "temporarily_disabled_until_shared_encryption_is_fully_externalized"
    },
    security: buildExternalAccessSecurityContract(),
    vault: {
      saveFolder: config.saveFolder,
      dateFormat: config.dateFormat,
      localFilesRemainAfterRevocation: true
    }
  };
}

function yamlString(value: string) {
  return JSON.stringify(value);
}

function toolTextResponse<T extends Record<string, unknown>>(text: string, structuredContent?: T) {
  const response: {
    content: Array<{ type: "text"; text: string }>;
    structuredContent?: T;
  } = {
    content: [
      {
        type: "text" as const,
        text
      }
    ]
  };

  if (structuredContent !== undefined) {
    response.structuredContent = structuredContent;
  }

  return response;
}

function trimEnv(value: string | undefined) {
  return value?.trim() ?? "";
}

function assertDateFormat(value: string): YoofloeDateFormat {
  if (DATE_FORMATS.includes(value as YoofloeDateFormat)) {
    return value as YoofloeDateFormat;
  }

  throw new Error(`YOOFLOE_DATE_FORMAT must be one of: ${DATE_FORMATS.join(", ")}.`);
}

function normalizeSaveFolder(value: string) {
  const normalized = value.replace(/\\/g, "/").trim();
  const candidate = normalized || DEFAULT_SAVE_FOLDER;

  if (path.isAbsolute(candidate)) {
    throw new Error("YOOFLOE_SAVE_FOLDER must be a relative folder inside the vault.");
  }

  const segments = candidate.split("/").filter(Boolean);
  if (segments.length === 0) {
    return DEFAULT_SAVE_FOLDER;
  }

  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error("YOOFLOE_SAVE_FOLDER cannot contain '.' or '..' segments.");
  }

  return path.join(...segments);
}

function resolveVaultRoot(vaultPath: string) {
  const candidate = trimEnv(vaultPath);
  if (!candidate) {
    throw new Error(VAULT_ENV_ERROR);
  }

  let stats;
  try {
    stats = statSync(candidate);
  } catch {
    throw new Error("YOOFLOE_VAULT_PATH must point to an existing directory.");
  }

  if (!stats.isDirectory()) {
    throw new Error("YOOFLOE_VAULT_PATH must point to an existing directory.");
  }

  return realpathSync(candidate);
}

function ensureContainedPath(vaultRoot: string, candidatePath: string) {
  if (!isInsidePath(vaultRoot, candidatePath)) {
    throw new Error("Resolved output path escaped the configured Obsidian vault.");
  }
}

function inspectExistingPathChain(vaultRoot: string, targetPath: string) {
  const relativePath = path.relative(vaultRoot, targetPath);
  if (!relativePath || relativePath === ".") {
    return;
  }

  let current = vaultRoot;
  for (const segment of relativePath.split(path.sep)) {
    current = path.join(current, segment);
    if (!existsSync(current)) {
      break;
    }

    const stats = lstatSync(current);
    if (stats.isSymbolicLink()) {
      ensureContainedPath(vaultRoot, realpathSync(current));
    }
  }
}

function resolveOutputDirectory(config: YoofloeMcpConfig, createIfMissing: boolean) {
  const outputDir = path.resolve(config.vaultPath, config.saveFolder);
  ensureContainedPath(config.vaultPath, outputDir);
  inspectExistingPathChain(config.vaultPath, outputDir);

  if (createIfMissing) {
    mkdirSync(outputDir, { recursive: true });
  }

  if (existsSync(outputDir)) {
    const resolved = realpathSync(outputDir);
    ensureContainedPath(config.vaultPath, resolved);
    return resolved;
  }

  return outputDir;
}

function formatDate(date: Date, format: YoofloeDateFormat) {
  const yyyy = String(date.getFullYear());
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");

  switch (format) {
    case "YYYYMMDD":
      return `${yyyy}${mm}${dd}`;
    case "YYYY.MM.DD":
      return `${yyyy}.${mm}.${dd}`;
    case "YYYY-MM-DD":
    default:
      return `${yyyy}-${mm}-${dd}`;
  }
}

function slugify(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "yoofloe-report";
}

function chooseReportPreset(domains: YoofloeDomain[]) {
  if (domains.length === 1) {
    return DOMAIN_PRESETS[domains[0]];
  }

  return {
    title: "Yoofloe Report",
    type: "yoofloe-report",
    surface: `${domains.join("-")}-report`
  };
}

function nextNotePath(config: YoofloeMcpConfig, surface: string) {
  const outputDir = resolveOutputDirectory(config, true);
  const stamp = formatDate(new Date(), config.dateFormat);
  const safeSurface = slugify(surface);

  for (let attempt = 1; attempt < 1000; attempt += 1) {
    const suffix = attempt === 1 ? "" : `__${attempt}`;
    const filePath = path.join(outputDir, `${stamp}__${safeSurface}${suffix}.md`);
    ensureContainedPath(config.vaultPath, filePath);

    if (!existsSync(filePath)) {
      return filePath;
    }
  }

  throw new Error("Unable to allocate a unique Yoofloe note path after 999 attempts.");
}

function writeNewFile(filePath: string, content: string) {
  const fd = openSync(filePath, "wx");
  try {
    writeFileSync(fd, content, "utf8");
  } finally {
    closeSyncSafe(fd);
  }
}

function closeSyncSafe(fd: number) {
  try {
    closeSync(fd);
  } catch {
    // Ignore close failures after write errors.
  }
}

function countMarkdownFiles(folderPath: string): number {
  if (!existsSync(folderPath)) {
    return 0;
  }

  let total = 0;
  for (const entry of readdirSync(folderPath, { withFileTypes: true })) {
    const entryPath = path.join(folderPath, entry.name);
    if (entry.isSymbolicLink()) {
      continue;
    }
    if (entry.isDirectory()) {
      total += countMarkdownFiles(entryPath);
      continue;
    }
    if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      total += 1;
    }
  }

  return total;
}

function resolveConfigVersion() {
  if (process.env.npm_package_version?.trim()) {
    return process.env.npm_package_version.trim();
  }

  try {
    const packageJsonPath = path.join(process.cwd(), "package.json");
    if (existsSync(packageJsonPath)) {
      const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version?: string };
      if (typeof packageJson.version === "string" && packageJson.version.trim()) {
        return packageJson.version.trim();
      }
    }
  } catch {
    // Fall through to the hard-coded safe default.
  }

  return "0.3.0";
}

function buildReportPayload(args: {
  bundle: YoofloeBundle;
  title: string;
  type: string;
  surface: string;
  includeRawData: boolean;
  config: YoofloeMcpConfig;
  writeFile: boolean;
}) {
  const markdown = renderReportMarkdown({
    title: args.title,
    type: args.type,
    bundle: args.bundle,
    settings: {
      autoFrontmatter: true,
      includeRawData: args.includeRawData
    },
    pluginVersion: args.config.pluginVersion,
    provider: "yoofloe-mcp"
  });

  let filePath: string | null = null;
  if (args.writeFile) {
    filePath = nextNotePath(args.config, args.surface);
    writeNewFile(filePath, markdown);
  }

  return {
    title: args.title,
    type: args.type,
    surface: args.surface,
    markdown,
    filePath,
    bundleMeta: args.bundle.meta
  };
}

function defaultTags(domains: YoofloeDomain[]) {
  return ["yoofloe", ...domains.map((domain) => `yoofloe/${domain}`)];
}

function normalizeNoteBody(markdownBody: string) {
  let value = markdownBody.trim();

  if (value.startsWith("---")) {
    const closingMarker = value.indexOf("\n---", 3);
    if (closingMarker >= 0) {
      value = value.slice(closingMarker + 4).trim();
    }
  }

  if (value.startsWith("# ")) {
    const firstLineBreak = value.indexOf("\n");
    value = firstLineBreak >= 0 ? value.slice(firstLineBreak + 1).trim() : "";
  }

  return value;
}

function renderAgentNoteMarkdown(args: {
  title: string;
  type: string;
  domains: YoofloeDomain[];
  range: YoofloeRange;
  markdownBody: string;
  provider: string;
  tags?: string[];
  config: YoofloeMcpConfig;
}) {
  const tags = args.tags?.length ? args.tags : defaultTags(args.domains);
  const body = normalizeNoteBody(args.markdownBody);
  const generatedAt = new Date().toISOString();
  const frontmatter = [
    "---",
    `source: ${yamlString("yoofloe")}`,
    `plugin_id: ${yamlString("yoofloe")}`,
    `plugin_version: ${yamlString(args.config.pluginVersion)}`,
    `type: ${yamlString(args.type)}`,
    "domains:",
    ...args.domains.map((domain) => `  - ${yamlString(domain)}`),
    `range: ${yamlString(args.range)}`,
    `scope: ${yamlString("personal")}`,
    `generated_at: ${yamlString(generatedAt)}`,
    `provider: ${yamlString(args.provider)}`,
    "tags:",
    ...tags.map((tag) => `  - ${yamlString(tag)}`),
    "---"
  ].join("\n");

  return `${frontmatter}\n\n# ${args.title}\n\n${body}\n`;
}

async function tryFetchGardenerBriefMarkdown(
  client: YoofloeMcpHttpClient,
  domains: YoofloeDomain[],
  range: YoofloeRange
) {
  try {
    const response = await client.fetchGardenerBrief({
      domains,
      range,
      format: "markdown"
    });

    return {
      markdown: response.rendered?.trim() || null,
      entitlement: response.entitlement
    };
  } catch {
    return {
      markdown: null,
      entitlement: null
    };
  }
}

async function buildAiDocumentContext(args: {
  client: YoofloeMcpHttpClient;
  documentType: YoofloeAiDocumentType;
  domains: YoofloeDomain[];
  range: YoofloeRange;
  includeRaw: boolean;
  focusInstruction?: string;
}) {
  const response = await args.client.fetchBundle({
    domains: args.domains,
    range: args.range,
    includeRaw: args.includeRaw,
    includeFrontmatterHints: true
  });
  const gardener = await tryFetchGardenerBriefMarkdown(args.client, args.domains, args.range);
  const definition = getAiDocumentDefinition(args.documentType);
  const title = suggestedAiDocumentTitle(args.documentType, args.focusInstruction);

  return {
    documentType: args.documentType,
    definition,
    bundle: response.bundle,
    entitlement: response.entitlement,
    rateLimit: response.rateLimit,
    gardenerBriefMarkdown: gardener.markdown,
    gardenerEntitlement: gardener.entitlement,
    focusInstruction: args.focusInstruction?.trim() || null,
    suggestedOutput: {
      title,
      type: definition.type,
      surface: definition.surface,
      provider: "yoofloe-mcp",
      tags: defaultTags(args.domains)
    },
    promptScaffold: buildAiDocumentPrompt({
      bundle: response.bundle,
      documentType: args.documentType,
      gardenerBrief: gardener.markdown,
      focusInstruction: args.focusInstruction
    })
  };
}

function renderAiDocumentMarkdown(args: {
  title: string;
  documentType: YoofloeAiDocumentType;
  bundle: YoofloeBundle;
  markdownBody: string;
  provider: string;
  pluginVersion: string;
}) {
  const definition = getAiDocumentDefinition(args.documentType);

  return renderAiNoteMarkdown({
    title: args.title,
    type: definition.type,
    bundle: args.bundle,
    settings: {
      autoFrontmatter: true,
      includeRawData: false
    },
    pluginVersion: args.pluginVersion,
    provider: args.provider,
    body: args.markdownBody
  });
}

function requireFocusInstruction(documentType: YoofloeAiDocumentType, focusInstruction?: string) {
  const definition = getAiDocumentDefinition(documentType);
  const normalized = focusInstruction?.trim() || "";

  if (definition.requiresFocusInstruction && !normalized) {
    throw new Error("focusInstruction is required for documentType deep-dive.");
  }

  return normalized || undefined;
}

export function readMcpConfig(env: NodeJS.ProcessEnv): YoofloeMcpConfig {
  const pat = trimEnv(env.YOOFLOE_PAT);
  if (!pat) {
    throw new Error(PAT_ENV_ERROR);
  }

  const vaultPath = resolveVaultRoot(trimEnv(env.YOOFLOE_VAULT_PATH));
  const saveFolder = normalizeSaveFolder(trimEnv(env.YOOFLOE_SAVE_FOLDER));
  const dateFormat = trimEnv(env.YOOFLOE_DATE_FORMAT)
    ? assertDateFormat(trimEnv(env.YOOFLOE_DATE_FORMAT))
    : DEFAULT_DATE_FORMAT;

  return {
    pat,
    functionsBaseUrl: trimEnv(env.YOOFLOE_FUNCTIONS_BASE_URL) || defaultFunctionsBaseUrl(),
    vaultPath,
    saveFolder,
    dateFormat,
    pluginVersion: resolveConfigVersion()
  };
}

export function registerYoofloeTools(server: McpServer, config: YoofloeMcpConfig) {
  const client = new YoofloeMcpHttpClient(config);

  server.registerTool("yoofloe_mcp_session_status", {
    description: "Inspect the Obsidian MCP wrapper security, scope, local vault, and ZK readiness contract without fetching Yoofloe data.",
    inputSchema: {}
  }, () => {
      const status = buildMcpSessionStatus(config);
      return toolTextResponse(asJsonText(status), status);
    });

  server.registerTool("yoofloe_agent_direct_guide", {
    description: "Return the current Agent Direct and MCP workflow contract for external AI agents without fetching data or writing files.",
    inputSchema: {}
  }, () => {
      const guide = buildAgentDirectGuidePayload({
        pluginVersion: config.pluginVersion,
        saveFolder: config.saveFolder,
        functionsBaseUrl: config.functionsBaseUrl
      });

      return toolTextResponse(
        buildAgentSetupNoteMarkdown({
          pluginVersion: config.pluginVersion,
          saveFolder: config.saveFolder,
          functionsBaseUrl: config.functionsBaseUrl
        }),
        guide
      );
    });

  server.registerTool("yoofloe_ai_document_context", {
    description: "Fetch a grounded AI-document context package for Insight Brief, Decision Memo, Action Plan, or Deep Dive workflows.",
    inputSchema: {
      documentType: z.enum(AI_DOCUMENT_TYPES).describe("AI document type to prepare."),
      domains: z.array(z.enum(YOOFLOE_DOMAINS)).min(1).describe("One or more Yoofloe domains to include."),
      range: z.enum(YOOFLOE_RANGES).optional().describe("Time range. Defaults to 1M."),
      includeRaw: z.boolean().optional().describe("Include raw evidence payloads in the canonical bundle. Defaults to false."),
      focusInstruction: z.string().optional().describe("Required when documentType is deep-dive.")
    }
  }, async ({ documentType, domains, range, includeRaw, focusInstruction }) => {
      const normalizedFocus = requireFocusInstruction(documentType, focusInstruction);
      const context = await buildAiDocumentContext({
        client,
        documentType,
        domains,
        range: range ?? "1M",
        includeRaw: includeRaw ?? false,
        focusInstruction: normalizedFocus
      });

      return toolTextResponse(asJsonText(context), context);
    });

  server.registerTool("yoofloe_data_bundle", {
    description: "Fetch a canonical Yoofloe data bundle for the requested domains and range.",
    inputSchema: {
      domains: z.array(z.enum(YOOFLOE_DOMAINS)).min(1).describe("One or more Yoofloe domains to include."),
      range: z.enum(YOOFLOE_RANGES).optional().describe("Time range. Defaults to 1M."),
      includeRaw: z.boolean().optional().describe("Include raw evidence payloads. Defaults to false."),
      includeFrontmatterHints: z.boolean().optional().describe("Include frontmatter hints from Yoofloe. Defaults to true.")
    }
  }, async ({ domains, range, includeRaw, includeFrontmatterHints }) => {
      const response = await client.fetchBundle({
        domains,
        range: range ?? "1M",
        includeRaw: includeRaw ?? false,
        includeFrontmatterHints: includeFrontmatterHints ?? true
      });

      return toolTextResponse(asJsonText(response), { ...response });
    });

  server.registerTool("yoofloe_gardener_brief", {
    description: "Fetch the deterministic Yoofloe gardener brief for the requested domains and range.",
    inputSchema: {
      domains: z.array(z.enum(YOOFLOE_DOMAINS)).min(1).describe("One or more Yoofloe domains to include."),
      range: z.enum(YOOFLOE_RANGES).optional().describe("Time range. Defaults to 1M."),
      format: z.enum(["json", "markdown"]).optional().describe("Return the gardener brief as JSON or rendered Markdown.")
    }
  }, async ({ domains, range, format }) => {
      const response = await client.fetchGardenerBrief({
        domains,
        range: range ?? "1M",
        format: format ?? "json"
      });

      const text = response.format === "markdown" && response.rendered
        ? response.rendered
        : asJsonText(response);

      return toolTextResponse(text, { ...response });
    });

  server.registerTool("yoofloe_generate_report", {
    description: "Deprecated: generate report-style Yoofloe Markdown from a data bundle and optionally write it into the configured vault folder. Prefer yoofloe_ai_document_context plus yoofloe_write_ai_document for new workflows.",
    inputSchema: {
      domains: z.array(z.enum(YOOFLOE_DOMAINS)).min(1).describe("One or more Yoofloe domains to include."),
      range: z.enum(YOOFLOE_RANGES).optional().describe("Time range. Defaults to 1M."),
      title: z.string().optional().describe("Optional Markdown title override."),
      type: z.string().optional().describe("Optional frontmatter type override."),
      surface: z.string().optional().describe("Optional file surface/slug override."),
      includeRawData: z.boolean().optional().describe("Include raw JSON blocks. Defaults to false."),
      writeFile: z.boolean().optional().describe("Write the note into the vault. Defaults to true.")
    }
  }, async ({ domains, range, title, type, surface, includeRawData, writeFile }) => {
      const preset = chooseReportPreset(domains);
      const response = await client.fetchBundle({
        domains,
        range: range ?? "1M",
        includeRaw: includeRawData ?? false,
        includeFrontmatterHints: true
      });

      const report = buildReportPayload({
        bundle: response.bundle,
        title: title?.trim() || preset.title,
        type: type?.trim() || preset.type,
        surface: surface?.trim() || preset.surface,
        includeRawData: includeRawData ?? false,
        config,
        writeFile: writeFile ?? true
      });

      const summary = report.filePath
        ? `Generated ${report.surface} and wrote ${report.filePath}.`
        : report.markdown;

      return toolTextResponse(summary, report);
    });

  server.registerTool("yoofloe_write_ai_document", {
    description: "Write a normalized Yoofloe AI document into the configured vault folder using caller-supplied Markdown content.",
    inputSchema: {
      documentType: z.enum(AI_DOCUMENT_TYPES).describe("AI document type to write."),
      title: z.string().min(1).describe("Document title rendered as the top-level heading."),
      domains: z.array(z.enum(YOOFLOE_DOMAINS)).min(1).describe("One or more Yoofloe domains reflected in the document."),
      range: z.enum(YOOFLOE_RANGES).describe("Time range that the document summarizes."),
      markdownBody: z.string().min(1).describe("Markdown body content without YAML frontmatter."),
      provider: z.string().optional().describe("Frontmatter provider label. Defaults to codex."),
      focusInstruction: z.string().optional().describe("Required when documentType is deep-dive.")
    }
  }, async ({ documentType, title, domains, range, markdownBody, provider, focusInstruction }) => {
      const normalizedFocus = requireFocusInstruction(documentType, focusInstruction);
      const response = await client.fetchBundle({
        domains,
        range,
        includeRaw: false,
        includeFrontmatterHints: true
      });
      const definition = getAiDocumentDefinition(documentType);
      const normalizedTitle = title.trim();
      const normalizedProvider = provider?.trim() || "codex";
      const markdown = renderAiDocumentMarkdown({
        title: normalizedTitle,
        documentType,
        bundle: response.bundle,
        markdownBody,
        provider: normalizedProvider,
        pluginVersion: config.pluginVersion
      });

      const filePath = nextNotePath(config, definition.surface);
      writeNewFile(filePath, markdown);

      const result = {
        documentType,
        title: normalizedTitle,
        type: definition.type,
        surface: definition.surface,
        domains,
        range,
        provider: normalizedProvider,
        focusInstruction: normalizedFocus,
        filePath,
        markdown,
        bundleMeta: response.bundle.meta
      };

      return toolTextResponse(`Wrote ${filePath}.`, result);
    });

  server.registerTool("yoofloe_write_note", {
    description: "Write a richer Yoofloe Markdown note into the configured vault folder using caller-supplied Markdown content.",
    inputSchema: {
      title: z.string().min(1).describe("The note title that will be rendered as the top-level heading."),
      surface: z.string().min(1).describe("The file surface/slug used in the generated note filename."),
      type: z.string().min(1).describe("The Yoofloe frontmatter type to write."),
      domains: z.array(z.enum(YOOFLOE_DOMAINS)).min(1).describe("One or more Yoofloe domains reflected in the note."),
      range: z.enum(YOOFLOE_RANGES).describe("Time range that the note summarizes."),
      markdownBody: z.string().min(1).describe("Markdown body content without YAML frontmatter."),
      provider: z.string().optional().describe("Frontmatter provider label. Defaults to codex."),
      tags: z.array(z.string().min(1)).optional().describe("Optional explicit tags. Defaults to Yoofloe domain tags.")
    }
  }, ({ title, surface, type, domains, range, markdownBody, provider, tags }) => {
      const markdown = renderAgentNoteMarkdown({
        title: title.trim(),
        type: type.trim(),
        domains,
        range,
        markdownBody,
        provider: provider?.trim() || "codex",
        tags: tags?.map((tag) => tag.trim()).filter(Boolean),
        config
      });

      const filePath = nextNotePath(config, surface.trim());
      writeNewFile(filePath, markdown);

      const result = {
        title: title.trim(),
        type: type.trim(),
        surface: surface.trim(),
        domains,
        range,
        provider: provider?.trim() || "codex",
        filePath,
        markdown
      };

      return toolTextResponse(`Wrote ${filePath}.`, result);
    });

  server.registerTool("yoofloe_vault_status", {
    description: "Inspect the configured Obsidian vault output folder and note conventions without modifying anything.",
    inputSchema: {}
  }, () => {
      const outputDir = resolveOutputDirectory(config, false);
      const folderExists = existsSync(outputDir);
      const structured = {
        vaultRoot: config.vaultPath,
        saveFolder: config.saveFolder,
        resolvedOutputDirectory: outputDir,
        outputDirectoryExists: folderExists,
        markdownFileCount: folderExists ? countMarkdownFiles(outputDir) : 0,
        dateFormat: config.dateFormat,
        conventions: {
          folder: config.saveFolder,
          fileName: `${formatDate(new Date(), config.dateFormat)}__<surface>.md`,
          overwrite: false,
          collision: "numeric suffix (__2, __3, ...)"
        }
      };

      return toolTextResponse(asJsonText(structured), structured);
    });

  server.registerTool("yoofloe_test_token", {
    description: "Verify the configured Yoofloe PAT by calling the data API with a minimal read-only request.",
    inputSchema: {}
  }, async () => {
      const result = await client.testToken();
      return toolTextResponse(asJsonText(result), result);
    });
}
