import type { YoofloeAiDocumentType, YoofloeBundle } from "../types";

export type YoofloeAiDocumentDefinition = {
  title: string;
  type: string;
  surface: string;
  systemPrompt: string;
  userGoal: string;
  requiresFocusInstruction?: boolean;
};

const DOCUMENT_DEFINITIONS: Record<YoofloeAiDocumentType, YoofloeAiDocumentDefinition> = {
  "insight-brief": {
    title: "AI Insight Brief",
    type: "ai-insight-brief",
    surface: "ai-insight-brief",
    systemPrompt: "You are an insight-focused analyst for Yoofloe data. Use only the provided facts, distinguish evidence from interpretation, and return Markdown only.",
    userGoal: [
      "Create an insight brief grounded in the Yoofloe data.",
      "Include: What Matters Now, Key Signals, Tensions or Risks, Opportunities, and Suggested Questions.",
      "Make the document concise, practical, and evidence-based.",
      "Do not include YAML frontmatter.",
      "Do not wrap the result in code fences.",
      "Do not add a top-level title."
    ].join("\n")
  },
  "decision-memo": {
    title: "AI Decision Memo",
    type: "ai-decision-memo",
    surface: "ai-decision-memo",
    systemPrompt: "You are a strategic decision-support writer for Yoofloe data. Use only the provided facts, separate interpretation from evidence, and return Markdown only.",
    userGoal: [
      "Create a decision memo grounded in the Yoofloe data.",
      "Include: Situation Summary, Decision Framing, Tradeoffs, Recommended Direction, Supporting Evidence, and Open Questions.",
      "Call out where the data is strong and where uncertainty remains.",
      "Do not include YAML frontmatter.",
      "Do not wrap the result in code fences.",
      "Do not add a top-level title."
    ].join("\n")
  },
  "action-plan": {
    title: "AI Action Plan",
    type: "ai-action-plan",
    surface: "ai-action-plan",
    systemPrompt: "You are an action-oriented planning assistant for Yoofloe data. Use only the provided facts, separate evidence from recommendations, and return Markdown only.",
    userGoal: [
      "Create an action plan grounded in the Yoofloe data.",
      "Include: Current State, Priority Actions, Recommended Sequence, Dependencies or Blockers, Watchouts, and Evidence Notes.",
      "Recommendations must stay realistic and directly tied to the data.",
      "Do not include YAML frontmatter.",
      "Do not wrap the result in code fences.",
      "Do not add a top-level title."
    ].join("\n")
  },
  "deep-dive": {
    title: "AI Deep Dive",
    type: "ai-deep-dive",
    surface: "ai-deep-dive",
    systemPrompt: "You are a focused research analyst for Yoofloe data. Stay tightly aligned to the supplied focus instruction, use only the provided facts, and return Markdown only.",
    userGoal: [
      "Create a deep-dive analysis grounded in the Yoofloe data and the provided focus instruction.",
      "Include: Focus Summary, Relevant Signals, Interpretation, Recommended Actions, and Open Questions.",
      "Stay tightly scoped to the requested theme or concern.",
      "Do not include YAML frontmatter.",
      "Do not wrap the result in code fences.",
      "Do not add a top-level title."
    ].join("\n"),
    requiresFocusInstruction: true
  }
};

export function getAiDocumentDefinition(documentType: YoofloeAiDocumentType) {
  return DOCUMENT_DEFINITIONS[documentType];
}

export function buildAiDocumentPrompt({
  bundle,
  documentType,
  gardenerBrief,
  focusInstruction
}: {
  bundle: YoofloeBundle;
  documentType: YoofloeAiDocumentType;
  gardenerBrief?: string | null;
  focusInstruction?: string | null;
}) {
  const document = getAiDocumentDefinition(documentType);
  const sections = [
    document.userGoal
  ];

  if (document.requiresFocusInstruction) {
    const normalizedFocus = focusInstruction?.trim() ?? "";
    if (!normalizedFocus) {
      throw new Error("Add a focus instruction before running AI Deep Dive.");
    }
    sections.push("", `Focus instruction:\n${normalizedFocus}`);
  } else if (focusInstruction?.trim()) {
    sections.push("", `Optional focus instruction:\n${focusInstruction.trim()}`);
  }

  if (gardenerBrief?.trim()) {
    sections.push(
      "",
      "Deterministic Yoofloe signal brief:",
      "```markdown",
      gardenerBrief.trim(),
      "```"
    );
  }

  sections.push(
    "",
    "Canonical Yoofloe bundle JSON:",
    "```json",
    JSON.stringify(bundle, null, 2),
    "```"
  );

  return sections.join("\n");
}
