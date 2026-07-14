import type {
  MarkdownRenderOptions,
  YoofloeWriterRequest,
  YoofloeWriterResponse
} from "../types";

function yamlString(value: string) {
  return JSON.stringify(value);
}

function yamlList(values: string[]) {
  return values.map((value) => `  - ${yamlString(value)}`).join("\n");
}

function normalizeBody(markdownBody: string) {
  return markdownBody.trim().replace(/^```(?:markdown)?\s*/i, "").replace(/```$/i, "").trim();
}

export function writerSurface(documentType: string) {
  return `ai-${documentType}`;
}

export function renderWriterNoteMarkdown({
  response,
  request,
  settings,
  pluginVersion,
  titleOverride
}: {
  response: YoofloeWriterResponse;
  request: YoofloeWriterRequest;
  settings: MarkdownRenderOptions;
  pluginVersion: string;
  titleOverride?: string;
}) {
  const title = titleOverride?.trim() || response.title?.trim() || "Yoofloe AI note";
  const body = normalizeBody(response.markdownBody || "");
  const providerType = response.provider?.type || "user-owned-vertex-ai";
  const model = response.provider?.model || "";
  const tags = ["yoofloe", "yoofloe/obsidian", "yoofloe/writer", ...request.domains.map((domain) => `yoofloe/${domain}`)];
  const generatedAt = new Date().toISOString();

  const frontmatter = settings.autoFrontmatter
    ? [
      "---",
      `source: ${yamlString("yoofloe")}`,
      `plugin_id: ${yamlString("yoofloe")}`,
      `plugin_version: ${yamlString(pluginVersion)}`,
      `type: ${yamlString(writerSurface(request.documentType))}`,
      "domains:",
      yamlList(request.domains),
      `range: ${yamlString(request.range)}`,
      `scope: ${yamlString(request.scope)}`,
      `generated_at: ${yamlString(generatedAt)}`,
      `provider: ${yamlString(providerType)}`,
      ...(model ? [`model: ${yamlString(model)}`] : []),
      "tags:",
      yamlList(tags),
      "---",
      ""
    ].join("\n")
    : "";

  return `${frontmatter}# ${title}\n\n${body}\n`;
}

export function renderWriterInlineMarkdown(response: YoofloeWriterResponse) {
  const title = response.title?.trim() || "Yoofloe AI note";
  const body = normalizeBody(response.markdownBody || "");
  return `## ${title}\n\n${body}\n`;
}

// Preserve internal call sites while the public Writer contract is renamed.
export const hostedWriterSurface = writerSurface;
export const renderHostedWriterNoteMarkdown = renderWriterNoteMarkdown;
export const renderHostedWriterInlineMarkdown = renderWriterInlineMarkdown;
