import type { YoofloeCaptureCandidate, YoofloeCaptureTarget } from "./types";

function trimCaptureText(value: string) {
  return value.replace(/\r\n/g, "\n").trim().slice(0, 5000);
}

function firstLine(text: string) {
  return text.split("\n").map((line) => line.trim()).find(Boolean) || "";
}

function titleFromText(text: string, fallback: string) {
  const title = firstLine(text)
    .replace(/^[-*]\s+\[[ xX]\]\s*/, "")
    .replace(/^[-*]\s+/, "")
    .trim();
  return (title || fallback).slice(0, 140);
}

function bodyAfterTitle(text: string) {
  const [, ...rest] = text.split("\n");
  return rest.join("\n").trim();
}

function todayDate() {
  return new Date().toISOString().slice(0, 10);
}

function sourceSnippet(text: string) {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > 140 ? `${normalized.slice(0, 139)}...` : normalized;
}

function asNumberOrNull(value: string) {
  const normalized = value.replace(/,/g, "").trim();
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function extractFirstAmount(text: string) {
  const match = text.match(/(?:[$€£₩]\s*)?(-?\d+(?:[,.]\d{3})*(?:\.\d{1,2})?|-?\d+(?:\.\d{1,2})?)/);
  return match ? asNumberOrNull(match[1]) : null;
}

function actionForTarget(target: Exclude<YoofloeCaptureTarget, "auto">) {
  switch (target) {
    case "journal":
      return "journal.entry.create";
    case "task":
      return "schedule.task.create";
    case "event":
      return "schedule.event.create";
    case "goal":
      return "goals.goal.create";
    case "study-item":
      return "study.item.create";
    case "study-lecture":
      return "study.lecture.create";
    case "study-plan":
      return "study.plan.create";
    case "activity":
      return "activity.item.create";
    case "condition":
      return "wellness.condition.create";
    case "meal":
      return "wellness.meal.create";
    case "ritual":
      return "wellness.ritual.create";
    case "exercise":
      return "exercise.item.create";
    case "business-item":
      return "business.item.create";
    case "finance-transaction":
      return "finance.transaction.create";
    case "memo":
    default:
      return "journal.memo.create";
  }
}

function menuForTarget(target: Exclude<YoofloeCaptureTarget, "auto">) {
  if (target === "task" || target === "event") return "Schedule";
  if (target === "goal") return "Goals";
  if (target.startsWith("study")) return "Study";
  if (target === "activity") return "Activity Log";
  if (target === "condition" || target === "meal" || target === "ritual") return "Wellness";
  if (target === "exercise") return "Exercise";
  if (target === "business-item") return "Business";
  if (target === "finance-transaction") return "Finance";
  return "Journal/Memo";
}

function fieldsForTarget(target: Exclude<YoofloeCaptureTarget, "auto">, text: string) {
  const title = titleFromText(text, `Captured ${target.replace("-", " ")}`);
  const body = bodyAfterTitle(text);
  const date = todayDate();
  switch (target) {
    case "task":
      return { title, fields: { scope: "personal", title, description: body || null, dueDate: null, priority: null, type: "task" } };
    case "event":
      return { title, fields: { scope: "personal", title, description: body || null, start: "", end: "", allDay: false, location: null, status: "confirmed" } };
    case "goal":
      return { title, fields: { scope: "personal", title, description: body || null, category: null, targetValue: null, currentValue: 0, unit: null, targetDate: null, goalMode: "personal" } };
    case "study-item":
      return { title, fields: { scope: "personal", title, name: title, description: body || null, type: "study", date } };
    case "study-lecture":
      return { title, fields: { scope: "personal", title, subject: title, dayOfWeek: "", startTime: "", endTime: "", room: null, semester: null } };
    case "study-plan":
      return { title, fields: { scope: "personal", title, name: title, description: body || null, status: "active", targetDate: null, priority: null } };
    case "activity":
      return { title, fields: { scope: "personal", title, name: title, description: body || null, type: "activity", date, duration: null } };
    case "condition":
      return { title, fields: { scope: "personal", title, name: title, notes: body || text, value: null, unit: null, date, time: null, type: "condition" } };
    case "meal":
      return { title, fields: { scope: "personal", title, name: title, notes: body || text, date, time: null, type: "meal" } };
    case "ritual":
      return { title, fields: { scope: "personal", title, name: title, description: body || null, frequency: "daily", duration: null, vibe: null, is_active: true, type: "ritual" } };
    case "exercise":
      return { title, fields: { scope: "personal", title, name: title, notes: body || null, date, duration: null, distance: null, sets: null, reps: null, weight: null, category: null, type: "exercise" } };
    case "business-item":
      return { title, fields: { scope: "personal", title, name: title, description: body || null, status: "active", priority: null, type: "project", tabCategory: "project", due_date: null, client: null, currency: null } };
    case "finance-transaction":
      return { title, fields: { scope: "personal", title, name: title, description: body || null, type: "expense", amount: extractFirstAmount(text), currency: "USD", category: null, date } };
    case "journal":
      return { title, fields: { scope: "personal", title, content: text, type: "entry", date } };
    case "memo":
    default:
      return { title, fields: { scope: "personal", title, content: text, type: "memo", date } };
  }
}

export function buildLocalCaptureCandidates(textValue: string, target: YoofloeCaptureTarget): YoofloeCaptureCandidate[] {
  const text = trimCaptureText(textValue);
  if (!text) return [];
  const effectiveTarget: Exclude<YoofloeCaptureTarget, "auto"> = target === "auto"
    ? /^[-*]\s+\[[ xX]\]/m.test(text) ? "task" : "memo"
    : target;
  const { title, fields } = fieldsForTarget(effectiveTarget, text);
  const sensitive = effectiveTarget === "business-item" || effectiveTarget === "finance-transaction";
  return [{
    candidateId: `local-${Date.now()}-${effectiveTarget}`,
    action: actionForTarget(effectiveTarget),
    domain: menuForTarget(effectiveTarget).toLowerCase(),
    menu: menuForTarget(effectiveTarget),
    riskTier: sensitive ? "high" : effectiveTarget === "memo" || effectiveTarget === "journal" || effectiveTarget === "task" ? "low" : "medium",
    itemType: effectiveTarget,
    title,
    normalizedFields: fields,
    sourceSnippet: sourceSnippet(text),
    confidence: 0.74,
    warnings: ["Connect Yoofloe to apply this candidate."],
    requiresConfirmation: sensitive
  }];
}
