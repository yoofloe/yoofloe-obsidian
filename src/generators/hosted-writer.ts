import type {
  MarkdownRenderOptions,
  YoofloeHostedWriterRequest,
  YoofloeHostedWriterResponse
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

export function hostedWriterSurface(documentType: string) {
  return `ai-${documentType}`;
}

export function renderHostedWriterNoteMarkdown({
  response,
  request,
  settings,
  pluginVersion
}: {
  response: YoofloeHostedWriterResponse;
  request: YoofloeHostedWriterRequest;
  settings: MarkdownRenderOptions;
  pluginVersion: string;
}) {
  const title = response.title?.trim() || "Yoofloe AI note";
  const body = normalizeBody(response.markdownBody || "");
  const providerType = response.provider?.type || "yoofloe-hosted";
  const model = response.provider?.model || "";
  const tags = ["yoofloe", "yoofloe/obsidian", "yoofloe/writer", ...request.domains.map((domain) => `yoofloe/${domain}`)];
  const generatedAt = new Date().toISOString();

  const frontmatter = settings.autoFrontmatter
    ? [
      "---",
      `source: ${yamlString("yoofloe")}`,
      `plugin_id: ${yamlString("yoofloe")}`,
      `plugin_version: ${yamlString(pluginVersion)}`,
      `type: ${yamlString(hostedWriterSurface(request.documentType))}`,
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

export function renderHostedWriterInlineMarkdown(response: YoofloeHostedWriterResponse) {
  const title = response.title?.trim() || "Yoofloe AI note";
  const body = normalizeBody(response.markdownBody || "");
  return `## ${title}\n\n${body}\n`;
}
