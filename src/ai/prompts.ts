import type { YoofloeBundle, YoofloeByokTaskType } from "../types";

type ByokTaskDefinition = {
  title: string;
  type: string;
  surface: string;
  systemPrompt: string;
  userGoal: string;
};

const TASK_DEFINITIONS: Record<YoofloeByokTaskType, ByokTaskDefinition> = {
  brief: {
    title: "AI Brief",
    type: "ai-brief",
    surface: "ai-brief",
    systemPrompt: "You are a careful analyst for Yoofloe data. Use only the provided facts, avoid invented details, and return Markdown only.",
    userGoal: [
      "Create a concise executive brief from the Yoofloe bundle.",
      "Include: Overview, Top Priorities, Risks or Watchouts, and Suggested Questions.",
      "Keep the tone practical and evidence-based.",
      "Do not include YAML frontmatter.",
      "Do not wrap the result in code fences.",
      "Do not add a top-level title."
    ].join("\n")
  },
  "action-plan": {
    title: "AI Action Plan",
    type: "ai-action-plan",
    surface: "ai-action-plan",
    systemPrompt: "You are a careful planning assistant for Yoofloe data. Use only the provided facts, separate facts from recommendations, and return Markdown only.",
    userGoal: [
      "Create a read-only action plan from the Yoofloe bundle.",
      "Include: Current State, Priority Actions, Recommended Sequence, Open Questions, and Evidence Notes.",
      "Recommendations must stay grounded in the provided data.",
      "Do not include YAML frontmatter.",
      "Do not wrap the result in code fences.",
      "Do not add a top-level title."
    ].join("\n")
  },
  "prompt-package": {
    title: "AI Prompt Package",
    type: "ai-prompt-package",
    surface: "ai-prompt-package",
    systemPrompt: "You are preparing a reusable prompt package from Yoofloe data. Stay faithful to the provided facts and return Markdown only.",
    userGoal: [
      "Create a reusable prompt package from the Yoofloe bundle for a downstream AI assistant.",
      "Include: Situation Summary, Important Signals, Constraints, Suggested Questions, and a Reusable Prompt block.",
      "The reusable prompt should instruct another AI to use only the supplied Yoofloe facts.",
      "Do not include YAML frontmatter.",
      "Do not wrap the whole answer in code fences.",
      "Do not add a top-level title."
    ].join("\n")
  }
};

export function getByokTaskDefinition(taskType: YoofloeByokTaskType) {
  return TASK_DEFINITIONS[taskType];
}

export function buildByokPrompt({
  bundle,
  taskType
}: {
  bundle: YoofloeBundle;
  taskType: YoofloeByokTaskType;
}) {
  const task = getByokTaskDefinition(taskType);

  return [
    task.userGoal,
    "",
    "Yoofloe bundle JSON:",
    "```json",
    JSON.stringify(bundle, null, 2),
    "```"
  ].join("\n");
}
