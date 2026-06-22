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
  "daily-review": {
    title: "Daily Yoofloe review",
    type: "ai-daily-review",
    surface: "ai-daily-review",
    systemPrompt: "You are a practical daily review writer for Yoofloe data. Use only the provided facts, distinguish evidence from interpretation, and return Markdown only.",
    userGoal: [
      "Create a daily review grounded in the Yoofloe data.",
      "Include: Today Snapshot, Key Signals, Friction, Next Actions, and Reflection Prompts.",
      "Keep the document concise and useful for a personal daily note.",
      "Do not include YAML frontmatter.",
      "Do not wrap the result in code fences.",
      "Do not add a top-level title."
    ].join("\n")
  },
  "weekly-plan": {
    title: "Weekly Yoofloe plan",
    type: "ai-weekly-plan",
    surface: "ai-weekly-plan",
    systemPrompt: "You are a weekly planning assistant for Yoofloe data. Use only the provided facts, keep recommendations realistic, and return Markdown only.",
    userGoal: [
      "Create a weekly plan grounded in the Yoofloe data.",
      "Include: Week Focus, Scheduled Commitments, Wellness Considerations, Priority Actions, and Watchouts.",
      "Keep the plan practical and evidence-based.",
      "Do not include YAML frontmatter.",
      "Do not wrap the result in code fences.",
      "Do not add a top-level title."
    ].join("\n")
  },
  "insight-brief": {
    title: "AI insight brief",
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
    title: "AI decision memo",
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
    title: "AI action plan",
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
  "wellness-check": {
    title: "Wellness check",
    type: "ai-wellness-check",
    surface: "ai-wellness-check",
    systemPrompt: "You are a grounded wellness reflection writer for Yoofloe data. Use only the provided facts, avoid medical claims, and return Markdown only.",
    userGoal: [
      "Create a wellness check grounded in the Yoofloe data.",
      "Include: Current Signals, Energy and Recovery, Helpful Patterns, Gentle Adjustments, and Questions to Notice.",
      "Avoid diagnosis, treatment advice, or unsupported health claims.",
      "Do not include YAML frontmatter.",
      "Do not wrap the result in code fences.",
      "Do not add a top-level title."
    ].join("\n")
  },
  "finance-snapshot": {
    title: "Finance snapshot",
    type: "ai-finance-snapshot",
    surface: "ai-finance-snapshot",
    systemPrompt: "You are a finance snapshot writer for Yoofloe data. Use only the provided facts, avoid investment advice, and return Markdown only.",
    userGoal: [
      "Create a finance snapshot grounded in the Yoofloe data.",
      "Include: Cashflow Signals, Spending or Income Changes, Risks to Watch, Practical Next Steps, and Open Questions.",
      "Do not provide investment, tax, or legal advice.",
      "Do not include YAML frontmatter.",
      "Do not wrap the result in code fences.",
      "Do not add a top-level title."
    ].join("\n")
  },
  "free-prompt": {
    title: "Yoofloe AI note",
    type: "ai-free-prompt",
    surface: "ai-free-prompt",
    systemPrompt: "You are a grounded writing assistant for Yoofloe data. Use only the provided facts, separate evidence from interpretation, and return Markdown only.",
    userGoal: [
      "Create a Markdown document grounded in the Yoofloe data and the user's prompt.",
      "If the prompt is broad, organize the answer into clear sections and identify uncertainty.",
      "Do not include YAML frontmatter.",
      "Do not wrap the result in code fences.",
      "Do not add a top-level title."
    ].join("\n")
  },
  "deep-dive": {
    title: "AI deep dive",
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
      throw new Error("Add a focus instruction before running AI deep dive.");
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
