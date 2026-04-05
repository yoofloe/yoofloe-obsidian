import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { renderReportMarkdown } from "../generators/markdown";
import {
  type YoofloeBundle,
  type YoofloeDateFormat,
  type YoofloeDomain,
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
  return process.env.npm_package_version || "0.1.1";
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

  server.tool(
    "yoofloe_data_bundle",
    "Fetch a canonical Yoofloe data bundle for the requested domains and range.",
    {
      domains: z.array(z.enum(YOOFLOE_DOMAINS)).min(1).describe("One or more Yoofloe domains to include."),
      range: z.enum(YOOFLOE_RANGES).optional().describe("Time range. Defaults to 1M."),
      includeRaw: z.boolean().optional().describe("Include raw evidence payloads. Defaults to false."),
      includeFrontmatterHints: z.boolean().optional().describe("Include frontmatter hints from Yoofloe. Defaults to true.")
    },
    async ({ domains, range, includeRaw, includeFrontmatterHints }) => {
      const response = await client.fetchBundle({
        domains,
        range: range ?? "1M",
        includeRaw: includeRaw ?? false,
        includeFrontmatterHints: includeFrontmatterHints ?? true
      });

      return toolTextResponse(asJsonText(response), { ...response });
    }
  );

  server.tool(
    "yoofloe_gardener_brief",
    "Fetch the deterministic Yoofloe gardener brief for the requested domains and range.",
    {
      domains: z.array(z.enum(YOOFLOE_DOMAINS)).min(1).describe("One or more Yoofloe domains to include."),
      range: z.enum(YOOFLOE_RANGES).optional().describe("Time range. Defaults to 1M."),
      format: z.enum(["json", "markdown"]).optional().describe("Return the gardener brief as JSON or rendered Markdown.")
    },
    async ({ domains, range, format }) => {
      const response = await client.fetchGardenerBrief({
        domains,
        range: range ?? "1M",
        format: format ?? "json"
      });

      const text = response.format === "markdown" && response.rendered
        ? response.rendered
        : asJsonText(response);

      return toolTextResponse(text, { ...response });
    }
  );

  server.tool(
    "yoofloe_generate_report",
    "Generate Yoofloe Markdown from a data bundle and optionally write it into the configured vault folder.",
    {
      domains: z.array(z.enum(YOOFLOE_DOMAINS)).min(1).describe("One or more Yoofloe domains to include."),
      range: z.enum(YOOFLOE_RANGES).optional().describe("Time range. Defaults to 1M."),
      title: z.string().optional().describe("Optional Markdown title override."),
      type: z.string().optional().describe("Optional frontmatter type override."),
      surface: z.string().optional().describe("Optional file surface/slug override."),
      includeRawData: z.boolean().optional().describe("Include raw JSON blocks. Defaults to false."),
      writeFile: z.boolean().optional().describe("Write the note into the vault. Defaults to true.")
    },
    async ({ domains, range, title, type, surface, includeRawData, writeFile }) => {
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
    }
  );

  server.tool(
    "yoofloe_vault_status",
    "Inspect the configured Obsidian vault output folder and note conventions without modifying anything.",
    {},
    async () => {
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
    }
  );

  server.tool(
    "yoofloe_test_token",
    "Verify the configured Yoofloe PAT by calling the data API with a minimal read-only request.",
    {},
    async () => {
      const result = await client.testToken();
      return toolTextResponse(asJsonText(result), result);
    }
  );
}
