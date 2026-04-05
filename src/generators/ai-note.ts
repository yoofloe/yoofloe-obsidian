import { renderYoofloeFrontmatter } from "./markdown";
import type { MarkdownRenderOptions, YoofloeBundle } from "../types";

export function renderAiNoteMarkdown({
  title,
  type,
  bundle,
  settings,
  pluginVersion,
  provider,
  body
}: {
  title: string;
  type: string;
  bundle: YoofloeBundle;
  settings: MarkdownRenderOptions;
  pluginVersion: string;
  provider: string;
  body: string;
}) {
  const frontmatter = renderYoofloeFrontmatter({
    bundle,
    settings,
    pluginVersion,
    type,
    provider
  });

  const normalizedBody = body.trim();
  const parts = [
    frontmatter.trimEnd(),
    `# ${title}`,
    "",
    normalizedBody
  ].filter(Boolean);

  return `${parts.join("\n")}\n`;
}
