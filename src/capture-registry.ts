export type YoofloeCaptureDomain =
  | "auto"
  | "journal"
  | "goals"
  | "schedule"
  | "study"
  | "activity"
  | "wellness"
  | "exercise"
  | "business"
  | "finance"
  | "garden"
  | "agent";

export type YoofloeCaptureStatus = "ready" | "gated" | "future" | "blocked";

export type YoofloeCaptureDomainOption = {
  domain: YoofloeCaptureDomain;
  label: string;
  description: string;
  status: YoofloeCaptureStatus;
  riskTier: "low" | "medium" | "high" | "read_only";
  sensitive?: boolean;
  defaultTarget?: "memo" | "task" | "journal";
};

export const YOOFLOE_CAPTURE_DOMAIN_OPTIONS: YoofloeCaptureDomainOption[] = [
  { domain: "auto", label: "Auto suggest", description: "Let Yoofloe choose memo, task, or journal from your text.", status: "ready", riskTier: "low", defaultTarget: "memo" },
  { domain: "journal", label: "Journal/Memo", description: "Create personal memos or journal entries.", status: "ready", riskTier: "low", defaultTarget: "memo" },
  { domain: "schedule", label: "Schedule", description: "Create personal tasks now; events are gated next.", status: "ready", riskTier: "low", defaultTarget: "task" },
  { domain: "goals", label: "Goals", description: "Goal create and progress updates are next.", status: "gated", riskTier: "medium" },
  { domain: "study", label: "Study", description: "Study logs, lectures, and plans are planned after core capture.", status: "gated", riskTier: "medium" },
  { domain: "activity", label: "Activity Log", description: "Life activity capture is planned with learning/life domains.", status: "gated", riskTier: "medium" },
  { domain: "wellness", label: "Wellness", description: "Condition, meal, and ritual capture need health-data review.", status: "gated", riskTier: "medium" },
  { domain: "exercise", label: "Exercise", description: "Workout capture is planned with health-domain capture.", status: "gated", riskTier: "medium" },
  { domain: "business", label: "Business", description: "Sensitive business writeback needs explicit confirmation.", status: "gated", riskTier: "high", sensitive: true },
  { domain: "finance", label: "Finance", description: "Sensitive transaction writeback needs amount review.", status: "gated", riskTier: "high", sensitive: true },
  { domain: "garden", label: "Garden", description: "Garden is an insight source, not a writeback target.", status: "blocked", riskTier: "read_only" },
  { domain: "agent", label: "Workspace overview", description: "Overview is an insight source, not a direct mutation target.", status: "blocked", riskTier: "read_only" }
];

export function getCaptureDomainOption(domain: YoofloeCaptureDomain) {
  return YOOFLOE_CAPTURE_DOMAIN_OPTIONS.find((entry) => entry.domain === domain) || YOOFLOE_CAPTURE_DOMAIN_OPTIONS[0];
}

export function isCaptureDomainReady(domain: YoofloeCaptureDomain) {
  return getCaptureDomainOption(domain).status === "ready";
}
