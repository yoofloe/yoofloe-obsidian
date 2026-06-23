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
  defaultTarget?: "auto" | "memo" | "journal" | "task" | "event" | "goal" | "study-item" | "study-lecture" | "study-plan" | "activity" | "condition" | "meal" | "ritual" | "exercise" | "business-item" | "finance-transaction";
};

export const YOOFLOE_CAPTURE_DOMAIN_OPTIONS: YoofloeCaptureDomainOption[] = [
  { domain: "auto", label: "Auto suggest", description: "Let Yoofloe suggest the best personal write target from your text.", status: "ready", riskTier: "low", defaultTarget: "auto" },
  { domain: "journal", label: "Journal/Memo", description: "Create personal memos or journal entries.", status: "ready", riskTier: "low", defaultTarget: "memo" },
  { domain: "schedule", label: "Schedule", description: "Create personal tasks or calendar events.", status: "ready", riskTier: "low", defaultTarget: "task" },
  { domain: "goals", label: "Goals", description: "Create personal goals from selected or written notes.", status: "ready", riskTier: "medium", defaultTarget: "goal" },
  { domain: "study", label: "Study", description: "Create study items, lectures, or study plans.", status: "ready", riskTier: "medium", defaultTarget: "study-item" },
  { domain: "activity", label: "Activity Log", description: "Create personal life activity records.", status: "ready", riskTier: "medium", defaultTarget: "activity" },
  { domain: "wellness", label: "Wellness", description: "Create condition, meal, or ritual records after review.", status: "ready", riskTier: "medium", defaultTarget: "condition" },
  { domain: "exercise", label: "Exercise", description: "Create workout and exercise records.", status: "ready", riskTier: "medium", defaultTarget: "exercise" },
  { domain: "business", label: "Business", description: "Create personal business items with explicit confirmation.", status: "ready", riskTier: "high", sensitive: true, defaultTarget: "business-item" },
  { domain: "finance", label: "Finance", description: "Create personal finance transactions with amount review.", status: "ready", riskTier: "high", sensitive: true, defaultTarget: "finance-transaction" },
  { domain: "garden", label: "Garden", description: "Garden is an insight source, not a writeback target.", status: "blocked", riskTier: "read_only" },
  { domain: "agent", label: "Workspace overview", description: "Overview is an insight source, not a direct mutation target.", status: "blocked", riskTier: "read_only" }
];

export function getCaptureDomainOption(domain: YoofloeCaptureDomain) {
  return YOOFLOE_CAPTURE_DOMAIN_OPTIONS.find((entry) => entry.domain === domain) || YOOFLOE_CAPTURE_DOMAIN_OPTIONS[0];
}

export function isCaptureDomainReady(domain: YoofloeCaptureDomain) {
  return getCaptureDomainOption(domain).status === "ready";
}
