import type { MarkdownRenderOptions, YoofloeBundle, YoofloeDomain } from "../types";

function yamlString(value: string) {
  return JSON.stringify(value);
}

function yamlValue(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return yamlString(String(value));
}

function renderFrontmatter({
  bundle,
  settings,
  pluginVersion,
  type,
  provider
}: {
  bundle: YoofloeBundle;
  settings: MarkdownRenderOptions;
  pluginVersion: string;
  type: string;
  provider: string;
}) {
  const tags = bundle.frontmatter_hints?.tags?.length
    ? bundle.frontmatter_hints.tags
    : ["yoofloe", ...bundle.meta.domains.map((domain) => `yoofloe/${domain}`)];

  const lines = [
    "---",
    `source: ${yamlString("yoofloe")}`,
    `plugin_id: ${yamlString("yoofloe")}`,
    `plugin_version: ${yamlString(pluginVersion)}`,
    `type: ${yamlString(type)}`,
    "domains:",
    ...bundle.meta.domains.map((domain) => `  - ${yamlString(domain)}`),
    `range: ${yamlString(bundle.meta.range)}`,
    `scope: ${yamlString(bundle.meta.scope)}`,
    `generated_at: ${yamlString(bundle.meta.generated_at)}`,
    `provider: ${yamlString(provider)}`,
    "tags:",
    ...tags.map((tag) => `  - ${yamlString(tag)}`),
    "---"
  ];

  if (!settings.autoFrontmatter) {
    return "";
  }

  return `${lines.join("\n")}\n\n`;
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "n/a";
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function renderMetrics(metrics: Record<string, unknown>) {
  return Object.entries(metrics).map(([key, value]) => `- ${key}: ${formatValue(value)}`).join("\n");
}

function renderEvidence(evidence: Record<string, unknown>) {
  const sections: string[] = [];

  for (const [key, value] of Object.entries(evidence || {})) {
    sections.push(`### ${key}`);

    if (Array.isArray(value)) {
      if (value.length === 0) {
        sections.push("- none");
      } else {
        for (const item of value.slice(0, 10)) {
          sections.push(`- ${JSON.stringify(item)}`);
        }
      }
    } else if (value && typeof value === "object") {
      const objectLines = Object.entries(value as Record<string, unknown>).map(([childKey, childValue]) => `- ${childKey}: ${formatValue(childValue)}`);
      sections.push(...(objectLines.length > 0 ? objectLines : ["- none"]));
    } else {
      sections.push(`- ${formatValue(value)}`);
    }

    sections.push("");
  }

  return sections.join("\n").trim();
}

function renderRaw(raw?: Record<string, unknown>) {
  if (!raw) return "";
  return `### Raw\n\`\`\`json\n${JSON.stringify(raw, null, 2)}\n\`\`\``;
}

function titleForDomain(domain: YoofloeDomain) {
  switch (domain) {
    case "schedule":
      return "Schedule";
    case "life":
      return "Life";
    case "wellness":
      return "Wellness";
    case "finance":
      return "Finance";
    case "business":
      return "Business";
    case "journal":
      return "Journal";
    case "garden":
      return "Garden";
  }
}

export function renderReportMarkdown({
  title,
  type,
  bundle,
  settings,
  pluginVersion,
  provider
}: {
  title: string;
  type: string;
  bundle: YoofloeBundle;
  settings: MarkdownRenderOptions;
  pluginVersion: string;
  provider: string;
}) {
  const parts: string[] = [];
  const frontmatter = renderFrontmatter({ bundle, settings, pluginVersion, type, provider });
  if (frontmatter) {
    parts.push(frontmatter.trimEnd(), "");
  }

  parts.push(`# ${title}`, "");
  parts.push("## Overview", "");
  parts.push(renderMetrics(bundle.overview || {}), "");

  for (const domain of bundle.meta.domains) {
    const payload = bundle.domains[domain];
    if (!payload) continue;

    parts.push(`## ${titleForDomain(domain)}`, "");
    parts.push("### Summary", "");
    parts.push(renderMetrics(payload.summary || {}), "");

    if (payload.evidence) {
      parts.push("### Evidence", "");
      parts.push(renderEvidence(payload.evidence), "");
    }

    if (settings.includeRawData && payload.raw) {
      parts.push(renderRaw(payload.raw), "");
    }
  }

  if (bundle.prompt_hints?.suggested_questions?.length) {
    parts.push("## Suggested Questions", "");
    parts.push(...bundle.prompt_hints.suggested_questions.map((question) => `- ${question}`), "");
  }

  if (bundle.prompt_hints?.usage_notes?.length) {
    parts.push("## Usage Notes", "");
    parts.push(...bundle.prompt_hints.usage_notes.map((note) => `- ${note}`), "");
  }

  return `${parts.join("\n").trim()}\n`;
}
